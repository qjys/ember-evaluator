import { taskResourceFiles } from "../shared/task-resource-files.js";
import { fileURLToPath } from "node:url";
import type { RuntimeInstallation } from "../../core/contracts/environment.js";

export const CLAUDE_CODE_VERSION = "2.1.322";
export const CLAUDE_CODE_ENTRY = "node_modules/@anthropic-ai/claude-code/bin/claude.exe";

export async function claudeCodeRuntimeInstallation(signal: AbortSignal): Promise<RuntimeInstallation> {
  signal.throwIfAborted();
  return {
    id: `claudecode:${CLAUDE_CODE_VERSION}`,
    cacheName: `claudecode-${CLAUDE_CODE_VERSION}`,
    files: [
      ...taskResourceFiles(),
      ...["package.json", "package-lock.json", "launch.mjs", "search-hook.mjs"].map(target => ({
        source: fileURLToPath(new URL(`./assets/${target}`, import.meta.url)), target,
      })),
      { source: fileURLToPath(new URL("../shared/assets/model-relay.mjs", import.meta.url)), target: "runtimes/shared/assets/model-relay.mjs" },
    ],
    commands: [
      { executable: "npm", args: ["ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"] },
      { executable: "node", args: ["node_modules/@anthropic-ai/claude-code/install.cjs"] },
    ],
    probes: [{
      executable: "node",
      args: ["--eval", [
        "const { execFileSync } = require('node:child_process');",
        "const [entry, expected] = process.argv.slice(1);",
        "const actual = execFileSync(entry, ['--version'], { encoding: 'utf8' }).trim();",
        "if (actual !== expected) throw Error('unexpected Claude Code version: ' + actual);",
      ].join("\n"), CLAUDE_CODE_ENTRY, `${CLAUDE_CODE_VERSION} (Claude Code)`],
    }],
  };
}
