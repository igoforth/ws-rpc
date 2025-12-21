# @igoforth/ws-rpc

[![CI](https://github.com/igoforth/ws-rpc/actions/workflows/ci.yml/badge.svg)](https://github.com/igoforth/ws-rpc/actions/workflows/ci.yml)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.0+-3178c6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Node](https://img.shields.io/badge/Node.js-18+-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

Bidirectional RPC over WebSocket with Zod schema validation and full TypeScript inference.

## Features

- **Bidirectional RPC** - Both client and server can call methods on each other
- **Schema-first** - Define your API with Zod schemas, get full TypeScript inference
- **Multiple codecs** - JSON (built-in), MessagePack, and CBOR support
- **Cloudflare Durable Objects** - First-class support with hibernation-safe persistence
- **Auto-reconnect** - Client automatically reconnects with exponential backoff
- **Fire-and-forget events** - Decoupled from request/response pattern

## Installation

```bash
npm install @igoforth/ws-rpc zod
# or
pnpm add @igoforth/ws-rpc zod
```

### Optional codecs

```bash
# MessagePack (faster, smaller)
pnpm add @msgpack/msgpack

# CBOR (binary, compact)
pnpm add cbor-x
```

### Cloudflare Durable Objects

```bash
pnpm add @cloudflare/actors
```

## Quick Start

### 1. Define your schema

```typescript
import { z } from "zod";
import { method, event, type RpcSchema } from "@igoforth/ws-rpc/schema";

// Server schema - methods the server implements
export const ServerSchema = {
  methods: {
    getUser: method({
      input: z.object({ id: z.string() }),
      output: z.object({ name: z.string(), email: z.string() }),
    }),
    createOrder: method({
      input: z.object({ product: z.string(), quantity: z.number() }),
      output: z.object({ orderId: z.string() }),
    }),
  },
  events: {
    orderUpdated: event({
      data: z.object({ orderId: z.string(), status: z.string() }),
    }),
  },
} satisfies RpcSchema;

// Client schema - methods the client implements (for bidirectional RPC)
export const ClientSchema = {
  methods: {
    ping: method({
      input: z.object({}),
      output: z.object({ pong: z.boolean() }),
    }),
  },
  events: {},
} satisfies RpcSchema;
```

### 2. Create a client

```typescript
import { RpcClient } from "@igoforth/ws-rpc/adapters/client";
import { ServerSchema, ClientSchema } from "./schemas";

const client = new RpcClient({
  url: "wss://your-server.com/ws",
  localSchema: ClientSchema,
  remoteSchema: ServerSchema,
  provider: {
    // Implement methods the server can call on us
    ping: async () => ({ pong: true }),
  },
  reconnect: {
    initialDelay: 1000,
    maxDelay: 30000,
    maxAttempts: 10,
  },
  autoConnect: true, // Connect immediately (or call client.connect() manually)
  onConnect: () => console.log("Connected"),
  onDisconnect: (code, reason) => console.log("Disconnected:", code, reason),
});

// Call server methods with full type safety
const user = await client.driver.getUser({ id: "123" });
console.log(user.name, user.email);

const order = await client.driver.createOrder({ product: "widget", quantity: 5 });
console.log(order.orderId);

// Emit events to the server
client.emit("someEvent", { data: "value" });

// Disconnect when done
client.disconnect();
```

### 3. Create a server (Node.js)

```typescript
import { WebSocketServer } from "ws";
import { RpcServer } from "@igoforth/ws-rpc/adapters/server";
import { ServerSchema, ClientSchema } from "./schemas";

const server = new RpcServer({
  wss: { port: 8080 },
  WebSocketServer,
  localSchema: ServerSchema,
  remoteSchema: ClientSchema,
  provider: {
    getUser: async ({ id }) => {
      return { name: "John Doe", email: "john@example.com" };
    },
    createOrder: async ({ product, quantity }) => {
      return { orderId: crypto.randomUUID() };
    },
  },
  hooks: {
    onConnect: (peer) => {
      console.log(`Client ${peer.id} connected`);

      // Call methods on this specific client
      peer.driver.ping({}).then((result) => {
        console.log("Client responded:", result.pong);
      });
    },
    onDisconnect: (peer) => {
      console.log(`Client ${peer.id} disconnected`);
    },
    onError: (peer, error) => {
      console.error(`Error from ${peer?.id}:`, error);
    },
  },
});

// Emit to all connected clients
server.emit("orderUpdated", { orderId: "123", status: "shipped" });

// Emit to specific clients by ID
server.emit("orderUpdated", { orderId: "456", status: "delivered" }, ["peer-id-1", "peer-id-2"]);

// Call methods on all clients
const results = await server.driver.ping({});
for (const { id, result } of results) {
  if (result.success) {
    console.log(`Peer ${id}:`, result.value);
  }
}

// Get connection info
console.log("Connected clients:", server.getConnectionCount());
console.log("Client IDs:", server.getConnectionIds());

// Close a specific client
server.closePeer("peer-id", 1000, "Goodbye");

// Graceful shutdown
process.on("SIGTERM", () => server.close());
```

### 4. Cloudflare Durable Object

```typescript
import { Actor } from "@cloudflare/actors";
import { withRpc } from "@igoforth/ws-rpc/adapters/cloudflare-do";
import { RpcPeer } from "@igoforth/ws-rpc/peers";
import { ServerSchema, ClientSchema } from "./schemas";

// First, create an Actor with the RPC method implementations
// Methods from localSchema MUST be defined here for type checking
class GameRoomActor extends Actor<Env> {
  protected gameState = { players: [] as string[] };

  // Implement methods from ServerSchema
  async getUser({ id }: { id: string }) {
    return { name: `Player ${id}`, email: `${id}@game.com` };
  }

  async createOrder({ product, quantity }: { product: string; quantity: number }) {
    return { orderId: crypto.randomUUID() };
  }
}

// Then apply the RPC mixin to get driver, emit, etc.
export class GameRoom extends withRpc(GameRoomActor, {
  localSchema: ServerSchema,
  remoteSchema: ClientSchema,
}) {
  // Use this.driver to call methods on connected clients
  async notifyAllPlayers() {
    const results = await this.driver.ping({});
    console.log("Ping results:", results);
  }

  // Use this.emit to send events to clients
  broadcastUpdate() {
    this.emit("orderUpdated", { orderId: "123", status: "updated" });
  }

  // Check connection status
  getPlayerCount() {
    return this.getConnectionCount();
  }

  // Override RPC lifecycle hooks
  protected override onRpcConnect(peer: RpcPeer<typeof ServerSchema, typeof ClientSchema>) {
    console.log(`Player ${peer.id} joined`);
  }

  protected override onRpcDisconnect(peer: RpcPeer<typeof ServerSchema, typeof ClientSchema>) {
    console.log(`Player ${peer.id} left`);
  }

  protected override onRpcError(
    peer: RpcPeer<typeof ServerSchema, typeof ClientSchema> | null,
    error: Error,
  ) {
    console.error(`Error from ${peer?.id}:`, error);
  }

  protected override onRpcPeerRecreated(
    peer: RpcPeer<typeof ServerSchema, typeof ClientSchema>,
    ws: WebSocket,
  ) {
    console.log(`Player ${peer.id} recovered from hibernation`);
  }
}
```

## Hibernation-Safe Durable Objects

For Cloudflare Durable Objects that need hibernation-safe outgoing calls, use `DurableRpcPeer` with continuation-passing style:

```typescript
import { DurableRpcPeer } from "@igoforth/ws-rpc/peer";
import { SqlPendingCallStorage } from "@igoforth/ws-rpc/storage";

class MyDO extends Actor<Env> {
  private peer!: DurableRpcPeer<LocalSchema, RemoteSchema, this>;

  onWebSocketConnect(ws: WebSocket) {
    this.peer = new DurableRpcPeer({
      ws,
      localSchema: LocalSchema,
      remoteSchema: RemoteSchema,
      provider: this,
      storage: new SqlPendingCallStorage(this.ctx.storage.sql),
      actor: this,
    });
  }

  onWebSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
    this.peer.handleMessage(message);
  }

  async doSomething() {
    // Promise-based (NOT hibernation-safe - pending if DO hibernates)
    const result = await this.peer.driver.someMethod({ data: "value" });

    // Continuation-based (hibernation-safe)
    this.peer.callWithCallback("someMethod", { data: "value" }, "onResult");
  }

  // Callback receives result even after hibernation
  onResult(result: SomeResult, context: CallContext) {
    console.log("Result:", result);
    console.log("Latency:", context.latencyMs, "ms");
  }
}
```

## Performance

Real WebSocket RPC round-trip benchmarks (GitHub Actions runner, Node.js 22):

**Wire sizes:**
| Payload | JSON | MessagePack | CBOR |
|---------|------|-------------|------|
| Small | 93 B | 71 B | 112 B |
| Medium | 3.4 KB | 2.1 KB | 1.3 KB |
| Large | 24.4 KB | 19.5 KB | 14.1 KB |

**Throughput (ops/sec):**
| Payload | JSON | MessagePack | CBOR | Fastest |
|---------|------|-------------|------|---------|
| Small | 0 | 0 | 0 | JSON |
| Medium | 0 | 0 | 0 | JSON |
| Large | 0 | 0 | 0 | JSON |

> Benchmarks run automatically via GitHub Actions. Results may vary based on runner load.
> Run locally with `pnpm bench` for your environment.

## Multi-Peer Driver Results

When calling methods via `server.driver` or `this.driver` in a Durable Object, results are returned as an array:

```typescript
// Call all connected peers
const results = await server.driver.getData({});

// Each result contains the peer ID and success/error
for (const { id, result } of results) {
  if (result.success) {
    console.log(`Peer ${id} returned:`, result.value);
  } else {
    console.error(`Peer ${id} failed:`, result.error.message);
  }
}

// Call specific peers
const singleResult = await server.driver.getData({}, { ids: "peer-123" });
const multiResult = await server.driver.getData({}, {
  ids: ["peer-1", "peer-2"],
  timeout: 5000,
});
```

## License

MIT
