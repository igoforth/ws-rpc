/**
 * RPC Codecs
 *
 * Zod-based codecs for serialization with built-in validation.
 *
 * Core exports (always available):
 * - Factory functions for creating custom codecs
 * - JSON codec (uses built-in JSON.stringify/parse)
 *
 * Optional binary codecs (require peer dependencies):
 * - MessagePack: import from "@igoforth/ws-rpc/codecs/msgpack"
 * - CBOR: import from "@igoforth/ws-rpc/codecs/cbor"
 */

// Core types and factories
export {
	type BinaryCodec,
	type CodecFactory,
	type CodecOptions,
	createBinaryCodecFactory,
	createStringCodecFactory,
	isBinaryCodec,
	isStringCodec,
	type StringCodec,
	type WireCodec,
	type WireData,
} from "./factory";

// JSON codec (always available)
export { createJsonCodec, JsonCodec } from "./json";
