import { lstat, mkdir, mkdtemp, rename, rm } from "node:fs/promises";
import { join, toNamespacedPath } from "node:path";
import type { PreparedTask } from "../contracts/task.js";
import type { EnvironmentSession } from "../contracts/environment.js";
import { checkedPath, evidencePath } from "./artifacts.js";

type Directory = NonNullable<PreparedTask["artifactDirectory"]>;
const reserved = new Set(["agent", "artifacts", "collect", "logs", "steps", "verifier"]);

export function validateArtifactDirectory(spec: Directory): void {
  if (!/^[a-z][a-z0-9_-]*$/u.test(spec.name) || reserved.has(spec.name))
    throw new TypeError("Invalid attempt artifact directory name");
  if (!spec.requiredFiles.length || spec.requiredFiles.some(path => evidencePath(path) !== path))
    throw new TypeError("An artifact directory requires relative evidence filenames");
}

/** Only publish a finished download. On cancellation the cleanup phase can retry using its own signal. */
export async function publishArtifactDirectory(session: EnvironmentSession, root: string, spec: Directory, signal: AbortSignal): Promise<void> {
  const parent = join(root, spec.name);
  await mkdir(parent, { recursive: true });
  await checkedPath(root, spec.name);
  const staging = await mkdtemp(toNamespacedPath(join(parent, ".collection-")));
  try {
    const tree = join(staging, "tree");
    await session.download(spec.name, tree, signal);
    if (!(await lstat(tree)).isDirectory()) throw new TypeError("Artifact source must be a directory");
    signal.throwIfAborted();
    await rename(tree, join(parent, "outputs"));
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}
