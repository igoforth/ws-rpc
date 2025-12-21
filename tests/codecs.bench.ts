/**
 * Wire Protocol End-to-End Benchmarks
 *
 * Measures real WebSocket round-trip performance through RpcClient/RpcServer
 * using JSON, MessagePack, and CBOR codecs.
 */

import { afterAll, beforeAll, bench, describe } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import * as z from "zod";
import { RpcClient } from "../src/adapters/client.js";
import { RpcServer } from "../src/adapters/server.js";
import { createCborCodec } from "../src/codecs/cbor.js";
import { createJsonCodec } from "../src/codecs/json.js";
import { createMsgpackCodec } from "../src/codecs/msgpack.js";
import {
	createProtocol,
	RpcMessageSchema,
	type RpcProtocol,
} from "../src/protocol.js";
import { method, type RpcSchema } from "../src/schema.js";
import type { IWebSocket, IWebSocketServer } from "../src/types.js";

// Test schema
const BenchSchema = {
	methods: {
		echo: method({
			input: z.object({ data: z.unknown() }),
			output: z.object({ data: z.unknown() }),
		}),
	},
	events: {},
} as const satisfies RpcSchema;

// Test payloads
const smallPayload = { message: "Hello, World!" };

const mediumPayload = {
	items: Array.from({ length: 50 }, (_, i) => ({
		id: i,
		name: `Item ${i}`,
		value: Math.random() * 1000,
		active: i % 2 === 0,
	})),
	total: 500,
	page: 1,
};

const largePayload = {
	trades: Array.from({ length: 100 }, (_, i) => ({
		id: `trade-${i}`,
		market: `0x${"a".repeat(40)}`,
		side: i % 2 === 0 ? "BUY" : "SELL",
		price: 0.5 + Math.random() * 0.5,
		size: Math.floor(Math.random() * 10000),
		timestamp: Date.now() - i * 1000,
		metadata: {
			source: "polymarket",
			confidence: 0.95,
			tags: ["crypto", "prediction", "market"],
		},
	})),
	summary: {
		totalVolume: 1234567.89,
		avgPrice: 0.65,
		count: 100,
	},
};

// Create protocols for each codec
const jsonProtocol = createProtocol(createJsonCodec(RpcMessageSchema));
const msgpackProtocol = createProtocol(createMsgpackCodec(RpcMessageSchema));
const cborProtocol = createProtocol(createCborCodec(RpcMessageSchema));

interface BenchConnection {
	server: RpcServer<typeof BenchSchema, typeof BenchSchema>;
	client: RpcClient<typeof BenchSchema, typeof BenchSchema>;
	close: () => void;
}

async function createConnection(
	port: number,
	protocol: RpcProtocol,
): Promise<BenchConnection> {
	const provider = {
		echo: async (input: { data: unknown }) => ({ data: input.data }),
	};

	const server = new RpcServer({
		wss: { port },
		WebSocketServer: WebSocketServer as unknown as new () => IWebSocketServer,
		localSchema: BenchSchema,
		remoteSchema: BenchSchema,
		provider,
		protocol,
	});

	const client = new RpcClient({
		url: `ws://localhost:${port}`,
		WebSocket: WebSocket as unknown as new (url: string) => IWebSocket,
		localSchema: BenchSchema,
		remoteSchema: BenchSchema,
		provider,
		protocol,
		reconnect: false,
	});

	await client.connect();

	return {
		server,
		client,
		close: () => {
			client.disconnect();
			server.close();
		},
	};
}

// Track connections for cleanup
const connections: BenchConnection[] = [];

// Log wire sizes
const logSizes = () => {
	const getSize = (data: string | Uint8Array) =>
		typeof data === "string" ? data.length : data.byteLength;

	const jsonSmall = jsonProtocol.createRequest("1", "echo", {
		data: smallPayload,
	});
	const msgpackSmall = msgpackProtocol.createRequest("1", "echo", {
		data: smallPayload,
	});
	const cborSmall = cborProtocol.createRequest("1", "echo", {
		data: smallPayload,
	});

	const jsonMedium = jsonProtocol.createRequest("1", "echo", {
		data: mediumPayload,
	});
	const msgpackMedium = msgpackProtocol.createRequest("1", "echo", {
		data: mediumPayload,
	});
	const cborMedium = cborProtocol.createRequest("1", "echo", {
		data: mediumPayload,
	});

	const jsonLarge = jsonProtocol.createRequest("1", "echo", {
		data: largePayload,
	});
	const msgpackLarge = msgpackProtocol.createRequest("1", "echo", {
		data: largePayload,
	});
	const cborLarge = cborProtocol.createRequest("1", "echo", {
		data: largePayload,
	});

	console.log("\n📊 Wire sizes (request):");
	console.log(
		`  Small:  JSON=${getSize(jsonSmall)}B, MsgPack=${getSize(msgpackSmall)}B, CBOR=${getSize(cborSmall)}B`,
	);
	console.log(
		`  Medium: JSON=${getSize(jsonMedium)}B, MsgPack=${getSize(msgpackMedium)}B, CBOR=${getSize(cborMedium)}B`,
	);
	console.log(
		`  Large:  JSON=${getSize(jsonLarge)}B, MsgPack=${getSize(msgpackLarge)}B, CBOR=${getSize(cborLarge)}B`,
	);
	console.log();
};

logSizes();

// Connections for each codec
let jsonConn: BenchConnection;
let msgpackConn: BenchConnection;
let cborConn: BenchConnection;

beforeAll(async () => {
	jsonConn = await createConnection(9100, jsonProtocol);
	msgpackConn = await createConnection(9101, msgpackProtocol);
	cborConn = await createConnection(9102, cborProtocol);
	connections.push(jsonConn, msgpackConn, cborConn);
});

afterAll(() => {
	for (const conn of connections) {
		conn.close();
	}
});

// Benchmark options for stable results
const benchOpts = {
	time: 2000,
	iterations: 100,
	warmupTime: 500,
	warmupIterations: 20,
};

describe("Small payload - RPC roundtrip", () => {
	bench(
		"JSON",
		async () => {
			await jsonConn.client.driver.echo({ data: smallPayload });
		},
		benchOpts,
	);

	bench(
		"MessagePack",
		async () => {
			await msgpackConn.client.driver.echo({ data: smallPayload });
		},
		benchOpts,
	);

	bench(
		"CBOR",
		async () => {
			await cborConn.client.driver.echo({ data: smallPayload });
		},
		benchOpts,
	);
});

describe("Medium payload - RPC roundtrip", () => {
	bench(
		"JSON",
		async () => {
			await jsonConn.client.driver.echo({ data: mediumPayload });
		},
		benchOpts,
	);

	bench(
		"MessagePack",
		async () => {
			await msgpackConn.client.driver.echo({ data: mediumPayload });
		},
		benchOpts,
	);

	bench(
		"CBOR",
		async () => {
			await cborConn.client.driver.echo({ data: mediumPayload });
		},
		benchOpts,
	);
});

describe("Large payload - RPC roundtrip", () => {
	bench(
		"JSON",
		async () => {
			await jsonConn.client.driver.echo({ data: largePayload });
		},
		benchOpts,
	);

	bench(
		"MessagePack",
		async () => {
			await msgpackConn.client.driver.echo({ data: largePayload });
		},
		benchOpts,
	);

	bench(
		"CBOR",
		async () => {
			await cborConn.client.driver.echo({ data: largePayload });
		},
		benchOpts,
	);
});
