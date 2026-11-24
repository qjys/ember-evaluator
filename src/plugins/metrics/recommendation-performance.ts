import type { Metrics } from "../../core/contracts/metrics.js";
import type { ResultSnapshot } from "../../core/contracts/result.js";
import { fingerprintConfig } from "../../core/results/run-manifest.js";
import { isEvaluationComplete } from "../../core/results/evaluation-outcome.js";
import { expectPositiveInteger, expectPositiveNumber, expectRecord, rejectUnknown } from "../../core/validation/input.js";
import { northStarLengths } from "../benchmarks/recommendation/config.js";
import { lockedPoint, summarizeSamples } from "../benchmarks/recommendation/evidence.js";
import { sglangDiagnostics } from "../benchmarks/recommendation/counters.js";
import { selectedRecords } from "./records.js";

// Reference budgets embedded in gr-a2 north_star_report.py, in milliseconds.
const eager910b2: Record<number, number> = { 128: 68.7, 512: 66.7, 1024: 69.3, 5120: 99.8, 10240: 180.178 };
const graph910b1: Record<number, number> = { 128: 35.1, 512: 39.6, 1024: 47.6, 5120: 120.8, 10240: 253.1 };

type Baseline = { length: number; comparisonKey: string; p50Ms: number };
export function parseRecommendationMetrics(value: unknown): Baseline[] {
  const config = expectRecord(value, "recommendation-performance");
  rejectUnknown(config, ["eagerBaseline"], "recommendation-performance");
  if (config.eagerBaseline === undefined) return [];
  if (!Array.isArray(config.eagerBaseline)) throw new TypeError("eagerBaseline must be an array");
  const rows = config.eagerBaseline.map(item => {
    const row = expectRecord(item, "eagerBaseline[]");
    rejectUnknown(row, ["length", "comparisonKey", "p50Ms"], "eagerBaseline[]");
    if (typeof row.comparisonKey !== "string" || !/^[a-f0-9]{64}$/u.test(row.comparisonKey)) throw new TypeError("Invalid baseline comparisonKey");
    return { length: expectPositiveInteger(row.length, "baseline.length"), comparisonKey: row.comparisonKey, p50Ms: expectPositiveNumber(row.p50Ms, "baseline.p50Ms") };
  });
  if (new Set(rows.map(row => row.length)).size !== rows.length) throw new TypeError("Duplicate baseline length");
  return rows;
}

export class RecommendationPerformanceMetrics implements Metrics {
  readonly name = "recommendation-performance";
  constructor(private readonly baseline: Baseline[]) {}

  async compute(snapshot: ResultSnapshot) {
    const source = snapshot.run.source;
    if (source?.source !== "recommendation:local") return { applicable: false, points: [] };
    const meta = source.metadata;
    if (!meta || typeof meta !== "object" || Array.isArray(meta)) throw new TypeError("Invalid recommendation source metadata");
    const records = new Map(selectedRecords(snapshot).map(item => [item.key.taskId, item]));
    const ids = snapshot.run.taskIds.filter(id => !id.startsWith("profiling-L"));
    if (!ids.length) return { applicable: false, points: [] };
    const points = ids.map(id => {
      const length = Number(/^recommendation-L(\d+)$/u.exec(id)?.[1]);
      expectPositiveInteger(length, "task length");
      const record = records.get(id);
      const obs = record?.solve?.observations ?? null;
      const workload = lockedPoint(source, length);
      const { requests, warmup, beamWidth, decodeSteps, concurrency, digests } = workload;
      if (obs !== null && (typeof obs !== "object" || Array.isArray(obs) ||
          fingerprintConfig(obs.workload ?? null) !== fingerprintConfig(workload))) throw new TypeError("Recommendation evidence differs from the source lock");
      const samples = obs ? summarizeSamples(obs, workload) : null;
      const invalidReasons = samples ? [...samples.invalidReasons] : ["缺少请求样本"];
      if (meta.scenario === "north-star" && obs?.counters == null) invalidReasons.push("缺少服务端计数器快照");
      const valid = !!(record && isEvaluationComplete(record) && samples?.valid && (meta.scenario !== "north-star" || obs?.counters != null) &&
        ![record.collection.trajectory, record.collection.artifacts].some(state => state === "partial" || state === "missing"));
      const client = samples?.client ?? null;
      const diagnostics = obs?.counters != null ? sglangDiagnostics(obs.counters, client?.e2eMs.mean ?? null) : null;
      const fastpathForward = diagnostics?.fastpathForward ?? null;
      const stageMs = diagnostics?.stageMs ?? {};
      const comparisonKey = meta.comparison ? fingerprintConfig({ identity: meta.comparison, length, digests, requests, warmup,
        concurrency, beamWidth, decodeSteps, timing: "recommendation-http-e2e-v1" }) : null;
      const baseline = this.baseline.find(row => row.length === length);
      const comparable = baseline !== undefined && baseline.comparisonKey === comparisonKey;
      const p50Ms = valid && samples ? samples.p50Ms : null;
      const referenceP50 = diagnostics ? client?.e2eMs.p50 : null;
      const eager = eager910b2[length], graph = graph910b1[length];
      const historical = meta.scenario === "north-star" && eager && graph ? {
        eagerMs: eager, deltaEagerMs: referenceP50 == null ? null : referenceP50 - eager,
        eagerRatio: referenceP50 == null ? null : referenceP50 / eager,
        graphMs: graph, graphRatio: referenceP50 == null ? null : referenceP50 / graph,
      } : null;
      return { length, valid, requests, warmup, resetOk: obs?.resetOk ?? null, client, diagnostics, historical, invalidReasons,
        successfulRequests: samples?.successfulRequests ?? 0, prompts: samples?.prompts ?? 0, p50Ms,
        stageMs, fastpathForward, decodeForward: diagnostics?.decodeForward ?? null, fastpathRatio: diagnostics?.fastpathRatio ?? null,
        comparisonKey, baselineStatus: baseline ? comparable ? "matched" : "mismatch" : "missing",
        baselineMs: comparable ? baseline.p50Ms : null, deltaMs: comparable && p50Ms !== null ? p50Ms - baseline.p50Ms : null };
    });
    const complete = northStarLengths.every(length => points.some(point => point.length === length && point.valid));
    const standard = meta.scenario === "north-star";
    const gatePoints = standard ? points.filter(point => point.length === 128) : points;
    const fast = meta.tag !== "fast" ? "not-requested" : gatePoints.some(point => (point.fastpathRatio ?? 0) > 0) ? "hit" :
      gatePoints.length && gatePoints.every(point => point.fastpathRatio !== null) ? "miss" : "unverified";
    const delta = points.find(point => point.length === 128)?.deltaMs;
    const comparableRun = meta.scenario === "north-star" && complete && (fast === "not-requested" || fast === "hit");
    if (fast === "miss" || fast === "unverified") for (const point of points) point.deltaMs = null;
    const passedLengths = points.filter(point => point.valid && point.historical?.deltaEagerMs != null && point.historical.deltaEagerMs <= 0).map(point => point.length);
    const northStar = standard ? { valid: comparableRun, missingLengths: northStarLengths.filter(length =>
      !points.some(point => point.length === length && point.diagnostics !== null)),
      historicalEagerProfile: { length: 10240, stageUs: 180178, opTotalUs: 159035, freeUs: 21144, kernels: 1665 },
      l128: !comparableRun ? "invalid" : passedLengths.includes(128) ? "pass" : "fail",
      overall: !comparableRun ? "invalid" : passedLengths.length === northStarLengths.length ? "pass" : "fail",
      passedLengths } : null;
    return { applicable: true, northStar, scenario: String(meta.scenario), tag: String(meta.tag), complete, fast,
      l128: comparableRun && delta != null ? delta <= 0 ? "pass" : "fail" : "unassessed", points };
  }
}
