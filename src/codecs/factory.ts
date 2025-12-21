/**
 * RPC Codecs
 *
 * Zod-based codecs for serialization with built-in validation.
 * Provides factories for creating codecs that encode to string or binary.
 *
 * @example
 * ```ts
 * // JSON codec with validation
 * const MyDataCodec = jsonCodec(MyDataSchema);
 * const encoded = MyDataCodec.encode(data); // string
 * const decoded = MyDataCodec.decode(encoded); // validated MyData
 *
 * // Safe decode with error handling
 * const result = MyDataCodec.safeDecode(encoded);
 * if (result.success) {
 *   console.log(result.data);
 * } else {
 *   console.error(result.error);
 * }
 * ```
 */

import * as z from "zod";
import type { LiteralStringUnion } from "../schema";

/**
 * Type alias for a Zod codec that encodes to string
 */
export type StringCodec<T extends z.ZodType = z.ZodType> = z.ZodCodec<
	z.ZodString,
	T
>;

/**
 * Type alias for a Zod codec that encodes to Uint8Array
 */
export type BinaryCodec<T extends z.ZodType = z.ZodType> = z.ZodCodec<
	z.ZodCustom<Uint8Array<ArrayBuffer>>,
	T
>;

// ZodCodec<ZodCustom<Uint8Array<ArrayBuffer>, Uint8Array<ArrayBuffer>>, T>;

/**
 * Options for codec factories
 */
export interface CodecOptions {
	/** Custom error message for parse failures */
	errorMessage?: string;
}

/**
 * Codec factory signature for custom serialization libraries
 *
 * Implement this interface to create codecs using libraries like
 * superjson, devalue, or MessagePack.
 */
export interface CodecFactory<TEncoded> {
	<T extends z.ZodType>(
		schema: T,
		options?: CodecOptions,
	): z.ZodCodec<
		string extends TEncoded ? z.ZodString : z.ZodCustom<TEncoded>,
		T
	>;
}

/**
 * Create a custom string codec factory
 *
 * Use this to integrate custom serialization libraries that encode to strings.
 *
 * @param serialize - Function to serialize a value to string
 * @param deserialize - Function to deserialize a string to a value
 * @param formatName - Name of the format for error messages
 * @returns A codec factory function
 *
 * @example
 * ```ts
 * import superjson from "superjson";
 *
 * const superJsonCodec = createStringCodecFactory(
 *   superjson.stringify,
 *   superjson.parse,
 *   "superjson"
 * );
 *
 * // Now supports Date, Map, Set, BigInt, etc.
 * const DataCodec = superJsonCodec(z.object({
 *   timestamp: z.date(),
 *   values: z.map(z.string(), z.number()),
 * }));
 * ```
 */
export function createStringCodecFactory(
	serialize: (value: unknown) => string,
	deserialize: (text: string) => unknown,
	formatName: LiteralStringUnion<z.core.$ZodStringFormats>,
): CodecFactory<string> {
	return <T extends z.ZodType>(
		schema: T,
		options?: CodecOptions,
	): StringCodec<T> => {
		return z.codec(z.string(), schema, {
			decode: (text, ctx) => {
				try {
					return deserialize(text) as z.util.MaybeAsync<z.input<T>>;
				} catch (err) {
					ctx.issues.push({
						code: "invalid_format",
						format: formatName,
						input: text,
						message:
							options?.errorMessage ??
							(err instanceof Error ? err.message : `Invalid ${formatName}`),
					});
					return z.NEVER;
				}
			},
			encode: (value) => serialize(value),
		});
	};
}

/**
 * Create a custom binary codec factory
 *
 * Use this to integrate binary serialization libraries like MessagePack or CBOR.
 *
 * @param serialize - Function to serialize a value to Uint8Array
 * @param deserialize - Function to deserialize a Uint8Array to a value
 * @param formatName - Name of the format for error messages
 * @returns A codec factory function
 *
 * @example
 * ```ts
 * import { encode, decode } from "@msgpack/msgpack";
 *
 * const msgpackCodec = createBinaryCodecFactory(
 *   (v) => new Uint8Array(encode(v)),
 *   decode,
 *   "msgpack"
 * );
 *
 * const DataCodec = msgpackCodec(MySchema);
 * const bytes = DataCodec.encode(data); // Uint8Array
 * const data = DataCodec.decode(bytes); // validated
 * ```
 */
export function createBinaryCodecFactory(
	serialize: (value: unknown) => Uint8Array<ArrayBuffer>,
	deserialize: (bytes: Uint8Array<ArrayBuffer>) => unknown,
	formatName: string,
): CodecFactory<Uint8Array<ArrayBuffer>> {
	return <T extends z.ZodType>(
		schema: T,
		options?: CodecOptions,
	): BinaryCodec<T> => {
		return z.codec(z.instanceof(Uint8Array), schema, {
			decode: (bytes, ctx) => {
				try {
					return deserialize(bytes) as z.util.MaybeAsync<z.input<T>>;
				} catch (err) {
					ctx.issues.push({
						code: "invalid_format",
						format: formatName,
						input: String(bytes),
						message:
							options?.errorMessage ??
							(err instanceof Error ? err.message : `Invalid ${formatName}`),
					});
					return z.NEVER;
				}
			},
			encode: (value) => serialize(value),
		});
	};
}

/**
 * Wire codec - either string or binary
 */
export type WireCodec<T extends z.ZodType = z.ZodType> =
	| StringCodec<T>
	| BinaryCodec<T>;

/**
 * Wire data - what gets sent over WebSocket
 */
export type WireData = string | Uint8Array<ArrayBuffer>;

/**
 * Helper to check if a codec encodes to string
 */
export function isStringCodec(
	codec: z.ZodCodec<z.ZodType, z.ZodType>,
): codec is StringCodec {
	// Check if the "from" schema accepts strings
	return codec._zod.def.in._zod.def.type === "string";
}

/**
 * Helper to check if a codec encodes to binary
 */
export function isBinaryCodec(
	codec: z.ZodCodec<z.ZodType, z.ZodType>,
): codec is BinaryCodec {
	return !isStringCodec(codec);
}
