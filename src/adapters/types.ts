/**
 * Adapter Type Definitions
 *
 * Common interfaces and types for WebSocket adapters.
 */

import type { RpcPeer } from "../peers/default.js";
import type {
	Driver,
	EventDef,
	EventHandler,
	InferInput,
	InferOutput,
	MethodDef,
	RpcSchema,
	StringKeys,
} from "../schema.js";
import type {
	IEventController,
	IMethodController,
	IRpcOptions,
} from "../types.js";

// =============================================================================
// Multi-Connection Adapter Types
// =============================================================================

/**
 * Options for driver method calls on multi-connection adapters
 */
export interface MultiCallOptions {
	/** Connection ID(s) to call. If omitted, calls all connections. */
	ids?: string | string[];
	/** Request timeout in milliseconds */
	timeout?: number;
}

/**
 * Result of a driver method call on a multi-connection adapter
 *
 * Each result contains the peer ID and either a success value or an error.
 *
 * @typeParam T - The expected return type of the remote method
 *
 * @example
 * ```ts
 * const results = await server.driver.ping({});
 * for (const { id, result } of results) {
 *   if (result.success) {
 *     console.log(`Peer ${id} responded:`, result.value);
 *   } else {
 *     console.error(`Peer ${id} failed:`, result.error);
 *   }
 * }
 * ```
 */
export type MultiCallResult<T> = {
	/** Peer ID that this result is from */
	id: string;
	/** Success or failure result */
	result: { success: true; value: T } | { success: false; error: Error };
};

/**
 * Driver type for multi-connection adapters
 *
 * Methods accept an optional second argument with `ids` and `timeout`.
 * Returns an array of results, one per connection called.
 *
 * @typeParam TRemoteSchema - Schema defining the remote methods available
 *
 * @example
 * ```ts
 * // Call all connected peers
 * const allResults = await server.driver.getData({});
 *
 * // Call specific peer by ID
 * const oneResult = await server.driver.getData({}, { ids: "peer-123" });
 *
 * // Call multiple peers with timeout
 * const someResults = await server.driver.getData({}, {
 *   ids: ["peer-1", "peer-2"],
 *   timeout: 5000,
 * });
 * ```
 */
export type MultiDriver<TRemoteSchema extends RpcSchema> =
	TRemoteSchema["methods"] extends Record<string, MethodDef>
		? {
				[K in StringKeys<TRemoteSchema["methods"]>]: <
					O extends MultiCallOptions,
				>(
					input: TRemoteSchema["methods"] extends Record<string, MethodDef>
						? InferInput<TRemoteSchema["methods"][K]>
						: never,
					options?: O,
				) => Promise<
					O extends { ids: infer I }
						? string extends I
							? MultiCallResult<
									TRemoteSchema["methods"] extends Record<string, MethodDef>
										? InferOutput<TRemoteSchema["methods"][K]>
										: never
								>
							: Array<
									MultiCallResult<
										TRemoteSchema["methods"] extends Record<string, MethodDef>
											? InferOutput<TRemoteSchema["methods"][K]>
											: never
									>
								>
						: never
				>;
			}
		: never;

/**
 * Event emitter type for client callbacks
 */
export interface IAdapterHooks<
	TRemoteEvents extends Record<string, EventDef> | undefined,
> {
	/** Called when WebSocket connection opens */
	onConnect?(): void;

	/** Called when WebSocket connection closes */
	onDisconnect?(code: number, reason: string): void;

	/** Called when attempting to reconnect */
	onReconnect?(attempt: number, delay: number): void;

	/** Called when reconnection fails after max attempts */
	onReconnectFailed?(): void;

	/** Called when receiving an event from the server */
	onEvent?: EventHandler<TRemoteEvents>;
}

export interface IMultiAdapterHooks<
	TLocalSchema extends RpcSchema,
	TRemoteSchema extends RpcSchema,
> {
	/** Called when a peer connects */
	onConnect?(peer: RpcPeer<TLocalSchema, TRemoteSchema>): void;

	/** Called when a peer disconnects */
	onDisconnect?(peer: RpcPeer<TLocalSchema, TRemoteSchema>): void;

	/** Called when an event is received from a peer */
	onEvent?: EventHandler<
		TRemoteSchema["events"],
		[peer: RpcPeer<TLocalSchema, TRemoteSchema>]
	>;

	/** Called when a peer encounters an error */
	onError?(
		peer: RpcPeer<TLocalSchema, TRemoteSchema> | null,
		error: Error,
	): void;

	onClose?(): void;
}

export interface IConnectionAdapter<
	TLocalSchema extends RpcSchema,
	TRemoteSchema extends RpcSchema,
> extends IRpcOptions<TLocalSchema, TRemoteSchema>,
		IMethodController<TLocalSchema["methods"]>,
		IEventController<TLocalSchema["events"], TRemoteSchema["events"]> {
	/** Driver for calling remote methods on connected peer */
	readonly driver: Driver<TRemoteSchema["methods"]>;

	readonly hooks: IAdapterHooks<TRemoteSchema["events"]>;
}

/**
 * Interface for adapters that manage multiple connections
 *
 * Extends IRpcConnection - `emit()` broadcasts to all connected peers.
 * Implemented by RpcServer and Cloudflare DO adapter.
 */
export interface IMultiConnectionAdapter<
	TLocalSchema extends RpcSchema,
	TRemoteSchema extends RpcSchema,
> extends IRpcOptions<TLocalSchema, TRemoteSchema>,
		IMethodController<TLocalSchema["methods"]>,
		IEventController<
			TLocalSchema["events"],
			TRemoteSchema["events"],
			[ids?: string[]]
		> {
	/** Driver for calling remote methods on connected peers */
	readonly driver: MultiDriver<TRemoteSchema>;

	readonly hooks: IMultiAdapterHooks<TLocalSchema, TRemoteSchema>;

	/** Get count of connected peers */
	getConnectionCount(): number;

	/** Get all connected peer IDs */
	getConnectionIds(): string[];
}

// Re-export reconnection utilities from utils
export {
	calculateReconnectDelay,
	defaultReconnectOptions,
	type ReconnectOptions,
} from "../utils/reconnect.js";
