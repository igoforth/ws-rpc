/**
 * RPC Peer
 *
 * Core bidirectional RPC implementation. Both client and server are "peers"
 * that can call methods on each other.
 */

import { v7 as uuidv7 } from "uuid";
import {
	RpcConnectionClosed,
	RpcMethodNotFoundError,
	RpcRemoteError,
	RpcTimeoutError,
	RpcValidationError,
} from "../errors.js";
import {
	JsonProtocol,
	type RpcError,
	RpcErrorCodes,
	type RpcEvent,
	type RpcProtocol,
	type RpcRequest,
	type RpcResponse,
	type WireInput,
} from "../protocol.js";
import type {
	Driver,
	EventHandler,
	InferEvents,
	Provider,
	RpcSchema,
	StringKeys,
} from "../schema.js";
import type { IMinWebSocket, IRpcOptions } from "../types.js";

/**
 * Pending request tracking
 */
interface PendingRequest {
	resolve: (result: unknown) => void;
	reject: (error: Error) => void;
	timeout: ReturnType<typeof setTimeout>;
	method: string;
}

/**
 * Options for creating an RpcPeer
 */
export interface RpcPeerOptions<
	TLocalSchema extends RpcSchema,
	TRemoteSchema extends RpcSchema,
> extends IRpcOptions<TLocalSchema, TRemoteSchema> {
	/** Unique identifier for this peer (auto-generated if not provided) */
	id?: string;
	/** WebSocket instance */
	ws: IMinWebSocket;
	/** Implementation of local methods */
	provider: Partial<Provider<TLocalSchema["methods"]>>;
	/** Handler for incoming events */
	onEvent?: EventHandler<TRemoteSchema["events"]> | undefined;
	/** Generate unique request IDs */
	generateId?: (() => string) | undefined;
}

/**
 * Bidirectional RPC peer
 *
 * Both sides of a WebSocket connection are "peers" - they each implement
 * some methods (provider) and can call methods on the other side (driver).
 */
export class RpcPeer<
	TLocalSchema extends RpcSchema,
	TRemoteSchema extends RpcSchema,
> {
	/** Unique identifier for this peer */
	readonly id: string;
	/** WebSocket instance - protected for subclass access */
	protected readonly ws: IMinWebSocket;
	/** Protocol instance - protected for subclass access */
	protected readonly protocol: RpcProtocol;
	private readonly localSchema: TLocalSchema;
	private readonly remoteSchema: TRemoteSchema;
	private readonly provider: Partial<Provider<TLocalSchema["methods"]>>;
	private readonly onEventHandler?: RpcPeerOptions<
		TLocalSchema,
		TRemoteSchema
	>["onEvent"];
	private readonly defaultTimeout: number;
	private readonly generateId: () => string;
	private readonly pendingRequests = new Map<string, PendingRequest>();
	private requestCounter = 0;
	private closed = false;

	/** Proxy for calling remote methods */
	readonly driver: Driver<TRemoteSchema["methods"]>;

	constructor(options: RpcPeerOptions<TLocalSchema, TRemoteSchema>) {
		this.id = options.id ?? uuidv7();
		this.ws = options.ws;
		this.protocol = options.protocol ?? JsonProtocol;
		this.localSchema = options.localSchema;
		this.remoteSchema = options.remoteSchema;
		this.provider = options.provider;
		this.onEventHandler = options.onEvent;
		this.defaultTimeout = options.timeout ?? 30000;
		this.generateId = options.generateId ?? (() => `${++this.requestCounter}`);

		// Create driver proxy for calling remote methods
		this.driver = this.createDriver();
	}

	/**
	 * Create a proxy that allows calling remote methods
	 */
	private createDriver(): Driver<TRemoteSchema["methods"]> {
		const methods = this.remoteSchema.methods ?? {};
		const driver: Record<string, (input: unknown) => Promise<unknown>> = {};

		for (const methodName of Object.keys(methods)) {
			driver[methodName] = (input: unknown) =>
				this.callMethod(methodName, input);
		}

		return driver as Driver<TRemoteSchema["methods"]>;
	}

	/**
	 * Call a remote method and wait for the response (used by driver proxy)
	 */
	private async callMethod(
		method: string,
		input: unknown,
		timeout?: number,
	): Promise<unknown> {
		if (this.closed || this.ws.readyState !== 1) {
			throw new RpcConnectionClosed();
		}

		const methodDef = this.remoteSchema.methods?.[method];
		if (!methodDef) {
			throw new RpcMethodNotFoundError(method);
		}

		// Validate input against schema
		const parseResult = methodDef.input.safeParse(input);
		if (!parseResult.success) {
			throw new RpcValidationError(
				`Invalid input for method '${method}'`,
				parseResult.error,
			);
		}

		const id = this.generateId();
		const timeoutMs = timeout ?? this.defaultTimeout;

		return new Promise((resolve, reject) => {
			const timeoutHandle = setTimeout(() => {
				this.pendingRequests.delete(id);
				reject(new RpcTimeoutError(method, timeoutMs));
			}, timeoutMs);

			this.pendingRequests.set(id, {
				resolve,
				reject,
				timeout: timeoutHandle,
				method,
			});

			this.ws.send(this.protocol.createRequest(id, method, parseResult.data));
		});
	}

	/**
	 * Emit an event to the remote peer (fire-and-forget)
	 */
	emit<K extends StringKeys<InferEvents<TLocalSchema["events"]>>>(
		event: K,
		data: InferEvents<TLocalSchema["events"]>[K],
	): void {
		if (this.closed || this.ws.readyState !== 1) {
			console.warn(`Cannot emit event '${String(event)}': connection closed`);
			return;
		}

		const eventName = event;
		const eventDef = this.localSchema.events?.[eventName];
		if (!eventDef) {
			console.warn(`Unknown event '${eventName}'`);
			return;
		}

		// Validate data against schema
		const parseResult = eventDef.data.safeParse(data);
		if (!parseResult.success) {
			console.warn(`Invalid data for event '${eventName}':`, parseResult.error);
			return;
		}

		this.ws.send(this.protocol.createEvent(eventName, parseResult.data));
	}

	/**
	 * Handle an incoming WebSocket message
	 *
	 * Accepts string, ArrayBuffer, Uint8Array (including Node.js Buffer),
	 * or Uint8Array[] (for ws library's fragmented messages).
	 *
	 * @example
	 * ```ts
	 * // Works directly with ws library's message event
	 * ws.on("message", (data) => peer.handleMessage(data));
	 * ```
	 */
	handleMessage(data: WireInput): void {
		const message = this.protocol.safeDecodeMessage(data);
		if (!message) {
			console.error("Failed to parse RPC message");
			return;
		}

		switch (message.type) {
			case "rpc:request":
				void this.handleRequest(message);
				break;
			case "rpc:response":
				this.handleResponse(message);
				break;
			case "rpc:error":
				this.handleError(message);
				break;
			case "rpc:event":
				this.handleEvent(message);
				break;
		}
	}

	/**
	 * Handle an incoming RPC request
	 */
	private async handleRequest(request: RpcRequest): Promise<void> {
		const { id, method, params } = request;

		const methodDef = this.localSchema.methods?.[method];
		if (!methodDef) {
			this.sendError(
				id,
				RpcErrorCodes.METHOD_NOT_FOUND,
				`Method '${method}' not found`,
			);
			return;
		}

		// Validate input
		const parseResult = await methodDef.input.safeParseAsync(params);
		if (!parseResult.success) {
			this.sendError(
				id,
				RpcErrorCodes.INVALID_PARAMS,
				`Invalid params for '${method}'`,
				parseResult.error,
			);
			return;
		}

		// Get handler from provider
		const handler = this.provider[method as keyof typeof this.provider] as
			| ((input: unknown) => Promise<unknown>)
			| undefined;
		if (!handler) {
			this.sendError(
				id,
				RpcErrorCodes.METHOD_NOT_FOUND,
				`Method '${method}' not implemented`,
			);
			return;
		}

		try {
			// Call handler with correct `this` context
			const result = await handler.call(this.provider, parseResult.data);

			// Validate output
			const outputResult = await methodDef.output.safeParseAsync(result);
			if (!outputResult.success) {
				this.sendError(
					id,
					RpcErrorCodes.INTERNAL_ERROR,
					`Invalid output from '${method}'`,
					outputResult.error,
				);
				return;
			}

			this.ws.send(this.protocol.createResponse(id, outputResult.data));
		} catch (error) {
			const message = error instanceof Error ? error.message : "Unknown error";
			this.sendError(id, RpcErrorCodes.INTERNAL_ERROR, message);
		}
	}

	/**
	 * Handle an incoming RPC response
	 */
	private handleResponse(response: RpcResponse): void {
		const pending = this.pendingRequests.get(response.id);
		if (!pending) {
			console.warn(`Received response for unknown request: ${response.id}`);
			return;
		}

		clearTimeout(pending.timeout);
		this.pendingRequests.delete(response.id);
		pending.resolve(response.result);
	}

	/**
	 * Handle an incoming RPC error
	 */
	private handleError(error: RpcError): void {
		const pending = this.pendingRequests.get(error.id);
		if (!pending) {
			console.warn(`Received error for unknown request: ${error.id}`);
			return;
		}

		clearTimeout(pending.timeout);
		this.pendingRequests.delete(error.id);
		pending.reject(
			new RpcRemoteError(pending.method, error.code, error.message, error.data),
		);
	}

	/**
	 * Handle an incoming event
	 */
	private handleEvent(event: RpcEvent): void {
		if (!this.onEventHandler) {
			return;
		}

		const eventDef = this.remoteSchema.events?.[event.event];
		if (!eventDef) {
			console.warn(`Unknown event: ${event.event}`);
			return;
		}

		// Validate event data
		const parseResult = eventDef.data.safeParse(event.data);
		if (!parseResult.success) {
			console.warn(
				`Invalid data for event '${event.event}':`,
				parseResult.error,
			);
			return;
		}

		// Cast is safe because we validated against the schema
		(this.onEventHandler as (event: string, data: unknown) => void)(
			event.event,
			parseResult.data,
		);
	}

	/**
	 * Send an error response
	 */
	private sendError(
		id: string,
		code: number,
		message: string,
		data?: unknown,
	): void {
		if (this.ws.readyState !== 1) return;
		this.ws.send(this.protocol.createError(id, code, message, data));
	}

	/**
	 * Mark the peer as closed and reject all pending requests
	 */
	close(): void {
		this.closed = true;

		// Reject all pending requests
		for (const [, pending] of this.pendingRequests) {
			clearTimeout(pending.timeout);
			pending.reject(new RpcConnectionClosed());
		}
		this.pendingRequests.clear();
	}

	/**
	 * Check if the peer connection is open
	 */
	get isOpen(): boolean {
		return !this.closed && this.ws.readyState === 1;
	}

	/**
	 * Get the underlying WebSocket
	 *
	 * Use for advanced scenarios like DurableRpcPeer integration.
	 */
	getWebSocket(): IMinWebSocket {
		return this.ws;
	}

	/**
	 * Get the number of pending requests
	 */
	get pendingCount(): number {
		return this.pendingRequests.size;
	}
}
