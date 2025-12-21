/**
 * @igoforth/ws-rpc
 *
 * Bidirectional RPC over WebSocket with Zod schema validation, TypeScript inference,
 * and Cloudflare Durable Object support.
 *
 * @example
 * ```ts
 * // Client
 * import { RpcClient } from "@igoforth/ws-rpc/adapters/client";
 *
 * const client = new RpcClient({
 *   url: "wss://example.com/ws",
 *   localSchema: ClientSchema,
 *   remoteSchema: ServerSchema,
 *   provider: { clientMethod: async (input) => { ... } },
 * });
 *
 * // Server (Cloudflare Durable Object)
 * import { withRpc } from "@igoforth/ws-rpc/adapters/cloudflare-do";
 *
 * class MyDO extends withRpc(Actor, {
 *   localSchema: ServerSchema,
 *   remoteSchema: ClientSchema,
 * }) { ... }
 * ```
 */

// Errors
export {
	RpcConnectionClosed,
	RpcError,
	RpcMethodNotFoundError,
	RpcRemoteError,
	RpcTimeoutError,
	RpcValidationError,
} from "./errors.js";
// Protocol
export {
	createProtocol,
	JsonProtocol,
	type RpcError as RpcErrorMessage,
	RpcErrorCodes,
	RpcErrorSchema,
	type RpcEvent,
	RpcEventSchema,
	type RpcMessage,
	RpcMessageCodec,
	RpcMessageSchema,
	type RpcProtocol,
	type RpcRequest,
	RpcRequestSchema,
	type RpcResponse,
	RpcResponseSchema,
	type RpcWireCodec,
} from "./protocol.js";
// Schema utilities
export {
	type Driver,
	type EventDef,
	type EventHandler,
	event,
	type InferEventData,
	type InferEvents,
	type InferInput,
	type InferMethods,
	type InferOutput,
	type MethodDef,
	method,
	type Provider,
	type RpcSchema,
} from "./schema.js";
// Storage
export {
	type AsyncPendingCallStorage,
	type MaybePromise,
	MemoryPendingCallStorage,
	type PendingCall,
	type PendingCallStorage,
	SqlPendingCallStorage,
	type StorageMode,
	type SyncPendingCallStorage,
} from "./storage/index.js";
// Core types and WebSocket interfaces
export {
	type IEventController,
	type IMethodController,
	type IMinWebSocket,
	type IRpcConnection,
	type IRpcOptions,
	type IWebSocket,
	type IWebSocketServer,
	type WebSocketOptions,
	WebSocketReadyState,
	type WebSocketServerOptions,
} from "./types.js";
// Utilities
export {
	calculateReconnectDelay,
	defaultReconnectOptions,
	type ReconnectOptions,
} from "./utils/index.js";
