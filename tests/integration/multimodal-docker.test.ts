import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, test } from "vitest";
import { DockerEnvironment } from "../../src/plugins/environments/docker/environment.js";
import { LocalEnvironment } from "../../src/plugins/environments/local/environment.js";
import { PINNED_NODE_IMAGE } from "../../src/infrastructure/containers/runtime-contract.js";
import { loadAttachments } from "../../src/runtimes/multimodal/input.js";
import type { PublicTask } from "../../src/core/contracts/task.js";
import { fixturePNG } from "../fixtures/multimodal.js";

for (const kind of ["local", "docker"] as const) {
test.skipIf(kind === "docker" && (process.env.EVALUATOR_TEST_DOCKER !== "1" || process.platform !== "linux"))(`${kind} reads locked public media from its workspace and releases resources`, async () => {
  const root = await mkdtemp(join(tmpdir(), "docker-media-"));
  const bytes = fixturePNG(); const source = join(root, "source.png"); await writeFile(source, bytes);
  const paths = { root: join(root, "attempt"), agent: join(root, "attempt/agent"), verifier: join(root, "attempt/verifier"), artifacts: join(root, "attempt/artifacts") };
  await Promise.all(Object.values(paths).map(path => mkdir(path, { recursive: true })));
  const environment = kind === "docker" ? new DockerEnvironment() : new LocalEnvironment(); const signal = AbortSignal.timeout(180_000);
  let session;
  try {
    session = await environment.prepare({ image: kind === "docker" ? PINNED_NODE_IMAGE : null, workdir: kind === "docker" ? "/workspace" : ".", initialFiles: [{ source, target: "public/figure.png" }], runtime: [], network: "none" }, paths, "solve", signal);
    const task: PublicTask = { id: "image", prompt: "look", attachments: [{ kind: "image", path: "public/figure.png", mediaType: "image/png", sha256: createHash("sha256").update(bytes).digest("hex") }] };
    expect(await loadAttachments(task, session, { key: { runId: "r", taskId: "image", attemptId: "a" }, paths, signal })).toEqual([
      { name: "public/figure.png", mediaType: "image/png", data: bytes.toString("base64") },
    ]);
  } finally {
    await session?.dispose(AbortSignal.timeout(30_000));
    await rm(root, { recursive: true, force: true });
  }
}, 190_000);
}
