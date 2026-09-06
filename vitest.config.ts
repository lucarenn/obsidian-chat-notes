import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
	resolve: {
		alias: {
			// types-only package; see tests/stubs/obsidian.ts
			obsidian: fileURLToPath(new URL("./tests/stubs/obsidian.ts", import.meta.url)),
		},
	},
	test: {
		// the format layer is pure string handling - no DOM needed
		environment: "node",
		include: ["tests/**/*.test.ts"],
	},
});
