import { afterEach, beforeEach, describe, type Mock, vi } from "vitest";
import * as z from "zod";
import { RpcClient } from "../src/adapters/client.js";
import {
	calculateReconnectDelay,
	defaultReconnectOptions,
} from "../src/adapters/types.js";
import { event, method } from "../src/schema.js";
import { WebSocketReadyState } from "../src/types.js";

// Mock WebSocket for testing
class MockWebSocket {
	static CONNECTING = 0;
	static OPEN = 1;
	static CLOSING = 2;
	static CLOSED = 3;

	readyState = MockWebSocket.CONNECTING;
	sentMessages: string[] = [];
	url: string;
	protocols: string | string[] | undefined;

	onopen: ((event: Event) => void) | null = null;
	onclose: ((event: CloseEvent) => void) | null = null;
	onmessage: ((event: MessageEvent) => void) | null = null;
	onerror: ((event: Event) => void) | null = null;

	private listeners: Map<string, Set<(event: unknown) => void>> = new Map();

	constructor(url: string, protocols?: string | string[]) {
		this.url = url;
		this.protocols = protocols;
	}

	send(data: string): void {
		if (this.readyState !== MockWebSocket.OPEN) {
			throw new Error("WebSocket is not open");
		}
		this.sentMessages.push(data);
	}

	close(code?: number, reason?: string): void {
		this.readyState = MockWebSocket.CLOSED;
		const event = { code: code ?? 1000, reason: reason ?? "" } as CloseEvent;
		this.onclose?.(event);
		this.dispatchEvent("close", event);
	}

	addEventListener(type: string, listener: (event: unknown) => void): void {
		if (!this.listeners.has(type)) {
			this.listeners.set(type, new Set());
		}
		this.listeners.get(type)?.add(listener);
	}

	removeEventListener(type: string, listener: (event: unknown) => void): void {
		this.listeners.get(type)?.delete(listener);
	}

	private dispatchEvent(type: string, event: unknown): void {
		const listeners = this.listeners.get(type);
		if (listeners) {
			for (const listener of listeners) {
				listener(event);
			}
		}
	}

	// Test helpers
	simulateOpen(): void {
		this.readyState = MockWebSocket.OPEN;
		const event = {} as Event;
		this.dispatchEvent("open", event);
		this.onopen?.(event);
	}

	simulateClose(code = 1000, reason = ""): void {
		this.readyState = MockWebSocket.CLOSED;
		const event = { code, reason } as CloseEvent;
		this.dispatchEvent("close", event);
		this.onclose?.(event);
	}

	simulateError(): void {
		const event = new Event("error");
		this.dispatchEvent("error", event);
		this.onerror?.(event);
	}

	simulateMessage(data: unknown): void {
		const event = { data: JSON.stringify(data) } as MessageEvent;
		this.onmessage?.(event);
	}
}

// Test schemas
const TestLocalSchema = {
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

const TestRemoteSchema = {
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

type TestLocalSchema = typeof TestLocalSchema;
type TestRemoteSchema = typeof TestRemoteSchema;

describe("RpcClient", () => {
	let mockWsInstances: MockWebSocket[];
	let mockWsConstructor: Mock;

	beforeEach(() => {
		vi.useFakeTimers();
		mockWsInstances = [];
		mockWsConstructor = vi.fn((url: string, protocols?: string | string[]) => {
			const ws = new MockWebSocket(url, protocols);
			mockWsInstances.push(ws);
			return ws;
		});
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	function createClient(
		options?: Partial<
			ConstructorParameters<
				typeof RpcClient<TestLocalSchema, TestRemoteSchema>
			>[0]
		>,
	) {
		return new RpcClient({
			url: "wss://test.example.com/ws",
			localSchema: TestLocalSchema,
			remoteSchema: TestRemoteSchema,
			provider: {
				localMethod: vi.fn().mockResolvedValue({ result: "handled" }),
			},
			WebSocket: mockWsConstructor as any,
			...options,
		});
	}

	describe("constructor", (it) => {
		it("should initialize with disconnected state", ({ expect }) => {
			const client = createClient();
			expect(client.state).toBe("disconnected");
			expect(client.isConnected).toBe(false);
		});

		it("should throw when accessing driver before connect", ({ expect }) => {
			const client = createClient();
			expect(() => client.driver).toThrow("Not connected");
		});
	});

	describe("connect()", (it) => {
		it("should create WebSocket with correct URL", async ({ expect }) => {
			const client = createClient();
			const connectPromise = client.connect();

			expect(mockWsConstructor).toHaveBeenCalledWith(
				"wss://test.example.com/ws",
				undefined,
			);

			mockWsInstances[0]?.simulateOpen();
			await connectPromise;
		});

		it("should create WebSocket with protocols", async ({ expect }) => {
			const client = createClient({ protocols: ["rpc", "v1"] });
			const connectPromise = client.connect();

			expect(mockWsConstructor).toHaveBeenCalledWith(
				"wss://test.example.com/ws",
				["rpc", "v1"],
			);

			mockWsInstances[0]?.simulateOpen();
			await connectPromise;
		});

		it("should transition to connected state on open", async ({ expect }) => {
			const client = createClient();
			expect(client.state).toBe("disconnected");

			const connectPromise = client.connect();
			expect(client.state).toBe("connecting");

			mockWsInstances[0]?.simulateOpen();
			await connectPromise;

			expect(client.state).toBe("connected");
			expect(client.isConnected).toBe(true);
		});

		it("should call onConnect callback", async ({ expect }) => {
			const onConnect = vi.fn();
			const client = createClient({ onConnect });

			const connectPromise = client.connect();
			mockWsInstances[0]?.simulateOpen();
			await connectPromise;

			expect(onConnect).toHaveBeenCalledTimes(1);
		});

		it("should reject on connection error", async ({ expect }) => {
			const client = createClient();
			const connectPromise = client.connect();

			mockWsInstances[0]?.simulateError();
			mockWsInstances[0]?.simulateClose(1006, "Connection failed");

			// Error handler fires first before close, so we get "connection failed"
			await expect(connectPromise).rejects.toThrow(
				"WebSocket connection failed",
			);
		});

		it("should not create new connection if already connected", async ({
			expect,
		}) => {
			const client = createClient();

			const connectPromise1 = client.connect();
			mockWsInstances[0]?.simulateOpen();
			await connectPromise1;

			// Second connect should be a no-op
			await client.connect();

			expect(mockWsConstructor).toHaveBeenCalledTimes(1);
		});

		it("should not create new connection if already connecting", async ({
			expect,
		}) => {
			const client = createClient();

			const connectPromise1 = client.connect();
			const connectPromise2 = client.connect();

			mockWsInstances[0]?.simulateOpen();
			await connectPromise1;
			await connectPromise2;

			expect(mockWsConstructor).toHaveBeenCalledTimes(1);
		});
	});

	describe("disconnect()", (it) => {
		it("should close WebSocket and transition to disconnected", async ({
			expect,
		}) => {
			const client = createClient();
			const connectPromise = client.connect();
			mockWsInstances[0]?.simulateOpen();
			await connectPromise;

			expect(client.state).toBe("connected");

			client.disconnect();

			expect(client.state).toBe("disconnected");
			expect(client.isConnected).toBe(false);
		});

		it("should call onDisconnect callback", async ({ expect }) => {
			const onDisconnect = vi.fn();
			const client = createClient({ onDisconnect });

			const connectPromise = client.connect();
			mockWsInstances[0]?.simulateOpen();
			await connectPromise;

			client.disconnect(1000, "Client closing");

			expect(onDisconnect).toHaveBeenCalledWith(1000, "Client closing");
		});

		it("should not attempt reconnection after intentional disconnect", async ({
			expect,
		}) => {
			const onReconnect = vi.fn();
			const client = createClient({
				onReconnect,
				reconnect: { initialDelay: 100 },
			});

			const connectPromise = client.connect();
			mockWsInstances[0]?.simulateOpen();
			await connectPromise;

			client.disconnect();

			// Advance timers - should not trigger reconnect
			vi.advanceTimersByTime(10000);

			expect(onReconnect).not.toHaveBeenCalled();
		});
	});

	describe("driver", (it) => {
		it("should provide driver proxy when connected", async ({ expect }) => {
			const client = createClient();
			const connectPromise = client.connect();
			mockWsInstances[0]?.simulateOpen();
			await connectPromise;

			const driver = client.driver;
			expect(typeof driver.remoteMethod).toBe("function");
		});

		it("should allow calling remote methods", async ({ expect }) => {
			const client = createClient();
			const connectPromise = client.connect();
			mockWsInstances[0]?.simulateOpen();
			await connectPromise;

			const callPromise = client.driver.remoteMethod({ id: "123" });

			// Get request ID from sent message
			const sentMessage = JSON.parse(
				mockWsInstances[0]?.sentMessages[0] ?? "{}",
			) as { id: string };

			// Simulate response
			mockWsInstances[0]?.simulateMessage({
				type: "rpc:response",
				id: sentMessage.id,
				result: { name: "Test" },
			});

			const result = await callPromise;
			expect(result).toEqual({ name: "Test" });
		});
	});

	describe("emit()", (it) => {
		it("should send event when connected", async ({ expect }) => {
			const client = createClient();
			const connectPromise = client.connect();
			mockWsInstances[0]?.simulateOpen();
			await connectPromise;

			client.emit("localEvent", { message: "hello" });

			expect(mockWsInstances[0]?.sentMessages.length).toBe(1);
			const event = JSON.parse(mockWsInstances[0]?.sentMessages[0] ?? "{}") as {
				type: string;
				event: string;
			};
			expect(event.type).toBe("rpc:event");
			expect(event.event).toBe("localEvent");
		});

		it("should warn and not throw when not connected", ({ expect }) => {
			const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
			const client = createClient();

			// Should not throw
			client.emit("localEvent", { message: "hello" });

			expect(warnSpy).toHaveBeenCalledWith(
				expect.stringContaining("Cannot emit event"),
			);
		});
	});

	describe("auto-reconnect", (it) => {
		it("should attempt reconnection after unexpected close", async ({
			expect,
		}) => {
			const onReconnect = vi.fn();
			const client = createClient({
				onReconnect,
				reconnect: { initialDelay: 1000 },
			});

			const connectPromise = client.connect();
			mockWsInstances[0]?.simulateOpen();
			await connectPromise;

			// Simulate unexpected close
			mockWsInstances[0]?.simulateClose(1006, "Connection lost");

			expect(client.state).toBe("reconnecting");
			expect(onReconnect).toHaveBeenCalledWith(1, expect.any(Number));

			// Advance timer to trigger reconnect
			vi.advanceTimersByTime(1100);

			// Should have created new WebSocket
			expect(mockWsInstances.length).toBe(2);
		});

		it("should use exponential backoff for reconnection", async ({
			expect,
		}) => {
			const onReconnect = vi.fn();
			const client = createClient({
				onReconnect,
				reconnect: {
					initialDelay: 1000,
					backoffMultiplier: 2,
					maxDelay: 10000,
					jitter: 0,
				},
			});

			const connectPromise = client.connect();
			mockWsInstances[0]?.simulateOpen();
			await connectPromise;

			// First disconnect triggers reconnect scheduling
			mockWsInstances[0]?.simulateClose(1006, "Connection lost");
			expect(onReconnect).toHaveBeenLastCalledWith(1, 1000);

			// Advance timer and flush microtasks to allow async reconnect to run
			await vi.advanceTimersByTimeAsync(1100);

			// Verify second WebSocket was created
			expect(mockWsInstances.length).toBe(2);

			// Second WebSocket connection fails immediately
			mockWsInstances[1]?.simulateClose(1006, "Still down");

			// Wait for reconnect callback to be called with second attempt
			await vi.waitFor(() => {
				expect(onReconnect).toHaveBeenCalledTimes(2);
			});

			// Should have delay ~2000ms (exponential backoff)
			expect(onReconnect).toHaveBeenLastCalledWith(2, 2000);
		});

		it("should stop after maxAttempts", async ({ expect }) => {
			const onReconnect = vi.fn();
			const onReconnectFailed = vi.fn();
			const client = createClient({
				onReconnect,
				onReconnectFailed,
				reconnect: {
					initialDelay: 100,
					maxAttempts: 2,
					jitter: 0,
				},
			});

			const connectPromise = client.connect();
			mockWsInstances[0]?.simulateOpen();
			await connectPromise;

			// First disconnect triggers first reconnect scheduling
			mockWsInstances[0]?.simulateClose(1006, "Connection lost");
			expect(onReconnect).toHaveBeenCalledTimes(1);

			await vi.advanceTimersByTimeAsync(150);
			expect(mockWsInstances.length).toBe(2);

			// First reconnect attempt fails
			mockWsInstances[1]?.simulateClose(1006, "Still down");

			// Wait for second reconnect to be scheduled
			await vi.waitFor(() => {
				expect(onReconnect).toHaveBeenCalledTimes(2);
			});

			await vi.advanceTimersByTimeAsync(250);
			expect(mockWsInstances.length).toBe(3);

			// Second reconnect attempt fails
			mockWsInstances[2]?.simulateClose(1006, "Still down");

			// Wait for reconnect failed callback
			await vi.waitFor(() => {
				expect(onReconnectFailed).toHaveBeenCalledTimes(1);
			});

			// Should have stopped after 2 attempts
			expect(client.state).toBe("disconnected");
		});

		it("should not reconnect when disabled", async ({ expect }) => {
			const onReconnect = vi.fn();
			const client = createClient({
				onReconnect,
				reconnect: false,
			});

			const connectPromise = client.connect();
			mockWsInstances[0]?.simulateOpen();
			await connectPromise;

			mockWsInstances[0]?.simulateClose(1006, "Connection lost");

			// Should immediately be disconnected
			expect(client.state).toBe("disconnected");
			expect(onReconnect).not.toHaveBeenCalled();

			vi.advanceTimersByTime(10000);
			expect(mockWsInstances.length).toBe(1);
		});

		it("should reset reconnect attempts on successful connection", async ({
			expect,
		}) => {
			const onReconnect = vi.fn();
			const client = createClient({
				onReconnect,
				reconnect: { initialDelay: 100, jitter: 0 },
			});

			const connectPromise = client.connect();
			mockWsInstances[0]?.simulateOpen();
			await connectPromise;

			// Disconnect and reconnect once
			mockWsInstances[0]?.simulateClose(1006, "Connection lost");
			expect(onReconnect).toHaveBeenCalledWith(1, 100);

			vi.advanceTimersByTime(150);
			mockWsInstances[1]?.simulateOpen();

			// Disconnect again - should start from attempt 1
			mockWsInstances[1]?.simulateClose(1006, "Connection lost");
			expect(onReconnect).toHaveBeenCalledWith(1, 100);
		});
	});

	describe("message handling", (it) => {
		it("should handle incoming events", async ({ expect }) => {
			const onEvent = vi.fn();
			const client = createClient({ onEvent });

			const connectPromise = client.connect();
			mockWsInstances[0]?.simulateOpen();
			await connectPromise;

			mockWsInstances[0]?.simulateMessage({
				type: "rpc:event",
				event: "remoteEvent",
				data: { count: 42 },
			});

			expect(onEvent).toHaveBeenCalledWith("remoteEvent", { count: 42 });
		});

		it("should handle incoming RPC requests", async ({ expect }) => {
			const localMethod = vi.fn().mockResolvedValue({ result: "handled" });
			const client = createClient({
				provider: { localMethod },
			});

			const connectPromise = client.connect();
			mockWsInstances[0]?.simulateOpen();
			await connectPromise;

			mockWsInstances[0]?.simulateMessage({
				type: "rpc:request",
				id: "req-1",
				method: "localMethod",
				params: { value: "test" },
			});

			// Wait for async handler
			await vi.waitFor(() => {
				expect(localMethod).toHaveBeenCalledWith({ value: "test" });
			});

			// Should have sent response
			const response = JSON.parse(
				mockWsInstances[0]?.sentMessages[0] ?? "{}",
			) as { type: string };
			expect(response.type).toBe("rpc:response");
		});
	});
});

describe("calculateReconnectDelay", (it) => {
	it("should return initial delay on first attempt", ({ expect }) => {
		const options = { ...defaultReconnectOptions, jitter: 0 };
		const delay = calculateReconnectDelay(0, options);
		expect(delay).toBe(1000);
	});

	it("should apply exponential backoff", ({ expect }) => {
		const options = { ...defaultReconnectOptions, jitter: 0 };

		expect(calculateReconnectDelay(0, options)).toBe(1000);
		expect(calculateReconnectDelay(1, options)).toBe(2000);
		expect(calculateReconnectDelay(2, options)).toBe(4000);
		expect(calculateReconnectDelay(3, options)).toBe(8000);
	});

	it("should cap at maxDelay", ({ expect }) => {
		const options = { ...defaultReconnectOptions, jitter: 0, maxDelay: 5000 };

		expect(calculateReconnectDelay(0, options)).toBe(1000);
		expect(calculateReconnectDelay(1, options)).toBe(2000);
		expect(calculateReconnectDelay(2, options)).toBe(4000);
		expect(calculateReconnectDelay(3, options)).toBe(5000);
		expect(calculateReconnectDelay(10, options)).toBe(5000);
	});

	it("should apply jitter within range", ({ expect }) => {
		const options = { ...defaultReconnectOptions, jitter: 0.5 };

		// Run multiple times to test randomness
		for (let i = 0; i < 10; i++) {
			const delay = calculateReconnectDelay(0, options);
			// With 50% jitter on 1000ms base, range is 500-1500ms
			expect(delay).toBeGreaterThanOrEqual(500);
			expect(delay).toBeLessThanOrEqual(1500);
		}
	});

	it("should not return negative delay", ({ expect }) => {
		const options = { ...defaultReconnectOptions, jitter: 1 };

		// Even with 100% jitter, delay should never be negative
		for (let i = 0; i < 100; i++) {
			const delay = calculateReconnectDelay(0, options);
			expect(delay).toBeGreaterThanOrEqual(0);
		}
	});
});

describe("WebSocketReadyState", (it) => {
	it("should have correct values", ({ expect }) => {
		expect(WebSocketReadyState.CONNECTING).toBe(0);
		expect(WebSocketReadyState.OPEN).toBe(1);
		expect(WebSocketReadyState.CLOSING).toBe(2);
		expect(WebSocketReadyState.CLOSED).toBe(3);
	});
});

describe("defaultReconnectOptions", (it) => {
	it("should have expected defaults", ({ expect }) => {
		expect(defaultReconnectOptions.initialDelay).toBe(1000);
		expect(defaultReconnectOptions.maxDelay).toBe(30000);
		expect(defaultReconnectOptions.backoffMultiplier).toBe(2);
		expect(defaultReconnectOptions.maxAttempts).toBe(0);
		expect(defaultReconnectOptions.jitter).toBe(0.1);
	});
});
