/**
 * Cloudflare Durable Object RPC Adapter
 *
 * Mixin for @cloudflare/actors that adds RPC capabilities to Durable Objects.
 * Manages RPC peers for each WebSocket connection with hibernation support.
 *
 * ## Usage
 *
 * The mixin requires that the base Actor class implements the methods defined
 * in the local schema. TypeScript will enforce this at compile time.
 *
 * ```ts
 * // First, create an Actor with the RPC method implementations
 * class MyActorBase extends Actor<Env> {
 *   protected wallets: string[] = [];
 *
 *   // Required: implement methods from SignalSchema
 *   async getWallets() {
 *     return { wallets: this.wallets };
 *   }
 * }
 *
 * // Then apply the RPC mixin
 * class MyDO extends withRpc(MyActorBase, {
 *   localSchema: SignalSchema,
 *   remoteSchema: FilterSchema,
 * }) {
 *   // Call methods on connected clients via driver
 *   async notifyClients() {
 *     // Call all connected peers
 *     const results = await this.driver.someClientMethod({});
 *
 *     // Or call specific peer with timeout
 *     const results = await this.driver.someClientMethod({}, {
 *       ids: "peer-id",
 *       timeout: 5000,
 *     });
 *   }
 * }
 * ```
 *
 * ## Hibernation Handling
 *
 * When a DO hibernates, all in-memory state is lost but WebSocket connections
 * remain open. This adapter handles hibernation by lazily recreating RpcPeer
 * instances when messages arrive on connections that were established before
 * hibernation.
 *
 * For hibernation-safe outgoing calls, use DurableRpcPeer which persists
 * pending calls to durable storage.
 */

import type { Actor } from "@cloudflare/actors";
import type { Constructor } from "type-fest";
import { RpcPeer } from "../peers/default.js";
import {
	createDurableRpcPeerFactory,
	DurableRpcPeer,
	type DurableRpcPeerOptions,
} from "../peers/durable.js";
import type { EventTuple, Provider, RpcSchema } from "../schema.js";
import type { SyncPendingCallStorage } from "../storage/interface.js";
import { MemoryPendingCallStorage } from "../storage/memory.js";
import { SqlPendingCallStorage } from "../storage/sql.js";
import type { IRpcOptions } from "../types.js";
import { MultiPeerBase, type MultiPeerOptions } from "./multi-peer.js";
import type { IMultiAdapterHooks, IMultiConnectionAdapter } from "./types.js";

/**
 * Extended hooks for Durable Object adapter
 */
export interface IDOHooks<
	TLocalSchema extends RpcSchema,
	TRemoteSchema extends RpcSchema,
> extends IMultiAdapterHooks<TLocalSchema, TRemoteSchema> {
	/** Called when a peer is recreated after hibernation */
	onPeerRecreated?(
		peer: RpcPeer<TLocalSchema, TRemoteSchema>,
		ws: WebSocket,
	): void;
}

/**
 * Concrete MultiPeerBase for Durable Objects using native WebSocket
 */
class DOMultiPeer<
	TLocalSchema extends RpcSchema,
	TRemoteSchema extends RpcSchema,
	TActor,
> extends MultiPeerBase<TLocalSchema, TRemoteSchema, WebSocket> {
	public override readonly hooks: IDOHooks<TLocalSchema, TRemoteSchema>;
	private readonly _createPeer;

	constructor(
		options: MultiPeerOptions<TLocalSchema, TRemoteSchema> &
			DurableRpcPeerOptions<TActor> & {
				hooks?: IDOHooks<TLocalSchema, TRemoteSchema>;
			},
	) {
		super(options);
		this.hooks = options.hooks ?? {};
		this._createPeer = createDurableRpcPeerFactory({
			actor: options.actor,
			storage: options.storage,
			...(options.durableTimeout != null && {
				durableTimeout: options.durableTimeout,
			}),
		});
	}

	/**
	 * Create an RPC peer for a WebSocket connection.
	 * Override to use the actor instance as provider via closure.
	 */
	public createPeerWithProvider(
		ws: WebSocket,
		provider: Provider<TLocalSchema["methods"]>,
	): DurableRpcPeer<TLocalSchema, TRemoteSchema, TActor> {
		const peer = this._createPeer({
			ws,
			localSchema: this.localSchema,
			remoteSchema: this.remoteSchema,
			provider,
			...(this.protocol !== undefined && { protocol: this.protocol }),
			onEvent: (...args) => {
				this.hooks.onEvent?.(
					peer,
					...(args as EventTuple<TRemoteSchema["events"]>),
				);
			},
			timeout: this.timeout,
		});
		return peer;
	}

	/**
	 * Get or create RPC peer for a WebSocket
	 * Handles lazy recreation after hibernation.
	 */
	public getOrCreatePeer(
		ws: WebSocket,
		provider: Provider<TLocalSchema["methods"]>,
		isHibernationRecovery = false,
	): RpcPeer<TLocalSchema, TRemoteSchema> {
		let peer = this.getPeerFor(ws);

		if (!peer) {
			peer = this.createPeerWithProvider(ws, provider);
			this.addPeer(ws, peer);

			if (isHibernationRecovery) {
				this.hooks.onPeerRecreated?.(peer, ws);
			}
		}

		return peer;
	}

	/**
	 * Connect a new WebSocket and create its peer
	 */
	public connectPeer(
		ws: WebSocket,
		provider: Provider<TLocalSchema["methods"]>,
	): RpcPeer<TLocalSchema, TRemoteSchema> {
		const peer = this.createPeerWithProvider(ws, provider);
		this.addPeer(ws, peer);
		return peer;
	}

	/**
	 * Disconnect a WebSocket and remove its peer
	 */
	public disconnectPeer(ws: WebSocket): void {
		this.removePeer(ws);
	}

	/**
	 * Handle an error on a WebSocket
	 */
	public handleError(ws: WebSocket, error: Error): void {
		const peer = this.getPeerFor(ws);
		if (peer) {
			peer.close();
			this.removePeer(ws);
		}
		this.hooks.onError?.(peer ?? null, error);
	}
}

/**
 * Interface for overridable RPC hooks exposed by the mixin.
 * Subclasses can override these to handle RPC lifecycle events.
 */
export interface IRpcActorHooks<
	TLocalSchema extends RpcSchema,
	TRemoteSchema extends RpcSchema,
> {
	/** Called when a peer connects. Override to handle connection events. */
	onRpcConnect(peer: RpcPeer<TLocalSchema, TRemoteSchema>): void;

	/** Called when a peer disconnects. Override to handle disconnection events. */
	onRpcDisconnect(peer: RpcPeer<TLocalSchema, TRemoteSchema>): void;

	/** Called when an event is received from a peer. Override to handle events. */
	onRpcEvent(
		peer: RpcPeer<TLocalSchema, TRemoteSchema>,
		...args: EventTuple<TRemoteSchema["events"]>
	): void;

	/** Called when a peer encounters an error. Override to handle errors. */
	onRpcError(
		peer: RpcPeer<TLocalSchema, TRemoteSchema> | null,
		error: Error,
	): void;

	/** Called when a peer is recreated after hibernation. Override to handle recovery. */
	onRpcPeerRecreated(
		peer: RpcPeer<TLocalSchema, TRemoteSchema>,
		ws: WebSocket,
	): void;
}

/**
 * Constructor type for the RPC mixin result.
 *
 * Subclasses must implement methods from TLocalSchema on `this`.
 * Runtime enforces this when methods are called via RPC.
 */
export type RpcActorConstructor<
	TBase extends Constructor<Actor<unknown>>,
	TLocalSchema extends RpcSchema,
	TRemoteSchema extends RpcSchema,
> = {
	new (
		...args: ConstructorParameters<TBase>
	): InstanceType<TBase> &
		IMultiConnectionAdapter<TLocalSchema, TRemoteSchema> &
		IRpcActorHooks<TLocalSchema, TRemoteSchema>;
} & Omit<TBase, "new">;

/**
 * Create a mixin that adds RPC capabilities to a Durable Object Actor.
 *
 * The resulting class requires implementation of all methods defined in
 * `localSchema`. TypeScript enforces this at compile time.
 *
 * @param Base - The Actor class to extend
 * @param options - RPC configuration including local/remote schemas and timeout
 * @returns A new class with RPC capabilities mixed in
 *
 * @example
 * ```ts
 * const ServerSchema = {
 *   methods: {
 *     getData: method({
 *       input: z.object({}),
 *       output: z.object({ data: z.array(z.string()) }),
 *     }),
 *   },
 *   events: {},
 * } as const;
 *
 * // Define methods on the base Actor class
 * class MyActorBase extends Actor<Env> {
 *   protected dataList: string[] = [];
 *
 *   async getData() {
 *     return { data: this.dataList };
 *   }
 * }
 *
 * // Apply the RPC mixin
 * class MyDO extends withRpc(MyActorBase, {
 *   localSchema: ServerSchema,
 *   remoteSchema: ClientSchema,
 * }) {
 *   // Call methods on connected clients
 *   async notifyClients() {
 *     const results = await this.driver.clientMethod({ info: "update" });
 *   }
 * }
 * ```
 */
export function withRpc<
	TLocalSchema extends RpcSchema,
	TRemoteSchema extends RpcSchema,
	TEnv,
	TBase extends Constructor<Actor<TEnv>> & {
		prototype: Provider<TLocalSchema["methods"]>;
	},
>(
	Base: TBase,
	options: IRpcOptions<TLocalSchema, TRemoteSchema>,
): RpcActorConstructor<TBase, TLocalSchema, TRemoteSchema> {
	// @ts-expect-error - TypeScript can't verify the anonymous class satisfies RpcActorConstructor
	return class RpcActor extends Base {
		private __rpc: DOMultiPeer<TLocalSchema, TRemoteSchema, this> | null = null;

		/**
		 * Internal RPC manager (lazily initialized)
		 *
		 * Handles peer management, message routing, and durable storage.
		 * Uses SQL storage from the Durable Object for hibernation-safe calls.
		 * Falls back to in-memory storage if DurableObjectStorage is not available.
		 */
		private get _rpc() {
			if (this.__rpc) return this.__rpc;

			let storage: SyncPendingCallStorage;
			if (this.storage?.raw) {
				storage = new SqlPendingCallStorage(this.storage.raw.sql);
			} else {
				console.warn(
					`[ws-rpc] DurableObjectStorage not available (storage=${typeof this.storage}, this=${this?.constructor?.name ?? typeof this}). ` +
						`Falling back to in-memory storage. Pending calls will not survive hibernation.`,
				);
				storage = new MemoryPendingCallStorage();
			}

			return (this.__rpc = new DOMultiPeer({
				actor: this,
				storage,
				localSchema: options.localSchema,
				remoteSchema: options.remoteSchema,
				provider: this as unknown as Provider<TLocalSchema["methods"]>,
				...(options.timeout !== undefined && { timeout: options.timeout }),
				...(options.protocol !== undefined && { protocol: options.protocol }),
				hooks: {
					onConnect: (peer) => this.onRpcConnect(peer),
					onDisconnect: (peer) => this.onRpcDisconnect(peer),
					onEvent: (peer, ...args) => this.onRpcEvent(peer, ...args),
					onError: (peer, error) => this.onRpcError(peer, error),
					onPeerRecreated: (peer, ws) => this.onRpcPeerRecreated(peer, ws),
				},
			}));
		}

		// =========================================================================
		// Overridable RPC Hooks
		// =========================================================================

		/** Called when a peer connects. Override to handle connection events. */
		protected onRpcConnect(_peer: RpcPeer<TLocalSchema, TRemoteSchema>): void {}

		/** Called when a peer disconnects. Override to handle disconnection events. */
		protected onRpcDisconnect(
			_peer: RpcPeer<TLocalSchema, TRemoteSchema>,
		): void {}

		/** Called when an event is received from a peer. Override to handle events. */
		protected onRpcEvent(
			_peer: RpcPeer<TLocalSchema, TRemoteSchema>,
			...[_event, _data]: EventTuple<TRemoteSchema["events"]>
		): void {}

		/** Called when a peer encounters an error. Override to handle errors. */
		protected onRpcError(
			_peer: RpcPeer<TLocalSchema, TRemoteSchema> | null,
			_error: Error,
		): void {}

		/** Called when a peer is recreated after hibernation. Override to handle recovery. */
		protected onRpcPeerRecreated(
			_peer: RpcPeer<TLocalSchema, TRemoteSchema>,
			_ws: WebSocket,
		): void {}

		/**
		 * Driver for calling methods on connected clients
		 */
		public get driver() {
			return this._rpc.driver;
		}

		/**
		 * Emit an event to connected clients
		 *
		 * @param event - Event name from local schema
		 * @param data - Event data matching the schema
		 * @param ids - Optional array of peer IDs to emit to (broadcasts to all if omitted)
		 */
		public emit(
			...args: [...EventTuple<TLocalSchema["events"]>, ids?: string[]]
		): void {
			this._rpc.emit(...args);
		}

		/**
		 * Get the number of connected peers
		 */
		public getConnectionCount() {
			return this._rpc.getConnectionCount();
		}

		/**
		 * Get the IDs of all connected peers
		 */
		public getConnectionIds() {
			return this._rpc.getConnectionIds();
		}

		// =========================================================================
		// Actor WebSocket Hooks (DO-specific, required by Actor class)
		// =========================================================================

		/** Called by Actor when WebSocket connects */
		protected onWebSocketConnect(ws: WebSocket, _request: Request): void {
			this._rpc.connectPeer(
				ws,
				this as unknown as Provider<TLocalSchema["methods"]>,
			);
		}

		/** Called by Actor when WebSocket message received (handles hibernation recovery) */
		protected onWebSocketMessage(
			ws: WebSocket,
			message: ArrayBuffer | string,
		): void {
			const existingPeer = this._rpc.getPeerFor(ws);
			const peer = this._rpc.getOrCreatePeer(
				ws,
				this as unknown as Provider<TLocalSchema["methods"]>,
				!existingPeer,
			);
			peer.handleMessage(message);
		}

		/** Called by Actor when WebSocket disconnects */
		protected onWebSocketDisconnect(ws: WebSocket): void {
			this._rpc.disconnectPeer(ws);
		}

		/** Called by Actor when WebSocket error occurs */
		protected onWebSocketError(ws: WebSocket, error: Error): void {
			this._rpc.handleError(ws, error);
		}
	};
}
