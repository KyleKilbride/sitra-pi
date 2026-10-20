import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		// Never start a real background learner (it would call a model) from a test.
		env: { SITRA_LEARN_SPAWN: "0" },
		include: ["test/**/*.test.ts"],
	},
});
