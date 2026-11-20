import { expectPositiveInteger, expectRecord } from "../../../core/validation/input.js";
import type { SourceLock } from "../../../core/contracts/task.js";

export function lockedPoint(source: SourceLock, length: number) {
  const meta = source.metadata;
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) throw new TypeError("Invalid recommendation source metadata");
  const digests: Record<string, string> = {};
  for (const path of ["prefix1.json", "prefix2.json", `prompts-${length}.json`]) {
    const file = source.files.find(item => item.path === path);
    if (!file) throw new Error(`Missing locked input: ${path}`);
    digests[path] = file.sha256;
  }
  return { length, scenario: String(meta.scenario), tag: String(meta.tag), beamWidth: expectPositiveInteger(meta.beamWidth, "beamWidth"),
    decodeSteps: expectPositiveInteger(meta.decodeSteps, "decodeSteps"), concurrency: expectPositiveInteger(meta.concurrency, "concurrency"),
    requests: expectPositiveInteger(meta.requests, "requests"), warmup: meta.warmup === 0 ? 0 : expectPositiveInteger(meta.warmup, "warmup"), digests };
}

function nonnegative(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new TypeError(`Invalid recommendation ${label}`);
  return value;
}

// gr_diag uses statistics.fmean. Retain small terms lost when adding latencies of different magnitudes.
function meanLatency(values: number[]): number {
  let sum = 0, correction = 0;
  for (const value of values) {
    const next = sum + value;
    correction += sum >= value ? (sum - next) + value : (value - next) + sum;
    sum = next;
  }
  return values.length ? (sum + correction) / values.length : 0;
}

export function summarizeSamples(observations: Record<string, unknown>, workload: { requests: number; warmup: number }) {
  const legacy = observations.version === 1;
  if ((!legacy && observations.version !== 2) || !Array.isArray(observations.samples)) throw new TypeError("Invalid recommendation observations");
  const latencies: number[] = [];
  const indices = { warmup: new Set<number>(), measure: new Set<number>() };
  let prompts = 0, sidValidRequests = 0, finiteScoreRequests = 0, outputTokens = 0, validRequests = 0;
  let knownTokens = true, knownStatus = true;
  for (const value of observations.samples) {
    const sample = expectRecord(value, "recommendation sample");
    const { phase, index, e2eMs, error } = sample;
    if (phase !== "warmup" && phase !== "measure") throw new TypeError("Invalid sample phase");
    const limit = phase === "warmup" ? workload.warmup : workload.requests;
    if (typeof index !== "number" || !Number.isSafeInteger(index) || index < 0 || index >= limit || indices[phase].has(index))
      throw new TypeError("Invalid or duplicate recommendation request index");
    indices[phase].add(index);
    if (phase === "warmup") continue;
    prompts += expectPositiveInteger(sample.promptCount, "sample.promptCount");
    if (error !== null && typeof error !== "string") throw new TypeError("Invalid recommendation request error");
    if (legacy && error !== null) knownStatus = false;
    if (!legacy && sample.status !== "ok" && sample.status !== "error") throw new TypeError("Invalid recommendation request status");
    if (legacy ? error !== null : sample.status !== "ok") continue;
    latencies.push(nonnegative(e2eMs, "latency"));
    const tokens = legacy ? (Array.isArray(sample.outputIds) ? sample.outputIds.length : null) : sample.outputTokens;
    if (tokens === null && legacy) knownTokens = false;
    else {
      if (typeof tokens !== "number" || !Number.isSafeInteger(tokens) || tokens < 0) throw new TypeError("Invalid recommendation output token count");
      outputTokens += tokens;
    }
    if (!legacy && (typeof sample.sidValid !== "boolean" || typeof sample.scoresFinite !== "boolean"))
      throw new TypeError("Missing recommendation choice checks");
    if (legacy || sample.sidValid) sidValidRequests++;
    if (legacy || sample.scoresFinite) finiteScoreRequests++;
    if (legacy || (sample.sidValid && sample.scoresFinite)) validRequests++;
  }
  const attempted = indices.measure.size, ok = latencies.length;
  const invalidReasons: string[] = [];
  if (attempted !== workload.requests || ok !== attempted || !ok) invalidReasons.push("正式请求失败或样本缺失");
  if (sidValidRequests !== ok) invalidReasons.push("SID 非法");
  if (finiteScoreRequests !== ok) invalidReasons.push("分数非有限");
  if (observations.resetOk !== true) invalidReasons.push("计数器重置未确认");
  const valid = invalidReasons.length === 0;
  latencies.sort((a, b) => a - b);
  const percentile = (q: number) => knownStatus ? latencies[Math.ceil(ok * q) - 1] ?? 0 : null;
  const mean = knownStatus ? meanLatency(latencies) : null;
  const total = knownStatus && knownTokens ? outputTokens : null;
  const meanTokens = total === null ? null : ok ? total / ok : 0;
  const wall = legacy ? null : nonnegative(observations.wallSeconds, "measurement window");
  const client = { requests: attempted, success: knownStatus ? ok : null, failed: knownStatus ? attempted - ok : null,
    sidValidRequests: knownStatus ? sidValidRequests : null, scoresFiniteRequests: knownStatus ? finiteScoreRequests : null,
    e2eMs: { mean, p50: percentile(0.5), p95: percentile(0.95), p99: percentile(0.99) },
    outputTokens: total, meanOutputTokens: meanTokens, tpotMs: meanTokens === null || mean === null ? null : meanTokens ? mean / meanTokens : 0,
    wallElapsedSeconds: wall === null ? null : Number(wall.toFixed(6)), qps: wall === null ? null : wall > 0 ? attempted / wall : 0 };
  return { valid, invalidReasons, p50Ms: valid ? client.e2eMs.p50 : null, successfulRequests: validRequests, attemptedRequests: attempted, prompts, client };
}
