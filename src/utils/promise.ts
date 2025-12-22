/**
 * Checks if a value is a Promise.
 */
export const isPromise = <T>(value: T | Promise<T>): value is Promise<T> =>
	value != null && typeof (value as any).then === "function";
