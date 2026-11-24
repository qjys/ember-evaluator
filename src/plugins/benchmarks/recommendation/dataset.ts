import { execFile } from "node:child_process";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, mkdtemp, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expectRecord } from "../../../core/validation/input.js";
import type { RecommendationConfig } from "./config.js";

export type DatasetRuntime = { python: string; tokenizerPath: string | null; tolerance: number; directory: string };
const script = fileURLToPath(new URL("../../../runtimes/sglang-gr/assets/prepare_dataset.py", import.meta.url));

function digest(value: unknown): string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/u.test(value)) throw new TypeError("Invalid prepared dataset digest");
  return value;
}

async function verifyPublished(path: string, expected: string, signal: AbortSignal) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path, { signal })) hash.update(chunk);
  if (hash.digest("hex") !== expected) throw new Error("Saved generated dataset differs from its digest: " + path);
}

export async function prepareDataset(config: RecommendationConfig, runtime: DatasetRuntime, resolvePath: (path: string) => string,
  signal: AbortSignal) {
  const { generator } = config;
  const inputs = config.inputs.map(input => ({ ...input, file: generator ? input.file : resolvePath(input.file) }));
  let staging: string | undefined;
  try {
    if (generator) {
      await mkdir(runtime.directory, { recursive: true });
      staging = await mkdtemp(join(runtime.directory, ".prepare-"));
    }
    const request = { inputs, generator, staging, scenario: config.scenario, prefix1File: resolvePath(config.prefix1File),
      prefix2File: resolvePath(config.prefix2File), tokenizerPath: runtime.tokenizerPath, tolerance: runtime.tolerance };
    const proc = promisify(execFile)(runtime.python, ["-B", script], { cwd: resolvePath("."), signal,
      windowsHide: true, encoding: "utf8", env: { ...process.env, PYTHONUTF8: "1", HF_HUB_OFFLINE: "1" } });
    const stdin = proc.child.stdin;
    if (!stdin) throw new Error("Dataset preparation process has no stdin");
    const [exit, sent] = await Promise.allSettled([proc, pipeline(Readable.from([JSON.stringify(request)]), stdin, { signal })]);
    if (exit.status === "rejected") throw exit.reason;
    if (sent.status === "rejected") throw sent.reason;
    const { stdout } = exit.value;
    const result = expectRecord(JSON.parse(stdout), "prepared dataset");
    const hashes = expectRecord(result.digests, "dataset digests");
    const names = ["prefix1.json", "prefix2.json", ...inputs.map(input => `prompts-${input.length}.json`)];
    const files = names.map(path => ({ path, sha256: digest(hashes[path]), origin: "recommendation:" + path }));
    if (!staging) return { files, manifestSha256: null };
    const manifestSha256 = digest(result.manifestSha256);
    const destination = join(runtime.directory, manifestSha256);
    signal.throwIfAborted();
    try {
      await rename(staging, destination);
      staging = undefined;
    } catch (error) {
      if (!["EEXIST", "ENOTEMPTY", "EPERM"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
      // A previous or concurrent run published the same contents. Never replace an existing dataset.
      await verifyPublished(join(destination, "dataset.json"), manifestSha256, signal);
      for (const input of inputs)
        await verifyPublished(join(destination, input.file), digest(hashes[`prompts-${input.length}.json`]), signal);
    }
    return { files, manifestSha256 };
  } finally {
    if (staging) await rm(staging, { recursive: true, force: true });
  }
}
