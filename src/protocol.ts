/**
 * Wire Protocol Definitions
 *
 * Defines the message format for bidirectional RPC over WebSocket.
 * Messages can be JSON-encoded (string) or binary-encoded (Uint8Array).
 */

import * as z from "zod";
import {
	createJsonCodec,
	isStringCodec,
	type WireCodec,
} from "./codecs/index.js";

/**
 * RPC Request - sent when calling a remote method
 */
export const RpcRequestSchema = z.object({
	type: z.literal("rpc:request"),
	id: z.string(),
	method: z.string(),
	params: z.unknown(),
});
export type RpcRequest = z.infer<typeof RpcRequestSchema>;

/**
 * RPC Response - sent as success response to a request
 */
export const RpcResponseSchema = z.object({
	type: z.literal("rpc:response"),
	id: z.string(),
	result: z.unknown(),
});
export type RpcResponse = z.infer<typeof RpcResponseSchema>;

/**
 * RPC Error - sent when a request fails
 */
export const RpcErrorSchema = z.object({
	type: z.literal("rpc:error"),
	id: z.string(),
	code: z.number(),
	message: z.string(),
	data: z.unknown().optional(),
});
export type RpcError = z.infer<typeof RpcErrorSchema>;

/**
 * RPC Event - fire-and-forget event (no response expected)
 */
export const RpcEventSchema = z.object({
	type: z.literal("rpc:event"),
	event: z.string(),
	data: z.unknown(),
});
export type RpcEvent = z.infer<typeof RpcEventSchema>;

/**
 * Union of all RPC message types
 */
export const RpcMessageSchema = z.union([
	RpcRequestSchema,
	RpcResponseSchema,
	RpcErrorSchema,
	RpcEventSchema,
]);
export type RpcMessage = z.infer<typeof RpcMessageSchema>;

/**
 * Standard RPC error codes (JSON-RPC 2.0 compatible)
 */
export const RpcErrorCodes = {
	PARSE_ERROR: -32700,
	INVALID_REQUEST: -32600,
	METHOD_NOT_FOUND: -32601,
	INVALID_PARAMS: -32602,
	INTERNAL_ERROR: -32603,
	// Custom codes (-32000 to -32099 reserved for implementation-defined errors)
	TIMEOUT: -32000,
	CONNECTION_CLOSED: -32001,
	VALIDATION_ERROR: -32002,
} as const;

/**
 * Default JSON codec for RPC messages
 *
 * Encodes RPC messages to JSON strings with validation on decode.
 *
 * @example
 * ```ts
 * // Encode a message
 * const json = RpcMessageCodec.encode(createRequest("1", "ping", {}));
 *
 * // Decode and validate
 * const message = RpcMessageCodec.decode(json);
 * ```
 */
export const RpcMessageCodec = createJsonCodec(RpcMessageSchema);

/**
 * Type alias for RPC wire codecs
 *
 * Wire codecs can encode to string (text frames) or Uint8Array (binary frames).
 */
export type RpcWireCodec = WireCodec<typeof RpcMessageSchema>;

/**
 * Wire data type - inferred from codec
 */
type WireDataOf<T extends RpcWireCodec> =
	T extends z.ZodCodec<infer A>
		? A extends z.ZodType<infer V>
			? V
			: never
		: never;

/**
 * Wire data type - inferred from codec
 */
type WireInputOf<T extends RpcWireCodec> =
	T extends z.ZodCodec<any, infer B>
		? B extends z.ZodType<infer V>
			? V
			: never
		: never;

/**
 * Wire input types accepted by decode methods
 *
 * Includes Node.js ws library's RawData type (Buffer | ArrayBuffer | Buffer[])
 * for seamless integration with the ws package.
 */
export type WireInput = string | ArrayBuffer | Uint8Array | Uint8Array[];

/**
 * Protocol interface returned by createProtocol
 */
export interface RpcProtocol<TWire extends RpcWireCodec = RpcWireCodec> {
	/** The underlying codec */
	readonly codec: TWire;

	/** Create and encode an RPC request */
	createRequest(id: string, method: string, params: unknown): WireDataOf<TWire>;

	/** Create and encode an RPC response */
	createResponse(id: string, result: unknown): WireDataOf<TWire>;

	/** Create and encode an RPC error */
	createError(
		id: string,
		code: number,
		message: string,
		data?: unknown,
	): WireDataOf<TWire>;

	/** Create and encode an RPC event */
	createEvent(event: string, data: unknown): WireDataOf<TWire>;

	/**
	 * Decode wire data to an RPC message (throws on invalid)
	 *
	 * Accepts string, ArrayBuffer, Uint8Array (including Node.js Buffer),
	 * or Uint8Array[] (for ws library's fragmented messages).
	 */
	decodeMessage(data: WireInput): RpcMessage;

	/**
	 * Safely decode wire data (returns null on invalid)
	 *
	 * Accepts string, ArrayBuffer, Uint8Array (including Node.js Buffer),
	 * or Uint8Array[] (for ws library's fragmented messages).
	 */
	safeDecodeMessage(data: WireInput): RpcMessage | null;
}

/**
 * Create a protocol instance with bound encode/decode functions
 *
 * @param codec - Wire codec for serialization (defaults to JSON)
 * @returns Protocol object with pre-bound encode/decode methods
 *
 * @example
 * ```ts
 * // JSON protocol (default)
 * const protocol = createProtocol();
 *
 * // MessagePack protocol
 * import { createMsgpackCodec } from "@igoforth/ws-rpc/codecs/msgpack";
 * const protocol = createProtocol(createMsgpackCodec(RpcMessageSchema));
 *
 * // Use in peer
 * const wire = protocol.createRequest("1", "ping", {});
 * ws.send(wire); // string or Uint8Array depending on codec
 *
 * const message = protocol.decodeMessage(event.data);
 * ```
 */
export function createProtocol<
	TWire extends RpcWireCodec = typeof RpcMessageCodec,
>(codec: TWire = RpcMessageCodec as TWire): RpcProtocol<TWire> {
	const isString = isStringCodec(codec);
	const textDecoder = new TextDecoder();
	const textEncoder = new TextEncoder();

	/**
	 * Normalize input for the codec type.
	 * String codecs need string input (decode ArrayBuffer via TextDecoder).
	 * Binary codecs need Uint8Array input.
	 *
	 * Handles ws library's RawData (Buffer | ArrayBuffer | Buffer[]):
	 * - Buffer extends Uint8Array, so it's handled as Uint8Array
	 * - Buffer[] (fragmented messages) are concatenated
	 */
	const normalizeInput = (data: WireInput): string | Uint8Array => {
		// Handle Uint8Array[] (ws fragmented messages) first
		if (Array.isArray(data)) {
			const totalLength = data.reduce((sum, buf) => sum + buf.byteLength, 0);
			const result = new Uint8Array(totalLength);
			let offset = 0;
			for (const buf of data) {
				result.set(buf, offset);
				offset += buf.byteLength;
			}
			// Now decode the concatenated buffer
			return isString ? textDecoder.decode(result) : result;
		}

		if (isString) {
			// String codec - decode binary to string if needed
			if (typeof data === "string") return data;
			if (data instanceof ArrayBuffer) {
				return textDecoder.decode(data);
			}
			// Uint8Array (including Node.js Buffer)
			return textDecoder.decode(data);
		}

		// Binary codec - convert to Uint8Array
		if (typeof data === "string") {
			return textEncoder.encode(data);
		}
		if (data instanceof ArrayBuffer) {
			return new Uint8Array(data);
		}
		// Uint8Array (including Node.js Buffer) - return as-is
		return data;
	};

	return {
		codec,

		createRequest(id, method, params) {
			return codec.encode({
				type: "rpc:request",
				id,
				method,
				params,
			}) as WireDataOf<TWire>;
		},

		createResponse(id, result) {
			return codec.encode({
				type: "rpc:response",
				id,
				result,
			}) as WireDataOf<TWire>;
		},

		createError(id, code, message, data) {
			return codec.encode({
				type: "rpc:error",
				id,
				code,
				message,
				data,
			}) as WireDataOf<TWire>;
		},

		createEvent(event, data) {
			return codec.encode({
				type: "rpc:event",
				event,
				data,
			}) as WireDataOf<TWire>;
		},

		decodeMessage(data) {
			return codec.decode(normalizeInput(data) as WireInputOf<TWire>);
		},

		safeDecodeMessage(data) {
			try {
				return codec.decode(normalizeInput(data) as WireInputOf<TWire>);
			} catch {
				return null;
			}
		},
	};
}

/**
 * Default JSON protocol instance
 *
 * Pre-configured with JSON codec for convenience.
 */
export const JsonProtocol = createProtocol(RpcMessageCodec);
