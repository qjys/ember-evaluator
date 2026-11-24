import { taskResourceFiles } from "../shared/task-resource-files.js";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import type { RuntimeInstallation } from "../../core/contracts/environment.js";

export const ZCODE_ENTRY = "source/apps/zcode-cli/packages/cli/dist/zcode.cjs";

export async function readZCodeSourceLock(signal: AbortSignal): Promise<{ cliVersion: string; commit: string }> {
  const lock: unknown = JSON.parse(await readFile(new URL("./assets/source-lock.json", import.meta.url), { encoding: "utf8", signal }));
  if (!lock || typeof lock !== "object" || !("cliVersion" in lock) || typeof lock.cliVersion !== "string" ||
      !("commit" in lock) || typeof lock.commit !== "string" || !/^[a-f0-9]{40}$/u.test(lock.commit) ||
      !/^\d+\.\d+\.\d+$/u.test(lock.cliVersion)) {
    throw new TypeError("Invalid ZCode source lock");
  }
  return { cliVersion: lock.cliVersion, commit: lock.commit };
}

export async function zcodeRuntimeInstallation(signal: AbortSignal): Promise<RuntimeInstallation> {
  const { cliVersion, commit } = await readZCodeSourceLock(signal);
  return {
    id: `zcode:${cliVersion}:${commit}`,
    cacheName: `zcode-${cliVersion}`,
    files: [
      ...taskResourceFiles(),
      ...["package.json", "package-lock.json", "source-lock.json", "install.mjs", "launch.mjs", "cli.mjs"]
        .map(target => ({ source: fileURLToPath(new URL(`./assets/${target}`, import.meta.url)), target })),
      { source: fileURLToPath(new URL("../shared/assets/model-relay.mjs", import.meta.url)), target: "runtimes/shared/assets/model-relay.mjs" },
      { source: fileURLToPath(new URL("../shared/assets/stage-attachments.mjs", import.meta.url)), target: "stage-attachments.mjs" },
    ],
    commands: [
      { executable: "npm", args: ["ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"] },
      { executable: "node", args: ["install.mjs"], env: { NODE_USE_ENV_PROXY: "1" } },
    ],
    probes: [{
      executable: "node",
      args: ["--eval", [
        "const { execFileSync } = require('node:child_process');",
        "const [entry, expected] = process.argv.slice(1);",
        "const actual = execFileSync(process.execPath, [entry, '--version'], { encoding: 'utf8' }).trim();",
        "if (actual !== expected) throw Error('unexpected ZCode CLI version: ' + actual);",
      ].join("\n"), ZCODE_ENTRY, cliVersion],
    }],
  };
}
