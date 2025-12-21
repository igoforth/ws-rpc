import { afterEach, beforeEach, describe, vi } from "vitest";
import * as z from "zod";
import {
	RpcConnectionClosed,
	RpcRemoteError,
	RpcTimeoutError,
	RpcValidationError,
} from "../src/errors.js";
import { RpcPeer } from "../src/peers/default.js";
import { RpcErrorCodes } from "../src/protocol.js";
import { event, method } from "../src/schema.js";
import type { IMinWebSocket } from "../src/types.js";

// Mock WebSocket for testing
class MockWebSocket implements IMinWebSocket {
	readyState = 1; // OPEN
	sentMessages: string[] = [];
	closed = false;
	closeCode: number | undefined;
	closeReason: string | undefined;

	send(data: string): void {
		if (this.readyState !== 1) {
			throw new Error("WebSocket is not open");
		}
		this.sentMessages.push(data);
	}

	close(code?: number, reason?: string): void {
		this.closed = true;
		this.closeCode = code;
		this.closeReason = reason;
		this.readyState = 3; // CLOSED
	}

	// Helper to get last sent message as parsed JSON
	getLastMessage(): unknown {
		const last = this.sentMessages[this.sentMessages.length - 1];
		return last ? JSON.parse(last) : null;
	}

	// Helper to simulate receiving a message
	receiveMessage(
		peer: RpcPeer<TestLocalSchema, TestRemoteSchema>,
		data: unknown,
	): void {
		peer.handleMessage(JSON.stringify(data));
	}
}

// Test schemas
const TestLocalSchema = {
	methods: {
		localMethod: method({
			input: z.object({ value: z.string() }),
			output: z.object({ result: z.string() }),
		}),
		asyncMethod: method({
			input: z.object({ delay: z.number() }),
			output: z.object({ done: z.boolean() }),
		}),
	},
	events: {
		localEvent: event({
			data: z.object({ message: z.string() }),
		}),
	},
} as const;

const TestRemoteSchema = {
	methods: {
		remoteMethod: method({
			input: z.object({ id: z.string() }),
			output: z.object({ name: z.string() }),
		}),
		failingMethod: method({
			input: z.object({}),
			output: z.object({}),
		}),
	},
	events: {
		remoteEvent: event({
			data: z.object({ count: z.number() }),
		}),
	},
} as const;

type TestLocalSchema = typeof TestLocalSchema;
type TestRemoteSchema = typeof TestRemoteSchema;

describe("RpcPeer", (it) => {
	let ws: MockWebSocket;
	let peer: RpcPeer<TestLocalSchema, TestRemoteSchema>;
	let localMethodHandler: ReturnType<typeof vi.fn>;
	let asyncMethodHandler: ReturnType<typeof vi.fn>;
	let onEventHandler: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		ws = new MockWebSocket();
		localMethodHandler = vi.fn().mockResolvedValue({ result: "handled" });
		asyncMethodHandler = vi.fn().mockResolvedValue({ done: true });
		onEventHandler = vi.fn();

		peer = new RpcPeer({
			ws,
			localSchema: TestLocalSchema,
			remoteSchema: TestRemoteSchema,
			provider: {
				localMethod: localMethodHandler,
				asyncMethod: asyncMethodHandler,
			},
			onEvent: onEventHandler,
			timeout: 1000,
		});
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	describe("constructor", (it) => {
		it("should create a peer with driver proxy", ({ expect }) => {
			expect(peer.driver).toBeDefined();
			expect(typeof peer.driver.remoteMethod).toBe("function");
		});

		it("should be open when WebSocket is open", ({ expect }) => {
			expect(peer.isOpen).toBe(true);
		});

		it("should not be open when WebSocket is closed", ({ expect }) => {
			ws.readyState = 3;
			expect(peer.isOpen).toBe(false);
		});
	});

	describe("driver (calling remote methods)", (it) => {
		it("should send RPC request when calling driver method", async ({
			expect,
		}) => {
			const callPromise = peer.driver.remoteMethod({ id: "123" });

			// Verify request was sent
			expect(ws.sentMessages.length).toBe(1);
			const request = ws.getLastMessage() as {
				type: string;
				id: string;
				method: string;
				params: unknown;
			};
			expect(request.type).toBe("rpc:request");
			expect(request.method).toBe("remoteMethod");
			expect(request.params).toEqual({ id: "123" });

			// Simulate response
			ws.receiveMessage(peer, {
				type: "rpc:response",
				id: request.id,
				result: { name: "Test User" },
			});

			const result = await callPromise;
			expect(result).toEqual({ name: "Test User" });
		});

		it("should reject with RpcValidationError on invalid input", async ({
			expect,
		}) => {
			await expect(
				// @ts-expect-error - Testing invalid input
				peer.driver.remoteMethod({ id: 123 }),
			).rejects.toThrow(RpcValidationError);
		});

		it("should reject with RpcConnectionClosed when WebSocket is closed", async ({
			expect,
		}) => {
			ws.readyState = 3;

			await expect(peer.driver.remoteMethod({ id: "123" })).rejects.toThrow(
				RpcConnectionClosed,
			);
		});

		it("should reject with RpcTimeoutError after timeout", async ({
			expect,
		}) => {
			vi.useFakeTimers();

			const callPromise = peer.driver.remoteMethod({ id: "123" });

			// Advance time past timeout
			vi.advanceTimersByTime(1100);

			await expect(callPromise).rejects.toThrow(RpcTimeoutError);
		});

		it("should reject with RpcRemoteError on error response", async ({
			expect,
		}) => {
			const callPromise = peer.driver.remoteMethod({ id: "123" });

			const request = ws.getLastMessage() as { id: string };

			// Simulate error response
			ws.receiveMessage(peer, {
				type: "rpc:error",
				id: request.id,
				code: RpcErrorCodes.INTERNAL_ERROR,
				message: "Something went wrong",
				data: { detail: "more info" },
			});

			await expect(callPromise).rejects.toThrow(RpcRemoteError);
		});
	});

	describe("emit (fire-and-forget events)", (it) => {
		it("should send event message", ({ expect }) => {
			peer.emit("localEvent", { message: "hello" });

			expect(ws.sentMessages.length).toBe(1);
			const event = ws.getLastMessage() as {
				type: string;
				event: string;
				data: unknown;
			};
			expect(event.type).toBe("rpc:event");
			expect(event.event).toBe("localEvent");
			expect(event.data).toEqual({ message: "hello" });
		});

		it("should not throw when WebSocket is closed", ({ expect }) => {
			ws.readyState = 3;

			// Should not throw, just warn
			expect(() => peer.emit("localEvent", { message: "hello" })).not.toThrow();
			expect(ws.sentMessages.length).toBe(0);
		});

		it("should validate event data", ({ expect }) => {
			// Invalid data should not be sent
			// @ts-expect-error - Testing invalid data
			peer.emit("localEvent", { message: 123 });
			expect(ws.sentMessages.length).toBe(0);
		});

		it("should warn and not send for unknown event", ({ expect }) => {
			// @ts-expect-error - Testing unknown event
			peer.emit("unknownLocalEvent", { data: "test" });
			expect(ws.sentMessages.length).toBe(0);
		});
	});

	describe("handleMessage (incoming requests)", (it) => {
		it("should call provider method and send response", async ({ expect }) => {
			const requestId = "req-1";

			ws.receiveMessage(peer, {
				type: "rpc:request",
				id: requestId,
				method: "localMethod",
				params: { value: "test" },
			});

			// Wait for async handler
			await vi.waitFor(() => {
				expect(localMethodHandler).toHaveBeenCalledWith({ value: "test" });
			});

			// Check response was sent
			const response = ws.getLastMessage() as {
				type: string;
				id: string;
				result: unknown;
			};
			expect(response.type).toBe("rpc:response");
			expect(response.id).toBe(requestId);
			expect(response.result).toEqual({ result: "handled" });
		});

		it("should send error for unknown method", async ({ expect }) => {
			ws.receiveMessage(peer, {
				type: "rpc:request",
				id: "req-1",
				method: "unknownMethod",
				params: {},
			});

			await vi.waitFor(() => {
				expect(ws.sentMessages.length).toBe(1);
			});

			const error = ws.getLastMessage() as {
				type: string;
				code: number;
			};
			expect(error.type).toBe("rpc:error");
			expect(error.code).toBe(RpcErrorCodes.METHOD_NOT_FOUND);
		});

		it("should send error for invalid params", async ({ expect }) => {
			ws.receiveMessage(peer, {
				type: "rpc:request",
				id: "req-1",
				method: "localMethod",
				params: { value: 123 }, // Should be string
			});

			await vi.waitFor(() => {
				expect(ws.sentMessages.length).toBe(1);
			});

			const error = ws.getLastMessage() as {
				type: string;
				code: number;
			};
			expect(error.type).toBe("rpc:error");
			expect(error.code).toBe(RpcErrorCodes.INVALID_PARAMS);
		});

		it("should send error when handler throws", async ({ expect }) => {
			localMethodHandler.mockRejectedValue(new Error("Handler error"));

			ws.receiveMessage(peer, {
				type: "rpc:request",
				id: "req-1",
				method: "localMethod",
				params: { value: "test" },
			});

			await vi.waitFor(() => {
				expect(ws.sentMessages.length).toBe(1);
			});

			const error = ws.getLastMessage() as {
				type: string;
				code: number;
				message: string;
			};
			expect(error.type).toBe("rpc:error");
			expect(error.code).toBe(RpcErrorCodes.INTERNAL_ERROR);
			expect(error.message).toBe("Handler error");
		});

		it("should send error when handler throws non-Error", async ({
			expect,
		}) => {
			localMethodHandler.mockRejectedValue("string error");

			ws.receiveMessage(peer, {
				type: "rpc:request",
				id: "req-1",
				method: "localMethod",
				params: { value: "test" },
			});

			await vi.waitFor(() => {
				expect(ws.sentMessages.length).toBe(1);
			});

			const error = ws.getLastMessage() as {
				type: string;
				code: number;
				message: string;
			};
			expect(error.type).toBe("rpc:error");
			expect(error.code).toBe(RpcErrorCodes.INTERNAL_ERROR);
			expect(error.message).toBe("Unknown error");
		});

		it("should send error for method without handler implementation", async ({
			expect,
		}) => {
			// Create a schema with an extra method
			const ExtendedLocalSchema = {
				methods: {
					...TestLocalSchema.methods,
					unimplementedMethod: method({
						input: z.object({ foo: z.string() }),
						output: z.object({ bar: z.string() }),
					}),
				},
				events: TestLocalSchema.events,
			} as const;

			// Create peer without handler for the extra method
			const peerWithMissingHandler = new RpcPeer({
				ws,
				localSchema: ExtendedLocalSchema,
				remoteSchema: TestRemoteSchema,
				provider: {
					localMethod: localMethodHandler,
					asyncMethod: asyncMethodHandler,
					// unimplementedMethod is NOT provided
				},
				timeout: 1000,
			});

			// Simulate incoming request for unimplemented method
			peerWithMissingHandler.handleMessage(
				JSON.stringify({
					type: "rpc:request",
					id: "req-1",
					method: "unimplementedMethod",
					params: { foo: "test" },
				}),
			);

			await vi.waitFor(() => {
				expect(ws.sentMessages.length).toBe(1);
			});

			const error = ws.getLastMessage() as {
				type: string;
				code: number;
				message: string;
			};
			expect(error.type).toBe("rpc:error");
			expect(error.code).toBe(RpcErrorCodes.METHOD_NOT_FOUND);
			expect(error.message).toBe(
				"Method 'unimplementedMethod' not implemented",
			);
		});

		it("should send error when handler returns invalid output", async ({
			expect,
		}) => {
			// Handler returns data that doesn't match output schema
			localMethodHandler.mockResolvedValue({ wrongKey: "invalid" });

			ws.receiveMessage(peer, {
				type: "rpc:request",
				id: "req-1",
				method: "localMethod",
				params: { value: "test" },
			});

			await vi.waitFor(() => {
				expect(ws.sentMessages.length).toBe(1);
			});

			const error = ws.getLastMessage() as {
				type: string;
				code: number;
				message: string;
			};
			expect(error.type).toBe("rpc:error");
			expect(error.code).toBe(RpcErrorCodes.INTERNAL_ERROR);
			expect(error.message).toBe("Invalid output from 'localMethod'");
		});
	});

	describe("handleMessage (incoming responses)", (it) => {
		it("should warn when receiving response for unknown request", ({
			expect,
		}) => {
			// Receive response for a request that was never made
			expect(() => {
				ws.receiveMessage(peer, {
					type: "rpc:response",
					id: "unknown-request-id",
					result: { name: "Test" },
				});
			}).not.toThrow();
		});

		it("should warn when receiving error for unknown request", ({ expect }) => {
			// Receive error for a request that was never made
			expect(() => {
				ws.receiveMessage(peer, {
					type: "rpc:error",
					id: "unknown-request-id",
					code: RpcErrorCodes.INTERNAL_ERROR,
					message: "Some error",
				});
			}).not.toThrow();
		});
	});

	describe("handleMessage (incoming events)", (it) => {
		it("should call onEvent handler for valid events", ({ expect }) => {
			ws.receiveMessage(peer, {
				type: "rpc:event",
				event: "remoteEvent",
				data: { count: 42 },
			});

			expect(onEventHandler).toHaveBeenCalledWith("remoteEvent", { count: 42 });
		});

		it("should not throw for unknown events", ({ expect }) => {
			expect(() => {
				ws.receiveMessage(peer, {
					type: "rpc:event",
					event: "unknownEvent",
					data: {},
				});
			}).not.toThrow();
		});

		it("should validate event data", ({ expect }) => {
			ws.receiveMessage(peer, {
				type: "rpc:event",
				event: "remoteEvent",
				data: { count: "not a number" },
			});

			// Handler should not be called with invalid data
			expect(onEventHandler).not.toHaveBeenCalled();
		});

		it("should silently ignore events when no onEvent handler", ({
			expect,
		}) => {
			// Create peer without event handler
			const peerWithoutEventHandler = new RpcPeer({
				ws,
				localSchema: TestLocalSchema,
				remoteSchema: TestRemoteSchema,
				provider: {
					localMethod: localMethodHandler,
					asyncMethod: asyncMethodHandler,
				},
				// onEvent is NOT provided
				timeout: 1000,
			});

			// Should not throw
			expect(() => {
				peerWithoutEventHandler.handleMessage(
					JSON.stringify({
						type: "rpc:event",
						event: "remoteEvent",
						data: { count: 42 },
					}),
				);
			}).not.toThrow();
		});
	});

	describe("close", (it) => {
		it("should reject all pending requests", async ({ expect }) => {
			vi.useFakeTimers();

			const callPromise = peer.driver.remoteMethod({ id: "123" });

			peer.close();

			await expect(callPromise).rejects.toThrow(RpcConnectionClosed);
		});

		it("should mark peer as closed", ({ expect }) => {
			peer.close();
			expect(peer.isOpen).toBe(false);
		});

		it("should clear pending request count", async ({ expect }) => {
			vi.useFakeTimers();

			// Create pending request (will be rejected on close)
			const pendingCall = peer.driver.remoteMethod({ id: "123" });
			expect(peer.pendingCount).toBe(1);

			peer.close();
			expect(peer.pendingCount).toBe(0);

			// Verify the pending request was rejected
			await expect(pendingCall).rejects.toThrow(RpcConnectionClosed);
		});
	});

	describe("concurrent requests", (it) => {
		it("should handle multiple concurrent requests", async ({ expect }) => {
			const call1 = peer.driver.remoteMethod({ id: "1" });
			const call2 = peer.driver.remoteMethod({ id: "2" });

			expect(ws.sentMessages.length).toBe(2);
			expect(peer.pendingCount).toBe(2);

			// Get the request IDs
			const req1 = JSON.parse(ws.sentMessages[0] as string) as { id: string };
			const req2 = JSON.parse(ws.sentMessages[1] as string) as { id: string };

			// Respond to second request first
			ws.receiveMessage(peer, {
				type: "rpc:response",
				id: req2.id,
				result: { name: "User 2" },
			});

			const result2 = await call2;
			expect(result2).toEqual({ name: "User 2" });
			expect(peer.pendingCount).toBe(1);

			// Respond to first request
			ws.receiveMessage(peer, {
				type: "rpc:response",
				id: req1.id,
				result: { name: "User 1" },
			});

			const result1 = await call1;
			expect(result1).toEqual({ name: "User 1" });
			expect(peer.pendingCount).toBe(0);
		});
	});

	describe("message parsing", (it) => {
		it("should handle ArrayBuffer messages", async ({ expect }) => {
			const requestId = "req-1";
			const message = JSON.stringify({
				type: "rpc:request",
				id: requestId,
				method: "localMethod",
				params: { value: "test" },
			});

			// Simulate ArrayBuffer message
			const encoder = new TextEncoder();
			const encoded = encoder.encode(message);
			peer.handleMessage(
				encoded.buffer.slice(
					encoded.byteOffset,
					encoded.byteOffset + encoded.byteLength,
				) as ArrayBuffer,
			);

			await vi.waitFor(() => {
				expect(localMethodHandler).toHaveBeenCalledWith({ value: "test" });
			});
		});

		it("should handle invalid JSON gracefully", ({ expect }) => {
			expect(() => {
				peer.handleMessage("not valid json");
			}).not.toThrow();
		});

		it("should handle invalid message schema gracefully", ({ expect }) => {
			expect(() => {
				peer.handleMessage(JSON.stringify({ invalid: true }));
			}).not.toThrow();
		});
	});
});
