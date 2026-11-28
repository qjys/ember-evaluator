import { LocalRecordSource } from "../../../../infrastructure/datasets/sources/local/files-source.js";
import { localDatasetConfig } from "../../shared/local-data.js";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { expectNonEmptyString, expectPositiveInteger, expectRecord, rejectUnknown } from "../../../../core/validation/input.js";
import type { EffectiveConfig } from "../../../../core/contracts/config.js";
import type { Benchmark, BenchmarkRunPlan } from "../../../../core/contracts/benchmark.js";
import type { PreparedTask, SourceLock, TaskRef } from "../../../../core/contracts/task.js";
import type { AttemptStepResult, ResultSnapshot, SolveResult, VerifyResult } from "../../../../core/contracts/result.js";
import { parseEngineMetrics, parseProfileConfig, type AgentXProfileConfig } from "./evidence/service-collections.js";
import { fingerprintConfig } from "../../../../core/results/run-manifest.js";
import { DatasetCache } from "../../../../infrastructure/datasets/cache.js";
import type { DatasetRecordSource } from "../../../../infrastructure/datasets/record-source.js";
import type { ActivityListener } from "../../../../core/contracts/activity.js";
import { withDatasetActivity } from "../../../../infrastructure/datasets/activity.js";
import { HuggingFaceFilesSource } from "../../../../infrastructure/datasets/sources/huggingface/files-source.js";
import { agentXAssets, agentXBridgeDigest } from "../../../../runtimes/agentx/runtime.js";
import { parseAgentXSummary, successfulAgentXWindow, type AgentXMode, type AgentXVariant, type AgentXWorkload } from "./evidence/summary.js";
import { parseTelemetryConfig } from "./evidence/telemetry.js";

export type AgentXConfig = {
  measurementMode?: "performance" | "profiling" | "all";
  profiling?: AgentXProfileConfig;
  engineMetrics?: string[];
  variant: AgentXVariant;
  mode: Exclude<AgentXMode, "smoke">;
  concurrency: number[];
  durationSeconds: number;
  seed: number;
  traceCount?: number;
  cacheDir: string;
  hfToken?: string;
  localPath?: string;
};

export function parseAgentXConfig(value: unknown): AgentXConfig {
  const v = expectRecord(value, "agentx");
  rejectUnknown(v, ["variant", "mode", "concurrency", "durationSeconds", "seed", "traceCount", "cacheDir", "hfToken", "localPath", "engineMetrics", "profiling", "measurementMode"], "agentx");
  if (v.variant !== undefined && v.variant !== "256k" && v.variant !== "full") throw new TypeError("agentx.variant must be 256k or full");
  if (v.mode !== undefined && !["standard", "replay"].includes(String(v.mode))) throw new TypeError("agentx.mode must be standard or replay");
  const mode = v.mode === "replay" ? "replay" : "standard";
  const entries = v.concurrency ?? [1];
  if (!Array.isArray(entries) || !entries.length) throw new TypeError("agentx.concurrency must be a non-empty array");
  const concurrency = entries.map(n => expectPositiveInteger(n, "agentx.concurrency"));
  if (new Set(concurrency).size !== concurrency.length) throw new TypeError("agentx.concurrency must not contain duplicates");
  const durationSeconds = expectPositiveInteger(v.durationSeconds ?? (mode === "replay" ? 86400 : 3600), "agentx.durationSeconds");
  const seed = v.seed ?? 42;
  if (!Number.isSafeInteger(seed)) throw new TypeError("agentx.seed must be a safe integer");
  if (mode === "standard" && seed !== 42) throw new TypeError("AgentX standard requires seed=42");
  const traceCount = mode === "replay" ? expectPositiveInteger(v.traceCount, "agentx.traceCount") : undefined;
  if (mode !== "replay" && v.traceCount !== undefined) throw new TypeError("agentx.traceCount requires mode=replay");
  if (traceCount !== undefined && concurrency.some(n => n > traceCount)) throw new TypeError("AgentX replay concurrency must not exceed traceCount");
  const measurementMode = v.measurementMode;
  if (measurementMode !== undefined && measurementMode !== "performance" && measurementMode !== "profiling" && measurementMode !== "all")
    throw new TypeError("agentx.measurementMode must be performance, profiling or all");
  const configuredProfile = v.profiling === undefined ? undefined : parseProfileConfig(v.profiling, measurementMode ? "vllm" : undefined);
  const profiling = measurementMode === "performance" ? undefined : configuredProfile;
  if ((measurementMode === "profiling" || measurementMode === "all") && !profiling)
    throw new TypeError("agentx.profiling is required for the selected measurementMode");
  const engineMetrics = v.engineMetrics === undefined ? measurementMode && measurementMode !== "profiling" ?
    (configuredProfile?.provider === "sglang" ? ["sglang:token_usage", "sglang:num_running_reqs", "sglang:num_queue_reqs"] :
      ["vllm:kv_cache_usage_perc", "vllm:num_requests_running", "vllm:num_requests_waiting"]) : undefined : parseEngineMetrics(v.engineMetrics);
  const profileTrees = profiling?.traceCount;
  if (profileTrees !== undefined && (concurrency.some(n => n > profileTrees) || (traceCount !== undefined && profileTrees > traceCount)))
    throw new TypeError("profiling.traceCount must cover every concurrency and fit the replay selection");
  return { ...localDatasetConfig(v), variant: v.variant === "full" ? "full" : "256k", mode, concurrency, durationSeconds, seed: Number(seed),
    ...(profiling ? { profiling } : {}), ...(engineMetrics ? { engineMetrics } : {}), ...(measurementMode ? { measurementMode } : {}),
    ...(traceCount === undefined ? {} : { traceCount }),
    cacheDir: expectNonEmptyString(v.cacheDir ?? ".cache/agentx", "agentx.cacheDir"),
    ...(v.hfToken === undefined ? {} : { hfToken: expectNonEmptyString(v.hfToken, "agentx.hfToken") }) };
}

export class AgentXBenchmark implements Benchmark {
  readonly evaluationKind = "performance";
  readonly validateSourceOnCompletedResume = true;
  private readonly source: DatasetRecordSource;
  private readonly cache: DatasetCache;
  private readonly dataset: string;
  constructor(readonly config: AgentXConfig, private readonly environmentName: string, source?: DatasetRecordSource, network?: import("../../../../core/contracts/network.js").NetworkAccess) {
    this.dataset = `semianalysisai/cc-traces-weka-062126${config.variant === "256k" ? "-256k" : ""}`;
    this.cache = new DatasetCache(config.cacheDir, network);
    const definition = { dataset: this.dataset, revision: "main",
      selections: [{ key: "traces", format: "jsonl" as const, path: "traces.jsonl" }] };
    this.source = source ?? (config.localPath === undefined
      ? new HuggingFaceFilesSource(config.cacheDir, "agentx", definition, config.hfToken ?? process.env.HF_TOKEN, undefined, network)
      : new LocalRecordSource(config.localPath, definition));
  }

  validateRun(config: EffectiveConfig): void {
    if (config.solver.name !== "agentx-replay" || config.verifier !== undefined)
      throw new TypeError("AgentX requires agentx-replay and has no correctness verifier");
    if (!["local", "docker"].includes(config.environment.name) || config.scheduler.name !== "local" ||
      config.scheduler.config.concurrency !== 1) throw new TypeError("AgentX supports local/Docker with local scheduler concurrency=1");
    if (config.solver.config.telemetry !== undefined) {
      const ascend = parseTelemetryConfig(config.solver.config.telemetry, config.hardware).ascend;
      if (ascend && "mode" in ascend && !["local", "docker"].includes(config.environment.name))
        throw new TypeError("Local Ascend telemetry requires a local Docker host or local environment");
    }
    const minimum = this.config.durationSeconds + 3600 + 300;
    if (config.run.timeoutSeconds < minimum) throw new TypeError(`AgentX run.timeoutSeconds must be at least ${minimum} (includes configuration, warmup and drain)`);
    if (config.run.preparation?.mode === "pipeline") throw new TypeError("AgentX does not support pipeline preparation");
    const model = config.services[config.solver.service];
    if (!model || model.api !== "openai-completions" || model.endpoint === null)
      throw new TypeError("AgentX requires an OpenAI Chat Completions endpoint");
    if (model.maxTokens !== undefined) throw new TypeError("AgentX output lengths come from traces; remove services maxTokens");
    if (this.config.profiling) {
      if ((config.hardware ?? "npu") !== "npu") throw new TypeError("AgentX Ascend profiling requires hardware=npu");
      if (config.run.sampling || config.run.taskIds || config.run.offset || config.run.maxTasks !== null)
        throw new TypeError("Select ordered profiling points using benchmark.config.concurrency");
      const profile = config.services[this.config.profiling.service ?? config.solver.service];
      if (!profile?.endpoint || profile.api !== "openai-completions" || profile.name !== model.name || profile.maxTokens !== undefined)
        throw new TypeError("AgentX profiling requires a Chat Completions service with the same model and trace-controlled output length");
    }
  }

  async resolveSource(previous: SourceLock | null, signal: AbortSignal, activity?: ActivityListener): Promise<SourceLock> {
    return await withDatasetActivity(activity, () => this.source.resolve(previous, signal));
  }

  async *enumerate(_source: SourceLock, signal: AbortSignal): AsyncIterable<TaskRef> {
    for (const concurrency of this.config.concurrency) {
      signal.throwIfAborted();
      const id = this.id(concurrency) + (this.config.measurementMode === "profiling" ? "-profiling" : "");
      yield { id, recordKey: { concurrency } };
    }
  }

  async validatePrerequisites(ref: TaskRef, snapshot: () => Promise<ResultSnapshot>): Promise<void> {
    if (!this.config.profiling) return;
    const { records } = await snapshot();
    for (const record of records) {
      const diagnostic = record.steps?.find(step => step.name === "profiling");
      if (!diagnostic && !record.key.taskId.endsWith("-profiling")) continue;
      if (record.errors.some(error => error.message.includes("stop_profile unconfirmed")) ||
          (record.executionStatus === "cancelled" && !diagnostic?.verdict) || record.cleanupStatus === "unconfirmed")
        throw new Error(`Profiling skipped: service cleanup unconfirmed after ${record.key.taskId}; inspect the profiler before running ${ref.id}`);
    }
  }

  evaluateSteps(_task: PreparedTask, results: AttemptStepResult[]): { verdict: VerifyResult | null; continue: boolean } {
    const last = results.at(-1);
    if (!last?.verdict || !last.solve) return { verdict: null, continue: false };
    if (last.name === "performance" && !successfulAgentXWindow(parseAgentXSummary(last.solve.observations)))
      throw new Error("Profiling skipped: missing or failed requests in the formal measurement");
    return { verdict: last.verdict, continue: last.name === "performance" };
  }

  private id(concurrency: number): string { return `agentx-${this.config.variant}-${this.config.mode}-c${concurrency}`; }

  async prepare(ref: TaskRef, source: SourceLock, signal: AbortSignal): Promise<PreparedTask> {
    const key = expectRecord(ref.recordKey, "AgentX task key");
    const concurrency = expectPositiveInteger(key.concurrency, "AgentX task concurrency");
    const diagnostic = !!this.config.profiling && ref.id === this.id(concurrency) + "-profiling";
    if (!this.config.concurrency.includes(concurrency) || (!diagnostic && (this.config.measurementMode === "profiling" || ref.id !== this.id(concurrency)))) throw new TypeError("Invalid AgentX point selection");
    const file = source.files.find(file => file.path === "traces.jsonl");
    const metadata = expectRecord(source.metadata, "AgentX source metadata");
    if (!file || source.files.length !== 1 || metadata.dataset !== this.dataset || !/^(?:[a-f0-9]{40}|local:[a-f0-9]{64})$/u.test(source.revision))
      throw new TypeError("Invalid locked AgentX corpus");
    const token = this.config.hfToken ?? process.env.HF_TOKEN;
    const tracePath = this.source instanceof LocalRecordSource
      ? await this.source.files.file(source, "traces.jsonl", signal)
      : (await this.cache.fetch(file.origin, file.sha256, signal, token ? { Authorization: `Bearer ${token}` } : undefined)).path;
    const base: AgentXWorkload = { schemaVersion: 1, kind: "agentx", variant: this.config.variant, mode: this.config.mode,
      concurrency, durationSeconds: this.config.durationSeconds, seed: this.config.seed, dataset: this.dataset,
      loader: `semianalysis_cc_traces_weka_062126${this.config.variant === "256k" ? "_256k" : ""}`,
      revision: source.revision, sha256: file.sha256, tracePath: "input/traces.jsonl",
      ...(this.config.traceCount === undefined ? {} : { traceCount: this.config.traceCount }) };
    const formal: AgentXWorkload = this.config.profiling || this.config.engineMetrics ? { ...base,
      collection: { type: "performance", ...(this.config.measurementMode ? { sampleWindow: true } : {}),
        ...(this.config.engineMetrics ? { engineMetrics: this.config.engineMetrics } : {}) } } : base;
    const solveEnv: PreparedTask["solveEnv"] = { workdir: ".", image: null, initialFiles: [{ source: tracePath, target: base.tracePath }],
      runtime: [], ...(this.environmentName === "docker" ? { network: "host", build: { context: agentXAssets,
        dockerfile: "Dockerfile", sourceHash: await agentXBridgeDigest(signal) } } : {}) };
    const taskFor = (payload: AgentXWorkload): PreparedTask => {
      return { input: { id: ref.id, prompt: `AgentX ${payload.variant} ${payload.mode}: ${concurrency} concurrent session trees`, payload },
        verification: payload, solveEnv, verifyEnv: null, transfer: null, verificationMode: "none",
        artifactDirectory: { name: payload.collection?.type ?? "performance",
          requiredFiles: ["harness.log", ...(payload.mode === "replay" ? ["replay-coverage.json"] : [])] } };
    };
    const performance = taskFor(formal);
    if (!this.config.profiling) return performance;
    const profiling = taskFor({ ...base, mode: "replay", traceCount: this.config.profiling.traceCount ?? concurrency,
      collection: { type: "profiling", profiling: this.config.profiling } });
    if (diagnostic) return profiling;
    return { ...performance, steps: [{ name: "performance", task: performance }, { name: "profiling", task: profiling }] };
  }

  async planRun(refs: TaskRef[], source: SourceLock, signal: AbortSignal, activity?: ActivityListener): Promise<BenchmarkRunPlan> {
    await mkdir(join(this.config.cacheDir, "objects"), { recursive: true });
    const tasks: PreparedTask[] = [];
    for (const ref of refs) {
      activity?.({ message: `Planning task ${tasks.length + 1}/${refs.length} ${ref.id}` });
      tasks.push(await withDatasetActivity(activity, () => this.prepare(ref, source, signal)));
      activity?.({ lines: [`Planning completed ${tasks.length}/${refs.length}`] });
    }
    return { tasks, preparation: { defaultTimeoutSeconds: 3600 }, policy: { version: "agentx-1.0.7-preparation-v3", source: "agentx profile" } };
  }

  async verify(task: PreparedTask, result: SolveResult, _session: unknown, signal: AbortSignal): Promise<VerifyResult> {
    signal.throwIfAborted();
    const summary = parseAgentXSummary(result.observations);
    if (fingerprintConfig(summary.workload) !== fingerprintConfig(task.verification))
      throw new TypeError("AgentX observations differ from the locked measurement point");
    const collection = summary.workload.collection;
    if ((collection?.type === "profiling" && !summary.deviceProfile) ||
        (collection?.type === "performance" && collection.engineMetrics && !summary.engine))
      throw new TypeError("Missing requested AgentX collection");
    return { passed: null, details: { measurement: "agentx", comparable: summary.comparable,
      upstreamSubmissionValid: summary.upstreamSubmissionValid, incomparableReasons: summary.incomparableReasons } };
  }
}
