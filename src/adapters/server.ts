/**
 * RPC Server Adapter
 *
 * Manages RpcPeer instances for incoming WebSocket connections.
 * Works with Node.js `ws`, Bun's native WebSocket, or any compatible server.
 */

import { RpcPeer } from "../peers/default.js";
import type { Provider, RpcSchema } from "../schema.js";
import {
	type IRpcOptions,
	type IWebSocket,
	type IWebSocketServer,
	WebSocketReadyState,
	type WebSocketServerOptions,
} from "../types.js";
import { MultiPeerBase } from "./multi-peer.js";
import type { IMultiAdapterHooks } from "./types.js";

/**
 * Options for creating an RpcServer
 */
export interface RpcServerOptions<
	TLocalSchema extends RpcSchema,
	TRemoteSchema extends RpcSchema,
> extends IRpcOptions<TLocalSchema, TRemoteSchema> {
	/** Implementation of local methods */
	provider: Provider<TLocalSchema["methods"]>;
	/** WebSocket server instance or options to create one */
	wss: IWebSocketServer | WebSocketServerOptions;
	/** WebSocket server constructor (required when passing options instead of server instance) */
	WebSocketServer?: new (
		options: WebSocketServerOptions,
	) => IWebSocketServer;
	/** Lifecycle hooks */
	hooks?: IMultiAdapterHooks<TLocalSchema, TRemoteSchema>;
}

/**
 * Create or return existing WebSocket server
 */
function createWebSocketServer(
	wss: IWebSocketServer | WebSocketServerOptions,
	WebSocketServer?: new (options: WebSocketServerOptions) => IWebSocketServer,
): IWebSocketServer {
	if ("on" in wss && typeof wss.on === "function") {
		return wss as IWebSocketServer;
	}
	if (!WebSocketServer) {
		throw new Error(
			"WebSocketServer constructor required when passing options",
		);
	}
	return new WebSocketServer(wss as WebSocketServerOptions);
}

/**
 * RPC Server
 *
 * Manages WebSocket server and client connections with RPC capabilities.
 *
 * @example
 * ```typescript
 * import { WebSocketServer } from "ws";
 * import { RpcServer } from "@igoforth/ws-rpc/adapters/server";
 *
 * const server = new RpcServer({
 *   wss: { port: 8080 },
 *   WebSocketServer,
 *   localSchema: ServerSchema,
 *   remoteSchema: ClientSchema,
 *   provider: {
 *     getUser: async ({ id }) => ({ name: "John", email: "john@example.com" }),
 *   },
 *   hooks: {
 *     onConnect: (peer) => {
 *       console.log(`Client ${peer.id} connected`);
 *       peer.driver.ping({}).then(console.log);
 *     },
 *     onDisconnect: (peer) => console.log(`Client ${peer.id} disconnected`),
 *   },
 * });
 *
 * // Emit to all clients
 * server.emit("orderUpdated", { orderId: "123", status: "shipped" });
 *
 * // Graceful shutdown
 * process.on("SIGTERM", () => server.close());
 * ```
 */
export class RpcServer<
	TLocalSchema extends RpcSchema,
	TRemoteSchema extends RpcSchema,
> extends MultiPeerBase<TLocalSchema, TRemoteSchema, IWebSocket> {
	private readonly wss: IWebSocketServer;

	constructor(options: RpcServerOptions<TLocalSchema, TRemoteSchema>) {
		super({
			localSchema: options.localSchema,
			remoteSchema: options.remoteSchema,
			provider: options.provider,
			...(options.timeout !== undefined && { timeout: options.timeout }),
			...(options.protocol !== undefined && { protocol: options.protocol }),
			...(options.hooks !== undefined && { hooks: options.hooks }),
		});

		this.wss = createWebSocketServer(options.wss, options.WebSocketServer);
		this.wss.on("connection", (ws) => this.handleConnection(ws));
		this.wss.on("error", (error) => this.hooks.onError?.(null, error));
		this.wss.on("close", () => this.hooks.onClose?.());
	}

	// =========================================================================
	// Connection Handling
	// =========================================================================

	private handleConnection(ws: IWebSocket): void {
		const peer = new RpcPeer({
			ws,
			localSchema: this.localSchema,
			remoteSchema: this.remoteSchema,
			provider: this.provider,
			...(this.protocol !== undefined && { protocol: this.protocol }),
			timeout: this.timeout,
			onEvent: (event, data) => {
				this.hooks.onEvent?.(peer, event, data);
			},
		});

		this.addPeer(ws, peer);

		ws.onmessage = (event) => {
			if (
				typeof event === "object" &&
				event != null &&
				"data" in event &&
				(typeof event.data === "string" || event.data instanceof ArrayBuffer)
			) {
				peer.handleMessage(event.data as string | ArrayBuffer);
			}
		};

		ws.onclose = () => {
			this.removePeer(ws);
		};

		ws.onerror = (event) => {
			const error =
				event instanceof Error
					? event
					: new Error(`WebSocket error for peer ${peer.id}`);
			this.hooks.onError?.(peer, error);
		};
	}

	// =========================================================================
	// Server-Specific Methods
	// =========================================================================

	/**
	 * Close a peer connection with WebSocket close code/reason
	 *
	 * @param id - Peer ID to close
	 * @param code - WebSocket close code (default: 1000)
	 * @param reason - Close reason message (default: "Server disconnect")
	 * @returns true if peer was found and closed, false otherwise
	 */
	override closePeer(
		id: string,
		code = 1000,
		reason = "Server disconnect",
	): boolean {
		const entry = this.findPeerEntry(id);
		if (entry) {
			if (entry.connection.readyState !== WebSocketReadyState.CLOSED) {
				entry.connection.close(code, reason);
			}
			return super.closePeer(id);
		}
		return false;
	}

	/**
	 * Close the server and all client connections
	 *
	 * @param callback - Optional callback invoked when server is closed
	 */
	close(callback?: (err?: Error) => void): void {
		for (const entry of this.getOpenEntries()) {
			if (entry.connection.readyState !== WebSocketReadyState.CLOSED) {
				entry.connection.close(1001, "Server shutdown");
			}
		}

		this.closeAll();
		this.wss.close(callback);
	}
}
