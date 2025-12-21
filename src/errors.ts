/**
 * RPC Error Classes
 *
 * Custom error types for RPC operations.
 */

import { RpcErrorCodes } from "./protocol.js";

/**
 * Base class for all RPC errors
 *
 * @param code - RPC error code (from RpcErrorCodes)
 * @param message - Human-readable error message
 * @param data - Optional additional error data
 */
export class RpcError extends Error {
	readonly code: number;
	readonly data?: unknown;

	constructor(code: number, message: string, data?: unknown) {
		super(message);
		this.name = "RpcError";
		this.code = code;
		this.data = data;
	}
}

/**
 * Thrown when an RPC request times out waiting for a response
 *
 * @param method - Name of the method that timed out
 * @param timeoutMs - Timeout duration in milliseconds
 */
export class RpcTimeoutError extends RpcError {
	readonly method: string;
	readonly timeoutMs: number;

	constructor(method: string, timeoutMs: number) {
		super(
			RpcErrorCodes.TIMEOUT,
			`RPC request '${method}' timed out after ${timeoutMs}ms`,
		);
		this.name = "RpcTimeoutError";
		this.method = method;
		this.timeoutMs = timeoutMs;
	}
}

/**
 * Thrown when the remote handler returns an error
 *
 * @param method - Name of the remote method that failed
 * @param code - RPC error code from the remote
 * @param message - Error message from the remote
 * @param data - Optional additional error data from the remote
 */
export class RpcRemoteError extends RpcError {
	readonly method: string;

	constructor(method: string, code: number, message: string, data?: unknown) {
		super(code, message, data);
		this.name = "RpcRemoteError";
		this.method = method;
	}
}

/**
 * Thrown when the WebSocket connection closes while a request is pending
 *
 * @param message - Optional custom message (defaults to "WebSocket connection closed")
 */
export class RpcConnectionClosed extends RpcError {
	constructor(message = "WebSocket connection closed") {
		super(RpcErrorCodes.CONNECTION_CLOSED, message);
		this.name = "RpcConnectionClosed";
	}
}

/**
 * Thrown when input or output validation fails
 *
 * @param message - Description of the validation failure
 * @param data - Optional Zod error or validation details
 */
export class RpcValidationError extends RpcError {
	constructor(message: string, data?: unknown) {
		super(RpcErrorCodes.VALIDATION_ERROR, message, data);
		this.name = "RpcValidationError";
	}
}

/**
 * Thrown when a requested method doesn't exist on the provider
 *
 * @param method - Name of the method that was not found
 */
export class RpcMethodNotFoundError extends RpcError {
	readonly method: string;

	constructor(method: string) {
		super(RpcErrorCodes.METHOD_NOT_FOUND, `Method '${method}' not found`);
		this.name = "RpcMethodNotFoundError";
		this.method = method;
	}
}
