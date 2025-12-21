import { beforeEach, describe } from "vitest";
import type { PendingCall } from "../src/storage/interface.js";
import { MemoryPendingCallStorage } from "../src/storage/memory.js";

describe("MemoryPendingCallStorage", (it) => {
	let storage: MemoryPendingCallStorage;

	const createCall = (
		id: string,
		overrides: Partial<PendingCall> = {},
	): PendingCall => ({
		id,
		method: "testMethod",
		params: { value: "test" },
		callback: "onTestComplete",
		sentAt: Date.now(),
		timeoutAt: Date.now() + 30000,
		...overrides,
	});

	beforeEach(() => {
		storage = new MemoryPendingCallStorage();
	});

	describe("mode", (it) => {
		it("should be sync", ({ expect }) => {
			expect(storage.mode).toBe("sync");
		});
	});

	describe("save", (it) => {
		it("should store a pending call", ({ expect }) => {
			const call = createCall("call-1");
			storage.save(call);
			expect(storage.size).toBe(1);
		});

		it("should overwrite existing call with same ID", ({ expect }) => {
			const call1 = createCall("call-1", { method: "method1" });
			const call2 = createCall("call-1", { method: "method2" });

			storage.save(call1);
			storage.save(call2);

			expect(storage.size).toBe(1);
			expect(storage.get("call-1")?.method).toBe("method2");
		});
	});

	describe("get", (it) => {
		it("should return call by ID", ({ expect }) => {
			const call = createCall("call-1");
			storage.save(call);

			const retrieved = storage.get("call-1");
			expect(retrieved).toEqual(call);
		});

		it("should return null for unknown ID", ({ expect }) => {
			expect(storage.get("unknown")).toBeNull();
		});

		it("should return a copy, not the original", ({ expect }) => {
			const call = createCall("call-1");
			storage.save(call);

			const retrieved = storage.get("call-1");
			if (retrieved) {
				retrieved.method = "modified";
			}

			expect(storage.get("call-1")?.method).toBe("testMethod");
		});
	});

	describe("delete", (it) => {
		it("should remove call and return true", ({ expect }) => {
			const call = createCall("call-1");
			storage.save(call);

			const deleted = storage.delete("call-1");
			expect(deleted).toBe(true);
			expect(storage.get("call-1")).toBeNull();
			expect(storage.size).toBe(0);
		});

		it("should return false for unknown ID", ({ expect }) => {
			expect(storage.delete("unknown")).toBe(false);
		});
	});

	describe("listExpired", (it) => {
		it("should return calls that have exceeded timeout", ({ expect }) => {
			const now = Date.now();
			const expired1 = createCall("expired-1", { timeoutAt: now - 1000 });
			const expired2 = createCall("expired-2", { timeoutAt: now - 500 });
			const notExpired = createCall("not-expired", { timeoutAt: now + 1000 });

			storage.save(expired1);
			storage.save(expired2);
			storage.save(notExpired);

			const expired = storage.listExpired(now);
			expect(expired.length).toBe(2);
			expect(expired.map((c) => c.id)).toContain("expired-1");
			expect(expired.map((c) => c.id)).toContain("expired-2");
		});

		it("should return empty array when no calls are expired", ({ expect }) => {
			const call = createCall("call-1", { timeoutAt: Date.now() + 10000 });
			storage.save(call);

			expect(storage.listExpired(Date.now())).toEqual([]);
		});

		it("should sort by timeoutAt ascending", ({ expect }) => {
			const now = Date.now();
			storage.save(createCall("later", { timeoutAt: now - 100 }));
			storage.save(createCall("earlier", { timeoutAt: now - 200 }));

			const expired = storage.listExpired(now);
			expect(expired[0]?.id).toBe("earlier");
			expect(expired[1]?.id).toBe("later");
		});
	});

	describe("listAll", (it) => {
		it("should return all calls", ({ expect }) => {
			storage.save(createCall("call-1"));
			storage.save(createCall("call-2"));
			storage.save(createCall("call-3"));

			const all = storage.listAll();
			expect(all.length).toBe(3);
		});

		it("should return empty array when no calls", ({ expect }) => {
			expect(storage.listAll()).toEqual([]);
		});

		it("should sort by sentAt ascending", ({ expect }) => {
			const now = Date.now();
			storage.save(createCall("later", { sentAt: now + 100 }));
			storage.save(createCall("earlier", { sentAt: now - 100 }));

			const all = storage.listAll();
			expect(all[0]?.id).toBe("earlier");
			expect(all[1]?.id).toBe("later");
		});
	});

	describe("clear", (it) => {
		it("should remove all calls", ({ expect }) => {
			storage.save(createCall("call-1"));
			storage.save(createCall("call-2"));

			storage.clear();
			expect(storage.size).toBe(0);
			expect(storage.listAll()).toEqual([]);
		});
	});
});
