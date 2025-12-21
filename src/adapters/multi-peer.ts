/**
 * Multi-Peer Base Class
 *
 * Abstract base class for adapters managing multiple RPC peers.
 * Extended by RpcServer and Cloudflare DO adapter.
 */

import { RpcPeer } from "../peers/default.js";
import type { RpcProtocol } from "../protocol.js";
import type {
	EventDef,
	InferEventData,
	Provider,
	RpcSchema,
	StringKeys,
} from "../schema.js";
import type { IMinWebSocket } from "../types.js";
import type {
	IMultiAdapterHooks,
	IMultiConnectionAdapter,
	MultiCallOptions,
	MultiCallResult,
	MultiDriver,
} from "./types.js";

/**
 * Options for creating a MultiPeerBase subclass
 */
export interface MultiPeerOptions<
	TLocalSchema extends RpcSchema,
	TRemoteSchema extends RpcSchema,
> {
	/** Schema defining local methods we implement */
	localSchema: TLocalSchema;
	/** Schema defining remote methods we can call */
	remoteSchema: TRemoteSchema;
	/** Implementation of local methods */
	provider: Provider<TLocalSchema["methods"]>;
	/** Default timeout for RPC calls in ms */
	timeout?: number;
	/** Protocol for encoding/decoding messages */
	protocol?: RpcProtocol;
	/** Lifecycle hooks */
	hooks?: IMultiAdapterHooks<TLocalSchema, TRemoteSchema>;
}

/**
 * Abstract base class for multi-peer adapters
 *
 * Provides shared functionality for managing multiple RPC peers:
 * - Driver for calling methods on multiple peers
 * - Broadcast emit to all peers
 * - Peer lookup by ID
 * - Connection count/IDs
 *
 * @typeParam TLocalSchema - Schema for methods/events this side provides
 * @typeParam TRemoteSchema - Schema for methods/events the remote side provides
 * @typeParam TConnection - Connection type (IWebSocket, WebSocket, etc.)
 */
export abstract class MultiPeerBase<
	TLocalSchema extends RpcSchema,
	TRemoteSchema extends RpcSchema,
	TConnection,
> implements IMultiConnectionAdapter<TLocalSchema, TRemoteSchema>
{
	protected readonly peers = new Map<
		TConnection,
		RpcPeer<TLocalSchema, TRemoteSchema>
	>();

	/** Local schema */
	public readonly localSchema: TLocalSchema;

	/** Remote schema */
	public readonly remoteSchema: TRemoteSchema;

	/** Implementation of local methods */
	public readonly provider: Provider<TLocalSchema["methods"]>;

	/** Default timeout for RPC calls */
	public readonly timeout: number;

	/** Protocol for encoding/decoding messages */
	public readonly protocol?: RpcProtocol;

	/** Lifecycle hooks */
	public readonly hooks: IMultiAdapterHooks<TLocalSchema, TRemoteSchema>;

	constructor(options: MultiPeerOptions<TLocalSchema, TRemoteSchema>) {
		this.localSchema = options.localSchema;
		this.remoteSchema = options.remoteSchema;
		this.provider = options.provider;
		this.timeout = options.timeout ?? 30000;
		if (options.protocol) this.protocol = options.protocol;
		this.hooks = options.hooks ?? {};
	}

	// =========================================================================
	// Peer Creation
	// =========================================================================

	/**
	 * Create an RPC peer for a WebSocket connection.
	 * Subclasses can override to customize peer creation.
	 */
	protected createPeer(
		ws: IMinWebSocket,
	): RpcPeer<TLocalSchema, TRemoteSchema> {
		return new RpcPeer<TLocalSchema, TRemoteSchema>({
			ws,
			localSchema: this.localSchema,
			remoteSchema: this.remoteSchema,
			provider: this.provider,
			...(this.protocol !== undefined && { protocol: this.protocol }),
			onEvent: this.hooks.onEvent
				? (event, data) => {
						const peer = this.findPeerByWs(ws);
						if (peer) {
							(
								this.hooks.onEvent as (
									peer: RpcPeer<TLocalSchema, TRemoteSchema>,
									event: string,
									data: unknown,
								) => void
							)(peer, event, data);
						}
					}
				: undefined,
			timeout: this.timeout,
		});
	}

	/**
	 * Find peer by WebSocket (internal helper for event routing)
	 */
	private findPeerByWs(
		ws: IMinWebSocket,
	): RpcPeer<TLocalSchema, TRemoteSchema> | null {
		for (const peer of this.peers.values()) {
			if (peer.getWebSocket() === ws) {
				return peer;
			}
		}
		return null;
	}

	// =========================================================================
	// Peer Management
	// =========================================================================

	/**
	 * Add a peer (called by subclass when connection established)
	 */
	protected addPeer(
		connection: TConnection,
		peer: RpcPeer<TLocalSchema, TRemoteSchema>,
	): void {
		this.peers.set(connection, peer);
		this.hooks.onConnect?.(peer);
	}

	/**
	 * Remove a peer (called by subclass when connection closes)
	 */
	protected removePeer(
		connection: TConnection,
	): RpcPeer<TLocalSchema, TRemoteSchema> | null {
		const peer = this.peers.get(connection);
		if (peer) {
			peer.close();
			this.peers.delete(connection);
			this.hooks.onDisconnect?.(peer);
			return peer;
		}
		return null;
	}

	/**
	 * Get peer by connection object
	 */
	public getPeerFor(
		connection: TConnection,
	): RpcPeer<TLocalSchema, TRemoteSchema> | null {
		return this.peers.get(connection) ?? null;
	}

	/**
	 * Get peer by ID
	 */
	public getPeer(id: string): RpcPeer<TLocalSchema, TRemoteSchema> | null {
		for (const peer of this.peers.values()) {
			if (peer.id === id) {
				return peer;
			}
		}
		return null;
	}

	/**
	 * Find peer entry by ID (internal - includes connection)
	 */
	protected findPeerEntry(id: string): {
		peer: RpcPeer<TLocalSchema, TRemoteSchema>;
		connection: TConnection;
	} | null {
		for (const [connection, peer] of this.peers) {
			if (peer.id === id) {
				return { peer, connection };
			}
		}
		return null;
	}

	/**
	 * Get all peers
	 */
	public getPeers(): IterableIterator<RpcPeer<TLocalSchema, TRemoteSchema>> {
		return this.peers.values();
	}

	/**
	 * Get all open peer entries (internal)
	 */
	protected getOpenEntries(): Array<{
		peer: RpcPeer<TLocalSchema, TRemoteSchema>;
		connection: TConnection;
	}> {
		const result: Array<{
			peer: RpcPeer<TLocalSchema, TRemoteSchema>;
			connection: TConnection;
		}> = [];
		for (const [connection, peer] of this.peers) {
			if (peer.isOpen) result.push({ peer, connection });
		}
		return result;
	}

	// =========================================================================
	// IMultiConnectionAdapter Implementation
	// =========================================================================

	/**
	 * Get count of open connections
	 */
	public getConnectionCount(): number {
		let count = 0;
		for (const peer of this.peers.values()) {
			if (peer.isOpen) count++;
		}
		return count;
	}

	/**
	 * Get all open peer IDs
	 */
	public getConnectionIds(): string[] {
		const ids: string[] = [];
		for (const peer of this.peers.values()) {
			if (peer.isOpen) ids.push(peer.id);
		}
		return ids;
	}

	/**
	 * Driver for calling remote methods on connected peers
	 *
	 * @returns MultiDriver proxy for calling methods on all or specific peers
	 */
	public get driver(): MultiDriver<TRemoteSchema> {
		return this.createMultiDriver();
	}

	/**
	 * Emit an event to connected peers
	 *
	 * @param event - Event name from local schema
	 * @param data - Event data matching the schema
	 * @param ids - Optional array of peer IDs to emit to (broadcasts to all if omitted)
	 */
	public emit<K extends StringKeys<TLocalSchema["events"]>>(
		event: K,
		data: TLocalSchema["events"] extends Record<string, EventDef>
			? InferEventData<TLocalSchema["events"][K]>
			: never,
		ids?: string[],
	): void {
		const validPeers = ids
			? this.peers.values().filter((p) => ids.includes(p.id) && p.isOpen)
			: this.peers.values().filter((p) => p.isOpen);
		for (const peer of validPeers) peer.emit(event, data);
	}

	/**
	 * Close a specific peer by ID
	 *
	 * @param id - Peer ID to close
	 * @returns true if peer was found and closed, false otherwise
	 */
	public closePeer(id: string): boolean {
		const entry = this.findPeerEntry(id);
		if (entry) {
			entry.peer.close();
			this.peers.delete(entry.connection);
			this.hooks.onDisconnect?.(entry.peer);
			return true;
		}
		return false;
	}

	/**
	 * Close all peers
	 */
	protected closeAll(): void {
		for (const peer of this.peers.values()) {
			peer.close();
			this.hooks.onDisconnect?.(peer);
		}
		this.peers.clear();
		this.hooks.onClose?.();
	}

	// =========================================================================
	// Driver Implementation
	// =========================================================================

	/**
	 * Create a driver proxy for calling remote methods on multiple peers
	 */
	private createMultiDriver(): MultiDriver<TRemoteSchema> {
		const methods = this.remoteSchema.methods ?? {};
		const driver: Record<
			string,
			(input: unknown, options?: MultiCallOptions) => Promise<unknown>
		> = {};

		for (const methodName of Object.keys(methods)) {
			driver[methodName] = async (
				input: unknown,
				options?: MultiCallOptions,
			) => {
				return this.callMethod(methodName, input, options);
			};
		}

		return driver as MultiDriver<TRemoteSchema>;
	}

	/**
	 * Call a method on multiple peers with timeout handling
	 *
	 * @param method - Method name to call
	 * @param input - Method input parameters
	 * @param options - Call options including target peer IDs and timeout
	 * @returns Array of results from each peer (success or error)
	 */
	private async callMethod(
		method: string,
		input: unknown,
		options?: MultiCallOptions,
	): Promise<Array<MultiCallResult<unknown>>> {
		const ids = options?.ids;
		const timeout = options?.timeout ?? this.timeout;

		// Determine which peers to call
		let targetPeers: Array<RpcPeer<TLocalSchema, TRemoteSchema>>;

		if (ids === undefined) {
			targetPeers = Array.from(this.peers.values()).filter((p) => p.isOpen);
		} else if (typeof ids === "string") {
			const peer = this.getPeer(ids);
			targetPeers = peer?.isOpen ? [peer] : [];
		} else {
			targetPeers = ids
				.map((id) => this.getPeer(id))
				.filter(
					(p): p is RpcPeer<TLocalSchema, TRemoteSchema> => p?.isOpen === true,
				);
		}

		const promises = targetPeers.map(async (peer) => {
			try {
				const peerDriver = peer.driver as Record<
					string,
					(input: unknown) => Promise<unknown>
				>;
				const callPromise = peerDriver[method]!(input);

				const value = await Promise.race([
					callPromise,
					new Promise<never>((_, reject) =>
						setTimeout(
							() => reject(new Error(`Timeout after ${timeout}ms`)),
							timeout,
						),
					),
				]);

				return { id: peer.id, result: { success: true as const, value } };
			} catch (error) {
				return {
					id: peer.id,
					result: {
						success: false as const,
						error: error instanceof Error ? error : new Error(String(error)),
					},
				};
			}
		});

		return Promise.all(promises);
	}
}
