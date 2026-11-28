import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { bootstrap, fingerprintConfig, loadConfig, rebuildReport } from "arsi-evaluator";

const [scenario, directory] = process.argv.slice(2);
assert(directory, "usage: consumer.mjs <scenario> <directory>");
process.env.EVALUATOR_RUN_INDEX_DIR = join(directory, "run-index");
const experiment = join(directory, "experiment.yaml");
const networkConfigPath = join(directory, "network.json");
await writeFile(networkConfigPath, "{}\n");
process.env.EVALUATOR_NETWORK_CONFIG = networkConfigPath;
const guard = new URL("./no-external.mjs", import.meta.url).href;

async function hostCli() {
  let root = dirname(fileURLToPath(import.meta.resolve("arsi-evaluator")));
  while (true) {
    try {
      const metadata = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
      if (metadata.name === "arsi-evaluator") return resolve(root, metadata.bin["arsi-evaluator"]);
    } catch (error) { if (error.code !== "ENOENT") throw error; }
    const parent = dirname(root);
    assert.notEqual(parent, root, "Host package metadata must expose its installed CLI");
    root = parent;
  }
}

async function cli(args, success = true) {
  try {
    const executable = await hostCli();
    const result = await new Promise((resolveResult, reject) => {
      execFile(process.execPath, ["--import", guard, executable, ...args], {
        cwd: directory, timeout: 30000, encoding: "utf8", env: process.env,
      }, (error, stdout, stderr) => {
        if (error) reject(Object.assign(error, { stdout, stderr }));
        else resolveResult({ stdout, stderr });
      });
    });
    assert(success, `CLI unexpectedly accepted ${args.join(" ")}`);
    return result.stdout + result.stderr;
  } catch (error) {
    if (success || !Number.isInteger(error.code)) throw error;
    return error.stdout + error.stderr;
  }
}

const config = {
  services: { default: { model: "fixture", base_url: "http://127.0.0.1:1/v1", api_key: "${AISBENCH_OFFLINE_KEY}" } },
  benchmark: {
    name: "aisbench", config: { workload: { inputLength: 16, outputLength: 4, dataCount: 4, concurrency: 2 } },
    solver: { name: "aisbench-ssh", config: {
      remote: { ssh: { host: "fixture.invalid", user: "benchmark", identityFile: "missing-identity" },
        pythonExecutable: "/missing/python", aisbenchWorkPath: "/missing/aisbench", aisbenchVersion: "1.0.0", workRoot: "/missing/jobs" },
      tokenizerPath: "/missing/tokenizer",
    } },
  },
};
await writeFile(experiment, JSON.stringify(config));

async function checkAbsence() {
  assert.match(await cli(["benchmark", "list"]), /\baisbench\b/iu);
  const loaded = await loadConfig(experiment, {}, {}, { networkConfigPath, allowMissingAuth: true });
  assert.equal(loaded.experiment.benchmark.name, "aisbench");
}

async function checkConfig() {
  const listed = await cli(["benchmark", "list"]);
  assert.match(listed, /aisbench/iu);
  assert.match(await cli(["benchmark", "info", "aisbench"]), /aisbench/iu);
  // Dry-run resolves credentials and validates configuration without network probes.
  process.env.AISBENCH_OFFLINE_KEY = "fixture-secret";
  await cli(["run", experiment, "--dry-run"]);
  const loaded = await loadConfig(experiment, {}, {}, { networkConfigPath, allowMissingAuth: true });
  assert.equal(loaded.experiment.solver.name, "aisbench-ssh");
  assert.equal(loaded.experiment.reporter.name, "aisbench-markdown");
  assert.deepEqual(loaded.experiment.metrics.map(item => item.name), ["aisbench-performance", "duration", "usage"]);
  const components = await bootstrap(loaded, directory);
  try {
    assert.equal(typeof components.benchmark.resolveSource, "function");
    assert.equal(typeof components.solver.solve, "function");
    assert.equal(typeof components.reporter.render, "function");
    assert.equal(components.metrics.length, 3);
    assert.deepEqual(components.pluginRuntime.reportingProviders, {
      "metrics:aisbench-performance": "aisbench-plugin", "reporter:aisbench-markdown": "aisbench-plugin",
    });
  } finally { await components.dispose(); }
  await writeFile(experiment, JSON.stringify({ ...config, scheduler: { name: "local", concurrency: 2 } }));
  assert.match(await cli(["run", experiment, "--dry-run"], false), /concurrency=1/iu);
  const { aisbenchWorkPath: _legacy, ...nativeRemote } = config.benchmark.solver.config.remote;
  await writeFile(experiment, JSON.stringify({ ...config, benchmark: { name: "aisbench", scenario: "native",
    config: { backend: "vllm_api_general_chat", datasets: ["textvqa_gen_base64"], concurrency: [1, 8], dataCount: 100 },
    solver: { config: { remote: nativeRemote, tokenizerPath: "/tokenizer" } } } }));
  assert.match(await cli(["run", experiment, "--dry-run"]), /aisbench-native-/u);
  const native = await loadConfig(experiment, {}, {}, { networkConfigPath, allowMissingAuth: true });
  assert.equal(native.experiment.benchmark.name, "aisbench-native");
  assert.equal(native.experiment.solver.name, "aisbench-ssh");
  assert.equal(native.experiment.reporter.name, "aisbench-native-markdown");
  assert.equal(native.experiment.benchmark.config.workload, undefined);
  const generated = { name: "aisbench", scenario: "native",
    config: { backend: "vllm_api_general_chat", concurrency: [1, 8], dataCount: 16,
      multimodalGeneration: { imageScenario: "multi_720p_5", textTokens: 32, mmmuParquetDir: "/data/MMMU" } },
    solver: { config: { remote: nativeRemote, tokenizerPath: "/tokenizer" } } };
  await writeFile(experiment, JSON.stringify({ ...config, benchmark: generated }));
  assert.match(await cli(["run", experiment, "--dry-run"]), /aisbench-native-/u);
  delete generated.solver.config.tokenizerPath;
  await writeFile(experiment, JSON.stringify({ ...config, benchmark: generated }));
  assert.match(await cli(["run", experiment, "--dry-run"], false), /tokenizerPath/u);
  delete process.env.AISBENCH_OFFLINE_KEY;
}

async function checkReport() {
  // Persist only public contracts through the store returned by public bootstrap().
  const loaded = await loadConfig(experiment, {}, {}, { networkConfigPath, allowMissingAuth: true });
  const components = await bootstrap(loaded, directory);
  const signal = new AbortController().signal;
  const source = await components.benchmark.resolveSource(null, signal);
  const refs = [];
  for await (const ref of components.benchmark.enumerate(source, signal)) refs.push(ref);
  assert.equal(refs.length, 1);
  const task = await components.benchmark.prepare(refs[0], source, signal);
  const now = "2026-11-02T00:00:00.000Z";
  const manifest = {
    schemaVersion: 1, evaluationKind: "performance", executionVersion: 2, runId: "offline-run",
    source, taskIds: [refs[0].id], configFingerprint: fingerprintConfig(loaded.persisted),
    configSummary: { benchmark: loaded.experiment.benchmark, solver: { name: "aisbench-ssh" } },
    pluginVersions: components.pluginVersions, pluginRuntime: components.pluginRuntime,
    startedAt: now, finishedAt: now, durationMs: 1000, status: "completed",
  };
  const observations = { ...task.input.payload, aisbenchVersion: "1.0.0", rows: [{ total_req: "4", qps: "2.5", "P99 TTFT": "8.1" }] };
  const solve = { finalText: "completed fixture", usage: { inputTokens: null, outputTokens: null, totalTokens: null }, observations };
  const verdict = await components.benchmark.verify(task, solve, null, signal);
  const record = {
    key: { runId: manifest.runId, taskId: refs[0].id, attemptId: "attempt-1" },
    evaluationKind: "performance", executionStatus: "completed", scoreStatus: "not-applicable", cleanupStatus: "cleaned",
    solve, verdict, errors: [], collection: { trajectory: "not-produced", artifacts: "complete" },
    environments: { solve: {}, verify: null }, startedAt: now, finishedAt: now, durationMs: 1000, phaseDurationMs: { solve: 1000 },
  };
  const runDirectory = join(directory, manifest.runId);
  try {
    await components.store.create(directory, manifest, loaded.persisted);
    await components.store.allocate(record.key);
    await components.store.commit(record, { files: [], missing: [] });
  } finally {
    await components.store.close();
    await components.dispose();
  }
  delete process.env.AISBENCH_OFFLINE_KEY;
  await rebuildReport(runDirectory);
  await cli(["report", runDirectory]);
  const markdown = await readFile(join(runDirectory, "report.md"), "utf8");
  for (const value of ["AISBench", "2.5", "P99 TTFT", "8.1", "completed"]) assert(markdown.includes(value), `Report is missing ${value}`);
  assert(!markdown.includes("fixture-secret"));
  const metrics = JSON.parse(await readFile(join(runDirectory, "metrics.json"), "utf8"));
  assert.equal(metrics.metrics["aisbench-performance"].points[0].measurement.rows[0].qps, "2.5");
  // The host must refuse to load a provider different from the one that produced the run.
  const manifestFile = join(runDirectory, "manifest.json");
  const saved = JSON.parse(await readFile(manifestFile, "utf8"));
  saved.pluginRuntime.entries.find(entry => entry.id === "aisbench-plugin").bundledVersion = "different-version";
  await writeFile(manifestFile, JSON.stringify(saved));
  await assert.rejects(rebuildReport(runDirectory), /Plugin version differs/iu);
}

if (scenario === "absence" || scenario === "all") await checkAbsence();
if (scenario === "config" || scenario === "all") await checkConfig();
if (scenario === "report" || scenario === "all") {
  await writeFile(experiment, JSON.stringify(config));
  await checkReport();
}
assert(["absence", "config", "report", "all"].includes(scenario), "Unknown test scenario");
try {
  assert.equal(await readFile(process.env.AISBENCH_TEST_EXTERNAL_LOG, "utf8"), "", "External operation was attempted");
} catch (error) { if (error.code !== "ENOENT") throw error; }
console.log(JSON.stringify({ passed: true, scenario }));
