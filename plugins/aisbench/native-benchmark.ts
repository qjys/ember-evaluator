import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { isAbsolute, relative, sep } from "node:path";
import { fingerprintConfig } from "arsi-evaluator";
import type { Benchmark, EffectiveConfig, PluginFactoryContext, PreparedTask, ResultSnapshot, SolveResult, SourceLock, TaskRef } from "arsi-evaluator";
import { validateAisbenchRun, validateAisbenchService } from "./benchmark.js";
import type { NativeConfig } from "./native-config.js";
import { bundleDigest } from "./ssh/bundle.js";
import { expectNonEmptyString, expectRecord } from "./validation.js";

export async function nativeFiles(config: NativeConfig, runtime: PluginFactoryContext, signal: AbortSignal) {
  if (!config.configFile) return [];
  const root = await realpath(runtime.configDirectory);
  const result = [];
  for (const path of [config.configFile, ...config.files ?? []]) {
    const file = await realpath(runtime.resolvePath(path));
    const location = relative(root, file);
    if (location === ".." || location.startsWith(".." + sep) || isAbsolute(location)) throw new TypeError("AISBench config files must be inside the experiment directory");
    const bytes = await readFile(file, { signal });
    result.push({ path, sha256: createHash("sha256").update(bytes).digest("hex"), data: bytes.toString("base64") });
  }
  return result;
}

export class NativeBenchmark implements Benchmark {
  readonly evaluationKind = "performance";
  readonly validateSourceOnCompletedResume = true;
  constructor(readonly config: NativeConfig, private readonly runtime: PluginFactoryContext) {}

  private get dataOnly(): boolean {
    return this.config.multimodalAction === "prepare" || this.config.multimodalAction === "validate";
  }

  requestedMeasurements(): string[] {
    return ["service/requests", ...(this.config.engineMetrics ? ["engine/engine"] : []),
      ...(this.config.profiling ? ["execution/operators", "parallelism/timeline"] : [])];
  }

  async validatePrerequisites(ref: TaskRef, snapshot: () => Promise<ResultSnapshot>): Promise<void> {
    if (!this.config.profiling) return;
    for (const record of (await snapshot()).records) {
      const observations = record.solve?.observations;
      if (!observations || typeof observations !== "object" || Array.isArray(observations) || !Array.isArray(observations.collections)) continue;
      for (const collection of observations.collections) {
        const profile = expectRecord(collection, "AISBench collection").profiling;
        if (profile && String(expectRecord(profile, "AISBench profile").error).includes("stop_profile unconfirmed"))
          throw new Error(`Cannot start ${ref.id}: stop_profile unconfirmed after ${record.key.taskId}`);
      }
    }
  }

  validateRun(config: EffectiveConfig): void {
    validateAisbenchRun(config, !this.dataOnly);
    const profileService = this.config.profiling?.service;
    if (profileService) {
      validateAisbenchService(config, profileService);
      if (config.services[profileService]?.name !== config.services[config.solver.service]?.name)
        throw new TypeError("AISBench performance and profiling services must serve the same model");
    }
    if (this.config.multimodalGeneration && !config.solver.config.tokenizerPath)
      throw new TypeError("multimodalGeneration requires benchmark.solver.config.tokenizerPath on the benchmark host");
    if (Array.isArray(config.solver.config.podInfo) && config.solver.config.podInfo.length)
      throw new TypeError("podInfo belongs to the standard prefix-cache workload");
  }

  async resolveSource(previous: SourceLock | null, signal: AbortSignal): Promise<SourceLock> {
    signal.throwIfAborted();
    const files = (await nativeFiles(this.config, this.runtime, signal)).map(({ path, sha256 }) => ({ path, sha256, origin: "experiment" }));
    const source = { source: "aisbench:native", revision: previous?.revision === "1" ? "1" : "2", files, metadata: { bundleDigest: await bundleDigest(), configDigest: fingerprintConfig(this.config) } };
    if (previous && fingerprintConfig(previous) !== fingerprintConfig(source)) throw new TypeError("Native AISBench source or configuration changed");
    return source;
  }

  private *points(source: SourceLock) {
    const id = `aisbench-native-${fingerprintConfig(source).slice(-16)}`;
    const recordKey = fingerprintConfig(this.config);
    if (source.revision === "1" || this.dataOnly) {
      yield { ref: { id, recordKey }, native: this.config };
      return;
    }
    const batches = this.config.concurrency;
    if (!batches) {
      // Service collection sets batch size 1 itself. A native CLI/config may choose its own.
      const concurrency = this.config.profiling || this.config.engineMetrics ? 1 : null;
      yield { ref: { id, recordKey, measurementConcurrency: concurrency }, native: this.config };
      return;
    }
    for (const concurrency of new Set(batches)) {
      const indices = batches.flatMap((batch, index) => batch === concurrency ? [index] : []);
      const counts = this.config.dataCount;
      const native = { ...this.config, concurrency: indices.map(() => concurrency),
        ...(counts ? { dataCount: indices.map(i => counts[i]!) } : {}) };
      yield { ref: { id: id + "-c" + concurrency, recordKey, measurementConcurrency: concurrency }, native };
    }
  }

  async *enumerate(source: SourceLock, signal: AbortSignal): AsyncIterable<TaskRef> {
    signal.throwIfAborted();
    for (const point of this.points(source)) yield point.ref;
  }

  async prepare(ref: TaskRef, source: SourceLock, signal: AbortSignal): Promise<PreparedTask> {
    await this.resolveSource(source, signal);
    const point = Array.from(this.points(source)).find(p => ref.id === p.ref.id);
    if (!point || ref.recordKey !== point.ref.recordKey) throw new TypeError("Invalid native AISBench task selection");
    const shareGenerated = this.config.multimodalGeneration && !this.dataOnly &&
      source.revision !== "1" && new Set(this.config.concurrency).size > 1;
    const payload = { kind: "aisbench-native", schemaVersion: 1, native: point.native, files: source.files,
      ...(shareGenerated ? { sharedGenerationCount: Math.max(...this.config.dataCount!) } : {}),
      bundleDigest: expectNonEmptyString(expectRecord(source.metadata, "source metadata").bundleDigest, "bundleDigest") };
    return { input: { id: ref.id, prompt: "AISBench native performance measurement", payload }, verification: fingerprintConfig(payload),
      solveEnv: { workdir: ".", image: null, initialFiles: [], runtime: [] }, verifyEnv: null, transfer: null, verificationMode: "none" };
  }

  async verify(task: PreparedTask, result: SolveResult, _session: unknown, signal: AbortSignal) {
    signal.throwIfAborted();
    const evidence = expectRecord(result.observations, "native AISBench observations");
    if (evidence.kind !== "aisbench-native" || evidence.schemaVersion !== 1 || evidence.taskDigest !== task.verification || !Array.isArray(evidence.groups))
      throw new TypeError("Native AISBench observations differ from the selected task");
    return { passed: null, details: { measurement: "aisbench-native", groups: evidence.groups.length } };
  }
}
