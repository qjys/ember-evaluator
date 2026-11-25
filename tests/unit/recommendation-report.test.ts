import { expect, test } from "vitest";
import { storeKey, storeRecord, storeRun } from "../fixtures/results/store-fixture.js";
import type { ResultSnapshot } from "../../src/core/contracts/result.js";
import { northStarLengths } from "../../src/plugins/benchmarks/recommendation/config.js";
import { lockedPoint } from "../../src/plugins/benchmarks/recommendation/evidence.js";
import { RecommendationPerformanceMetrics } from "../../src/plugins/metrics/recommendation-performance.js";
import { renderRecommendationTable } from "../../src/plugins/reporters/recommendation-table.js";
import { compareRecommendation } from "../../src/plugins/benchmarks/recommendation/compare.js";
import { currentBudget } from "../../src/plugins/benchmarks/recommendation/budgets.js";
import { fastpathEvidence, sglangDiagnostics } from "../../src/plugins/benchmarks/recommendation/counters.js";

function snapshot(): ResultSnapshot {
  const records = northStarLengths.map(length => {
    const record = storeRecord({ ...storeKey, taskId: `recommendation-L${length}` });
    record.evaluationKind = "performance";
    record.verdict = { passed: null, details: {} };
    record.solve!.observations = { version: 1, samples: [{ phase: "measure", index: 0, promptCount: 1, error: null, e2eMs: 15 }],
      resetOk: true, counters: { shared_prefix_forward: 3, decode_forward: 6, groups_admitted: 1, prefill_wait_us: 1500 } };
    return record;
  });
  const files = ["prefix1.json", "prefix2.json", ...northStarLengths.map(length => `prompts-${length}.json`)]
    .map(path => ({ path, origin: "fixture", sha256: "0".repeat(64) }));
  const source = { source: "recommendation:local", files, revision: "fixed", metadata: { scenario: "north-star", tag: "fast",
    requests: 1, warmup: 0, beamWidth: 128, decodeSteps: 3, concurrency: 1,
    comparison: { session: "A", machine: "host", devices: "0", modelRevision: "m1", tokenizerRevision: "t1" } } };
  records.forEach((record, index) => {
    const obs = record.solve!.observations!;
    if (typeof obs === "object" && obs && !Array.isArray(obs)) obs.workload = lockedPoint(source, northStarLengths[index]!);
  });
  return { run: { ...storeRun, source, evaluationKind: "performance", taskIds: records.map(r => r.key.taskId) }, records, pendingTaskIds: [], digest: "test" };
}

test("offline p50, fast evidence and matching eager baseline are independent decisions", async () => {
  const run = snapshot();
  const metrics = new RecommendationPerformanceMetrics([]);
  const measured = await metrics.compute(run);
  expect(measured).toMatchObject({ complete: true, fast: "hit", l128: "unassessed", northStar: { valid: true, l128: "pass", overall: "pass" } });
  const baseline = [{ length: 128, comparisonKey: String(measured.points[0]!.comparisonKey), p50Ms: 14 }];
  const compare = new RecommendationPerformanceMetrics(baseline);
  const result = await compare.compute(run);
  expect(result).toMatchObject({ l128: "fail" });
  expect(result.points[0]).toMatchObject({ valid: true, deltaMs: 1 });
  expect(renderRecommendationTable(result).join("\n")).toContain("未达标");
  const otherSession = new RecommendationPerformanceMetrics([{ length: 128, comparisonKey: "1".repeat(64), p50Ms: 100 }]);
  const unmatched = await otherSession.compute(run);
  expect(unmatched.l128).toBe("unassessed");
  expect(unmatched.points[0]).toMatchObject({ baselineStatus: "mismatch", baselineMs: null, deltaMs: null });
  for (const record of run.records.slice(0, 1)) {
    const obs = record.solve!.observations!;
    if (typeof obs === "object" && obs && !Array.isArray(obs)) obs.counters = { shared_prefix_forward: 0, decode_forward: 6 };
  }
  expect(await compare.compute(run)).toMatchObject({ fast: "miss", l128: "unassessed" });
  run.records.pop();
  expect(await compare.compute(run)).toMatchObject({ complete: false, fast: "miss", northStar: { missingLengths: [10240], overall: "invalid" } });
  run.records.shift();
  expect(await compare.compute(run)).toMatchObject({ complete: false, fast: "unverified" });
});

test("server stages use admitted/finished group counts and preserve missing probes", () => {
  const result = sglangDiagnostics({ groups_finished: 2, groups_admitted: 2, request_span_us: 10000, first_decode_us: 2000,
    prefill_wait_us: 2000, prefill_selection_us: 1000, decode_step_us: 1000, prefill_commit_us: 1000, decode_steps: 6, decode_selection_us: 3000, decode_selection: 2, decode_forward: 4, overshoot_step_us: 600 }, 4);
  expect(result).toMatchObject({ fastpathForward: null, clientGapMs: -1, clientPercent: -25, dominant: "tail",
    shares: { prefill: 20, pf_sel: 10, decode1: 20, decode2: 10, tail: 40 }, stepMs: 0.25,
    selectionMs: 1.5, stepsPerRequest: 3, overshootRatio: 0.5 });
  expect(result.overshootWallShare).toBeCloseTo(0.2);
  expect(result.stageMs).toMatchObject({ span: 5, prefill: 1, pf_sel: 0.5, decode1: 1, decode2: 0.5, tail: 2 });
  expect(sglangDiagnostics({ shared_prefix_forward: 0 }).fastpathForward).toBe(0);
});

test("historical L=128 and overall budgets have independent verdicts; a missing snapshot removes coverage", async () => {
  const run = snapshot();
  const record = run.records.find(r => r.key.taskId === "recommendation-L512");
  const obs = record?.solve?.observations;
  if (!obs || typeof obs !== "object" || Array.isArray(obs)) throw new Error("Missing fixture observations");
  obs.samples = [{ phase: "measure", index: 0, promptCount: 1, error: null, e2eMs: 70 }];
  const metrics = new RecommendationPerformanceMetrics([]);
  const measured = await metrics.compute(run);
  expect(measured).toMatchObject({ northStar: { valid: true, l128: "pass", overall: "fail", passedLengths: [128, 1024, 5120, 10240] } });
  expect(measured.points[1]?.historical?.deltaEagerMs).toBeCloseTo(3.3);
  expect(measured.points[1]?.historical?.graphRatio).toBeCloseTo(70 / 39.6);
  obs.counters = null;
  const partial = await metrics.compute(run);
  expect(partial).toMatchObject({ complete: false, fast: "hit", northStar: { valid: false, missingLengths: [512], overall: "invalid" } });
  expect(partial.points[1]).toMatchObject({ valid: false, p50Ms: null, diagnostics: null, client: { e2eMs: { p50: 70 } } });
});

test("new graph and legacy eager gates can disagree on the same observations", async () => {
  const run = snapshot(), metrics = new RecommendationPerformanceMetrics([]);
  const obs = run.records[0]?.solve?.observations, meta = run.run.source?.metadata;
  if (!obs || typeof obs !== "object" || Array.isArray(obs) || !meta || typeof meta !== "object" || Array.isArray(meta)) throw new Error("fixture");
  obs.samples = [{ phase: "measure", index: 0, promptCount: 1, error: null, e2eMs: 50 }];
  expect((await metrics.compute(run)).northStar).toMatchObject({ budgetVersion: "legacy-eager", l128: "pass" });
  meta.budgetVersion = currentBudget;
  const result = await metrics.compute(run);
  expect(result.northStar).toMatchObject({ gate: "graph", l128: "fail", overall: "fail" });
  expect(result.points.map(p => p.historical?.gateMs)).toEqual([35.22, 36.90, 41.01, 84.58, 169.99]);
  expect(renderRecommendationTable(result).join("\n")).toContain(currentBudget);
});

test("missing fast-path evidence differs from an explicit zero", () => {
  for (const raw of [{}, { decode_forward: 16 }, { shared_prefix_forward: 0 }, { decode_forward: 0, shared_prefix_forward: 0 },
    { decode_forward: 3, shared_prefix_forward: 4 }])
    expect(fastpathEvidence(raw, true)).toMatchObject({ fastpathStatus: "unverified", fastpathRatio: null });
  const counts = { shared_prefix_forward: 0, decode_forward: 16 };
  expect(fastpathEvidence(counts, true)).toMatchObject({ fastpathStatus: "miss", fastpathRatio: 0 });
  expect(fastpathEvidence({ ...counts, shared_prefix_forward: 1 }, false).fastpathStatus).toBe("unverified");
});

function comparisonArm(tag: string) {
  const run = snapshot();
  run.run.configSummary = { model: "fixture" };
  const source = run.run.source!;
  if (!source.metadata || typeof source.metadata !== "object" || Array.isArray(source.metadata)) throw new Error("fixture source");
  source.metadata.tag = tag;
  for (const [i, record] of run.records.entries()) {
    record.solve!.observations = { workload: lockedPoint(source, northStarLengths[i]!), resetOk: true, samples: [
      { phase: "warmup", index: 0 }, { phase: "measure", index: 0, promptIndex: 0, status: "ok", error: null,
        sidValid: true, scoresFinite: true, choiceCount: 2, candidates: [
          { outputIds: [1, 2, 3], score: -1 }, { outputIds: [1, 4, 5], score: -2 }] }] };
  }
  return run;
}

test("ordered candidates, score drift, missing evidence and input identity", () => {
  const base = comparisonArm("base"), fast = comparisonArm("fast");
  const compare = () => compareRecommendation(base, fast);
  expect(compare().status).toBe("match");
  const obs = fast.records[0]!.solve!.observations!;
  if (typeof obs !== "object" || Array.isArray(obs) || !Array.isArray(obs.samples)) throw new Error("fixture rows");
  const row = obs.samples[1];
  if (!row || typeof row !== "object" || Array.isArray(row) || !Array.isArray(row.candidates)) throw new Error("fixture row");
  row.candidates[1] = { outputIds: [1, 4, 6], score: -1.75 };
  expect(compare().summary).toMatchObject({ requests: 5, verified: 5, sidMatches: 4, scoreMatches: 4, firstMismatch: { length: 128, index: 0 } });
  expect(compare().points[0]).toMatchObject({ status: "mismatch", sidMatches: 0, scoreMatches: 0, firstMismatch: 0,
    rows: [{ scoreDeltas: [0, 0.25] }] });
  row.candidates[1] = { outputIds: [1, 4, 5], score: -1.75 };
  expect(compare().points[0]).toMatchObject({ sidMatches: 1, scoreMatches: 0 });
  row.promptIndex = 1;
  expect(compare().status).toBe("unverified");
  row.promptIndex = 0;
  delete row.candidates;
  expect(compare().status).toBe("unverified");
  Object.assign(row, { choiceCount: 1, outputIds: [1, 2, 3], score: -1 });
  expect(compare().points[0]?.verified).toBe(1);
  obs.samples = [];
  expect(compare().points[0]).toMatchObject({ verified: 0, sidMatchRate: null, status: "unverified" });
  fast.run.source!.revision = "changed";
  expect(compare).toThrow(/digests/);
});
