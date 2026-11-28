import { taskResourceFiles } from "../shared/task-resource-files.js";
import { fileURLToPath } from "node:url";
import type { RuntimeInstallation } from "../../core/contracts/environment.js";

export const CODEX_VERSION = "0.167.0";
export const CODEX_ENTRY = "node_modules/@openai/codex/bin/codex.js";

export async function codexRuntimeInstallation(signal: AbortSignal): Promise<RuntimeInstallation> {
  signal.throwIfAborted();
  return {
    id: `codex:${CODEX_VERSION}`,
    cacheName: `codex-${CODEX_VERSION}`,
    files: [
      ...taskResourceFiles(),
      { source: fileURLToPath(new URL("../shared/assets/codex-skill-config.mjs", import.meta.url)), target: "codex-skill-config.mjs" },
      { source: fileURLToPath(new URL("../shared/assets/model-relay.mjs", import.meta.url)), target: "runtimes/shared/assets/model-relay.mjs" },
      ...["package.json", "package-lock.json", "launch.mjs"].map(target => ({
        source: fileURLToPath(new URL(`./assets/${target}`, import.meta.url)), target,
      })),
      { source: fileURLToPath(new URL("../shared/assets/stage-attachments.mjs", import.meta.url)), target: "stage-attachments.mjs" },
    ],
    commands: [{ executable: "npm", args: ["ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"] }],
    probes: [{
      executable: "node",
      args: ["--eval", [
        "const { execFileSync } = require('node:child_process');",
        "const [entry, expected] = process.argv.slice(1);",
        "const actual = execFileSync(process.execPath, [entry, '--version'], { encoding: 'utf8' }).trim();",
        "if (actual !== expected) throw Error('unexpected Codex CLI version: ' + actual);",
      ].join("\n"), CODEX_ENTRY, `codex-cli ${CODEX_VERSION}`],
    }],
  };
}
