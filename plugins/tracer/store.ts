import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  AttemptKey,
  AttemptPaths,
  AttemptRecord,
  AttemptSummary,
  FileManifest,
  RemoteAttemptUpdate,
  ResultSnapshot,
  RunManifest,
  RunStore,
} from "arsi-evaluator";
import type { JsonValue } from "arsi-evaluator";
import type { TracerClient } from "./client.js";
import { TrajectoryTailer } from "./tail.js";

const keyOf = (key: AttemptKey) => `${key.runId}/${key.taskId}/${key.attemptId}`;

/** Payload bytes the mirror may retain while the Collector is slow; beyond this, uploads are dropped with a warning. */
const MIRROR_BUDGET_BYTES = 64 * 1024 * 1024;

/** Keeps the local store authoritative and mirrors the same evidence into the Collector. */
export class TracerStore implements RunStore {
  private readonly allocations = new Map<string, AttemptPaths>();
  private readonly tails = new Map<string, TrajectoryTailer>();
  private readonly mirror: MirrorQueue;
  private runId: string | null = null;
  private runDirectory: string | null = null;

  constructor(
    private readonly inner: RunStore,
    private readonly client: TracerClient,
    private readonly warn: (message: string, level?: "info" | "warning") => void,
  ) {
    this.mirror = new MirrorQueue(MIRROR_BUDGET_BYTES, message => warn(message, "warning"));
    if ("controlDirectory" in inner) Object.defineProperty(this, "controlDirectory", { get: () => inner.controlDirectory });
    if (inner.currentTaskResult) this.currentTaskResult = inner.currentTaskResult.bind(inner);
    if (inner.updateRemoteAttempt) this.updateRemoteAttempt = inner.updateRemoteAttempt.bind(inner);
    const importAttempt = inner.importAttempt?.bind(inner);
    if (importAttempt) this.importAttempt = async (record, files, sourceRoot) => {
      const accepted = await importAttempt(record, files, sourceRoot);
      if (!accepted) return false;
      const key = keyOf(record.key);
      const tailer = this.tails.get(key);
      this.tails.delete(key);
      const paths = this.allocations.get(key) ?? { root: sourceRoot, agent: join(sourceRoot, "agent"), verifier: join(sourceRoot, "verifier"), artifacts: join(sourceRoot, "artifacts") };
      this.allocations.delete(key);
      await this.mirrorAttempt(record, paths, tailer);
      return true;
    };
  }

  declare readonly controlDirectory?: string;
  currentTaskResult?: (taskId: string) => Promise<AttemptRecord | null>;
  importAttempt?: (record: AttemptRecord, files: FileManifest, sourceRoot: string) => Promise<boolean>;
  updateRemoteAttempt?: (update: RemoteAttemptUpdate) => Promise<void>;

  async create(root: string, manifest: RunManifest, safeConfig: JsonValue): Promise<void> {
    await this.inner.create(root, manifest, safeConfig);
    this.runId = manifest.runId;
    this.runDirectory = join(root, manifest.runId);
    await this.client.begin(manifest.runId, manifest.configFingerprint, manifest.configSummary);
  }

  async open(runDir: string): Promise<RunManifest> {
    const manifest = await this.inner.open(runDir);
    this.runId = manifest.runId;
    this.runDirectory = runDir;
    await this.client.begin(manifest.runId, manifest.configFingerprint, manifest.configSummary);
    return manifest;
  }

  async allocate(key: AttemptKey): Promise<AttemptPaths> {
    const paths = await this.inner.allocate(key);
    this.allocations.set(keyOf(key), paths);
    this.tail(key, paths);
    return paths;
  }

  listAttempts(): Promise<AttemptSummary[]> {
    return this.inner.listAttempts();
  }

  async updateRun(patch: Partial<Pick<RunManifest, "status" | "finishedAt" | "durationMs" | "preparationRounds" | "source" | "taskIds" | "failure" | "initializationFailures">>): Promise<void> {
    await this.inner.updateRun(patch);
    if (this.runId && patch.status !== undefined && patch.status !== "running") {
      await this.stopTails();
      // Finish must observe every attempt: the export reads what the Collector has already stored.
      await this.mirror.flush();
      await this.client.finish(this.runId);
      await this.exportArtifacts();
    }
  }

  /**
   * Persists the deterministic outputs (signals + conclusion) next to the run
   * artifacts so downstream optimization reads a stable file instead of scraping
   * the UI. Best effort: a failure here must never change the run outcome.
   */
  private async exportArtifacts(): Promise<void> {
    const runId = this.runId;
    const base = this.runDirectory;
    if (!runId || !base) return;
    const epoch = encodeURIComponent(runId);
    const artifacts: Record<string, string> = { run_dir: base };
    const outputs: ReadonlyArray<readonly [string, string, string]> = [
      ["signals_json", `/v1/signals?epoch=${epoch}&format=json`, "signals.json"],
      ["signals_md", `/v1/signals?epoch=${epoch}&format=md`, "signals.md"],
      ["conclusion_json", `/v1/conclusion?epoch=${epoch}&format=json`, "conclusion.json"],
      ["conclusion_md", `/v1/conclusion?epoch=${epoch}&format=md`, "conclusion.md"],
    ];
    try {
      const directory = join(base, "analysis");
      await mkdir(directory, { recursive: true });
      for (const [key, query, name] of outputs) {
        const text = await this.client.get(query);
        if (!text) continue;
        const path = join(directory, name);
        await writeFile(path, text, "utf8");
        artifacts[key] = path;
      }
      if (artifacts.signals_json || artifacts.conclusion_json) {
        await this.client.artifacts(runId, artifacts);
      }
    } catch (error) {
      this.warn(`cannot write analysis outputs for run ${runId}: ${error instanceof Error ? error.message : String(error)}`, "warning");
    }
  }

  async commit(record: AttemptRecord, files: FileManifest): Promise<void> {
    await this.inner.commit(record, files);
    const key = keyOf(record.key);
    const tailer = this.tails.get(key);
    this.tails.delete(key);
    const paths = this.allocations.get(key);
    this.allocations.delete(key);
    // The scheduler slot is released when this resolves, so uploads stay off the commit path.
    await this.mirrorAttempt(record, paths, tailer);
  }

  snapshot(): Promise<ResultSnapshot> {
    return this.inner.snapshot();
  }

  saveReportBundle(...args: Parameters<RunStore["saveReportBundle"]>): Promise<void> {
    return this.inner.saveReportBundle(...args);
  }

  async close(): Promise<void> {
    try { await this.dispose(); } finally { await this.inner.close(); }
  }

  async dispose(): Promise<void> {
    await this.stopTails();
    await this.mirror.flush();
    this.allocations.clear();
  }

  /** Waits for queued uploads; shutdown paths and tests use this instead of sleeping. */
  flush(): Promise<void> {
    return this.mirror.flush();
  }

  private tail(key: AttemptKey, paths: AttemptPaths): void {
    const id = keyOf(key);
    void this.tails.get(id)?.stop();
    const tailer = new TrajectoryTailer(
      join(paths.agent, "trajectory.jsonl"),
      lines => this.client.ingest(key.attemptId, lines),
      this.warn,
    );
    this.tails.set(id, tailer);
    tailer.start();
  }

  private async stopTails(): Promise<void> {
    const tails = [...this.tails.values()];
    this.tails.clear();
    await Promise.all(tails.map(tailer => tailer.stop()));
  }

  /**
   * Reads the payloads locally and hands them to the mirror queue, so commit resolves without
   * waiting for the Collector; run finish and dispose flush the queue before closing the epoch.
   */
  private async mirrorAttempt(record: AttemptRecord, paths: AttemptPaths | undefined, tailer: TrajectoryTailer | undefined): Promise<void> {
    const lines = tailer ? [] : await this.readTrajectory(record, paths);
    const summary = await this.readSummary(record, paths);
    const state = JSON.stringify(record);
    const bytes = lines.reduce((total, line) => total + line.length, 0) + (summary?.length ?? 0) + state.length;
    const queued = this.mirror.enqueue(keyOf(record.key), bytes, async () => {
      if (tailer) await tailer.stop();
      if (lines.length) await this.client.ingest(record.key.attemptId, lines);
      if (summary) await this.client.ingest(record.key.attemptId, [summary]);
      await this.client.ingest(record.key.attemptId, [state]);
    });
    if (!queued) void tailer?.stop().catch(() => {});
  }

  /**
   * AgentX perf summaries are only written when an attempt is torn down, so report
   * one here to feed the inference/hardware metric pages. The raw summary has no
   * epoch and already carries kind="agentx", so wrap it with epoch/session/seq; a
   * fixed seq keeps re-reports from retries and resumes idempotent.
   */
  private async readSummary(record: AttemptRecord, paths: AttemptPaths | undefined): Promise<string | null> {
    if (!paths) return null;
    try {
      const text = await readFile(join(paths.agent, "agentx-summary.json"), "utf8");
      return JSON.stringify({ session: record.key.attemptId, epoch: record.key.runId, seq: 1, data: JSON.parse(text) as unknown });
    } catch (error) {
      if (!isMissing(error)) {
        this.warn(`cannot read agentx summary for attempt ${record.key.attemptId}: ${error instanceof Error ? error.message : String(error)}`, "warning");
      }
      return null;
    }
  }

  /** Fallback for attempts without a tailer, e.g. a resumed run that never allocated. */
  private async readTrajectory(record: AttemptRecord, paths: AttemptPaths | undefined): Promise<string[]> {
    if (!paths) return [];
    try {
      const text = await readFile(join(paths.agent, "trajectory.jsonl"), "utf8");
      return text.split(/\r?\n/).filter(line => line.trim() !== "");
    } catch (error) {
      if (!isMissing(error)) this.clientWarn(record, error);
      return [];
    }
  }

  private clientWarn(record: AttemptRecord, error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    this.warn(`cannot read trajectory for attempt ${record.key.attemptId}: ${message}`, "warning");
  }
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

type MirrorJob = () => Promise<void>;

/**
 * Serializes uploads per attempt and bounds how many payload bytes are retained, so a slow or
 * hung Collector can only delay the mirror, never the scheduler that produced the results.
 */
class MirrorQueue {
  private readonly chains = new Map<string, Promise<void>>();
  private bytes = 0;

  constructor(
    private readonly maxBytes: number,
    private readonly warn: (message: string) => void,
  ) {}

  enqueue(key: string, bytes: number, job: MirrorJob): boolean {
    if (this.bytes + bytes > this.maxBytes) {
      this.warn(`tracer mirror queue is full; dropping the pending upload for ${key}`);
      return false;
    }
    this.bytes += bytes;
    const previous = this.chains.get(key) ?? Promise.resolve();
    const next = previous.then(job).catch(error => {
      this.warn(`tracer mirror upload failed for ${key}: ${error instanceof Error ? error.message : String(error)}`);
    }).finally(() => {
      this.bytes -= bytes;
      if (this.chains.get(key) === next) this.chains.delete(key);
    });
    this.chains.set(key, next);
    return true;
  }

  async flush(): Promise<void> {
    while (this.chains.size) await Promise.all([...this.chains.values()]);
  }
}
