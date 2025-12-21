/**
 * Reconnection Utilities
 *
 * Exponential backoff with jitter for client-side reconnection.
 */

/**
 * Options for client-side reconnection
 */
export interface ReconnectOptions {
	/** Initial delay before first reconnect attempt (ms) */
	initialDelay?: number;
	/** Maximum delay between reconnect attempts (ms) */
	maxDelay?: number;
	/** Multiplier for exponential backoff */
	backoffMultiplier?: number;
	/** Maximum number of reconnect attempts (0 = unlimited) */
	maxAttempts?: number;
	/** Jitter factor (0-1) to randomize delays */
	jitter?: number;
}

/**
 * Default reconnection options
 */
export const defaultReconnectOptions: Required<ReconnectOptions> = {
	initialDelay: 1000,
	maxDelay: 30000,
	backoffMultiplier: 2,
	maxAttempts: 0,
	jitter: 0.1,
};

/**
 * Calculate delay for reconnection attempt with exponential backoff
 *
 * @param attempt - Reconnection attempt number (0-indexed)
 * @param options - Reconnection options including backoff multiplier and max delay
 * @returns Delay in milliseconds before the next reconnection attempt
 */
export function calculateReconnectDelay(
	attempt: number,
	options: Required<ReconnectOptions>,
): number {
	const baseDelay = Math.min(
		options.initialDelay * Math.pow(options.backoffMultiplier, attempt),
		options.maxDelay,
	);
	const jitter = baseDelay * options.jitter * (Math.random() * 2 - 1);
	return Math.max(0, baseDelay + jitter);
}
