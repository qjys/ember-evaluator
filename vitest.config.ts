import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

const pluginRoot = fileURLToPath(new URL("./plugins/", import.meta.url));
const pluginTests = readdirSync(pluginRoot, { withFileTypes: true })
  .filter(entry => entry.isDirectory() && existsSync(join(pluginRoot, entry.name, "ember-plugin.json")))
  .map(entry => `plugins/${entry.name}/tests/**/*.test.ts`);

export default defineConfig({
  resolve: {
    alias: {
      "ember-evaluator": fileURLToPath(new URL("./src/index.ts", import.meta.url)),
    },
  },
  test: {
    setupFiles: ["tests/fixtures/test-home.ts"],
    watch: false,
    // Several files spawn Node/npm processes; keep filesystem/process pressure
    // bounded instead of scaling their startup cost with every host CPU.
    maxWorkers: 4,
    include: [
      ...pluginTests,
      "tests/unit/**/*.test.ts",
      "tests/integration/**/*.test.ts",
    ],
    passWithNoTests: false,
  },
});
