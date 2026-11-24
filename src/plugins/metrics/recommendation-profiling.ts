import type { Metrics } from "../../core/contracts/metrics.js";
import type { ResultSnapshot } from "../../core/contracts/result.js";
import { isEvaluationComplete } from "../../core/results/evaluation-outcome.js";
import { safeTaskKey } from "../../core/artifacts/artifacts.js";
import { selectedRecords } from "./records.js";

export class RecommendationProfilingMetrics implements Metrics {
  readonly name = "recommendation-profiling";

  async compute(snapshot: ResultSnapshot) {
    const meta = snapshot.run.source?.metadata;
    if (!meta || typeof meta !== "object" || Array.isArray(meta) || !Array.isArray(meta.collections))
      return { applicable: false, points: [] };
    const ids = snapshot.run.taskIds.filter(id => /^profiling-L\d+$/u.test(id));
    const records = new Map(selectedRecords(snapshot).map(record => [record.key.taskId, record]));
    const points = ids.map(id => {
      const record = records.get(id);
      const obs = record?.solve?.observations;
      const profile = obs && typeof obs === "object" && !Array.isArray(obs) ? obs.profile ?? null : null;
      const valid = !!(record && isEvaluationComplete(record) && profile && typeof profile === "object" &&
        !Array.isArray(profile) && profile.deviceEvidence === true &&
        ![record.collection.trajectory, record.collection.artifacts].some(s => s === "missing" || s === "partial"));
      return { length: Number(id.slice("profiling-L".length)), valid, profile,
        attempt: record ? "tasks/" + safeTaskKey(id) + "/attempts/" + record.key.attemptId : null,
        errors: record?.errors.map(error => error.message) ?? [] };
    });
    return { applicable: ids.length > 0, scenario: meta.scenario ?? null, tag: meta.tag ?? null,
      collections: meta.collections, sourceRevision: snapshot.run.source?.revision ?? null, complete: ids.length > 0 && points.every(p => p.valid), points };
  }
}
