import { taskResourceFiles } from "../shared/task-resource-files.js";
import { lockedCliPatch } from "../shared/locked-cli-patch.js";
import { fileURLToPath } from "node:url";
import type { RuntimeInstallation } from "../../core/contracts/environment.js";

export const CODEBUDDY_VERSION = "2.183.0";
export const CODEBUDDY_ENTRY = "node_modules/@tencent-ai/codebuddy-code/bin/codebuddy";

export async function codeBuddyRuntimeInstallation(signal: AbortSignal): Promise<RuntimeInstallation> {
  signal.throwIfAborted();
  const patch = await lockedCliPatch("codebuddy");
  return {
    id: `codebuddy:${CODEBUDDY_VERSION}:${patch.digest}`,
    cacheName: `codebuddy-${CODEBUDDY_VERSION}`,
    files: [
      ...taskResourceFiles(),
      ...patch.files,
      ...["package.json", "package-lock.json", "launch.mjs"].map(target => ({
        source: fileURLToPath(new URL(`./assets/${target}`, import.meta.url)), target,
      })),
      { source: fileURLToPath(new URL("../shared/assets/model-relay.mjs", import.meta.url)), target: "runtimes/shared/assets/model-relay.mjs" },
    ],
    commands: [{ executable: "npm", args: ["ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"] }, patch.command],
    probes: [{
      executable: "node",
      args: ["--eval", [
        "const { execFileSync } = require('node:child_process');",
        "const [entry, expected] = process.argv.slice(1);",
        "const actual = execFileSync(process.execPath, [entry, '--version'], { encoding: 'utf8', windowsHide: true }).trim();",
        "if (actual !== expected) throw Error('unexpected CodeBuddy CLI version: ' + actual);",
      ].join("\n"), CODEBUDDY_ENTRY, CODEBUDDY_VERSION],
    }],
  };
}
