import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		include: ["tests/**/*.test.ts"],
		exclude: ["tests/do/**/*.test.ts"],
		benchmark: { include: ["tests/**/*.bench.ts"] },
		coverage: {
			provider: "v8",
		},
		pool: "vmThreads",
		poolOptions: { vmThreads: { maxThreads: 4, useAtomics: true } },
	},
});
