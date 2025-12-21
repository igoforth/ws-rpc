/**
 * Core RPC Type Definitions
 *
 * Shared interfaces for RPC options, method handling, event control,
 * and platform-agnostic WebSocket abstractions.
 */

import type { RpcProtocol, WireInput } from "./protocol";
import type { EventEmitter, EventHandler, Provider, RpcSchema } from "./schema";

// =============================================================================
// WebSocket Interfaces (Platform-Agnostic)
// =============================================================================

/**
 * WebSocket ready state constants type
 */
export interface WebSocketReadyState {
	CONNECTING: 0;
	OPEN: 1;
	CLOSING: 2;
	CLOSED: 3;
}

/**
 * WebSocket ready states
 */
export const WebSocketReadyState: WebSocketReadyState = {
	CONNECTING: 0,
	OPEN: 1,
	CLOSING: 2,
	CLOSED: 3,
} as const;

/**
 * Minimal WebSocket interface for sending and receiving
 */
export interface IMinWebSocket {
	send(data: string | ArrayBuffer | Uint8Array): void;
	close(code?: number, reason?: string): void;
	readonly readyState: number;
}

/**
 * Extended WebSocket interface with events
 */
export interface IWebSocket extends IMinWebSocket {
	send(data: string | ArrayBuffer): void;
	addEventListener?(
		type: "open" | "close" | "message" | "error",
		listener: (event: unknown) => void,
	): void;
	removeEventListener?(
		type: "open" | "close" | "message" | "error",
		listener: (event: unknown) => void,
	): void;
	onopen?: ((event: unknown) => void) | null;
	onclose?: ((event: unknown) => void) | null;
	onmessage?: ((event: unknown) => void) | null;
	onerror?: ((event: unknown) => void) | null;
}

/**
 * WebSocket constructor options (Bun-compatible)
 */
export interface WebSocketOptions {
	protocols?: string | string[];
	headers?: Record<string, string>;
}

/**
 * Minimal WebSocket server interface
 */
export interface IWebSocketServer {
	on(event: "connection", listener: (ws: IWebSocket) => void): this;
	on(event: "close", listener: () => void): this;
	on(event: "error", listener: (error: Error) => void): this;
	close(callback?: (err?: Error) => void): void;
}

/**
 * WebSocket server constructor options
 */
export interface WebSocketServerOptions {
	port?: number;
	host?: string;
	path?: string;
	server?: unknown;
	noServer?: boolean;
}

// =============================================================================
// RPC Core Interfaces
// =============================================================================

/**
 * Base RPC Options used across Peers and Adapters
 */
export interface IRpcOptions<
	TLocalSchema extends RpcSchema,
	TRemoteSchema extends RpcSchema,
> {
	/** Schema defining local methods we implement */
	readonly localSchema: TLocalSchema;
	/** Schema defining remote methods we can call */
	readonly remoteSchema: TRemoteSchema;
	/** Default timeout for RPC calls in ms */
	readonly timeout?: number;
	/**
	 * Protocol for encoding/decoding messages.
	 * Defaults to JSON. Use createProtocol() with a binary codec for better performance.
	 */
	readonly protocol?: RpcProtocol;
}

/**
 * Interface for types that provide RPC method implementations
 *
 * @typeParam TLocalSchema - Schema defining local methods
 */
export interface IMethodController<TLocalSchema extends RpcSchema> {
	/** Implementation of local methods */
	readonly provider: Provider<TLocalSchema>;
}

/**
 * Interface for types that can emit and receive events
 *
 * @typeParam TLocalSchema - Schema defining local events we can emit
 * @typeParam TRemoteSchema - Schema defining remote events we receive
 * @typeParam EmitArgs - Additional arguments for emit (e.g., peer IDs)
 * @typeParam EventArgs - Additional arguments for event handler
 */
export interface IEventController<
	TLocalSchema extends RpcSchema,
	TRemoteSchema extends RpcSchema,
	EmitArgs extends any[] = [],
	EventArgs extends any[] = [],
> {
	/** Emit an event to the connected peer */
	emit: EventEmitter<TLocalSchema, EmitArgs>;

	/** Called when receiving an event from the connected peer */
	onEvent?: EventHandler<TRemoteSchema, EventArgs>;
}

/**
 * Base interface for RPC connections (1-1)
 *
 * Implemented by RpcPeer.
 */
export interface IRpcConnection<
	TLocalSchema extends RpcSchema,
	TRemoteSchema extends RpcSchema,
> extends IRpcOptions<TLocalSchema, TRemoteSchema>,
		IMethodController<TLocalSchema>,
		IEventController<TLocalSchema, TRemoteSchema> {
	/** Timeout for RPC calls in ms */
	readonly timeout: number;

	/** Handle an incoming WebSocket message */
	handleMessage(data: WireInput): void;
}
