import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { expect, test, vi } from "vitest";
import type { PluginFactoryContext } from "arsi-evaluator";
import { NativeBenchmark } from "../../native-benchmark.js";
import { parseNativeConfig } from "../../native-config.js";
import { NativePerformanceMetrics, NativeMarkdownReporter, readNativeGroups } from "../../native-results.js";
import { AisbenchSshSolver } from "../../solver.js";
import { parseAisbenchSshConfig } from "../../config.js";
import { AisbenchRemoteClient } from "../../ssh/client.js";
import { aisbenchSnapshot } from "../fixtures/results.js";

const selection = { backend: "vllm_api_general_chat", datasets: ["textvqa_gen_base64"] };
test("collects native performance before profiling, preserving partial results and stopping failed captures", () => {
  const fixture = fileURLToPath(new URL("../fixtures/check-collections.py", import.meta.url));
  expect(execFileSync(process.platform === "win32" ? "python" : "python3", ["-B", fixture], { encoding: "utf8" }))
    .toContain("Service collection checks passed");
});
test("validates service collection parameters before accessing the benchmark host", () => {
  const profiling = { traceDirectory: "/shared/traces", service: "diagnostic", requestsPerPoint: 2 };
  const raw = { ...selection, dataCount: 2, profiling, engineMetrics: ["sglang:prompt_tokens_total"] };
  expect(parseNativeConfig(parseNativeConfig(raw))).toEqual(parseNativeConfig(raw));
  for (const change of [{ engineMetrics: [] }, { engineMetrics: [""] }, { profiling: { traceDirectory: "local" } },
    { dataCount: 1 }, { profiling: { ...profiling, unknown: true } }]) {
    expect(() => parseNativeConfig({ ...raw, ...change })).toThrow();
  }
  expect(() => parseNativeConfig({ configFile: "./config.py", profiling })).toThrow(/native backend/u);
});
const generated = { backend: selection.backend, concurrency: [1, 8], dataCount: 8,
  multimodalGeneration: { imageScenario: "single_1080p", textTokens: 32, mmmuParquetDir: "/data/MMMU" } };

test.each(["single_1080p", "multi_720p_5"])("normalizes a shared generated dataset for %s", imageScenario => {
  const multimodalGeneration = { ...generated.multimodalGeneration, imageScenario, corpusPath: "/data/questions.jsonl" };
  const config = parseNativeConfig({ ...generated, multimodalGeneration });
  expect(config).toMatchObject({ multimodalGeneration: { ...multimodalGeneration, imageScenario: [imageScenario] }, dataCount: [8, 8], maxOutputTokens: 256 });
  expect(parseNativeConfig(config)).toEqual(config);
});

test.each([{ datasets: selection.datasets }, { remoteConfigFile: "/cfg.py" }, { dataCount: undefined }, { multimodalManifest: "/m.json" },
  { multimodalAction: "prepare" }, { multimodalAction: "validate" },
  ...[{ imageScenario: "custom" }, { imageScenario: [] }, { imageScenario: ["single_1080p", "single_1080p"] },
    { textTokens: 0 }, { mmmuParquetDir: "./local" }, { corpusPath: "" }].map(change => ({
    multimodalGeneration: { ...generated.multimodalGeneration, ...change },
  }))])("rejects inconsistent multimodal generation %j", change => {
  expect(() => parseNativeConfig({ ...generated, ...change })).toThrow();
});
test("selects both presets, independent counts, and offline manifest operations", () => {
  const presets = ["single_1080p", "multi_720p_5"];
  const config = parseNativeConfig({ ...generated, dataCount: [3, 8], multimodalGeneration: {
    ...generated.multimodalGeneration, imageScenario: presets } });
  expect(config).toMatchObject({ dataCount: [3, 8], multimodalGeneration: { imageScenario: presets } });
  expect(parseNativeConfig({ multimodalAction: "validate", multimodalManifest: "/saved/manifest.json" })).toEqual(
    { multimodalAction: "validate", multimodalManifest: "/saved/manifest.json" });
  expect(parseNativeConfig({ ...generated, backend: undefined, multimodalAction: "prepare", multimodalGeneration: {
    textTokens: 32, mmmuParquetDir: "/mmmu", outputDirectory: "/saved" } }).multimodalGeneration?.imageScenario).toEqual(["single_1080p"]);
});
test("broadcasts counts, preserves zero/false and leaves omitted options to AISBench", () => {
  const config = parseNativeConfig({ ...selection, concurrency: [1, 8], dataCount: 100, warmups: 0, stream: false });
  expect(config).toEqual({ backend: [selection.backend], datasets: [{ name: selection.datasets[0] }],
    concurrency: [1, 8], dataCount: [100, 100], warmups: 0, stream: false });
  expect(parseNativeConfig(config)).toEqual(config);
});
test("maps typed YAML to native boolean, list, repeated, duration and JSON options", () => {
  const config = parseNativeConfig({ ...selection, concurrency: [1, 8], dataCount: 100, stream: false, requestRate: 0, warmups: 0,
    pressureSeconds: 60, speculativeDecoding: true, generationParams: { temperature: 0.2 }, options: { "extra-label": ["first", "second item"] } });
  const fixture = fileURLToPath(new URL("../fixtures/native-argv.py", import.meta.url));
  const args = JSON.parse(execFileSync(process.platform === "win32" ? "python" : "python3", ["-X", "utf8", "-B", fixture],
    { input: JSON.stringify(config), encoding: "utf8" }));
  expect(args).toEqual(["--models", "vllm_api_general_chat", "--datasets", "textvqa_gen_base64", "--summarizer", "default_perf",
    "--model-name=vl", "--url=https://example.invalid/proxy/", "--host-ip=example.invalid", "--host-port=443", "--mode", "perf", "--work-dir",
    expect.stringMatching(/outputs$/u), "--path", "/vl", "--batch-size", "1", "8", "--num-prompts", "100", "100", "--request-rate=0", "--num-warmups=0",
    "--no-stream", "--spec-decode", '--generation-kwargs={"temperature":0.2}', "--pressure", "--pressure-time=60", "--extra-label=first", "--extra-label=second item"]);
});

test.each([{ concurrency: [1, 8], dataCount: [100] }, { dataCount: 0 }, { pressureSeconds: 86401 },
  { remoteConfigFile: "/etc/test.py" }, { options: { "no-stream": true } }, { options: { "dry-run": true } },
  { generationParams: { stream: true } }, { pressureSeconds: 10, options: { pressure: true } },
  { options: { "api-key": "private" } }, { datasets: ["--help"] }])("rejects conflicting or invalid YAML %j", change => {
  expect(() => parseNativeConfig({ ...selection, ...change })).toThrow();
});

function factory(directory: string): PluginFactoryContext {
  return { services: { default: { model: { name: "vl", endpoint: "http://model:8000/v1", api: "openai-completions", provider: null },
    auth: { value: "private", reference: null } } }, solverService: "default", configDirectory: directory, resolvePath: path => resolve(directory, path) };
}

test("hashes uploaded scripts and detects changes before execution", async () => {
  const root = await mkdtemp(join(tmpdir(), "native-input-"));
  try {
    const benchmark = new NativeBenchmark(parseNativeConfig({ configFile: "./main.py", files: ["data.py"] }), factory(root));
    await writeFile(join(root, "main.py"), "from data import datasets");
    await writeFile(join(root, "data.py"), "datasets=[]");
    const source = await benchmark.resolveSource(null, new AbortController().signal);
    expect(source.files.map(file => file.path)).toEqual(["main.py", "data.py"]);
    await writeFile(join(root, "data.py"), "datasets=[{}]");
    await expect(benchmark.resolveSource(source, new AbortController().signal)).rejects.toThrow(/changed/u);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test.each([false, true])("reads a historical single-job native selection with service collection %s", async collect => {
  const root = await mkdtemp(join(tmpdir(), "native-evidence-"));
  const signal = new AbortController().signal;
  const runtime = factory(root);
  const config = parseNativeConfig({ ...selection, concurrency: [1, 8], dataCount: 2,
    ...(collect ? { profiling: { traceDirectory: "/shared", service: "diagnostic" } } : {}) });
  if (collect) runtime.services.diagnostic = { model: { name: "vl", endpoint: "http://diag/v1", api: "openai-completions", provider: null },
    auth: { value: "fixture-diagnostic-key", reference: null } };
  const bench = new NativeBenchmark(config, runtime);
  const source = { ...await bench.resolveSource(null, signal), revision: "1" };
  const refs = [];
  for await (const ref of bench.enumerate(source, signal)) refs.push(ref);
  const [ref] = refs;
  if (!ref) throw new Error("Missing native task");
  const task = await bench.prepare(ref, source, signal);
  const solver = new AisbenchSshSolver(parseAisbenchSshConfig({ remote: { ssh: { host: "fixture", user: "u" },
    pythonExecutable: "/python", aisbenchVersion: "fixture", workRoot: "/jobs" }, tokenizerPath: "/vl" }), runtime);
  vi.spyOn(AisbenchRemoteClient.prototype, "deploy").mockResolvedValue();
  const start = vi.spyOn(AisbenchRemoteClient.prototype, "call").mockResolvedValue({});
  vi.spyOn(AisbenchRemoteClient.prototype, "status").mockResolvedValueOnce({ state: "missing", phase: "", offset: 0, log: "", heartbeat: null, exitCode: null })
    .mockResolvedValue({ state: "completed", phase: "finished", offset: 0, log: "", heartbeat: null, exitCode: 0 });
  vi.spyOn(AisbenchRemoteClient.prototype, "download").mockImplementation(async (_job, _fingerprint, dir) => {
    if (collect) await writeFile(join(dir, "collections.json"), JSON.stringify({ points: [1, 8].map(concurrency =>
      ({ dataset: "textvqa", concurrency, performanceStatus: concurrency === 1 ? "measured" : "partial",
        profiling: { status: "skipped", error: "Incomplete performance window" } })) }));
    const stamp = join(dir, "outputs", "timestamp");
    await mkdir(join(stamp, "performances", "vl-bs1"), { recursive: true });
    await writeFile(join(stamp, "combos_manifest.json"), JSON.stringify({ combos: [1, 8].map(n => ({ batch_size: n, model_abbr: "vl-bs" + n, dataset_abbr: "textvqa" })) }));
    const group = join(stamp, "performances", "vl-bs1", "textvqa");
    await writeFile(group + ".json", JSON.stringify({ "Success Requests": { total: "2" }, "Failed Requests": { total: "0" }, "Request Throughput": { total: "1.4 req/s" } }));
    await writeFile(group + ".csv", "Performance Parameters,Stage,P99\nTTFT,total,33 ms\n");
  });
  try {
    // The SSH solver never uses the host environment session.
    const session = { id: "local", metadata: {}, workdir: ".", agentOutputDir: ".", verifierOutputDir: ".",
      start: unexpected, upload: unexpected, download: unexpected, exportState: unexpected, restoreState: unexpected, dispose: unexpected };
    const key = { runId: "run-1", taskId: ref.id, attemptId: "attempt-1" };
    const paths = { root, agent: join(root, "agent"), artifacts: join(root, "artifacts"), verifier: join(root, "verifier") };
    const result = await solver.solve(task.input, session, { key, paths, signal });
    expect(start.mock.calls[0]?.[3]).toMatchObject({ config: { native: config, endpoint: "http://model:8000/" } });
    if (collect) expect(start.mock.calls[0]?.[3]).toMatchObject({ config: { profileEndpoint: "http://diag/", profileApiKey: "fixture-diagnostic-key" } });
    const verdict = await bench.verify(task, result, null, signal);
    const snapshot = aisbenchSnapshot();
    snapshot.run.source = source;
    snapshot.run.taskIds = [ref.id];
    const record = snapshot.records[0];
    if (!record) throw new Error("Missing fixture record");
    Object.assign(record, { key, verdict, solve: result });
    const metrics = await new NativePerformanceMetrics().compute(snapshot);
    expect(metrics.points[0]).toMatchObject({ status: "partial", groups: [{ concurrency: 1, status: "measured" }, { concurrency: 8, status: "missing" }] });
    expect(await new NativeMarkdownReporter().render(snapshot)).toContain("33 ms");
    if (collect) {
      expect(metrics.points[0]).toMatchObject({ collections: [{ concurrency: 1 }, { concurrency: 8 }] });
      expect(await new NativeMarkdownReporter().render(snapshot)).toContain("Ascend profiling · skipped");
    }
    expect(await readFile(join(paths.agent, "native-summary.json"), "utf8")).not.toContain("private");
    expect(await readNativeGroups(paths.agent)).toEqual([]);
    expect(await readNativeGroups(join(paths.artifacts, "aisbench"), [1, 8], 3)).toMatchObject([
      { concurrency: 1, status: "partial" }, { concurrency: 8, status: "missing" },
    ]);
  } finally { vi.restoreAllMocks(); await rm(root, { recursive: true, force: true }); }
});
async function unexpected(): Promise<never> { throw new Error("Unexpected environment call"); }

test("generated inputs are shared across point jobs and each job gets its paired request count", async () => {
  const root = await mkdtemp(join(tmpdir(), "native-shared-"));
  const signal = new AbortController().signal, runtime = factory(root);
  const bench = new NativeBenchmark(parseNativeConfig({ ...generated, dataCount: [2, 5] }), runtime);
  const solver = new AisbenchSshSolver(parseAisbenchSshConfig({ remote: { ssh: { host: "fixture", user: "u" },
    pythonExecutable: "/python", aisbenchVersion: "fixture", workRoot: "/jobs" }, tokenizerPath: "/vl" }), runtime);
  let batch = 0, count = 0;
  const manifest = "/jobs/first/generated-input/data/manifest.json";
  const calls = vi.spyOn(AisbenchRemoteClient.prototype, "call").mockResolvedValue({});
  vi.spyOn(AisbenchRemoteClient.prototype, "deploy").mockResolvedValue();
  const done = { state: "completed", phase: "", offset: 0, exitCode: 0, log: "", heartbeat: null };
  vi.spyOn(AisbenchRemoteClient.prototype, "status")
    .mockResolvedValueOnce({ ...done, state: "missing" }).mockResolvedValueOnce(done)
    .mockResolvedValueOnce({ ...done, state: "missing" }).mockResolvedValueOnce(done);
  vi.spyOn(AisbenchRemoteClient.prototype, "download").mockImplementation(async (_job, _fingerprint, dir) => {
    await writeFile(join(dir, "native-plan.json"), JSON.stringify({ multimodalGeneration: { requests: 5, manifestPath: manifest } }));
    const output = join(dir, "outputs", "performances", "model");
    await mkdir(output, { recursive: true });
    await writeFile(join(output, "dataset.json"), JSON.stringify({ "Success Requests": { total: String(count) }, "Failed Requests": { total: "0" } }));
  });
  try {
    const source = await bench.resolveSource(null, signal);
    for await (const ref of bench.enumerate(source, signal)) {
      batch = ref.measurementConcurrency!;
      count = batch === 1 ? 2 : 5;
      const task = await bench.prepare(ref, source, signal);
      const dir = join(root, "c" + batch);
      const paths = { root: dir, agent: join(dir, "agent"), artifacts: join(dir, "artifacts"), verifier: join(dir, "verifier"), measurementPoint: true as const };
      const session = { id: "local", metadata: {}, workdir: ".", agentOutputDir: ".", verifierOutputDir: ".",
        start: unexpected, upload: unexpected, download: unexpected, exportState: unexpected, restoreState: unexpected, dispose: unexpected };
      const result = await solver.solve(task.input, session, { key: { runId: "run", attemptId: "a", taskId: ref.id }, paths, signal });
      expect(result.observations).toMatchObject({ groups: [{ concurrency: batch, status: "measured" }] });
    }
    expect(calls.mock.calls[0]?.[3]).toMatchObject({ config: { generationCount: 5, native: { dataCount: [2], concurrency: [1] } } });
    expect(calls.mock.calls[1]?.[3]).toMatchObject({ config: { native: { dataCount: [5], concurrency: [8], multimodalManifest: manifest } } });
    await solver.dispose();
    expect(calls.mock.calls[2]?.[0]).toBe("release-generated-input");
  } finally { vi.restoreAllMocks(); await rm(root, { recursive: true, force: true }); }
});

test("native-owned concurrency and dataset-only operations retain their distinct semantics", async () => {
  const signal = new AbortController().signal;
  const benchmark = new NativeBenchmark(parseNativeConfig({ remoteConfigFile: "/cfg.py" }), factory("."));
  const source = await benchmark.resolveSource(null, signal);
  const refs = [];
  for await (const ref of benchmark.enumerate(source, signal)) refs.push(ref);
  const point = refs[0];
  if (!point) throw new Error("Missing native-config measurement");
  expect(point?.measurementConcurrency).toBeNull();
  expect((await benchmark.prepare(point, source, signal)).input.payload).toMatchObject({ native: { remoteConfigFile: "/cfg.py" } });
  for (const config of [
    { ...generated, multimodalAction: "prepare", multimodalGeneration: { ...generated.multimodalGeneration, outputDirectory: "/data" } },
    { multimodalManifest: "/data/manifest.json", multimodalAction: "validate" },
  ]) {
    const operation = new NativeBenchmark(parseNativeConfig(config), factory("."));
    const refs = [];
    for await (const ref of operation.enumerate(await operation.resolveSource(null, signal), signal)) refs.push(ref);
    expect(refs).toHaveLength(1);
    expect(refs[0]).not.toHaveProperty("measurementConcurrency");
  }
});

test("a missing stop_profile confirmation blocks the following baseline", async () => {
  const benchmark = new NativeBenchmark(parseNativeConfig({ ...selection, concurrency: [1, 8], profiling: { traceDirectory: "/trace" } }), factory("."));
  const snapshot = aisbenchSnapshot();
  const solve = snapshot.records[0]!.solve!;
  solve.observations = { collections: [{ profiling: { status: "failed", error: "stop_profile unconfirmed" } }] };
  await expect(benchmark.validatePrerequisites({ id: "next", recordKey: 8 }, async () => snapshot)).rejects.toThrow(/stop_profile unconfirmed/u);
});
