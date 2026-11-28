import type { Metrics } from "../../core/contracts/metrics.js";
import type { AttemptStepResult, ResultSnapshot, SolveResult } from "../../core/contracts/result.js";
import type { JsonValue } from "../../core/contracts/task.js";
import { parseAgentXSummary, successfulAgentXWindow } from "../benchmarks/inference-engine/agentx/evidence/summary.js";
import { selectedRecords } from "./records.js";
import { attemptStatus, isEvaluationComplete } from "../../core/results/evaluation-outcome.js";
import { safeTaskKey } from "../../core/artifacts/artifacts.js";

export class AgentXPerformanceMetrics implements Metrics {
  readonly name = "agentx-performance";
  async compute(snapshot: ResultSnapshot): Promise<JsonValue> {
    const records = selectedRecords(snapshot);
    if (snapshot.run.evaluationKind !== "performance") return { applicable: false, points: [] };
    const source = snapshot.run.source;
    if (!source) return { applicable: true, taskSetKnown: false, points: [] };
    const byTask = new Map(records.map(record => [record.key.taskId, record]));
    const read = (solve: SolveResult | null | undefined) => {
      const summary = solve ? parseAgentXSummary(solve.observations) : null;
      if (summary && (summary.workload.revision !== source.revision ||
        source.files.find(file => file.path === "traces.jsonl")?.sha256 !== summary.workload.sha256))
        throw new TypeError("AgentX summary differs from the run source lock");
      return summary;
    };
    const stepMeasurement = (step: AttemptStepResult | undefined) =>
      step?.verdict && !step.errors.length ? read(step.solve) : null;
    const selected = new Set(snapshot.run.taskIds);
    const artifact = (id: string, tail: string) => {
      const record = byTask.get(id);
      return record ? `tasks/${safeTaskKey(id)}/attempts/${record.key.attemptId}/${tail}` : null;
    };
    const points = [...new Set(snapshot.run.taskIds.map(id => id.replace(/-profiling$/u, "")))].map(taskId => {
      const formal = byTask.get(taskId);
      const steps = formal?.steps;
      const performanceStep = steps?.find(step => step.name === "performance");
      const profileStep = steps?.find(step => step.name === "profiling");
      const summary = steps ? stepMeasurement(performanceStep) : formal && isEvaluationComplete(formal) ? read(formal.solve) : null;
      const point = { taskId, status: formal ? attemptStatus(formal) : "pending", measurement: summary };
      const diagnosticId = steps ? taskId : taskId + "-profiling";
      const hasProfile = !!steps || selected.has(diagnosticId);
      if (!hasProfile && !summary?.workload.collection) return point;
      const batch = summary?.workload.concurrency ?? Number(/-c(\d+)$/u.exec(taskId)?.[1]);
      if (steps && summary && (summary.workload.collection?.type !== "performance" || !taskId.endsWith("-c" + batch)))
        throw new TypeError("AgentX formal result differs from its concurrency point");
      const record = byTask.get(diagnosticId);
      const diagnostic = steps ? stepMeasurement(profileStep) : record && isEvaluationComplete(record) ? read(record.solve) : null;
      if (diagnostic && (diagnostic.workload.collection?.type !== "profiling" || diagnostic.workload.concurrency !== batch))
        throw new TypeError("AgentX diagnostic result differs from its concurrency point");
      const skipped = steps && !profileStep;
      const error = profileStep?.errors[0]?.message ?? record?.errors[0]?.message ??
        (skipped ? "Profiling skipped: formal measurement did not complete successfully" : undefined);
      const missingStatus = !record ? "pending" : skipped || error?.includes("Profiling skipped:") ? "skipped" :
        record.executionStatus === "cancelled" ? "cancelled" : "failed";
      const profiling = hasProfile ? { ...(diagnostic?.deviceProfile ?? { status: missingStatus, ...(error ? { error } : {}) }),
        artifactDirectory: diagnostic?.deviceProfile ? artifact(diagnosticId, diagnostic.artifactDirectory ?? `artifacts/agentx/profiling/point-${batch}`) : null,
        traceCount: diagnostic?.workload.traceCount ?? null, requests: diagnostic?.replayCoverage?.successfulRequests ?? null } : undefined;
      const diagnosticStatus = diagnostic?.deviceProfile?.coverageStatus ?? diagnostic?.deviceProfile?.status;
      if (!selected.has(taskId)) return { taskId, measurement: null, status: diagnosticStatus ?? missingStatus,
        collections: [{ concurrency: batch, dataset: diagnostic?.workload.dataset ?? null, ...(profiling ? { profiling } : {}) }] };
      const performanceStatus = summary ? successfulAgentXWindow(summary) ?
        "measured" : "partial" : point.status;
      const complete = performanceStatus === "measured" && (!summary?.engine || summary.engine.status === "measured") &&
        (!profiling || diagnosticStatus === "measured");
      return { ...point, status: !summary ? point.status : complete ? "measured" : "partial", collections: [{
        dataset: summary?.workload.dataset ?? null, concurrency: batch, performanceStatus,
        performanceDirectory: summary ? artifact(taskId, summary.artifactDirectory ?? `artifacts/agentx/outputs/point-${batch}`) : null, ...(summary?.engine ? { engine: summary.engine } : {}),
        ...(profiling ? { profiling } : {}) }] };
    });
    return { applicable: true, points };
  }
}
