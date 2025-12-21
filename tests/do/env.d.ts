/// <reference types="@cloudflare/vitest-pool-workers" />
/// <reference path="../../worker-configuration.d.ts" />

import type { TestRpcDO } from "../fixtures/test-do.js";

/**
 * Test-only type that exposes protected/public members of TestRpcDO
 */
export type TestableRpcDO = TestRpcDO & {
	// Exposed for testing
	getReceivedEvents(): Array<{ event: string; data: unknown }>;
	clearReceivedEvents(): void;
	getCounter(): number;
	setCounter(value: number): void;
	getHibernationRecoveryCount(): number;
};

// Type augmentation for cloudflare:test env
declare module "cloudflare:test" {
	interface ProvidedEnv extends Env {
		TestRpcDO: DurableObjectNamespace<TestableRpcDO>;
	}
}
