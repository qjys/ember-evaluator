import { fileURLToPath } from "node:url";
import type { RuntimeInstallation } from "../../core/contracts/environment.js";

function files(targets: string[]): RuntimeInstallation["files"] {
  return targets.map(target => ({
    source: fileURLToPath(new URL(`../../${target}`, import.meta.url)), target,
  }));
}

export function taskResourceFiles() {
  return files(["runtimes/shared/assets/task-resources.mjs", "infrastructure/network/web-search.mjs", "infrastructure/network/web-fetch.mjs"]);
}

export function bundleSearchFiles() {
  return files(["runtimes/shared/assets/search-stdio.mjs", "infrastructure/network/web-search.mjs", "infrastructure/network/web-fetch.mjs"]);
}
