import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersConfig({
	test: {
		include: ["tests/**/*.test.ts"],
		benchmark: { include: ["tests/**/*.bench.ts"] },
		coverage: {
			provider: "istanbul",
		},
		poolOptions: {
			workers: {
				main: "./tests/fixtures/test-do.ts",
				singleWorker: true,
				isolatedStorage: true,
				wrangler: {
					configPath: "./wrangler.jsonc",
				},
			},
		},
	},
});
