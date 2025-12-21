/**
 * CBOR codec using cbor-x
 *
 * Requires optional peer dependency: cbor-x
 *
 * @example
 * ```ts
 * import { createCborCodec, CborCodec } from "@igoforth/ws-rpc/codecs/cbor";
 *
 * // Create a typed codec
 * const MyDataCodec = createCborCodec(MyDataSchema);
 * const bytes = MyDataCodec.encode(data); // Uint8Array
 * const decoded = MyDataCodec.decode(bytes); // validated MyData
 *
 * // Or use the generic codec
 * const bytes = CborCodec.encode({ any: "data" });
 * ```
 */

import { Decoder, Encoder } from "cbor-x";
import * as z from "zod";
import { createBinaryCodecFactory } from "./factory";

const decode = <T>(data: Uint8Array<ArrayBuffer>): T =>
	new Decoder({ bundleStrings: true }).decode(data) as T;

const encode = (data: unknown): Uint8Array<ArrayBuffer> =>
	new Encoder({ bundleStrings: true }).encode(data) as Uint8Array<ArrayBuffer>;

export const createCborCodec = createBinaryCodecFactory(
	(value) => encode(value),
	(bytes) => decode(bytes),
	"cbor",
);

/**
 * Default CBOR codec for unknown values
 *
 * Use when you need to serialize arbitrary data without schema validation.
 * The decoded value will be `unknown` and should be validated separately.
 */
export const CborCodec = createCborCodec(z.unknown());
