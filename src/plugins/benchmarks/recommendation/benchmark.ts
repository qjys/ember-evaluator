import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import type { Benchmark } from "../../../core/contracts/benchmark.js";
import type { EffectiveConfig } from "../../../core/contracts/config.js";
import type { SolveResult, VerifyResult } from "../../../core/contracts/result.js";
import type { PreparedTask, SourceLock, TaskRef } from "../../../core/contracts/task.js";
import { VerificationError } from "../../../core/errors/verification-error.js";
import { fingerprintConfig } from "../../../core/results/run-manifest.js";
import type { RecommendationConfig } from "./config.js";
import { lockedPoint, summarizeSamples } from "./evidence.js";

export class RecommendationBenchmark implements Benchmark {
  readonly evaluationKind = "performance";
  readonly validateSourceOnCompletedResume = true;
  constructor(private readonly config: RecommendationConfig, private readonly resolvePath: (path: string) => string) {}

  validateRun(run: EffectiveConfig) {
    if (run.solver.name !== "sglang-gr" || run.verifier || run.environment.name !== "local" ||
      run.scheduler.name !== "local" || run.scheduler.config.concurrency !== 1)
      throw new TypeError("recommendation requires sglang-gr, local execution, scheduler concurrency=1 and no verifier");
    if (this.config.scenario === "north-star" && (run.run.sampling?.strategy === "random" || run.run.taskIds !== null ||
      (run.run.offset ?? 0) > 0 || (run.run.maxTasks !== null && run.run.maxTasks < 5)))
      throw new TypeError("north-star requires all five lengths in order; use custom for partial measurements");
    const endpoint = run.services[run.solver.service]?.endpoint;
    if (!endpoint) throw new TypeError("sglang-gr requires a service root URL");
    const url = new URL(endpoint);
    if (!["http:", "https:"].includes(url.protocol) || url.pathname !== "/" || url.search || url.hash || url.username || url.password)
      throw new TypeError("sglang-gr requires an HTTP(S) service root URL");
  }

  private files() {
    return [{ path: "prefix1.json", source: this.resolvePath(this.config.prefix1File) },
      { path: "prefix2.json", source: this.resolvePath(this.config.prefix2File) },
      ...this.config.inputs.map(input => ({ path: `prompts-${input.length}.json`, source: this.resolvePath(input.file) }))];
  }

  async resolveSource(previous: SourceLock | null, signal: AbortSignal): Promise<SourceLock> {
    const files = [];
    for (const { path, source } of this.files()) {
      const hash = createHash("sha256");
      for await (const chunk of createReadStream(source, { signal })) hash.update(chunk);
      files.push({ path, sha256: hash.digest("hex"), origin: `recommendation:${path}` });
    }
    const { scenario, tag, beamWidth, decodeSteps, concurrency, requests, warmup, comparison } = this.config;
    const lock = { source: "recommendation:local", revision: fingerprintConfig(files), files,
      metadata: { scenario, tag, beamWidth, decodeSteps, concurrency, requests, warmup, comparison: comparison ?? null } };
    if (previous && fingerprintConfig(previous) !== fingerprintConfig(lock)) throw new Error("Recommendation source or workload changed since the run was created");
    return lock;
  }

  async *enumerate(_source: SourceLock, signal: AbortSignal): AsyncIterable<TaskRef> {
    for (const { length } of this.config.inputs) {
      signal.throwIfAborted();
      yield { id: `recommendation-L${length}`, recordKey: length };
    }
  }

  async prepare(ref: TaskRef, source: SourceLock, signal: AbortSignal): Promise<PreparedTask> {
    signal.throwIfAborted();
    const length = ref.recordKey;
    if (!this.config.inputs.some(input => input.length === length) || typeof length !== "number" || ref.id !== `recommendation-L${length}`)
      throw new TypeError("Invalid recommendation task");
    const files = this.files().filter(file => ["prefix1.json", "prefix2.json", `prompts-${length}.json`].includes(file.path));
    const workload = lockedPoint(source, length);
    const paths = Object.fromEntries(files.map(file => [file.path, file.source]));
    return { input: { id: ref.id, prompt: `Recommendation performance at target length ${length}`, payload: { workload, files: paths } },
      verification: workload, verificationMode: "none", solveEnv: { workdir: ".", image: null, runtime: [],
        initialFiles: [] }, transfer: null, verifyEnv: null };
  }

  async verify(task: PreparedTask, result: SolveResult, _session: unknown, signal: AbortSignal): Promise<VerifyResult> {
    signal.throwIfAborted();
    const observations = result.observations;
    if (!observations || typeof observations !== "object" || Array.isArray(observations) ||
      fingerprintConfig(observations.workload ?? null) !== fingerprintConfig(task.verification))
      throw new VerificationError("Recommendation evidence differs from prepared task", {});
    const summary = summarizeSamples(observations, this.config);
    if (this.config.scenario === "north-star" && observations.counters == null)
      throw new VerificationError("North Star requires a GR counter snapshot", summary);
    if (!summary.valid) throw new VerificationError("Incomplete recommendation measurement; see per-request observations", summary);
    return { passed: null, details: { measurement: "recommendation", successfulRequests: summary.successfulRequests } };
  }
}
