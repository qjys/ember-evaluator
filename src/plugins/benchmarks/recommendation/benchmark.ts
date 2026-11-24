import { join } from "node:path";
import { expectNonEmptyString, expectPositiveInteger, expectRecord } from "../../../core/validation/input.js";
import { prepareDataset, type DatasetRuntime } from "./dataset.js";
import type { ActivityListener } from "../../../core/contracts/activity.js";
import type { Benchmark } from "../../../core/contracts/benchmark.js";
import type { EffectiveConfig } from "../../../core/contracts/config.js";
import type { ResultSnapshot, SolveResult, VerifyResult } from "../../../core/contracts/result.js";
import type { PreparedTask, SourceLock, TaskRef } from "../../../core/contracts/task.js";
import { VerificationError } from "../../../core/errors/verification-error.js";
import { isEvaluationComplete } from "../../../core/results/evaluation-outcome.js";
import { fingerprintConfig } from "../../../core/results/run-manifest.js";
import type { RecommendationConfig } from "./config.js";
import { lockedPoint, summarizeSamples } from "./evidence.js";

export class RecommendationBenchmark implements Benchmark {
  readonly evaluationKind = "performance";
  readonly validateSourceOnCompletedResume = true;
  constructor(private readonly config: RecommendationConfig, private readonly resolvePath: (path: string) => string) {}

  private dataset: DatasetRuntime = { python: process.platform === "win32" ? "python" : "python3", tokenizerPath: null, tolerance: 0, directory: "" };

  validateRun(run: EffectiveConfig) {
    const solver = run.solver.config;
    if (this.config.generator && !solver.tokenizerPath) throw new TypeError("generated data requires benchmark.solver.config.tokenizerPath");
    this.dataset = { python: expectNonEmptyString(solver.pythonExecutable ?? "python3", "pythonExecutable"),
      tolerance: solver.lengthToleranceTokens === undefined || solver.lengthToleranceTokens === 0 ? 0 :
        expectPositiveInteger(solver.lengthToleranceTokens, "lengthToleranceTokens"),
      tokenizerPath: solver.tokenizerPath === undefined ? null : this.resolvePath(expectNonEmptyString(solver.tokenizerPath, "tokenizerPath")),
      directory: join(this.resolvePath(run.output.directory), "datasets") };
    if (run.solver.name !== "sglang-gr" || run.verifier || run.environment.name !== "local" ||
      run.scheduler.name !== "local" || run.scheduler.config.concurrency !== 1)
      throw new TypeError("recommendation requires sglang-gr, local execution, scheduler concurrency=1 and no verifier");
    if (this.config.scenario === "north-star" && (run.run.sampling?.strategy === "random" || run.run.taskIds !== null ||
      (run.run.offset ?? 0) > 0 || (run.run.maxTasks !== null && run.run.maxTasks < 5)))
      throw new TypeError("north-star requires all five lengths in order; use custom for partial measurements");
    const routes = this.config.collections ?? [{ type: "performance", service: run.solver.service }];
    if (this.config.collections && (run.run.sampling || run.run.taskIds || run.run.offset || run.run.maxTasks !== null))
      throw new TypeError("Use collection lengths or custom inputs to select ordered collection tasks");
    const endpoints = new Set<string>();
    for (const route of routes) {
      const model = run.services[route.service];
      if (!model || model.name !== run.services[run.solver.service]?.name) throw new TypeError("Collection service missing or model differs");
      const endpoint = model.endpoint;
      if (!endpoint) throw new TypeError("sglang-gr requires a service root URL");
      const url = new URL(endpoint);
      if (!["http:", "https:"].includes(url.protocol) || url.pathname !== "/" || url.search || url.hash || url.username || url.password)
        throw new TypeError("sglang-gr requires an HTTP(S) service root URL");
      if (endpoints.has(url.href)) throw new TypeError("performance and profiling require distinct service URLs");
      endpoints.add(url.href);
    }
  }

  private files(source: SourceLock) {
    const manifest = expectRecord(source.metadata, "recommendation source").generatedManifestSha256;
    if (this.config.generator && (typeof manifest !== "string" || !/^[0-9a-f]{64}$/u.test(manifest))) throw new Error("Missing generated dataset digest");
    return [{ path: "prefix1.json", source: this.resolvePath(this.config.prefix1File) },
      { path: "prefix2.json", source: this.resolvePath(this.config.prefix2File) },
      ...this.config.inputs.map(input => ({ path: `prompts-${input.length}.json`, source: typeof manifest === "string" ? join(this.dataset.directory, manifest, input.file) : this.resolvePath(input.file) }))];
  }

  async resolveSource(previous: SourceLock | null, signal: AbortSignal, activity?: ActivityListener): Promise<SourceLock> {
    const { files, manifestSha256 } = await prepareDataset(this.config, this.dataset, this.resolvePath, signal);
    if (manifestSha256) activity?.({ lines: ["Generated dataset: " + join(this.dataset.directory, manifestSha256, "dataset.json")] });
    const { scenario, tag, beamWidth, decodeSteps, concurrency, requests, warmup, comparison } = this.config;
    const lock = { source: "recommendation:local", revision: fingerprintConfig(files), files,
      metadata: { ...(manifestSha256 && { generatedManifestSha256: manifestSha256 }), ...(this.config.collections && { collections: this.config.collections }), scenario, tag, beamWidth, decodeSteps, concurrency, requests, warmup, comparison: comparison ?? null } };
    if (previous && fingerprintConfig(previous) !== fingerprintConfig(lock)) throw new Error("Recommendation source or workload changed since the run was created");
    return lock;
  }

  async *enumerate(_source: SourceLock, signal: AbortSignal): AsyncIterable<TaskRef> {
    for (const route of this.config.collections ?? [{ type: "performance" } as const]) {
      for (const { length } of this.config.inputs) {
        signal.throwIfAborted();
        if ("lengths" in route && route.lengths && !route.lengths.includes(length)) continue;
        const prefix = route.type === "profiling" ? "profiling" : "recommendation";
        yield { id: prefix + "-L" + length, recordKey: length };
      }
    }
  }

  async validatePrerequisites(ref: TaskRef, snapshot: () => Promise<ResultSnapshot>) {
    if (!ref.id.startsWith("profiling-") || !this.config.collections?.some(c => c.type === "performance")) return;
    const { records } = await snapshot();
    const gateHits = this.config.inputs.map(({ length }) => {
      const record = records.find(item => item.key.taskId === "recommendation-L" + length);
      if (!record || !isEvaluationComplete(record) || [record.collection.trajectory, record.collection.artifacts].some(s => s === "missing" || s === "partial"))
        throw new Error("Profiling skipped: incomplete performance collection at L" + length);
      const obs = record.solve?.observations;
      const counters = obs && typeof obs === "object" && !Array.isArray(obs) ? obs.counters : null;
      const hit = counters && typeof counters === "object" && !Array.isArray(counters) &&
        typeof counters.decode_forward === "number" && counters.decode_forward > 0 &&
        typeof counters.shared_prefix_forward === "number" && counters.shared_prefix_forward > 0;
      return { length, hit };
    });
    const gate = this.config.scenario === "north-star" ? gateHits.filter(p => p.length === 128) : gateHits;
    if (this.config.tag === "fast" && !gate.some(p => p.hit))
      throw new Error("Profiling skipped: performance fast path not verified at the required length(s)");
  }

  async prepare(ref: TaskRef, source: SourceLock, signal: AbortSignal): Promise<PreparedTask> {
    signal.throwIfAborted();
    const length = ref.recordKey;
    const profiling = ref.id.startsWith("profiling-");
    const route = this.config.collections?.find(c => c.type === (profiling ? "profiling" : "performance"));
    if (profiling && (!route || (route.lengths && !route.lengths.includes(Number(length))))) throw new TypeError("Unexpected profiling length");
    if (!this.config.inputs.some(input => input.length === length) || typeof length !== "number" || ref.id !== (profiling ? "profiling-L" : "recommendation-L") + length)
      throw new TypeError("Invalid recommendation task");
    const files = this.files(source).filter(file => ["prefix1.json", "prefix2.json", `prompts-${length}.json`].includes(file.path));
    const workload = lockedPoint(source, length);
    const paths = Object.fromEntries(files.map(file => [file.path, file.source]));
    return { input: { id: ref.id, prompt: `Recommendation performance at target length ${length}`, payload: { workload, files: paths, ...(route && { collection: route.type, service: route.service }) } },
      verification: workload, verificationMode: "none", solveEnv: { workdir: ".", image: null, runtime: [],
        initialFiles: [] }, transfer: null, verifyEnv: null };
  }

  async verify(task: PreparedTask, result: SolveResult, _session: unknown, signal: AbortSignal): Promise<VerifyResult> {
    signal.throwIfAborted();
    const observations = result.observations;
    if (!observations || typeof observations !== "object" || Array.isArray(observations) ||
      fingerprintConfig(observations.workload ?? null) !== fingerprintConfig(task.verification))
      throw new VerificationError("Recommendation evidence differs from prepared task", {});
    if (task.input.id.startsWith("profiling-")) {
      const profile = observations.profile;
      if (!profile || typeof profile !== "object" || Array.isArray(profile) || profile.deviceEvidence !== true)
        throw new VerificationError("No NPU device evidence in profiler export", {});
      return { passed: null, details: { measurement: "profiling" } };
    }
    const summary = summarizeSamples(observations, this.config);
    if (this.config.scenario === "north-star" && observations.counters == null)
      throw new VerificationError("North Star requires a GR counter snapshot", summary);
    if (!summary.valid) throw new VerificationError("Incomplete recommendation measurement; see per-request observations", summary);
    return { passed: null, details: { measurement: "recommendation", successfulRequests: summary.successfulRequests } };
  }
}
