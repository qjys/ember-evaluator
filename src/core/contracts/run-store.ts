import type { MeasurementMetricFile, MetricResults } from "./metrics.js";
import type {
  AttemptKey,
  AttemptPaths,
  AttemptRecord,
  AttemptSummary,
  FileManifest,
  ResultSnapshot,
  RunManifest,
  RemoteAttemptUpdate,
} from "./result.js";
import type { JsonValue } from "./task.js";
import type { TaskReportDocument } from "./reporter.js";

export interface RunStore {
  readonly controlDirectory?: string;
  create(root: string, manifest: RunManifest, safeConfig: JsonValue): Promise<void>;
  open(runDir: string): Promise<RunManifest>;
  allocate(key: AttemptKey): Promise<AttemptPaths>;
  listAttempts(): Promise<AttemptSummary[]>;
  currentTaskResult?(taskId: string): Promise<AttemptRecord | null>;
  updateRun(patch: Partial<Pick<RunManifest, "status" | "finishedAt" | "durationMs" | "preparationRounds" | "source" | "taskIds" | "failure" | "initializationFailures">>): Promise<void>;
  commit(record: AttemptRecord, files: FileManifest): Promise<void>;
  /** Atomically admit only the currently allocated remote attempt; false keeps late evidence quarantined. */
  importAttempt?(record: AttemptRecord, files: FileManifest, sourceRoot: string): Promise<boolean>;
  updateRemoteAttempt?(update: RemoteAttemptUpdate): Promise<void>;
  snapshot(): Promise<ResultSnapshot>;
  /** Resume starts a separate report directory; updates replace the current reports. */
  saveReportBundle(snapshotDigest: string, metrics: MetricResults, markdown: string, reports: TaskReportDocument[], mode?: "update" | "resume", measurementFiles?: MeasurementMetricFile[]): Promise<void>;
  close(): Promise<void>;
}
