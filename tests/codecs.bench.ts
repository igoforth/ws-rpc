/**
 * Wire Protocol End-to-End Benchmarks
 *
 * Measures real WebSocket round-trip performance through RpcPeer
 * using JSON, MessagePack, and CBOR codecs.
 */

import { afterAll, beforeAll, bench, describe } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import * as z from "zod";
import { createCborCodec } from "../src/codecs/cbor.js";
import { createJsonCodec } from "../src/codecs/json.js";
import { createMsgpackCodec } from "../src/codecs/msgpack.js";
import { RpcPeer } from "../src/peers/default.js";
import { createProtocol, RpcMessageSchema } from "../src/protocol.js";
import { method, type RpcSchema } from "../src/schema.js";

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
	server: WebSocketServer;
	serverPeer: RpcPeer<typeof BenchSchema, typeof BenchSchema>;
	clientPeer: RpcPeer<typeof BenchSchema, typeof BenchSchema>;
	clientWs: WebSocket;
	close: () => Promise<void>;
}

async function createConnection(
	port: number,
	protocol: ReturnType<typeof createProtocol>,
): Promise<BenchConnection> {
	return new Promise((resolve, reject) => {
		const server = new WebSocketServer({ port });

		server.on("error", reject);

		server.on("connection", (serverWs) => {
			// Server peer - echo handler
			const serverPeer = new RpcPeer({
				ws: serverWs,
				localSchema: BenchSchema,
				remoteSchema: BenchSchema,
				provider: {
					echo: async (input) => ({ data: input.data }),
				},
				protocol,
			});

			serverWs.on("message", (data) => {
				serverPeer.handleMessage(data);
			});

			// Create client connection
			const clientWs = new WebSocket(`ws://localhost:${port}`);

			clientWs.on("open", () => {
				const clientPeer = new RpcPeer({
					ws: clientWs,
					localSchema: BenchSchema,
					remoteSchema: BenchSchema,
					provider: {
						echo: async (input) => ({ data: input.data }),
					},
					protocol,
				});

				clientWs.on("message", (data) => {
					clientPeer.handleMessage(data);
				});

				resolve({
					server,
					serverPeer,
					clientPeer,
					clientWs,
					close: async () => {
						clientWs.close();
						server.close();
						await new Promise((r) => setTimeout(r, 50));
					},
				});
			});

			clientWs.on("error", reject);
		});

		// Trigger connection by creating a dummy client
		const trigger = new WebSocket(`ws://localhost:${port}`);
		trigger.on("open", () => trigger.close());
	});
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

afterAll(async () => {
	for (const conn of connections) {
		await conn.close();
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
			await jsonConn.clientPeer.driver.echo({ data: smallPayload });
		},
		benchOpts,
	);

	bench(
		"MessagePack",
		async () => {
			await msgpackConn.clientPeer.driver.echo({ data: smallPayload });
		},
		benchOpts,
	);

	bench(
		"CBOR",
		async () => {
			await cborConn.clientPeer.driver.echo({ data: smallPayload });
		},
		benchOpts,
	);
});

describe("Medium payload - RPC roundtrip", () => {
	bench(
		"JSON",
		async () => {
			await jsonConn.clientPeer.driver.echo({ data: mediumPayload });
		},
		benchOpts,
	);

	bench(
		"MessagePack",
		async () => {
			await msgpackConn.clientPeer.driver.echo({ data: mediumPayload });
		},
		benchOpts,
	);

	bench(
		"CBOR",
		async () => {
			await cborConn.clientPeer.driver.echo({ data: mediumPayload });
		},
		benchOpts,
	);
});

describe("Large payload - RPC roundtrip", () => {
	bench(
		"JSON",
		async () => {
			await jsonConn.clientPeer.driver.echo({ data: largePayload });
		},
		benchOpts,
	);

	bench(
		"MessagePack",
		async () => {
			await msgpackConn.clientPeer.driver.echo({ data: largePayload });
		},
		benchOpts,
	);

	bench(
		"CBOR",
		async () => {
			await cborConn.clientPeer.driver.echo({ data: largePayload });
		},
		benchOpts,
	);
});
