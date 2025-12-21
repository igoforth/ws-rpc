/// <reference path="../do/env.d.ts" />
/**
 * Test Durable Object for cloudflare-do.ts adapter tests
 *
 * A minimal DO that uses the withRpc mixin for testing.
 */

import { Actor } from "@cloudflare/actors";
import * as z from "zod";
import { withRpc } from "../../src/adapters/cloudflare-do.js";
import type { RpcPeer } from "../../src/peers/default.js";
import { event, method } from "../../src/schema.js";

// Test schemas
export const TestLocalSchema = {
	methods: {
		echo: method({
			input: z.object({ message: z.string() }),
			output: z.object({ echoed: z.string() }),
		}),
		getState: method({
			input: z.object({}),
			output: z.object({ counter: z.number() }),
		}),
		increment: method({
			input: z.object({ by: z.number() }),
			output: z.object({ counter: z.number() }),
		}),
	},
	events: {
		stateChanged: event({
			data: z.object({ counter: z.number() }),
		}),
	},
} as const;

export const TestRemoteSchema = {
	methods: {
		ping: method({
			input: z.object({}),
			output: z.object({ pong: z.boolean() }),
		}),
	},
	events: {
		clientEvent: event({
			data: z.object({ info: z.string() }),
		}),
	},
} as const;

export type TestLocalSchema = typeof TestLocalSchema;
export type TestRemoteSchema = typeof TestRemoteSchema;

// Base Actor class
class BaseActor extends Actor<Env> {
	protected counter = 0;

	// RPC method implementations (required by TestLocalSchema)
	async echo(input: { message: string }): Promise<{ echoed: string }> {
		return { echoed: `Echo: ${input.message}` };
	}

	async getState(): Promise<{ counter: number }> {
		return { counter: this.counter };
	}

	async increment(input: { by: number }): Promise<{ counter: number }> {
		const newValue = this.counter + input.by;
		this.counter = newValue;
		return { counter: newValue };
	}
}

// Test DO with RPC mixin
export class TestRpcDO extends withRpc(BaseActor, {
	localSchema: TestLocalSchema,
	remoteSchema: TestRemoteSchema,
	timeout: 5000,
}) {
	private receivedEvents: Array<{ event: string; data: unknown }> = [];
	private hibernationRecoveryCount = 0;

	override async increment(input: {
		by: number;
	}): Promise<{ counter: number }> {
		const result = await super.increment(input);
		// Broadcast state change to all clients using emit()
		this.emit("stateChanged", result);
		return result;
	}

	// Hook for tracking received events (for testing)
	protected onRpcEvent(
		_peer: RpcPeer<TestLocalSchema, TestRemoteSchema>,
		event: string,
		data: unknown,
	): void {
		this.receivedEvents.push({ event, data });
	}

	// Hook for tracking hibernation recovery (for testing)
	protected onRpcPeerRecreated(
		_peer: RpcPeer<TestLocalSchema, TestRemoteSchema>,
		_ws: WebSocket,
	): void {
		this.hibernationRecoveryCount++;
	}

	// Enable WebSocket upgrades for all requests with Upgrade header
	protected override shouldUpgradeSocket(request: Request): boolean {
		return request.headers.get("Upgrade") === "websocket";
	}

	// Handle non-WebSocket requests
	protected override onRequest(_request: Request): Promise<Response> {
		return Promise.resolve(new Response("TestRpcDO"));
	}

	// Test helper methods
	getReceivedEvents(): Array<{ event: string; data: unknown }> {
		return this.receivedEvents;
	}

	clearReceivedEvents(): void {
		this.receivedEvents = [];
	}

	getHibernationRecoveryCount(): number {
		return this.hibernationRecoveryCount;
	}
}

// Worker entry point
export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url);

		// Route /ws/:id to DO WebSocket
		if (url.pathname.startsWith("/ws/")) {
			const id = url.pathname.slice(4); // Remove "/ws/"
			const doId = env.TestRpcDO.idFromName(id);
			const stub = env.TestRpcDO.get(doId);
			// Actor framework requires setName before fetch
			await stub.setName(id);
			return stub.fetch(request);
		}

		// Route /do/:id/* to DO
		if (url.pathname.startsWith("/do/")) {
			const parts = url.pathname.slice(4).split("/");
			const id = parts[0] ?? "default";
			const doId = env.TestRpcDO.idFromName(id);
			const stub = env.TestRpcDO.get(doId);
			// Actor framework requires setName before fetch
			await stub.setName(id);
			return stub.fetch(request);
		}

		return new Response("Test RPC DO Worker");
	},
};
