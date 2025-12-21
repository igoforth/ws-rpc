/**
 * SQL Pending Call Storage
 *
 * Synchronous storage implementation using Durable Object SQL storage.
 * Calls are persisted to SQLite and survive hibernation.
 */

import * as z from "zod";
import { createJsonCodec, type StringCodec } from "../codecs/index.js";
import type { PendingCall, SyncPendingCallStorage } from "./interface.js";

/**
 * SQL storage value types (matches Cloudflare SqlStorageValue)
 */
type SqlStorageValue = ArrayBuffer | string | number | null;

/**
 * Cursor returned by SqlStorage.exec()
 *
 * Compatible with Cloudflare's SqlStorageCursor.
 */
export interface SqlStorageCursor<T extends Record<string, SqlStorageValue>>
	extends Iterable<T> {
	next(): { done?: false; value: T } | { done: true; value?: never };
	toArray(): T[];
	one(): T;
	readonly rowsRead: number;
	readonly rowsWritten: number;
}

/**
 * Minimal SqlStorage interface for Durable Object SQL
 *
 * Compatible with `DurableObjectState.storage.sql` in Cloudflare Workers.
 */
export interface SqlStorage {
	exec<T extends Record<string, SqlStorageValue>>(
		query: string,
		...bindings: unknown[]
	): SqlStorageCursor<T>;
}

/**
 * Row shape from the pending calls table
 */
interface PendingCallRow extends Record<string, SqlStorageValue> {
	id: string;
	method: string;
	params: string;
	callback: string;
	sent_at: number;
	timeout_at: number;
}

/**
 * Table name for pending calls
 */
const TABLE_NAME = "_rpc_pending_calls";

/**
 * Default codec for params serialization (JSON)
 */
const defaultParamsCodec = createJsonCodec(z.unknown());

/**
 * Options for SQL pending call storage
 */
export interface SqlPendingCallStorageOptions {
	/**
	 * Codec for serializing/deserializing params
	 *
	 * Use a custom codec to support additional JavaScript types like
	 * Date, Map, Set, BigInt, etc.
	 *
	 * @example
	 * ```ts
	 * import superjson from "superjson";
	 * import { createStringCodecFactory } from "@igoforth/ws-rpc/codecs";
	 *
	 * const superJsonCodec = createStringCodecFactory(
	 *   superjson.stringify,
	 *   superjson.parse,
	 *   "superjson"
	 * );
	 *
	 * const storage = new SqlPendingCallStorage(sql, {
	 *   paramsCodec: superJsonCodec(z.unknown()),
	 * });
	 * ```
	 */
	paramsCodec?: StringCodec;
}

/**
 * SQL-backed pending call storage for Durable Objects
 *
 * Uses synchronous SQLite operations available in DO context.
 */
export class SqlPendingCallStorage implements SyncPendingCallStorage {
	readonly mode = "sync" as const;
	private readonly sql: SqlStorage;
	private readonly paramsCodec: StringCodec;
	private initialized = false;

	/**
	 * Create a SQL-backed pending call storage
	 *
	 * @param sql - Durable Object SQL storage instance
	 * @param options - Optional configuration including custom params codec
	 */
	constructor(sql: SqlStorage, options?: SqlPendingCallStorageOptions) {
		this.sql = sql;
		this.paramsCodec = options?.paramsCodec ?? defaultParamsCodec;
	}

	/**
	 * Ensure table exists (lazy initialization)
	 */
	private ensureTable(): void {
		if (this.initialized) return;

		this.sql.exec(`
			CREATE TABLE IF NOT EXISTS ${TABLE_NAME} (
				id TEXT PRIMARY KEY NOT NULL,
				method TEXT NOT NULL,
				params TEXT NOT NULL,
				callback TEXT NOT NULL,
				sent_at INTEGER NOT NULL,
				timeout_at INTEGER NOT NULL
			)
		`);

		// Index for timeout queries
		this.sql.exec(`
			CREATE INDEX IF NOT EXISTS idx_${TABLE_NAME}_timeout
			ON ${TABLE_NAME}(timeout_at)
		`);

		this.initialized = true;
	}

	/**
	 * Save a pending call to storage
	 *
	 * @param call - The pending call to persist
	 */
	save(call: PendingCall): void {
		this.ensureTable();

		const encodedParams = this.paramsCodec.encode(call.params);

		this.sql.exec(
			`INSERT OR REPLACE INTO ${TABLE_NAME}
			 (id, method, params, callback, sent_at, timeout_at)
			 VALUES (?, ?, ?, ?, ?, ?)`,
			call.id,
			call.method,
			encodedParams,
			call.callback,
			call.sentAt,
			call.timeoutAt,
		);
	}

	/**
	 * Get a pending call by ID
	 *
	 * @param id - The unique request ID
	 * @returns The pending call or null if not found
	 */
	get(id: string): PendingCall | null {
		this.ensureTable();

		const results = [
			...this.sql.exec<PendingCallRow>(
				`SELECT * FROM ${TABLE_NAME} WHERE id = ?`,
				id,
			),
		];

		const row = results[0];
		if (!row) return null;

		return this.rowToCall(row);
	}

	/**
	 * Delete a pending call by ID
	 *
	 * @param id - The unique request ID
	 * @returns true if the call existed and was deleted
	 */
	delete(id: string): boolean {
		this.ensureTable();

		// SQLite doesn't return affected rows easily, so check existence first
		const exists = this.get(id) !== null;
		if (exists) {
			this.sql.exec(`DELETE FROM ${TABLE_NAME} WHERE id = ?`, id);
		}
		return exists;
	}

	/**
	 * List all calls that have exceeded their timeout
	 *
	 * @param before - Unix timestamp (ms); returns calls with timeoutAt <= before
	 * @returns Array of expired pending calls ordered by timeout
	 */
	listExpired(before: number): PendingCall[] {
		this.ensureTable();

		const results = [
			...this.sql.exec<PendingCallRow>(
				`SELECT * FROM ${TABLE_NAME} WHERE timeout_at <= ? ORDER BY timeout_at ASC`,
				before,
			),
		];

		return results.map((row) => this.rowToCall(row));
	}

	/**
	 * List all pending calls
	 *
	 * @returns Array of all pending calls ordered by sent time
	 */
	listAll(): PendingCall[] {
		this.ensureTable();

		const results = [
			...this.sql.exec<PendingCallRow>(
				`SELECT * FROM ${TABLE_NAME} ORDER BY sent_at ASC`,
			),
		];

		return results.map((row) => this.rowToCall(row));
	}

	/**
	 * Delete all pending calls
	 */
	clear(): void {
		this.ensureTable();
		this.sql.exec(`DELETE FROM ${TABLE_NAME}`);
	}

	/**
	 * Convert a database row to a PendingCall
	 *
	 * @param row - Database row with call data
	 * @returns Deserialized pending call
	 */
	private rowToCall(row: PendingCallRow): PendingCall {
		const params = this.paramsCodec.decode(row.params);

		return {
			id: row.id,
			method: row.method,
			params,
			callback: row.callback,
			sentAt: row.sent_at,
			timeoutAt: row.timeout_at,
		};
	}
}
