import { describe } from "vitest";
import { createCborCodec } from "../src/codecs/cbor.js";
import { createMsgpackCodec } from "../src/codecs/msgpack.js";
import {
	createProtocol,
	JsonProtocol,
	RpcErrorCodes,
	RpcErrorSchema,
	RpcEventSchema,
	RpcMessageSchema,
	RpcRequestSchema,
	RpcResponseSchema,
} from "../src/protocol.js";

describe("Protocol Schemas", (it) => {
	describe("RpcRequestSchema", (it) => {
		it("should validate a valid request", ({ expect }) => {
			const request = {
				type: "rpc:request",
				id: "123",
				method: "test",
				params: { foo: "bar" },
			};

			const result = RpcRequestSchema.safeParse(request);
			expect(result.success).toBe(true);
		});

		it("should reject request with wrong type", ({ expect }) => {
			const request = {
				type: "wrong",
				id: "123",
				method: "test",
				params: {},
			};

			const result = RpcRequestSchema.safeParse(request);
			expect(result.success).toBe(false);
		});

		it("should reject request missing required fields", ({ expect }) => {
			const request = {
				type: "rpc:request",
				method: "test",
			};

			const result = RpcRequestSchema.safeParse(request);
			expect(result.success).toBe(false);
		});
	});

	describe("RpcResponseSchema", (it) => {
		it("should validate a valid response", ({ expect }) => {
			const response = {
				type: "rpc:response",
				id: "123",
				result: { data: "test" },
			};

			const result = RpcResponseSchema.safeParse(response);
			expect(result.success).toBe(true);
		});

		it("should accept null result", ({ expect }) => {
			const response = {
				type: "rpc:response",
				id: "123",
				result: null,
			};

			const result = RpcResponseSchema.safeParse(response);
			expect(result.success).toBe(true);
		});
	});

	describe("RpcErrorSchema", (it) => {
		it("should validate a valid error", ({ expect }) => {
			const error = {
				type: "rpc:error",
				id: "123",
				code: -32600,
				message: "Invalid request",
			};

			const result = RpcErrorSchema.safeParse(error);
			expect(result.success).toBe(true);
		});

		it("should accept error with optional data", ({ expect }) => {
			const error = {
				type: "rpc:error",
				id: "123",
				code: -32600,
				message: "Invalid request",
				data: { details: "more info" },
			};

			const result = RpcErrorSchema.safeParse(error);
			expect(result.success).toBe(true);
		});
	});

	describe("RpcEventSchema", (it) => {
		it("should validate a valid event", ({ expect }) => {
			const event = {
				type: "rpc:event",
				event: "trade",
				data: { price: 0.5 },
			};

			const result = RpcEventSchema.safeParse(event);
			expect(result.success).toBe(true);
		});
	});

	describe("RpcMessageSchema", (it) => {
		it("should validate any valid message type", ({ expect }) => {
			const messages = [
				{ type: "rpc:request", id: "1", method: "test", params: {} },
				{ type: "rpc:response", id: "1", result: {} },
				{ type: "rpc:error", id: "1", code: -1, message: "error" },
				{ type: "rpc:event", event: "test", data: {} },
			];

			for (const msg of messages) {
				const result = RpcMessageSchema.safeParse(msg);
				expect(result.success).toBe(true);
			}
		});

		it("should reject invalid message type", ({ expect }) => {
			const invalid = { type: "invalid", foo: "bar" };
			const result = RpcMessageSchema.safeParse(invalid);
			expect(result.success).toBe(false);
		});
	});
});

describe("createProtocol", (it) => {
	describe("with default JSON codec", (it) => {
		const protocol = createProtocol();

		it("should encode request to JSON string", ({ expect }) => {
			const wire = protocol.createRequest("1", "test", { foo: "bar" });

			expect(typeof wire).toBe("string");
			const parsed = JSON.parse(wire);
			expect(parsed.type).toBe("rpc:request");
			expect(parsed.id).toBe("1");
			expect(parsed.method).toBe("test");
			expect(parsed.params).toEqual({ foo: "bar" });
		});

		it("should encode response to JSON string", ({ expect }) => {
			const wire = protocol.createResponse("1", { result: "ok" });

			expect(typeof wire).toBe("string");
			const parsed = JSON.parse(wire);
			expect(parsed.type).toBe("rpc:response");
			expect(parsed.result).toEqual({ result: "ok" });
		});

		it("should encode error to JSON string", ({ expect }) => {
			const wire = protocol.createError("1", -32600, "Invalid", {
				detail: "x",
			});

			expect(typeof wire).toBe("string");
			const parsed = JSON.parse(wire);
			expect(parsed.type).toBe("rpc:error");
			expect(parsed.code).toBe(-32600);
			expect(parsed.data).toEqual({ detail: "x" });
		});

		it("should encode event to JSON string", ({ expect }) => {
			const wire = protocol.createEvent("trade", { price: 0.5 });

			expect(typeof wire).toBe("string");
			const parsed = JSON.parse(wire);
			expect(parsed.type).toBe("rpc:event");
			expect(parsed.event).toBe("trade");
		});

		it("should decode JSON string to message", ({ expect }) => {
			const json = JSON.stringify({
				type: "rpc:request",
				id: "1",
				method: "test",
				params: {},
			});

			const message = protocol.decodeMessage(json);
			expect(message.type).toBe("rpc:request");
		});

		it("should decode ArrayBuffer to message", ({ expect }) => {
			const json = JSON.stringify({
				type: "rpc:response",
				id: "1",
				result: { ok: true },
			});
			const encoded = new TextEncoder().encode(json);
			const buffer = encoded.buffer.slice(
				encoded.byteOffset,
				encoded.byteOffset + encoded.byteLength,
			) as ArrayBuffer;

			const message = protocol.decodeMessage(buffer);
			expect(message.type).toBe("rpc:response");
		});

		it("should return null for invalid message with safeDecodeMessage", ({
			expect,
		}) => {
			const result = protocol.safeDecodeMessage("not json");
			expect(result).toBeNull();
		});

		it("should return null for valid JSON but invalid schema", ({ expect }) => {
			const result = protocol.safeDecodeMessage(
				JSON.stringify({ invalid: true }),
			);
			expect(result).toBeNull();
		});

		it("should round-trip messages correctly", ({ expect }) => {
			const original = {
				type: "rpc:request" as const,
				id: "42",
				method: "ping",
				params: { ts: Date.now() },
			};
			const wire = protocol.createRequest(
				original.id,
				original.method,
				original.params,
			);
			const decoded = protocol.decodeMessage(wire);

			expect(decoded).toEqual(original);
		});
	});

	describe("with MessagePack codec", (it) => {
		const msgpackCodec = createMsgpackCodec(RpcMessageSchema);
		const protocol = createProtocol(msgpackCodec);

		it("should encode to Uint8Array", ({ expect }) => {
			const wire = protocol.createRequest("1", "test", { foo: "bar" });

			expect(wire).toBeInstanceOf(Uint8Array);
		});

		it("should round-trip messages correctly", ({ expect }) => {
			const original = {
				type: "rpc:request" as const,
				id: "1",
				method: "ping",
				params: { nested: { value: 123 } },
			};
			const wire = protocol.createRequest(
				original.id,
				original.method,
				original.params,
			);
			const decoded = protocol.decodeMessage(wire);

			expect(decoded).toEqual(original);
		});

		it("should decode ArrayBuffer", ({ expect }) => {
			const arr = protocol.createResponse("1", { data: [1, 2, 3] });
			// Simulate receiving as ArrayBuffer (create a properly sized copy)
			const buffer = arr.buffer.slice(
				arr.byteOffset,
				arr.byteOffset + arr.byteLength,
			);

			const decoded = protocol.decodeMessage(buffer);
			expect(decoded.type).toBe("rpc:response");
		});
	});

	describe("with CBOR codec", (it) => {
		const cborCodec = createCborCodec(RpcMessageSchema);
		const protocol = createProtocol(cborCodec);

		it("should encode to Uint8Array", ({ expect }) => {
			const wire = protocol.createRequest("1", "test", { foo: "bar" });

			expect(wire).toBeInstanceOf(Uint8Array);
		});

		it("should round-trip messages correctly", ({ expect }) => {
			const original = {
				type: "rpc:event" as const,
				event: "update",
				data: { values: [1, 2, 3] },
			};
			const wire = protocol.createEvent(original.event, original.data);
			const decoded = protocol.decodeMessage(wire);

			expect(decoded).toEqual(original);
		});
	});

	describe("JsonProtocol singleton", (it) => {
		it("should be pre-configured with JSON codec", ({ expect }) => {
			const wire = JsonProtocol.createRequest("1", "test", {});

			expect(typeof wire).toBe("string");
		});

		it("should work the same as createProtocol()", ({ expect }) => {
			const protocol = createProtocol();
			const wire1 = JsonProtocol.createRequest("1", "test", { a: 1 });
			const wire2 = protocol.createRequest("1", "test", { a: 1 });

			expect(wire1).toBe(wire2);
		});
	});
});

describe("RpcErrorCodes", (it) => {
	it("should have standard JSON-RPC error codes", ({ expect }) => {
		expect(RpcErrorCodes.PARSE_ERROR).toBe(-32700);
		expect(RpcErrorCodes.INVALID_REQUEST).toBe(-32600);
		expect(RpcErrorCodes.METHOD_NOT_FOUND).toBe(-32601);
		expect(RpcErrorCodes.INVALID_PARAMS).toBe(-32602);
		expect(RpcErrorCodes.INTERNAL_ERROR).toBe(-32603);
	});

	it("should have custom error codes in reserved range", ({ expect }) => {
		expect(RpcErrorCodes.TIMEOUT).toBe(-32000);
		expect(RpcErrorCodes.CONNECTION_CLOSED).toBe(-32001);
		expect(RpcErrorCodes.VALIDATION_ERROR).toBe(-32002);
	});
});
