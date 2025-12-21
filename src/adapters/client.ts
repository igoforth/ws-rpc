/**
 * RPC Client Adapter
 *
 * WebSocket client with auto-reconnect for Node.js/Bun environments.
 * Wraps RpcPeer with connection management.
 */

import type { Constructor } from "type-fest";
import { RpcPeer } from "../peers/default.js";
import type { RpcProtocol, WireInput } from "../protocol.js";
import type {
	Driver,
	InferEvents,
	Provider,
	RpcSchema,
	StringKeys,
} from "../schema.js";
import {
	type IRpcOptions,
	type IWebSocket,
	type WebSocketOptions,
	WebSocketReadyState,
} from "../types.js";
import {
	calculateReconnectDelay,
	defaultReconnectOptions,
	type IAdapterHooks,
	type IConnectionAdapter,
	type ReconnectOptions,
} from "./types.js";

/**
 * Options for creating an RpcClient
 */
export interface RpcClientOptions<
	TLocalSchema extends RpcSchema,
	TRemoteSchema extends RpcSchema,
> extends IAdapterHooks<TRemoteSchema["events"]>,
		IRpcOptions<TLocalSchema, TRemoteSchema> {
	/** WebSocket URL to connect to */
	url: string;
	/** Implementation of local methods */
	provider: Provider<TLocalSchema["methods"]>;
	/** Auto-reconnect options (set to false to disable) */
	reconnect?: ReconnectOptions | false;
	/** Automatically connect when client is created (default: false) */
	autoConnect?: boolean;
	/** WebSocket subprotocols */
	protocols?: string | string[];
	/** HTTP headers for WebSocket upgrade request (Bun/Node.js only) */
	headers?: Record<string, string>;
	/** Custom WebSocket constructor (defaults to global WebSocket) */
	WebSocket?: new (
		url: string,
		options?: string | string[] | WebSocketOptions,
	) => IWebSocket;
}

/**
 * Connection state
 */
export type ConnectionState =
	| "disconnected"
	| "connecting"
	| "connected"
	| "reconnecting";

/**
 * RPC Client with auto-reconnect
 *
 * Manages WebSocket connection lifecycle and provides RPC capabilities.
 */
export class RpcClient<
	TLocalSchema extends RpcSchema,
	TRemoteSchema extends RpcSchema,
> implements IConnectionAdapter<TLocalSchema, TRemoteSchema>
{
	readonly localSchema: TLocalSchema;
	readonly remoteSchema: TRemoteSchema;
	readonly timeout: number;
	readonly protocol?: RpcProtocol;
	readonly provider: Provider<TLocalSchema["methods"]>;
	readonly hooks: IAdapterHooks<TRemoteSchema["events"]> = {};

	private readonly reconnectOptions: Required<ReconnectOptions> | false;
	private readonly createWebSocket: () => IWebSocket;

	// Connection state
	private ws: IWebSocket | null = null;
	private peer: RpcPeer<TLocalSchema, TRemoteSchema> | null = null;
	private _state: ConnectionState = "disconnected";
	private reconnectAttempt = 0;
	private reconnectTimeout: ReturnType<typeof setTimeout> | null = null;
	private intentionalClose = false;

	constructor(options: RpcClientOptions<TLocalSchema, TRemoteSchema>) {
		this.localSchema = options.localSchema;
		this.remoteSchema = options.remoteSchema;
		this.timeout = options.timeout ?? 30000;
		if (options.protocol) this.protocol = options.protocol;

		this.provider = options.provider;
		this.reconnectOptions =
			options.reconnect === false
				? false
				: { ...defaultReconnectOptions, ...options.reconnect };

		// Create WebSocket factory capturing connection options
		const url = options.url;
		const protocols = options.protocols;
		const headers = options.headers;
		const WebSocketImpl =
			options.WebSocket ?? (globalThis.WebSocket as Constructor<IWebSocket>);

		this.createWebSocket = () => {
			const wsOptions = headers
				? { headers, ...(protocols && { protocols }) }
				: protocols;
			return new WebSocketImpl(url, wsOptions);
		};

		if (options.onConnect) this.hooks.onConnect = options.onConnect;
		if (options.onDisconnect) this.hooks.onDisconnect = options.onDisconnect;
		if (options.onReconnect) this.hooks.onReconnect = options.onReconnect;
		if (options.onReconnectFailed)
			this.hooks.onReconnectFailed = options.onReconnectFailed;
		if (options.onEvent) this.hooks.onEvent = options.onEvent;

		if (options.autoConnect) void this.connect();
	}

	/**
	 * Current connection state
	 */
	get state(): ConnectionState {
		return this._state;
	}

	/**
	 * Whether the client is currently connected
	 */
	get isConnected(): boolean {
		return this._state === "connected" && this.peer?.isOpen === true;
	}

	/**
	 * Get the driver for calling remote methods
	 *
	 * @returns Driver proxy for calling remote methods
	 * @throws Error if not connected
	 */
	get driver(): Driver<TRemoteSchema["methods"]> {
		if (!this.peer) {
			throw new Error("Not connected - call connect() first");
		}
		return this.peer.driver;
	}

	/**
	 * Emit an event to the server (fire-and-forget)
	 *
	 * @param event - Event name from local schema
	 * @param data - Event data matching the schema
	 */
	emit<K extends StringKeys<InferEvents<TLocalSchema["events"]>>>(
		event: K,
		data: InferEvents<TLocalSchema["events"]>[K],
	): void {
		if (!this.peer) {
			console.warn(`Cannot emit event '${String(event)}': not connected`);
			return;
		}
		this.peer.emit(event, data);
	}

	/**
	 * Connect to the WebSocket server
	 *
	 * @returns Promise that resolves when connected
	 * @throws Error if connection fails
	 */
	async connect(): Promise<void> {
		if (this._state === "connected" || this._state === "connecting") {
			return;
		}

		this.intentionalClose = false;
		this._state = "connecting";

		return new Promise<void>((resolve, reject) => {
			try {
				this.ws = this.createWebSocket();
			} catch (error) {
				this._state = "disconnected";
				reject(error);
				return;
			}

			const onOpen = () => {
				cleanup();
				this.handleOpen();
				resolve();
			};

			const onError = (event: unknown) => {
				cleanup();
				this._state = "disconnected";
				reject(new Error(`WebSocket connection failed: ${event}`));
			};

			const onClose = (event: unknown) => {
				cleanup();
				this._state = "disconnected";
				const code =
					typeof event === "object" && event != null && "code" in event
						? event.code
						: "Unknown code";
				const reason =
					typeof event === "object" && event != null && "reason" in event
						? event.reason
						: "Unknown reason";
				reject(new Error(`WebSocket closed: ${code} ${reason}`));
			};

			const cleanup = () => {
				this.ws?.removeEventListener?.("open", onOpen);
				this.ws?.removeEventListener?.("error", onError);
				this.ws?.removeEventListener?.("close", onClose);
			};

			this.ws.addEventListener?.("open", onOpen);
			this.ws.addEventListener?.("error", onError);
			this.ws.addEventListener?.("close", onClose);
		});
	}

	/**
	 * Disconnect from the server
	 *
	 * @param code - WebSocket close code (default: 1000)
	 * @param reason - Close reason message (default: "Client disconnect")
	 */
	disconnect(code = 1000, reason = "Client disconnect"): void {
		this.intentionalClose = true;
		this.cancelReconnect();

		if (this.peer) {
			this.peer.close();
			this.peer = null;
		}

		if (this.ws && this.ws.readyState !== WebSocketReadyState.CLOSED) {
			this.ws.close(code, reason);
		}
		this.ws = null;

		this._state = "disconnected";
	}

	/**
	 * Handle WebSocket open event
	 */
	private handleOpen(): void {
		if (!this.ws) return;

		this._state = "connected";
		this.reconnectAttempt = 0;

		// Create RPC peer
		this.peer = new RpcPeer({
			ws: this.ws,
			localSchema: this.localSchema,
			remoteSchema: this.remoteSchema,
			provider: this.provider,
			...(this.protocol !== undefined && { protocol: this.protocol }),
			onEvent: this.hooks.onEvent,
			timeout: this.timeout,
		});

		// Set up WebSocket event handlers
		this.ws.onmessage = (event) => {
			if (typeof event === "object" && event != null && "data" in event)
				this.peer?.handleMessage(event.data as WireInput);
			else
				throw new Error(
					`Received invalid event type in RpcClient.ws.onmessage ${JSON.stringify(event)}`,
				);
		};

		this.ws.onclose = (event) => {
			if (
				typeof event === "object" &&
				event != null &&
				"code" in event &&
				"reason" in event &&
				typeof event.code === "number" &&
				typeof event.reason === "string"
			)
				this.handleClose(event.code, event.reason);
			else
				throw new Error(
					`Received invalid event type in RpcClient.ws.onclose ${JSON.stringify(event)}`,
				);
		};

		this.ws.onerror = (event) => {
			console.error("WebSocket error:", event);
		};

		this.hooks.onConnect?.();
	}

	/**
	 * Handle WebSocket close event
	 */
	private handleClose(code: number, reason: string): void {
		this.peer?.close();
		this.peer = null;
		this.ws = null;

		this.hooks.onDisconnect?.(code, reason);

		if (this.intentionalClose) {
			this._state = "disconnected";
			return;
		}

		// Attempt reconnection
		if (this.reconnectOptions !== false) {
			this.scheduleReconnect();
		} else {
			this._state = "disconnected";
		}
	}

	/**
	 * Schedule a reconnection attempt
	 */
	private scheduleReconnect(): void {
		if (this.reconnectOptions === false) return;

		const { maxAttempts } = this.reconnectOptions;
		if (maxAttempts > 0 && this.reconnectAttempt >= maxAttempts) {
			this._state = "disconnected";
			this.hooks.onReconnectFailed?.();
			return;
		}

		this._state = "reconnecting";
		const delay = calculateReconnectDelay(
			this.reconnectAttempt,
			this.reconnectOptions,
		);
		this.reconnectAttempt++;

		this.hooks.onReconnect?.(this.reconnectAttempt, delay);

		this.reconnectTimeout = setTimeout(() => {
			this.reconnectTimeout = null;
			void this.attemptReconnect();
		}, delay);
	}

	/**
	 * Attempt to reconnect
	 */
	private async attemptReconnect(): Promise<void> {
		try {
			await this.connect();
		} catch {
			// connect() failed during reconnection - schedule another attempt
			if (!this.intentionalClose && this.reconnectOptions !== false) {
				this.scheduleReconnect();
			}
		}
	}

	/**
	 * Cancel any pending reconnection
	 */
	private cancelReconnect(): void {
		if (this.reconnectTimeout) {
			clearTimeout(this.reconnectTimeout);
			this.reconnectTimeout = null;
		}
	}
}
