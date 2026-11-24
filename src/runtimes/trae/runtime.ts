import { taskResourceFiles } from "../shared/task-resource-files.js";
import { fileURLToPath } from "node:url";
import type { RuntimeInstallation } from "../../core/contracts/environment.js";

export const TRAE_VERSION = "0.214.1";

export async function traeRuntimeInstallation(signal: AbortSignal): Promise<RuntimeInstallation> {
  signal.throwIfAborted();
  return {
    id: `trae:${TRAE_VERSION}`,
    cacheName: `trae-${TRAE_VERSION}`,
    files: [
      ...taskResourceFiles(),
      { source: fileURLToPath(new URL("../shared/assets/codex-skill-config.mjs", import.meta.url)), target: "codex-skill-config.mjs" },
      ...["release-lock.json", "install.mjs", "launch.mjs"].map(target => ({
        source: fileURLToPath(new URL(`./assets/${target}`, import.meta.url)), target,
      })),
      { source: fileURLToPath(new URL("../shared/assets/stage-attachments.mjs", import.meta.url)), target: "stage-attachments.mjs" },
      { source: fileURLToPath(new URL("../shared/assets/model-relay.mjs", import.meta.url)), target: "runtimes/shared/assets/model-relay.mjs" },
    ],
    commands: [{ executable: "node", args: ["install.mjs"], env: { NODE_USE_ENV_PROXY: "1" } }],
    probes: [{
      executable: "node",
      args: ["--eval", [
        "const { execFileSync } = require('node:child_process');",
        "const { resolve } = require('node:path');",
        "const entry = resolve(process.platform === 'win32' ? 'traecli.exe' : 'traecli');",
        "const actual = execFileSync(entry, ['--version'], { encoding: 'utf8', windowsHide: true }).split(/\\r?\\n/, 1)[0];",
        "if (actual !== process.argv[1]) throw Error('unexpected TRAE CLI version: ' + actual);",
      ].join("\n"), `traecli ${TRAE_VERSION}`],
    }],
  };
}
