import type { ResultSnapshot } from "../../../core/contracts/result.js";
import { isEvaluationComplete } from "../../../core/results/evaluation-outcome.js";
import { fingerprintConfig } from "../../../core/results/run-manifest.js";
import { expectRecord } from "../../../core/validation/input.js";
import { lockedPoint } from "./evidence.js";
import { fastpathEvidence } from "./counters.js";

type Candidate = { outputIds: number[]; score: number };
type Sample = { index: number; promptIndex: number; candidates: Candidate[] };

function measuredSamples(obs: Record<string, unknown>, depth: number, requests: number) {
  const samples = new Map<number, Sample>();
  const seen = new Set<number>();
  for (const value of Array.isArray(obs.samples) ? obs.samples : []) {
    const row = expectRecord(value, "GR request");
    if (row.phase === "warmup") continue;
    const { index, promptIndex, choiceCount } = row;
    if (row.phase !== "measure" || typeof index !== "number" || !Number.isSafeInteger(index) || index < 0 || index >= requests || seen.has(index))
      throw new Error("Invalid or duplicate formal request index");
    seen.add(index);
    if (row.error !== null || row.status !== "ok" || row.sidValid !== true || row.scoresFinite !== true ||
        typeof promptIndex !== "number" || !Number.isSafeInteger(promptIndex) || promptIndex < 0) continue;
    // Historical clients persisted a complete score only for the first candidate.
    const raw = row.candidates === undefined && choiceCount === 1 ? [row] : row.candidates;
    if (!Array.isArray(raw) || !raw.length || raw.length !== choiceCount) continue;
    const candidates: Candidate[] = [];
    for (const item of raw) {
      const c = expectRecord(item, "GR candidate");
      if (!Array.isArray(c.outputIds) || c.outputIds.length !== depth || !c.outputIds.every(Number.isSafeInteger) ||
          typeof c.score !== "number" || !Number.isFinite(c.score)) break;
      candidates.push({ outputIds: c.outputIds, score: c.score });
    }
    if (candidates.length === raw.length) samples.set(index, { index, promptIndex, candidates });
  }
  return samples;
}

function arm(snapshot: ResultSnapshot, tag: "base" | "fast") {
  const source = snapshot.run.source;
  if (source?.source !== "recommendation:local") throw new Error("Expected a saved recommendation run");
  const meta = expectRecord(source.metadata, "GR source");
  if (meta.tag !== tag) throw new Error("Expected " + tag + " run in this position");
  const { model } = expectRecord(snapshot.run.configSummary, "saved model configuration");
  if (typeof model !== "string" || !model) throw new Error("Missing saved model name");
  const ids = snapshot.run.taskIds.filter(id => /^recommendation-L\d+$/u.test(id));
  const lengthOf = (id: string) => Number(id.slice("recommendation-L".length));
  ids.sort((a, b) => lengthOf(a) - lengthOf(b));
  if (!ids.length) throw new Error("No selected performance tasks");
  const locked = source;
  const records = new Map(snapshot.records.map(record => [record.key.taskId, record]));
  function point(id: string) {
    const workload = lockedPoint(locked, lengthOf(id));
    const record = records.get(id);
    const saved = record?.solve?.observations;
    const obs = saved && typeof saved === "object" && !Array.isArray(saved) ? saved : {};
    if (obs.workload && fingerprintConfig(obs.workload) !== fingerprintConfig(workload)) throw new Error("Saved workload mismatch: " + id);
    const { tag: _tag, ...conditions } = workload;
    const valid = !!(obs.workload && record && isEvaluationComplete(record) &&
      ![record.collection.trajectory, record.collection.artifacts].some(state => state === "partial" || state === "missing"));
    return { conditions, valid, samples: measuredSamples(obs, workload.decodeSteps, workload.requests),
      fastpath: fastpathEvidence(obs.counters, obs.resetOk === true) };
  }
  const identity = expectRecord(meta.comparison ?? {}, "GR comparison identity");
  return { ids, model, revision: source.revision, modelRevision: identity.modelRevision ?? null,
    tokenizerRevision: identity.tokenizerRevision ?? null, point };
}

export function compareRecommendation(baseRun: ResultSnapshot, fastRun: ResultSnapshot) {
  const base = arm(baseRun, "base"), fast = arm(fastRun, "fast");
  if (base.model !== fast.model || base.modelRevision !== fast.modelRevision || base.tokenizerRevision !== fast.tokenizerRevision)
    throw new Error("Model name or declared model/tokenizer revision differs");
  if (base.revision !== fast.revision || fingerprintConfig(base.ids) !== fingerprintConfig(fast.ids))
    throw new Error("Input digests or selected lengths differ");
  const points = base.ids.map(id => {
    const left = base.point(id), right = fast.point(id);
    if (fingerprintConfig(left.conditions) !== fingerprintConfig(right.conditions)) throw new Error("Workload or input digests differ: " + id);
    const { length, requests } = left.conditions;
    const rows = Array.from({ length: requests }, (_, index) => {
      const a = left.samples.get(index), b = right.samples.get(index);
      const comparable = a !== undefined && b !== undefined && a.promptIndex === b.promptIndex;
      const sidMatch = comparable ? a.candidates.length === b.candidates.length && a.candidates.every((c, i) =>
        c.outputIds.every((token, j) => token === b.candidates[i]?.outputIds[j])) : null;
      const scoreDeltas = comparable && a.candidates.length === b.candidates.length
        ? a.candidates.map((c, i) => b.candidates[i]!.score - c.score) : null;
      const scoreMatch = comparable ? scoreDeltas !== null && scoreDeltas.every(delta => delta === 0) : null;
      return { index, base: a ?? null, fast: b ?? null, sidMatch, scoreMatch, scoreDeltas,
        status: !comparable ? "unverified" : sidMatch && scoreMatch ? "match" : "mismatch" };
    });
    const verified = rows.filter(r => r.status !== "unverified").length;
    const sidMatches = rows.filter(r => r.sidMatch).length, scoreMatches = rows.filter(r => r.scoreMatch).length;
    const firstMismatch = rows.find(r => r.status === "mismatch")?.index ?? null;
    return { length, requests, verified, sidMatches, scoreMatches, sidMatchRate: verified ? sidMatches / verified : null,
      firstMismatch, fastpath: right.fastpath, rows,
      status: verified !== requests || !left.valid || !right.valid ? "unverified" : firstMismatch !== null ? "mismatch" : "match" };
  });
  const sum = (key: "requests" | "verified" | "sidMatches" | "scoreMatches") => points.reduce((count, point) => count + point[key], 0);
  const first = points.find(point => point.firstMismatch !== null);
  const verified = sum("verified"), sidMatches = sum("sidMatches");
  const summary = { requests: sum("requests"), verified, sidMatches, sidMatchRate: verified ? sidMatches / verified : null,
    scoreMatches: sum("scoreMatches"), firstMismatch: first ? { length: first.length, index: first.firstMismatch } : null };
  return { schemaVersion: 1, summary, baseRunId: baseRun.run.runId, fastRunId: fastRun.run.runId, sourceRevision: base.revision,
    model: base.model, modelRevision: base.modelRevision, tokenizerRevision: base.tokenizerRevision,
    status: points.some(p => p.status === "unverified") ? "unverified" : points.some(p => p.status === "mismatch") ? "mismatch" : "match", points };
}
