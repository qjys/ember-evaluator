import { fingerprintConfig } from "arsi-evaluator";
import type { Benchmark, EffectiveConfig, PreparedTask, SourceLock, TaskRef, SolveResult, VerifyResult } from "arsi-evaluator";
import { expectRecord } from "./validation.js";
import type { AisbenchConfig } from "./config.js";
import { bundleDigest, upstreamRevision } from "./ssh/bundle.js";
import { aisbenchBaseUrl } from "./ssh/client.js";
import { parseAisbenchSummary } from "./evidence.js";

export { parseAisbenchConfig, type AisbenchConfig } from "./config.js";

const sourceName = "github:rayn-zzz/aisbench_auto_tools_prefix";

export class AisbenchBenchmark implements Benchmark {
  readonly evaluationKind = "performance";
  readonly validateSourceOnCompletedResume = true;
  constructor(readonly config: AisbenchConfig) {}

  validateRun(config: EffectiveConfig): void {
    validateAisbenchRun(config);
    if (!expectRecord(config.solver.config.remote, "remote").aisbenchWorkPath)
      throw new TypeError("aisbenchWorkPath is required for the standard AISBench scenario");
    if (!config.solver.config.tokenizerPath) throw new TypeError("tokenizerPath is required for the standard AISBench scenario");
  }

  async resolveSource(previous: SourceLock | null, signal: AbortSignal): Promise<SourceLock> {
    signal.throwIfAborted();
    const source: SourceLock = { source: this.config.workload.dataset === "synthetic" ? "aisbench:synthetic" : sourceName, revision: this.config.workload.dataset === "synthetic" ? "1" : upstreamRevision, files: [], metadata: { bundleDigest: await bundleDigest() } };
    if (previous && fingerprintConfig(previous) !== fingerprintConfig(source)) throw new TypeError("AISBench locked source differs from the installed bundle");
    return source;
  }

  private id(): string { return `aisbench-${fingerprintConfig(this.config.workload).slice(-16)}`; }

  async *enumerate(_source: SourceLock, signal: AbortSignal): AsyncIterable<TaskRef> {
    signal.throwIfAborted();
    yield { id: this.id(), recordKey: this.config.workload };
  }

  async prepare(ref: TaskRef, source: SourceLock, signal: AbortSignal): Promise<PreparedTask> {
    signal.throwIfAborted();
    if (ref.id !== this.id() || fingerprintConfig(ref.recordKey) !== fingerprintConfig(this.config.workload))
      throw new TypeError("Invalid AISBench measurement point selection");
    const locked = await this.resolveSource(source, signal);
    const metadata = expectRecord(locked.metadata, "AISBench source metadata");
    const payload = { schemaVersion: 1, kind: "aisbench", workload: this.config.workload, bundleDigest: String(metadata.bundleDigest) };
    return { input: { id: ref.id, prompt: `AISBench: ${this.config.workload.concurrency} concurrent requests`, payload },
      verification: payload, solveEnv: { workdir: ".", image: null, initialFiles: [], runtime: [] },
      verifyEnv: null, transfer: null, verificationMode: "none" };
  }

  async verify(task: PreparedTask, result: SolveResult, _session: unknown, signal: AbortSignal): Promise<VerifyResult> {
    signal.throwIfAborted();
    const summary = parseAisbenchSummary(result.observations);
    const evidence = { schemaVersion: summary.schemaVersion, kind: summary.kind, workload: summary.workload, bundleDigest: summary.bundleDigest };
    if (fingerprintConfig(evidence) !== fingerprintConfig(task.verification)) throw new TypeError("AISBench observations differ from the locked measurement point");
    return { passed: null, details: { measurement: "aisbench", rowCount: summary.rows.length, aisbenchVersion: summary.aisbenchVersion } };
  }
}

export function validateAisbenchRun(config: EffectiveConfig, usesModel = true): void {
  if (config.solver.name !== "aisbench-ssh" || config.verifier !== undefined)
    throw new TypeError("AISBench requires aisbench-ssh and has no correctness verifier");
  if (config.environment.name !== "local" || config.scheduler.name !== "local" || config.scheduler.config.concurrency !== 1)
    throw new TypeError("AISBench requires local environment and local scheduler concurrency=1");
  if (config.run.preparation?.mode === "pipeline") throw new TypeError("AISBench does not support pipeline preparation");
  if (!usesModel) return;
  validateAisbenchService(config, config.solver.service);
}

export function validateAisbenchService(config: EffectiveConfig, name: string): void {
  const model = config.services[name];
  if (!model || model.api !== "openai-completions" || model.endpoint === null)
    throw new TypeError("AISBench requires an OpenAI Chat Completions endpoint");
  if (model.maxTokens !== undefined) throw new TypeError("Set output length in the AISBench workload or maxOutputTokens; remove services maxTokens");
  aisbenchBaseUrl(model.endpoint);
}
