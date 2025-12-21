import { beforeEach, describe, vi } from "vitest";
import * as z from "zod";
import { type CallContext, DurableRpcPeer } from "../src/peers/durable.js";
import { event, method } from "../src/schema.js";
import { MemoryPendingCallStorage } from "../src/storage/memory.js";
import type { IMinWebSocket } from "../src/types.js";

// Mock WebSocket
class MockWebSocket implements IMinWebSocket {
	readyState = 1; // OPEN
	sentMessages: string[] = [];

	send(data: string): void {
		if (this.readyState !== 1) {
			throw new Error("WebSocket is not open");
		}
		this.sentMessages.push(data);
	}

	close(): void {
		this.readyState = 3;
	}

	getLastMessage(): unknown {
		const last = this.sentMessages[this.sentMessages.length - 1];
		return last ? JSON.parse(last) : null;
	}
}

// Test schemas
const LocalSchema = {
	methods: {
		localMethod: method({
			input: z.object({ value: z.string() }),
			output: z.object({ result: z.string() }),
		}),
	},
	events: {
		localEvent: event({
			data: z.object({ message: z.string() }),
		}),
	},
} as const;

const RemoteSchema = {
	methods: {
		remoteMethod: method({
			input: z.object({ id: z.string() }),
			output: z.object({ name: z.string() }),
		}),
	},
	events: {
		remoteEvent: event({
			data: z.object({ count: z.number() }),
		}),
	},
} as const;

type LocalSchema = typeof LocalSchema;
type RemoteSchema = typeof RemoteSchema;

// Mock actor with callback methods
class MockActor {
	callbackResults: Array<{ result: unknown; context: CallContext }> = [];
	errorResults: Array<{ error: Error; context: CallContext }> = [];

	onRemoteMethodComplete(result: unknown, context: CallContext): void {
		this.callbackResults.push({ result, context });
	}

	onRemoteMethodError(error: Error, context: CallContext): void {
		this.errorResults.push({ error, context });
	}

	// Non-function property for testing validation
	notAFunction = "string";
}

describe("DurableRpcPeer", (it) => {
	let ws: MockWebSocket;
	let storage: MemoryPendingCallStorage;
	let actor: MockActor;
	let durablePeer: DurableRpcPeer<LocalSchema, RemoteSchema, MockActor>;

	beforeEach(() => {
		ws = new MockWebSocket();
		storage = new MemoryPendingCallStorage();
		actor = new MockActor();

		durablePeer = new DurableRpcPeer({
			ws,
			localSchema: LocalSchema,
			remoteSchema: RemoteSchema,
			provider: {
				localMethod: async (input) => ({ result: input.value }),
			},
			timeout: 1000,
			storage,
			actor,
			durableTimeout: 30000,
		});
	});

	describe("constructor", (it) => {
		it("should create a durable peer", ({ expect }) => {
			expect(durablePeer.isOpen).toBe(true);
		});

		it("should have a driver", ({ expect }) => {
			expect(durablePeer.driver).toBeDefined();
			expect(typeof durablePeer.driver.remoteMethod).toBe("function");
		});
	});

	describe("callWithCallback", (it) => {
		it("should persist call to storage before sending", ({ expect }) => {
			durablePeer.callWithCallback(
				"remoteMethod",
				{ id: "123" },
				"onRemoteMethodComplete",
			);

			expect(storage.size).toBe(1);
			const calls = storage.listAll();
			expect(calls[0]?.method).toBe("remoteMethod");
			expect(calls[0]?.callback).toBe("onRemoteMethodComplete");
		});

		it("should send RPC request over WebSocket", ({ expect }) => {
			durablePeer.callWithCallback(
				"remoteMethod",
				{ id: "123" },
				"onRemoteMethodComplete",
			);

			expect(ws.sentMessages.length).toBe(1);
			const request = ws.getLastMessage() as {
				type: string;
				method: string;
				params: unknown;
			};
			expect(request.type).toBe("rpc:request");
			expect(request.method).toBe("remoteMethod");
			expect(request.params).toEqual({ id: "123" });
		});

		it("should throw if callback is not a function", ({ expect }) => {
			expect(() => {
				durablePeer.callWithCallback(
					"remoteMethod",
					{ id: "123" },
					"notAFunction",
				);
			}).toThrow("Callback 'notAFunction' is not a function on the actor");
		});

		it("should throw if callback does not exist", ({ expect }) => {
			expect(() => {
				durablePeer.callWithCallback(
					"remoteMethod",
					{ id: "123" },
					// @ts-expect-error - Testing nonexistent callback
					"nonExistentMethod",
				);
			}).toThrow("not a function");
		});

		it("should use custom timeout when provided", ({ expect }) => {
			const now = Date.now();
			vi.setSystemTime(now);

			durablePeer.callWithCallback(
				"remoteMethod",
				{ id: "123" },
				"onRemoteMethodComplete",
				5000,
			);

			const calls = storage.listAll();
			expect(calls[0]?.timeoutAt).toBe(now + 5000);

			vi.useRealTimers();
		});
	});

	describe("handleMessage (response routing)", (it) => {
		it("should route durable call responses to callback", ({ expect }) => {
			durablePeer.callWithCallback(
				"remoteMethod",
				{ id: "123" },
				"onRemoteMethodComplete",
			);

			const request = ws.getLastMessage() as { id: string };

			// Simulate response
			durablePeer.handleMessage(
				JSON.stringify({
					type: "rpc:response",
					id: request.id,
					result: { name: "Test User" },
				}),
			);

			expect(actor.callbackResults.length).toBe(1);
			expect(actor.callbackResults[0]?.result).toEqual({ name: "Test User" });
		});

		it("should include call context in callback", ({ expect }) => {
			const startTime = Date.now();
			vi.setSystemTime(startTime);

			durablePeer.callWithCallback(
				"remoteMethod",
				{ id: "123" },
				"onRemoteMethodComplete",
			);

			const request = ws.getLastMessage() as { id: string };

			// Advance time and simulate response
			vi.setSystemTime(startTime + 100);

			durablePeer.handleMessage(
				JSON.stringify({
					type: "rpc:response",
					id: request.id,
					result: { name: "Test User" },
				}),
			);

			const context = actor.callbackResults[0]?.context;
			expect(context?.call.method).toBe("remoteMethod");
			expect(context?.latencyMs).toBe(100);

			vi.useRealTimers();
		});

		it("should remove call from storage after response", ({ expect }) => {
			durablePeer.callWithCallback(
				"remoteMethod",
				{ id: "123" },
				"onRemoteMethodComplete",
			);

			expect(storage.size).toBe(1);

			const request = ws.getLastMessage() as { id: string };
			durablePeer.handleMessage(
				JSON.stringify({
					type: "rpc:response",
					id: request.id,
					result: { name: "Test User" },
				}),
			);

			expect(storage.size).toBe(0);
		});

		it("should pass errors to callback", ({ expect }) => {
			durablePeer.callWithCallback(
				"remoteMethod",
				{ id: "123" },
				"onRemoteMethodComplete",
			);

			const request = ws.getLastMessage() as { id: string };

			durablePeer.handleMessage(
				JSON.stringify({
					type: "rpc:error",
					id: request.id,
					code: -32603,
					message: "Internal error",
				}),
			);

			// Error is passed to the same callback as an Error object
			expect(actor.callbackResults.length).toBe(1);
			expect(actor.callbackResults[0]?.result).toBeInstanceOf(Error);
		});

		it("should delegate non-durable responses to base peer", async ({
			expect,
		}) => {
			// Make a promise-based call through the driver
			const callPromise = durablePeer.driver.remoteMethod({ id: "456" });

			const request = JSON.parse(ws.sentMessages[0] as string) as {
				id: string;
			};

			// Simulate response
			durablePeer.handleMessage(
				JSON.stringify({
					type: "rpc:response",
					id: request.id,
					result: { name: "Promise User" },
				}),
			);

			const result = await callPromise;
			expect(result).toEqual({ name: "Promise User" });
		});

		it("should delegate incoming requests to base peer", async ({ expect }) => {
			const localMethodSpy = vi.fn().mockResolvedValue({ result: "handled" });

			const testWs = new MockWebSocket();
			const durableWithSpy = new DurableRpcPeer({
				ws: testWs,
				localSchema: LocalSchema,
				remoteSchema: RemoteSchema,
				provider: { localMethod: localMethodSpy },
				timeout: 1000,
				storage,
				actor,
			});

			durableWithSpy.handleMessage(
				JSON.stringify({
					type: "rpc:request",
					id: "req-1",
					method: "localMethod",
					params: { value: "test" },
				}),
			);

			await vi.waitFor(() => {
				expect(localMethodSpy).toHaveBeenCalledWith({ value: "test" });
			});
		});
	});

	describe("hibernation simulation", (it) => {
		it("should recover pending calls after simulated hibernation", ({
			expect,
		}) => {
			// Make a durable call
			durablePeer.callWithCallback(
				"remoteMethod",
				{ id: "123" },
				"onRemoteMethodComplete",
			);

			const request = ws.getLastMessage() as { id: string };
			const requestId = request.id;

			// Simulate hibernation: create new peer instances but keep storage
			const newWs = new MockWebSocket();
			const newActor = new MockActor();
			const newDurablePeer = new DurableRpcPeer({
				ws: newWs,
				localSchema: LocalSchema,
				remoteSchema: RemoteSchema,
				provider: {},
				timeout: 1000,
				storage, // Same storage - survives hibernation
				actor: newActor,
			});

			// Verify call is still in storage
			expect(storage.size).toBe(1);

			// Response arrives on new peer
			newDurablePeer.handleMessage(
				JSON.stringify({
					type: "rpc:response",
					id: requestId,
					result: { name: "Recovered User" },
				}),
			);

			// Callback should be called on new actor
			expect(newActor.callbackResults.length).toBe(1);
			expect(newActor.callbackResults[0]?.result).toEqual({
				name: "Recovered User",
			});

			// Storage should be cleaned up
			expect(storage.size).toBe(0);
		});
	});

	describe("getPendingCalls", (it) => {
		it("should return all pending durable calls", ({ expect }) => {
			durablePeer.callWithCallback(
				"remoteMethod",
				{ id: "1" },
				"onRemoteMethodComplete",
			);
			durablePeer.callWithCallback(
				"remoteMethod",
				{ id: "2" },
				"onRemoteMethodComplete",
			);

			const pending = durablePeer.getPendingCalls();
			expect(pending.length).toBe(2);
		});
	});

	describe("cleanupExpired", (it) => {
		it("should remove expired calls and return them", ({ expect }) => {
			const now = Date.now();
			vi.setSystemTime(now);

			// Create a call with short timeout
			durablePeer.callWithCallback(
				"remoteMethod",
				{ id: "123" },
				"onRemoteMethodComplete",
				100,
			);

			// Advance past timeout
			vi.setSystemTime(now + 200);

			const expired = durablePeer.cleanupExpired();
			expect(expired.length).toBe(1);
			expect(storage.size).toBe(0);

			vi.useRealTimers();
		});

		it("should not remove non-expired calls", ({ expect }) => {
			durablePeer.callWithCallback(
				"remoteMethod",
				{ id: "123" },
				"onRemoteMethodComplete",
				30000,
			);

			const expired = durablePeer.cleanupExpired();
			expect(expired.length).toBe(0);
			expect(storage.size).toBe(1);
		});
	});

	describe("clearPendingCalls", (it) => {
		it("should remove all pending calls", ({ expect }) => {
			durablePeer.callWithCallback(
				"remoteMethod",
				{ id: "1" },
				"onRemoteMethodComplete",
			);
			durablePeer.callWithCallback(
				"remoteMethod",
				{ id: "2" },
				"onRemoteMethodComplete",
			);

			durablePeer.clearPendingCalls();
			expect(storage.size).toBe(0);
		});
	});

	describe("emit", (it) => {
		it("should delegate to base peer", ({ expect }) => {
			durablePeer.emit("localEvent", { message: "hello" });

			expect(ws.sentMessages.length).toBe(1);
			const sent = ws.getLastMessage() as {
				type: string;
				event: string;
				data: unknown;
			};
			expect(sent.type).toBe("rpc:event");
			expect(sent.event).toBe("localEvent");
		});
	});

	describe("close", (it) => {
		it("should close base peer", ({ expect }) => {
			durablePeer.close();
			expect(durablePeer.isOpen).toBe(false);
		});

		it("should not clear durable calls from storage", ({ expect }) => {
			durablePeer.callWithCallback(
				"remoteMethod",
				{ id: "123" },
				"onRemoteMethodComplete",
			);

			durablePeer.close();

			// Calls remain in storage for potential retry
			expect(storage.size).toBe(1);
		});
	});
});
