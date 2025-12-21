/**
 * MessagePack codec using @msgpack/msgpack
 *
 * Requires optional peer dependency: @msgpack/msgpack
 *
 * @example
 * ```ts
 * import { createMsgpackCodec, MsgpackCodec } from "@igoforth/ws-rpc/codecs/msgpack";
 *
 * // Create a typed codec
 * const MyDataCodec = createMsgpackCodec(MyDataSchema);
 * const bytes = MyDataCodec.encode(data); // Uint8Array
 * const decoded = MyDataCodec.decode(bytes); // validated MyData
 *
 * // Or use the generic codec
 * const bytes = MsgpackCodec.encode({ any: "data" });
 * ```
 */

import { decode, encode } from "@msgpack/msgpack";
import * as z from "zod";
import { createBinaryCodecFactory } from "./factory";

export const createMsgpackCodec = createBinaryCodecFactory(
	(value) => encode(value) as Uint8Array<ArrayBuffer>,
	(bytes) => decode(bytes),
	"msgpack",
);

/**
 * Default MessagePack codec for unknown values
 *
 * Use when you need to serialize arbitrary data without schema validation.
 * The decoded value will be `unknown` and should be validated separately.
 */
export const MsgpackCodec = createMsgpackCodec(z.unknown());
