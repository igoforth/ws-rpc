/**
 * Memory Pending Call Storage
 *
 * In-memory storage implementation for testing purposes.
 * Synchronous mode for compatibility with DurableRpcPeer tests.
 */

import { type StringCodec } from "../codecs/index.js";
import type { PendingCall, SyncPendingCallStorage } from "./interface.js";

/**
 * Options for memory pending call storage
 */
export interface MemoryPendingCallStorageOptions {
	/**
	 * Codec for serializing/deserializing params
	 *
	 * While memory storage doesn't strictly need serialization,
	 * using a codec ensures consistency with SQL storage and
	 * validates that params can be round-tripped.
	 */
	paramsCodec?: StringCodec;
}

/**
 * In-memory pending call storage for testing
 *
 * Optionally round-trips params through a codec for consistency testing.
 */
export class MemoryPendingCallStorage implements SyncPendingCallStorage {
	readonly mode = "sync" as const;
	private readonly calls = new Map<string, PendingCall>();
	private readonly paramsCodec: StringCodec | null;

	constructor(options?: MemoryPendingCallStorageOptions) {
		// Only use codec if explicitly provided (for testing codec behavior)
		this.paramsCodec = options?.paramsCodec ?? null;
	}

	save(call: PendingCall): void {
		// Optionally round-trip params through codec
		const params = this.paramsCodec
			? this.paramsCodec.decode(this.paramsCodec.encode(call.params))
			: call.params;

		this.calls.set(call.id, { ...call, params });
	}

	get(id: string): PendingCall | null {
		const call = this.calls.get(id);
		return call ? { ...call } : null;
	}

	delete(id: string): boolean {
		return this.calls.delete(id);
	}

	listExpired(before: number): PendingCall[] {
		const expired: PendingCall[] = [];
		for (const call of this.calls.values()) {
			if (call.timeoutAt <= before) {
				expired.push({ ...call });
			}
		}
		return expired.sort((a, b) => a.timeoutAt - b.timeoutAt);
	}

	listAll(): PendingCall[] {
		return [...this.calls.values()]
			.map((c) => ({ ...c }))
			.sort((a, b) => a.sentAt - b.sentAt);
	}

	clear(): void {
		this.calls.clear();
	}

	/**
	 * Get the number of stored calls (for testing)
	 */
	get size(): number {
		return this.calls.size;
	}
}
