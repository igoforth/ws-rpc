/// <reference path="./env.d.ts" />
/**
 * Cloudflare DO RPC Adapter Tests
 *
 * Tests for the withRpc mixin:
 * - Peer creation and cleanup
 * - Driver access
 * - Event broadcasting
 * - Hibernation recovery
 * - WebSocket lifecycle integration
 */

import { env, runInDurableObject, SELF } from "cloudflare:test";
import { describe, vi } from "vitest";

describe("withRpc Mixin - Initialization", (it) => {
	it("should create a DO with RPC capabilities", async ({ expect }) => {
		const stub = env.TestRpcDO.get(env.TestRpcDO.newUniqueId());

		await runInDurableObject(stub, (instance) => {
			// Should have IMultiConnectionAdapter methods
			expect(typeof instance.driver).toBe("object");
			expect(typeof instance.emit).toBe("function");
			expect(typeof instance.getConnectionCount).toBe("function");
			expect(typeof instance.getConnectionIds).toBe("function");
		});
	});

	it("should start with zero RPC peers", async ({ expect }) => {
		const stub = env.TestRpcDO.get(env.TestRpcDO.newUniqueId());

		const peerCount = await runInDurableObject(stub, (instance) =>
			instance.getConnectionCount(),
		);

		expect(peerCount).toBe(0);
	});

	it("should have driver available even with no peers", async ({ expect }) => {
		const stub = env.TestRpcDO.get(env.TestRpcDO.newUniqueId());

		const hasDriver = await runInDurableObject(stub, (instance) => {
			// Driver is always available, just calls will fail/timeout with no peers
			return instance.driver !== null && typeof instance.driver === "object";
		});

		expect(hasDriver).toBe(true);
	});
});

describe("withRpc Mixin - Provider Methods", (it) => {
	it("should have RPC methods available via schema", async ({ expect }) => {
		const stub = env.TestRpcDO.get(env.TestRpcDO.newUniqueId());

		await runInDurableObject(stub, async (instance) => {
			// RPC methods are available
			const result = await instance.echo({ message: "test" });
			expect(result).toEqual({ echoed: "Echo: test" });
		});
	});

	it("should maintain state across method calls", async ({ expect }) => {
		const stub = env.TestRpcDO.get(env.TestRpcDO.newUniqueId());

		const { initial, after } = await runInDurableObject(
			stub,
			async (instance) => {
				const initial = await instance.getState();
				await instance.increment({ by: 100 });
				const after = await instance.getState();
				return { initial, after };
			},
		);

		expect(initial).toEqual({ counter: 0 });
		expect(after).toEqual({ counter: 100 });
	});
});

describe("withRpc Mixin - Event Handling", (it) => {
	it("should track received events", async ({ expect }) => {
		const stub = env.TestRpcDO.get(env.TestRpcDO.newUniqueId());

		await runInDurableObject(stub, (instance) => {
			// Initially no events
			expect(instance.getReceivedEvents()).toEqual([]);

			// Clear should not throw
			expect(() => instance.clearReceivedEvents()).not.toThrow();
		});
	});

	it("should handle emit with no connections", async ({ expect }) => {
		const stub = env.TestRpcDO.get(env.TestRpcDO.newUniqueId());

		await runInDurableObject(stub, (instance) => {
			// Should not throw when no WebSocket connections exist
			expect(() =>
				instance.emit("stateChanged", { counter: 42 }),
			).not.toThrow();
		});
	});

	it("should handle multiple emit calls", async ({ expect }) => {
		const stub = env.TestRpcDO.get(env.TestRpcDO.newUniqueId());

		await runInDurableObject(stub, (instance) => {
			// Multiple emits should not throw
			expect(() => {
				instance.emit("stateChanged", { counter: 1 });
				instance.emit("stateChanged", { counter: 2 });
				instance.emit("stateChanged", { counter: 3 });
			}).not.toThrow();
		});
	});
});

describe("withRpc Mixin - State Consistency", (it) => {
	it("should maintain consistent peer count", async ({ expect }) => {
		const stub = env.TestRpcDO.get(env.TestRpcDO.newUniqueId());

		const { first, second } = await runInDurableObject(stub, (instance) => {
			const first = instance.getConnectionCount();
			const second = instance.getConnectionCount();
			return { first, second };
		});

		expect(first).toBe(second);
		expect(first).toBe(0);
	});

	it("should handle rapid method calls", async ({ expect }) => {
		const stub = env.TestRpcDO.get(env.TestRpcDO.newUniqueId());

		await runInDurableObject(stub, (instance) => {
			// Rapid-fire peer count checks should not cause issues
			for (let i = 0; i < 10; i++) {
				expect(typeof instance.getConnectionCount()).toBe("number");
			}
		});
	});
});

describe("withRpc Mixin - Error Handling", (it) => {
	it("should handle driver access gracefully with no peers", async ({
		expect,
	}) => {
		const stub = env.TestRpcDO.get(env.TestRpcDO.newUniqueId());

		await runInDurableObject(stub, (instance) => {
			// Multiple accesses should be safe - driver is always available
			expect(instance.driver).toBeDefined();
			expect(instance.driver).toBeDefined();
		});
	});

	it("should handle emit with various data", async ({ expect }) => {
		const stub = env.TestRpcDO.get(env.TestRpcDO.newUniqueId());

		await runInDurableObject(stub, (instance) => {
			// Various counter values should work
			expect(() => instance.emit("stateChanged", { counter: 0 })).not.toThrow();
			expect(() =>
				instance.emit("stateChanged", { counter: -1 }),
			).not.toThrow();
			expect(() =>
				instance.emit("stateChanged", { counter: 999999 }),
			).not.toThrow();
		});
	});
});

describe("withRpc Mixin - Isolation", (it) => {
	it("should have isolated state per DO instance", async ({ expect }) => {
		const stub1 = env.TestRpcDO.get(env.TestRpcDO.newUniqueId());
		const stub2 = env.TestRpcDO.get(env.TestRpcDO.newUniqueId());

		// Set counter in first instance via increment
		await runInDurableObject(stub1, async (instance) => {
			await instance.increment({ by: 100 });
		});

		// Second instance should have its own state
		const counter2 = await runInDurableObject(stub2, (instance) =>
			instance.getState(),
		);

		expect(counter2).toEqual({ counter: 0 });

		// First instance should still have its value
		const counter1 = await runInDurableObject(stub1, (instance) =>
			instance.getState(),
		);

		expect(counter1).toEqual({ counter: 100 });
	});

	it("should have isolated peer tracking per DO instance", async ({
		expect,
	}) => {
		const stub1 = env.TestRpcDO.get(env.TestRpcDO.newUniqueId());
		const stub2 = env.TestRpcDO.get(env.TestRpcDO.newUniqueId());

		const count1 = await runInDurableObject(stub1, (instance) =>
			instance.getConnectionCount(),
		);

		const count2 = await runInDurableObject(stub2, (instance) =>
			instance.getConnectionCount(),
		);

		// Both should be 0 and independent
		expect(count1).toBe(0);
		expect(count2).toBe(0);
	});
});

describe("withRpc Mixin - WebSocket Integration", (it) => {
	it("should accept WebSocket upgrade and create RPC peer", async ({
		expect,
	}) => {
		// Connect via WebSocket
		const response = await SELF.fetch("http://localhost/ws/test-ws-1", {
			headers: { Upgrade: "websocket" },
		});

		expect(response.status).toBe(101);
		expect(response.webSocket).toBeDefined();

		const ws = response.webSocket!;
		ws.accept();

		// Verify peer was created
		const stub = env.TestRpcDO.get(env.TestRpcDO.idFromName("test-ws-1"));
		const peerCount = await runInDurableObject(stub, (instance) =>
			instance.getConnectionCount(),
		);

		expect(peerCount).toBe(1);

		ws.close(1000, "test complete");
	});

	it("should handle RPC request/response over WebSocket", async ({
		expect,
	}) => {
		const response = await SELF.fetch("http://localhost/ws/test-ws-2", {
			headers: { Upgrade: "websocket" },
		});

		expect(response.status).toBe(101);
		const ws = response.webSocket!;
		ws.accept();

		// Send RPC request
		const request = JSON.stringify({
			type: "rpc:request",
			id: "1",
			method: "echo",
			params: { message: "Hello RPC" },
		});
		ws.send(request);

		// Wait for response
		const responsePromise = new Promise<string>((resolve) => {
			ws.addEventListener("message", (event) => {
				resolve(event.data as string);
			});
		});

		const responseData = await responsePromise;
		const parsed = JSON.parse(responseData);

		expect(parsed.type).toBe("rpc:response");
		expect(parsed.id).toBe("1");
		expect(parsed.result).toEqual({ echoed: "Echo: Hello RPC" });

		ws.close(1000, "test complete");
	});

	it("should handle multiple RPC requests", async ({ expect }) => {
		const response = await SELF.fetch("http://localhost/ws/test-ws-3", {
			headers: { Upgrade: "websocket" },
		});

		const ws = response.webSocket!;
		ws.accept();

		// Helper to wait for next message
		const waitForMessage = () =>
			new Promise<string>((resolve) => {
				const handler = (event: MessageEvent) => {
					ws.removeEventListener("message", handler);
					resolve(event.data as string);
				};
				ws.addEventListener("message", handler);
			});

		// Send getState request and wait for response
		const promise1 = waitForMessage();
		ws.send(
			JSON.stringify({
				type: "rpc:request",
				id: "1",
				method: "getState",
				params: {},
			}),
		);
		const response1Data = await promise1;
		const response1 = JSON.parse(response1Data);

		expect(response1.type).toBe("rpc:response");
		expect(response1.id).toBe("1");
		expect(response1.result).toEqual({ counter: 0 });

		// Send increment request and wait for response
		// Note: increment also emits an event, so we may get event or response first
		const messages: unknown[] = [];
		const messageHandler = (event: MessageEvent) => {
			messages.push(JSON.parse(event.data as string));
		};
		ws.addEventListener("message", messageHandler);

		ws.send(
			JSON.stringify({
				type: "rpc:request",
				id: "2",
				method: "increment",
				params: { by: 5 },
			}),
		);

		// Wait until we have the response
		await vi.waitFor(() => {
			const response2 = messages.find(
				(m): m is { type: string; id: string; result: unknown } =>
					(m as { type: string }).type === "rpc:response" &&
					(m as { id: string }).id === "2",
			);
			expect(response2).toBeDefined();
			expect(response2?.result).toEqual({ counter: 5 });
		});

		ws.removeEventListener("message", messageHandler);
		ws.close(1000, "test complete");
	});

	it("should return error for unknown method", async ({ expect }) => {
		const response = await SELF.fetch("http://localhost/ws/test-ws-4", {
			headers: { Upgrade: "websocket" },
		});

		const ws = response.webSocket!;
		ws.accept();

		const responsePromise = new Promise<string>((resolve) => {
			ws.addEventListener("message", (event) => {
				resolve(event.data as string);
			});
		});

		// Send request for unknown method
		ws.send(
			JSON.stringify({
				type: "rpc:request",
				id: "1",
				method: "unknownMethod",
				params: {},
			}),
		);

		const responseData = await responsePromise;
		const parsed = JSON.parse(responseData);

		expect(parsed.type).toBe("rpc:error");
		expect(parsed.id).toBe("1");
		expect(parsed.code).toBe(-32601); // METHOD_NOT_FOUND

		ws.close(1000, "test complete");
	});

	it("should return error for invalid params", async ({ expect }) => {
		const response = await SELF.fetch("http://localhost/ws/test-ws-5", {
			headers: { Upgrade: "websocket" },
		});

		const ws = response.webSocket!;
		ws.accept();

		const responsePromise = new Promise<string>((resolve) => {
			ws.addEventListener("message", (event) => {
				resolve(event.data as string);
			});
		});

		// Send request with invalid params (message should be string, not number)
		ws.send(
			JSON.stringify({
				type: "rpc:request",
				id: "1",
				method: "echo",
				params: { message: 123 },
			}),
		);

		const responseData = await responsePromise;
		const parsed = JSON.parse(responseData);

		expect(parsed.type).toBe("rpc:error");
		expect(parsed.id).toBe("1");
		expect(parsed.code).toBe(-32602); // INVALID_PARAMS

		ws.close(1000, "test complete");
	});

	it("should have driver available after WebSocket connect", async ({
		expect,
	}) => {
		const response = await SELF.fetch("http://localhost/ws/test-ws-6", {
			headers: { Upgrade: "websocket" },
		});

		const ws = response.webSocket!;
		ws.accept();

		// Check driver is available
		const stub = env.TestRpcDO.get(env.TestRpcDO.idFromName("test-ws-6"));
		const hasDriver = await runInDurableObject(stub, (instance) => {
			const driver = instance.driver;
			return driver !== null && typeof driver === "object";
		});

		expect(hasDriver).toBe(true);

		ws.close(1000, "test complete");
	});

	it("should broadcast events to connected clients", async ({ expect }) => {
		const response = await SELF.fetch("http://localhost/ws/test-ws-7", {
			headers: { Upgrade: "websocket" },
		});

		const ws = response.webSocket!;
		ws.accept();

		const messages: unknown[] = [];
		ws.addEventListener("message", (event) => {
			messages.push(JSON.parse(event.data as string));
		});

		// Trigger broadcast via increment (which broadcasts stateChanged)
		ws.send(
			JSON.stringify({
				type: "rpc:request",
				id: "1",
				method: "increment",
				params: { by: 10 },
			}),
		);

		// Wait for the stateChanged event
		await vi.waitFor(() => {
			const eventMsg = messages.find(
				(m): m is { type: string; event: string; data: unknown } =>
					(m as { type: string }).type === "rpc:event",
			);
			expect(eventMsg).toBeDefined();
			expect(eventMsg?.event).toBe("stateChanged");
			expect(eventMsg?.data).toEqual({ counter: 10 });
		});

		ws.close(1000, "test complete");
	});

	it("should clean up peer on WebSocket close", async ({ expect }) => {
		const response = await SELF.fetch("http://localhost/ws/test-ws-8", {
			headers: { Upgrade: "websocket" },
		});

		const ws = response.webSocket!;
		ws.accept();

		const stub = env.TestRpcDO.get(env.TestRpcDO.idFromName("test-ws-8"));

		// Verify peer exists
		const countBefore = await runInDurableObject(stub, (instance) =>
			instance.getConnectionCount(),
		);
		expect(countBefore).toBe(1);

		// Close WebSocket with proper code
		ws.close(1000, "test complete");

		// Wait for cleanup
		await new Promise((resolve) => setTimeout(resolve, 50));

		// Peer should be removed
		const countAfter = await runInDurableObject(stub, (instance) =>
			instance.getConnectionCount(),
		);
		expect(countAfter).toBe(0);
	});

	it("should handle multiple concurrent WebSocket connections", async ({
		expect,
	}) => {
		// Connect two clients
		const response1 = await SELF.fetch("http://localhost/ws/test-ws-multi", {
			headers: { Upgrade: "websocket" },
		});
		const ws1 = response1.webSocket!;
		ws1.accept();

		const response2 = await SELF.fetch("http://localhost/ws/test-ws-multi", {
			headers: { Upgrade: "websocket" },
		});
		const ws2 = response2.webSocket!;
		ws2.accept();

		const stub = env.TestRpcDO.get(env.TestRpcDO.idFromName("test-ws-multi"));
		const peerCount = await runInDurableObject(stub, (instance) =>
			instance.getConnectionCount(),
		);

		expect(peerCount).toBe(2);

		ws1.close(1000, "test complete");
		ws2.close(1000, "test complete");
	});
});

describe("withRpc Mixin - RPC Lifecycle Hooks", (it) => {
	it("should call onRpcConnect when peer connects", async ({ expect }) => {
		const response = await SELF.fetch("http://localhost/ws/test-hook-connect", {
			headers: { Upgrade: "websocket" },
		});

		const ws = response.webSocket!;
		ws.accept();

		const stub = env.TestRpcDO.get(
			env.TestRpcDO.idFromName("test-hook-connect"),
		);
		const connectedIds = await runInDurableObject(stub, (instance) =>
			instance.getConnectedPeerIds(),
		);

		expect(connectedIds.length).toBe(1);
		expect(typeof connectedIds[0]).toBe("string");

		ws.close(1000, "test complete");
	});

	it("should call onRpcDisconnect when peer disconnects", async ({
		expect,
	}) => {
		const response = await SELF.fetch(
			"http://localhost/ws/test-hook-disconnect",
			{
				headers: { Upgrade: "websocket" },
			},
		);

		const ws = response.webSocket!;
		ws.accept();

		const stub = env.TestRpcDO.get(
			env.TestRpcDO.idFromName("test-hook-disconnect"),
		);

		// Verify connected
		const connectedBefore = await runInDurableObject(stub, (instance) =>
			instance.getConnectedPeerIds(),
		);
		expect(connectedBefore.length).toBe(1);

		// Close WebSocket
		ws.close(1000, "test complete");

		// Wait for cleanup
		await new Promise((resolve) => setTimeout(resolve, 50));

		// Verify onRpcDisconnect was called
		const disconnectedIds = await runInDurableObject(stub, (instance) =>
			instance.getDisconnectedPeerIds(),
		);

		expect(disconnectedIds.length).toBe(1);
		expect(disconnectedIds[0]).toBe(connectedBefore[0]);
	});

	it("should call onRpcEvent when receiving event from client", async ({
		expect,
	}) => {
		const response = await SELF.fetch("http://localhost/ws/test-hook-event", {
			headers: { Upgrade: "websocket" },
		});

		const ws = response.webSocket!;
		ws.accept();

		// Send an event from client
		ws.send(
			JSON.stringify({
				type: "rpc:event",
				event: "clientEvent",
				data: { info: "hello from client" },
			}),
		);

		// Wait for event to be processed
		await new Promise((resolve) => setTimeout(resolve, 50));

		const stub = env.TestRpcDO.get(env.TestRpcDO.idFromName("test-hook-event"));
		const receivedEvents = await runInDurableObject(stub, (instance) =>
			instance.getReceivedEvents(),
		);

		expect(receivedEvents.length).toBe(1);
		expect(receivedEvents[0]).toEqual({
			event: "clientEvent",
			data: { info: "hello from client" },
		});

		ws.close(1000, "test complete");
	});

	it("should track multiple peer connections via hooks", async ({ expect }) => {
		// Connect first client
		const response1 = await SELF.fetch(
			"http://localhost/ws/test-hook-multi-connect",
			{
				headers: { Upgrade: "websocket" },
			},
		);
		const ws1 = response1.webSocket!;
		ws1.accept();

		// Connect second client
		const response2 = await SELF.fetch(
			"http://localhost/ws/test-hook-multi-connect",
			{
				headers: { Upgrade: "websocket" },
			},
		);
		const ws2 = response2.webSocket!;
		ws2.accept();

		const stub = env.TestRpcDO.get(
			env.TestRpcDO.idFromName("test-hook-multi-connect"),
		);
		const connectedIds = await runInDurableObject(stub, (instance) =>
			instance.getConnectedPeerIds(),
		);

		expect(connectedIds.length).toBe(2);
		// Each peer should have a unique ID
		expect(connectedIds[0]).not.toBe(connectedIds[1]);

		ws1.close(1000, "test complete");
		ws2.close(1000, "test complete");
	});

	it("should call hooks in correct order: connect then disconnect", async ({
		expect,
	}) => {
		const response = await SELF.fetch("http://localhost/ws/test-hook-order", {
			headers: { Upgrade: "websocket" },
		});

		const ws = response.webSocket!;
		ws.accept();

		const stub = env.TestRpcDO.get(env.TestRpcDO.idFromName("test-hook-order"));

		// Get connected peer ID
		const connectedIds = await runInDurableObject(stub, (instance) =>
			instance.getConnectedPeerIds(),
		);
		expect(connectedIds.length).toBe(1);
		const peerId = connectedIds[0];

		// Close and wait
		ws.close(1000, "test complete");
		await new Promise((resolve) => setTimeout(resolve, 50));

		// Verify disconnect was called with same peer ID
		const disconnectedIds = await runInDurableObject(stub, (instance) =>
			instance.getDisconnectedPeerIds(),
		);

		expect(disconnectedIds.length).toBe(1);
		expect(disconnectedIds[0]).toBe(peerId);
	});
});
