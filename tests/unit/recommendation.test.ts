import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { RecommendationBenchmark } from "../../src/plugins/benchmarks/recommendation/benchmark.js";
import { northStarLengths, parseRecommendationConfig } from "../../src/plugins/benchmarks/recommendation/config.js";
import { summarizeSamples } from "../../src/plugins/benchmarks/recommendation/evidence.js";

const inputs = { promptDir: "prompts", prefix1File: "prefix1.json", prefix2File: "prefix2.json" };
const signal = new AbortController().signal;
const temporary: string[] = [];
afterEach(async () => { for (const dir of temporary.splice(0)) await rm(dir, { recursive: true, force: true }); });

test("north-star enumerates five fixed points and custom requires unambiguous files", () => {
  const config = parseRecommendationConfig(inputs);
  expect(config.inputs.map(input => input.length)).toEqual(northStarLengths);
  expect(() => parseRecommendationConfig({ ...inputs, requests: 7 })).toThrow(/custom/);
  expect(() => parseRecommendationConfig({ ...inputs, scenario: "custom" })).toThrow(/inputs/);
});

test("resume rejects changed catalogs and the prepared task carries original paths and digests", async () => {
  const dir = await mkdtemp(join(tmpdir(), "recommendation-"));
  temporary.push(dir);
  const config = parseRecommendationConfig({ scenario: "custom", prefix1File: "a", prefix2File: "b", inputs: [{ length: 128, file: "prompt" }] });
  const bench = new RecommendationBenchmark(config, file => join(dir, file));
  for (const file of ["a", "b", "prompt"]) await writeFile(join(dir, file), file);
  const source = await bench.resolveSource(null, signal);
  const refs = [];
  for await (const ref of bench.enumerate(source, signal)) refs.push(ref);
  const task = await bench.prepare(refs[0]!, source, signal);
  expect(task.input.payload).toMatchObject({ workload: { digests: Object.fromEntries(source.files.map(f => [f.path, f.sha256])) },
    files: { "prefix1.json": join(dir, "a"), "prompts-128.json": join(dir, "prompt") } });
  await expect(bench.resolveSource(source, signal)).resolves.toEqual(source);
  await writeFile(join(dir, "a"), "changed");
  await expect(bench.resolveSource(source, signal)).rejects.toThrow(/changed/);
});

test("the GR client rejects incomplete or illegal SIDs, non-finite scores, and tokenizer mismatches", () => {
  const file = (path: string) => fileURLToPath(new URL(path, import.meta.url));
  execFileSync(process.platform === "win32" ? "python" : "python3", ["-B",
    file("../fixtures/recommendation/check-client.py"), file("../../src/runtimes/sglang-gr/assets/measure.py")]);
});

test("warmups stay outside p50 and failed or absent samples invalidate the point", () => {
  const workload = { requests: 2, warmup: 1 };
  const sample = (phase: string, index: number, e2eMs: number) => ({ phase, index, e2eMs, promptCount: 1, error: null });
  const samples = [sample("warmup", 0, 1000), sample("measure", 0, 2), sample("measure", 1, 6)];
  const summary = (items: unknown[], resetOk = true) => summarizeSamples({ samples: items, version: 1, resetOk }, workload);
  expect(summary(samples)).toMatchObject({ p50Ms: 2, successfulRequests: 2, prompts: 2, valid: true });
  expect(summary(samples.slice(0, 2)).p50Ms).toBeNull();
  expect(summary([samples[0], samples[1], { ...samples[2], error: "invalid candidate" }]).p50Ms).toBeNull();
  expect(summary(samples, false).p50Ms).toBeNull();
  expect(() => summary([...samples, samples[2]])).toThrow(/duplicate/);
});

test("client statistics use formal response status and the full wall window from gr_diag", () => {
  const rows = Array.from({ length: 8 }, (_, index) => ({ phase: "measure", index, e2eMs: index + 1,
    status: "ok", sidValid: true, scoresFinite: true, error: null, outputTokens: 3, promptCount: 1 }));
  const warmup = { ...rows[0], phase: "warmup", index: 0, status: "error", error: "warmup failed" };
  const compute = (samples: unknown[]) => summarizeSamples({ version: 2, resetOk: true, samples: [warmup, ...samples], wallSeconds: 0.12345678 },
    { warmup: 1, requests: 8 });
  expect(compute(rows)).toMatchObject({ valid: true, p50Ms: 4, client: { requests: 8, success: 8, failed: 0, e2eMs: { mean: 4.5, p50: 4, p95: 8, p99: 8 },
    wallElapsedSeconds: 0.123457, qps: 8 / 0.12345678, outputTokens: 24, meanOutputTokens: 3, tpotMs: 1.5 } });
  expect(compute([...rows.slice(0, 5), { ...rows[5], sidValid: false }, { ...rows[6], scoresFinite: false },
    { ...rows[7], status: "error", error: "HTTP 503", e2eMs: null }])).toMatchObject({ valid: false, p50Ms: null, successfulRequests: 5,
    client: { success: 7, failed: 1, sidValidRequests: 6, scoresFiniteRequests: 6, outputTokens: 21, qps: 8 / 0.12345678,
      e2eMs: { mean: 4, p50: 4, p95: 7, p99: 7 } } });
});
