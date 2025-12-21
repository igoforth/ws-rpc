/**
 * JSON Codec
 *
 * String-based codec using native JSON serialization.
 * Suitable for simple data types (no Date, Map, Set, BigInt support).
 *
 * @example
 * ```ts
 * import { createJsonCodec } from "@igoforth/ws-rpc/codecs";
 *
 * const UserCodec = createJsonCodec(z.object({
 *   id: z.string(),
 *   name: z.string(),
 * }));
 *
 * const encoded = UserCodec.encode({ id: "1", name: "John" });
 * const decoded = UserCodec.decode(encoded);
 * ```
 */
import * as z from "zod";
import { createStringCodecFactory } from "./factory";

/**
 * Factory for creating JSON codecs with Zod schema validation
 *
 * @param schema - Zod schema for validation
 * @param options - Optional codec configuration
 * @returns A codec that encodes to JSON string and validates on decode
 */
export const createJsonCodec = createStringCodecFactory(
	JSON.stringify,
	JSON.parse,
	"json_string",
);

/**
 * Default JSON codec for unknown values
 *
 * Use when you need to serialize arbitrary data without schema validation.
 * The decoded value will be `unknown` and should be validated separately.
 */
export const JsonCodec = createJsonCodec(z.unknown());
