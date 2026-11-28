import { attemptStatus, fingerprintConfig } from "arsi-evaluator";
import type { AttemptRecord, JsonValue, Metrics, ResultSnapshot } from "arsi-evaluator";
import { normalizedMetrics, parseAisbenchSummary } from "./evidence.js";
import type { AisbenchSummary } from "./evidence.js";
import { expectRecord } from "./validation.js";
import { aisbenchMeasurementFiles } from "./measurement-files.js";

type AisbenchPoint = { taskId: string; status: string; measurement: AisbenchSummary | null };
type AisbenchMetric = { applicable: boolean; taskSetKnown?: false; points: AisbenchPoint[] };

function applicable(snapshot: ResultSnapshot): boolean {
  return snapshot.run.evaluationKind === "performance" &&
    (!snapshot.run.source || ["github:rayn-zzz/aisbench_auto_tools_prefix", "aisbench:synthetic"].includes(snapshot.run.source.source));
}

export function recordsByTask(snapshot: ResultSnapshot): Map<string, AttemptRecord> {
  const selected = new Set(snapshot.run.taskIds);
  if (selected.size !== snapshot.run.taskIds.length) throw new TypeError("Duplicate selected task ID");
  const records = new Map<string, AttemptRecord>();
  // The store owns retry selection. Attempt history must not change its selected records here.
  for (const record of snapshot.records) {
    if (record.evaluationKind !== "performance") throw new TypeError("Record evaluation kind differs from the performance run");
    if (record.key.runId !== snapshot.run.runId || !selected.has(record.key.taskId))
      throw new TypeError("Record does not belong to the selected run/task");
    if (records.has(record.key.taskId)) throw new TypeError("Duplicate task record in snapshot");
    if (record.verdict && (record.verdict.passed !== null || record.verdict.score !== undefined))
      throw new TypeError("Performance evidence requires passed:null and no score");
    records.set(record.key.taskId, record);
  }
  const pending = new Set(snapshot.pendingTaskIds);
  if (pending.size !== snapshot.pendingTaskIds.length || [...pending].some(id => !selected.has(id)))
    throw new TypeError("Invalid pending task IDs");
  return records;
}

export function pointStatus(record: AttemptRecord | undefined): string {
  if (!record) return "pending";
  if (record.executionStatus !== "completed") return attemptStatus(record);
  return record.collection.artifacts === "complete" && record.solve && record.verdict?.passed === null && record.solve.observations != null ? "completed" : "incomplete";
}

function sourceDigest(snapshot: ResultSnapshot): string {
  const metadata = expectRecord(snapshot.run.source?.metadata, "AISBench source metadata");
  if (typeof metadata.bundleDigest !== "string" || !/^[a-f0-9]{64}$/u.test(metadata.bundleDigest))
    throw new TypeError("Invalid AISBench source bundle digest");
  return metadata.bundleDigest;
}

function measurement(value: unknown, taskId: string, digest: string): AisbenchSummary {
  const summary = parseAisbenchSummary(value);
  if (summary.bundleDigest !== digest || taskId !== `aisbench-${fingerprintConfig(summary.workload).slice(-16)}`)
    throw new TypeError("AISBench measurement differs from the run source lock");
  return summary;
}

export class AisbenchPerformanceMetrics implements Metrics {
  readonly measurementFiles = aisbenchMeasurementFiles;
  readonly name = "aisbench-performance";

  async compute(snapshot: ResultSnapshot): Promise<JsonValue> {
    if (!applicable(snapshot)) return { applicable: false, points: [] };
    const records = recordsByTask(snapshot);
    if (!snapshot.run.source) return { applicable: true, taskSetKnown: false, points: [] };
    const digest = sourceDigest(snapshot);
    const points = snapshot.run.taskIds.map(taskId => {
      const record = records.get(taskId), status = pointStatus(record);
      const summary = status === "completed" ? measurement(record?.solve?.observations, taskId, digest) : null;
      const provenance = snapshot.run.solverProvenance;
      if (summary && provenance && (provenance.bundleDigest !== summary.bundleDigest || provenance.aisbenchVersion !== summary.aisbenchVersion))
        throw new TypeError("AISBench measurement differs from solver provenance");
      if (summary && snapshot.run.source?.source !== (summary.workload.dataset === "synthetic" ? "aisbench:synthetic" : "github:rayn-zzz/aisbench_auto_tools_prefix"))
        throw new TypeError("AISBench workload differs from source");
      return { taskId, status, measurement: summary, workload: summary?.workload ?? null,
        metrics: summary ? normalizedMetrics(summary) : {} };
    });
    return { applicable: true, points };
  }
}

/** Check supplied report metrics against their public snapshot without reselecting attempts. */
export function readAisbenchMetric(snapshot: ResultSnapshot, value: JsonValue): AisbenchMetric {
  const metric = expectRecord(value, "aisbench-performance metric");
  if (metric.applicable !== applicable(snapshot) || !Array.isArray(metric.points))
    throw new TypeError("AISBench metric applicability or points differ from the run");
  if (metric.applicable === false) {
    if (metric.points.length) throw new TypeError("Non-applicable AISBench metrics cannot contain points");
    return { applicable: false, points: [] };
  }
  const records = recordsByTask(snapshot);
  if (!snapshot.run.source) {
    if (metric.taskSetKnown !== false || metric.points.length) throw new TypeError("AISBench task set is unknown");
    return { applicable: true, taskSetKnown: false, points: [] };
  }
  const digest = sourceDigest(snapshot), selected = new Set(snapshot.run.taskIds), seen = new Set<string>();
  const points = metric.points.map(value => {
    const point = expectRecord(value, "AISBench report point");
    if (typeof point.taskId !== "string" || !selected.has(point.taskId) || seen.has(point.taskId))
      throw new TypeError("Invalid or duplicate AISBench report task");
    seen.add(point.taskId);
    const record = records.get(point.taskId), status = pointStatus(record);
    if (point.status !== status || (status === "completed") !== (point.measurement !== null))
      throw new TypeError("AISBench report status or evidence differs from the selected attempt");
    const summary = point.measurement === null ? null : measurement(point.measurement, point.taskId, digest);
    const observations = record?.solve?.observations;
    if (summary && (observations === undefined || fingerprintConfig(summary) !== fingerprintConfig(observations)))
      throw new TypeError("AISBench report measurement differs from saved observations");
    return { taskId: point.taskId, status, measurement: summary };
  });
  if (seen.size !== selected.size) throw new TypeError("AISBench report is missing selected tasks");
  return { applicable: true, points };
}
