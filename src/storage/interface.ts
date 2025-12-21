/**
 * Pending Call Storage Interface
 *
 * Abstraction for persisting RPC calls that need to survive hibernation.
 * Supports both sync (DO SQL/KV) and async (file, external KV) backends.
 */

import type { RpcSchema } from "../schema";

/**
 * A pending RPC call awaiting a response
 */
export interface PendingCall {
	/** Unique request ID */
	id: string;
	/** Remote method name */
	method: string;
	/** Serialized parameters */
	params: unknown;
	/** Method name on actor to call with response */
	callback: string;
	/** When the call was sent (Unix ms) */
	sentAt: number;
	/** When the call should timeout (Unix ms) */
	timeoutAt: number;
}

/**
 * Storage mode discriminant
 */
export type StorageMode = "sync" | "async";

/**
 * Conditional return type based on storage mode
 */
export type MaybePromise<T, TMode extends StorageMode> = TMode extends "sync"
	? T
	: Promise<T>;

/**
 * Pending call storage interface
 *
 * Generic over sync/async mode to preserve type information about
 * whether operations block or return promises.
 *
 * @typeParam TMode - 'sync' for synchronous storage (DO SQL/KV), 'async' for file/external
 */
export interface PendingCallStorage<TMode extends StorageMode = "async"> {
	/** Storage mode discriminant for runtime checks */
	readonly mode: TMode;

	/**
	 * Save a pending call
	 */
	save(call: PendingCall): MaybePromise<void, TMode>;

	/**
	 * Get a pending call by ID
	 */
	get(id: string): MaybePromise<PendingCall | null, TMode>;

	/**
	 * Delete a pending call by ID
	 */
	delete(id: string): MaybePromise<boolean, TMode>;

	/**
	 * List all calls that have exceeded their timeout
	 */
	listExpired(before: number): MaybePromise<PendingCall[], TMode>;

	/**
	 * List all pending calls (for debugging/recovery)
	 */
	listAll(): MaybePromise<PendingCall[], TMode>;

	/**
	 * Delete all pending calls (for cleanup)
	 */
	clear(): MaybePromise<void, TMode>;
}

/**
 * Convenience alias for synchronous storage (DO SQL/KV)
 */
export type SyncPendingCallStorage = PendingCallStorage<"sync">;

/**
 * Convenience alias for asynchronous storage (file, external KV)
 */
export type AsyncPendingCallStorage = PendingCallStorage<"async">;

export interface IContinuationHandler<TRemoteSchema extends RpcSchema> {
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
		callback: keyof this & string,
		timeout?: number,
	): void;

	/**
	 * Get all pending durable calls (for debugging/monitoring)
	 */
	getPendingCalls(): PendingCall[];

	/**
	 * Get expired calls that have exceeded their timeout
	 */
	getExpiredCalls(): PendingCall[];

	/**
	 * Clean up expired calls
	 *
	 * Call this periodically (e.g., on alarm) to remove stale calls.
	 * Returns the expired calls for optional error handling.
	 */
	cleanupExpired(): PendingCall[];

	/**
	 * Clear all pending durable calls
	 */
	clearPendingCalls(): void;
}
