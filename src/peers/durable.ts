/**
 * Durable RPC Peer
 *
 * Extends RpcPeer to add hibernation-safe continuation-based RPC calls.
 * Uses synchronous storage to persist pending calls across DO hibernation.
 *
 * @example
 * ```ts
 * // In your Durable Object
 * class MyDO extends Actor<Env> {
 *   private peer: DurableRpcPeer<LocalSchema, RemoteSchema, this>;
 *
 *   onWebSocketConnect(ws: WebSocket) {
 *     const storage = new SqlPendingCallStorage(this.ctx.storage.sql);
 *     this.peer = new DurableRpcPeer({
 *       ws,
 *       localSchema,
 *       remoteSchema,
 *       provider,
 *       storage,
 *       actor: this,
 *     });
 *   }
 *
 *   async doSomething() {
 *     // Promise-based (not hibernation-safe)
 *     const result = await this.peer.driver.someMethod({ data });
 *
 *     // Continuation-based (hibernation-safe)
 *     this.peer.callWithCallback('someMethod', { data }, 'onSomeMethodResult');
 *   }
 *
 *   // Callback method - called with result even after hibernation
 *   onSomeMethodResult(result: SomeResult, context: CallContext) {
 *     // Handle result
 *   }
 * }
 * ```
 */

import type { WireInput } from "../protocol.js";
import type { RpcSchema } from "../schema.js";
import type {
	PendingCall,
	SyncPendingCallStorage,
} from "../storage/interface.js";
import { RpcPeer, type RpcPeerOptions } from "./default.js";

/**
 * Options for creating a DurableRpcPeer
 */
export interface DurableRpcPeerOptions<TActor> {
	/** Synchronous storage for persisting pending calls */
	storage: SyncPendingCallStorage;
	/** The actor instance (for resolving callback methods) */
	actor: TActor;
	/** Default timeout for continuation-based calls (ms) */
	durableTimeout?: number;
}

/**
 * Context passed to callback methods along with the result
 */
export interface CallContext {
	/** The original pending call */
	call: PendingCall;
	/** Time from send to response (ms) */
	latencyMs: number;
}

/**
 * Durable RPC Peer
 *
 * Extends RpcPeer to add:
 * - Hibernation-safe continuation-based calls via `callWithCallback`
 * - Automatic recovery of pending calls after hibernation
 * - Timeout cleanup for stale calls
 */
export class DurableRpcPeer<
	TLocalSchema extends RpcSchema,
	TRemoteSchema extends RpcSchema,
	TActor,
> extends RpcPeer<TLocalSchema, TRemoteSchema> {
	private readonly storage: SyncPendingCallStorage;
	private readonly actor: TActor;
	private readonly durableTimeout: number;
	private durableRequestCounter = 0;

	/**
	 * Create a durable RPC peer
	 *
	 * @param options - Combined RPC peer and durable options
	 */
	constructor(
		options: RpcPeerOptions<TLocalSchema, TRemoteSchema> &
			DurableRpcPeerOptions<TActor>,
	) {
		super(options);
		this.storage = options.storage;
		this.actor = options.actor;
		this.durableTimeout = options.durableTimeout ?? options.timeout ?? 30000;
	}

	/**
	 * Make a hibernation-safe RPC call using continuation-passing style
	 *
	 * Instead of returning a Promise, the result will be passed to the
	 * named callback method on the actor. This survives DO hibernation.
	 *
	 * @param method - Remote method to call
	 * @param params - Parameters for the method
	 * @param callback - Name of method on actor to call with result
	 * @param timeout - Optional timeout override (ms)
	 *
	 * @example
	 * ```ts
	 * // Make the call
	 * peer.callWithCallback('executeOrder', { market, side }, 'onOrderExecuted');
	 *
	 * // Define the callback on your actor
	 * onOrderExecuted(result: OrderResult, context: CallContext) {
	 *   console.log('Order executed:', result);
	 *   console.log('Latency:', context.latencyMs, 'ms');
	 * }
	 * ```
	 */
	callWithCallback<K extends keyof TRemoteSchema["methods"] & string>(
		method: K,
		params: unknown,
		callback: keyof TActor & string,
		timeout?: number,
	): void {
		// Validate callback exists and is a function
		const callbackFn = this.actor[callback as keyof TActor];
		if (typeof callbackFn !== "function") {
			throw new Error(`Callback '${callback}' is not a function on the actor`);
		}

		const now = Date.now();
		const timeoutMs = timeout ?? this.durableTimeout;

		const call: PendingCall = {
			id: `durable-${++this.durableRequestCounter}`,
			method,
			params,
			callback,
			sentAt: now,
			timeoutAt: now + timeoutMs,
		};

		// Persist to storage BEFORE sending (ensures delivery even if we crash)
		this.storage.save(call);

		// Send the request
		const ws = this.getWebSocket();
		if (ws.readyState === 1) {
			ws.send(this.protocol.createRequest(call.id, method, params));
		} else {
			console.warn(`Cannot send durable call '${method}': connection not open`);
		}
	}

	/**
	 * Handle an incoming WebSocket message
	 *
	 * Checks durable storage for continuation-based calls before
	 * delegating to the base class for promise-based calls.
	 *
	 * @param data - Raw WebSocket message data
	 */
	override handleMessage(data: WireInput): void {
		const message = this.protocol.safeDecodeMessage(data);
		if (!message) {
			// Let base class handle parse errors
			super.handleMessage(data);
			return;
		}

		// Check if this is a response for a durable call
		if (message.type === "rpc:response" || message.type === "rpc:error") {
			const id = message.id;
			const call = this.storage.get(id);

			if (call) {
				// This is a durable call - handle via callback
				this.storage.delete(id);

				const context: CallContext = {
					call,
					latencyMs: Date.now() - call.sentAt,
				};

				const callbackFn = this.actor[call.callback as keyof TActor];
				if (typeof callbackFn === "function") {
					if (message.type === "rpc:response") {
						callbackFn.call(this.actor, message.result, context);
					} else {
						callbackFn.call(this.actor, new Error(message.message), context);
					}
				}
				return;
			}
		}

		// Not a durable call - delegate to base class
		super.handleMessage(data);
	}

	/**
	 * Get all pending durable calls (for debugging/monitoring)
	 *
	 * @returns Array of all pending calls
	 */
	getPendingCalls(): PendingCall[] {
		return this.storage.listAll();
	}

	/**
	 * Get expired calls that have exceeded their timeout
	 *
	 * @returns Array of calls that have exceeded their timeout
	 */
	getExpiredCalls(): PendingCall[] {
		return this.storage.listExpired(Date.now());
	}

	/**
	 * Clean up expired calls
	 *
	 * Call this periodically (e.g., on alarm) to remove stale calls.
	 *
	 * @returns The expired calls that were removed (for optional error handling)
	 */
	cleanupExpired(): PendingCall[] {
		const expired = this.getExpiredCalls();
		for (const call of expired) {
			this.storage.delete(call.id);
		}
		return expired;
	}

	/**
	 * Clear all pending durable calls
	 */
	clearPendingCalls(): void {
		this.storage.clear();
	}
}

/**
 * Create a factory function for DurableRpcPeer instances
 *
 * Pre-configures the durable storage and actor, returning a function
 * that only needs RPC options to create a new peer.
 *
 * @param durableOptions - Durable configuration (storage, actor, timeout)
 * @returns Factory function that creates DurableRpcPeer instances
 *
 * @example
 * ```ts
 * const createPeer = createDurableRpcPeerFactory({
 *   storage: new SqlPendingCallStorage(sql),
 *   actor: this,
 * });
 *
 * // Later, create peers for each connection
 * const peer = createPeer({
 *   ws,
 *   localSchema,
 *   remoteSchema,
 *   provider,
 * });
 * ```
 */
export const createDurableRpcPeerFactory =
	<TActor>(durableOptions: DurableRpcPeerOptions<TActor>) =>
	<TLocalSchema extends RpcSchema, TRemoteSchema extends RpcSchema>(
		rpcOptions: RpcPeerOptions<TLocalSchema, TRemoteSchema>,
	) =>
		new DurableRpcPeer({ ...durableOptions, ...rpcOptions });
