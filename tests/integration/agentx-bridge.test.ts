import { cp, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { expect, test, vi } from "vitest";
import { stringify } from "yaml";
import { writeFile } from "node:fs/promises";
import { startLocalProcess } from "../../src/infrastructure/process/local.js";
import { normalizeAgentXExport, parseAgentXSummary, parseWorkload } from "../../src/plugins/benchmarks/inference-engine/agentx/evidence/summary.js";
import { loadConfig } from "../../src/application/config.js";
import { bootstrap } from "../../src/application/plugins/bootstrap.js";
import { runEngine } from "../../src/application/run-engine.js";
import { rebuildReport, saveReport } from "../../src/application/report/index.js";
import { resultDirectory } from "../../src/core/artifacts/artifacts.js";
import { planResume } from "../../src/core/recovery/resume.js";
import { normalizeTelemetry, parseTelemetryConfig } from "../../src/plugins/benchmarks/inference-engine/agentx/evidence/telemetry.js";
import { parseNetworkLatencyConfig } from "../../src/plugins/benchmarks/inference-engine/agentx/evidence/network-latency.js";

// Opt-in: default tests neither install Python packages nor download tokenizers.
const python = process.env.AGENTX_TEST_PYTHON;

test.skipIf(!python).each(["automatic", "manual"])("real AgentX exports raw and RTT-adjusted latencies with %s calibration", async mode => {
  await mkdir(".scratch", { recursive: true });
  const root = await mkdtemp(resolve(".scratch/agentx-network-"));
  const handle = await startLocalProcess({ executable: python ?? "python", args: [resolve("tests/fixtures/agentx/check-bridge.py"),
    root, resolve("src/runtimes/agentx/assets/runner.py"), `--network-${mode}`], cwd: resolve("."),
    env: { PYTHONDONTWRITEBYTECODE: "1", PYTHONUNBUFFERED: "1", PYTHONIOENCODING: "utf-8", PYTHONUTF8: "1" }, input: null }, AbortSignal.timeout(120000));
  const collect = async (stream: AsyncIterable<Uint8Array>) => {
    const chunks: Buffer[] = []; for await (const bytes of stream) chunks.push(Buffer.from(bytes));
    return Buffer.concat(chunks).toString("utf8");
  };
  let passed = false;
  try {
    const [stdout, stderr, exit] = await Promise.all([collect(handle.stdout), collect(handle.stderr), handle.done]);
    expect(exit.code, stderr).toBe(0);
    const value = JSON.parse(stdout);
    const summary = normalizeAgentXExport(value.raw, parseWorkload(value.workload), { source: "local:fixture", revision: "local", digest: "b".repeat(64) }, undefined,
      { config: parseNetworkLatencyConfig(value.networkLatencyConfig), probes: value.networkLatencyProbes });
    expect(summary.networkLatency?.status).toBe("complete");
    expect(summary.networkLatency?.rttMs).toBeGreaterThan(0);
    expect(summary.networkLatency?.adjusted.ttft?.mean).toBe(value.raw.network_adjusted_time_to_first_token.avg);
    expect(summary.profiling.ttft?.mean).toBe(value.raw.time_to_first_token.avg);
    expect(parseAgentXSummary(summary)).toEqual(summary);
    passed = true;
  } finally {
    await handle.stop(500);
    if (passed) await rm(root, { recursive: true, force: true });
  }
}, 130000);
test.skipIf(!python).each([false, true])("real AgentX preserves phase metrics, counter resets and collection failures (failure=%s)", async failure => {
  await mkdir(".scratch", { recursive: true });
  const root = await mkdtemp(resolve(".scratch/agentx-real-telemetry-"));
  const handle = await startLocalProcess({ executable: python ?? "python", args: [resolve("tests/fixtures/agentx/check-bridge.py"),
    root, resolve("src/runtimes/agentx/assets/runner.py"), "--full-replay", "--telemetry", ...(failure ? ["--telemetry-error"] : [])], cwd: resolve("."),
    env: { PYTHONDONTWRITEBYTECODE: "1", PYTHONIOENCODING: "utf-8" }, input: null }, AbortSignal.timeout(120000));
  const collect = async (stream: AsyncIterable<Uint8Array>) => {
    const chunks: Buffer[] = []; for await (const bytes of stream) chunks.push(Buffer.from(bytes));
    return Buffer.concat(chunks).toString("utf8");
  };
  let passed = false;
  try {
    const [stdout, stderr, exit] = await Promise.all([collect(handle.stdout), collect(handle.stderr), handle.done]);
    expect(exit.code, stderr).toBe(0);
    const value = JSON.parse(stdout);
    const telemetry = normalizeTelemetry(parseTelemetryConfig(value.telemetryConfig), "fixture-model", value.telemetry);
    expect(telemetry.sources.map(s => s.status), JSON.stringify(telemetry)).toEqual(["complete", "complete"]);
    if (failure) expect(telemetry.collectionErrors).toBeGreaterThan(0);
    else expect(telemetry.collectionErrors).toBe(0);
    const counter = telemetry.sources[0]?.series.find(s => s.metric === "vllm:num_preemptions");
    expect(counter?.total).toBeGreaterThan(0);
    expect(counter?.total).toBeLessThan(500);
    expect(telemetry.sources.every(s => s.samples > 0)).toBe(true);
    passed = true;
  } finally {
    await handle.stop(500);
    if (passed) await rm(root, { recursive: true, force: true });
  }
}, 130000);
test.skipIf(!python)("full replay covers the first selected traces and their child requests exactly once", async () => {
  await mkdir(".scratch", { recursive: true });
  const root = await mkdtemp(resolve(".scratch/agentx-full-replay-"));
  const handle = await startLocalProcess({ executable: python ?? "python", args: [resolve("tests/fixtures/agentx/check-bridge.py"),
    root, resolve("src/runtimes/agentx/assets/runner.py"), "--full-replay"], cwd: resolve("."),
    env: { PYTHONDONTWRITEBYTECODE: "1", PYTHONUNBUFFERED: "1", PYTHONIOENCODING: "utf-8", PYTHONUTF8: "1" }, input: null }, AbortSignal.timeout(120000));
  const collect = async (stream: AsyncIterable<Uint8Array>) => {
    const chunks: Buffer[] = []; for await (const bytes of stream) chunks.push(Buffer.from(bytes));
    return Buffer.concat(chunks).toString("utf8");
  };
  let passed = false;
  try {
    const [stdout, stderr, exit] = await Promise.all([collect(handle.stdout), collect(handle.stderr), handle.done]);
    expect(exit.code, stderr).toBe(0);
    const value = JSON.parse(stdout);
    const summary = normalizeAgentXExport(value.raw, parseWorkload(value.workload), { source: "local:fixture", revision: "local", digest: "b".repeat(64) }, value.replayCoverage);
    expect(summary.replayCoverage).toMatchObject({ selectedTraces: 3, completedTraces: 3, expectedRequests: 21, observedRequests: 21, complete: true });
    expect(summary.profiling.requests?.mean).toBe(21);
    expect(summary.workload.durationSeconds).toBe(1800);
    expect(summary.upstreamInvalidReasons).not.toContain("insufficient_profile_metric_coverage");
    expect(summary.comparable).toBe(false);
    passed = true;
  } finally {
    await handle.stop(500);
    if (passed) await rm(root, { recursive: true, force: true });
  }
}, 130000);

test.skipIf(!python).each([false, true])("real AgentX loads the locked corpus and starts smoke lanes together (concurrency check=%s)", async concurrency => {
  await mkdir(".scratch", { recursive: true });
  const root = await mkdtemp(resolve(".scratch/agentx-real-"));
  const handle = await startLocalProcess({ executable: python ?? "python",
    args: [resolve("tests/fixtures/agentx/check-bridge.py"), root, resolve("src/runtimes/agentx/assets/runner.py"), ...(concurrency ? ["--smoke-concurrency"] : [])],
    cwd: resolve("."), env: { PYTHONDONTWRITEBYTECODE: "1", PYTHONUNBUFFERED: "1", PYTHONIOENCODING: "utf-8", PYTHONUTF8: "1" }, input: null }, AbortSignal.timeout(120000));
  const collect = async (stream: AsyncIterable<Uint8Array>) => {
    const chunks: Buffer[] = []; for await (const bytes of stream) chunks.push(Buffer.from(bytes));
    return Buffer.concat(chunks).toString("utf8");
  };
  let passed = false;
  try {
    const [stdout, stderr, exit] = await Promise.all([collect(handle.stdout), collect(handle.stderr), handle.done]);
    expect(exit.code, stderr).toBe(0);
    const value = JSON.parse(stdout);
    expect(value.requests).toBeGreaterThan(0);
    const summary = normalizeAgentXExport(value.raw, parseWorkload(value.workload), { source: "local:fixture", revision: "local", digest: "b".repeat(64) });
    expect(summary.profiling.requests?.mean).toBeGreaterThan(0);
    if (concurrency) expect(summary.profiling.requests?.mean).toBeGreaterThanOrEqual(4);
    expect(summary.comparable).toBe(false);
    passed = true;
  } finally {
    await handle.stop(500);
    if (passed) await rm(root, { recursive: true, force: true });
  }
}, 130000);

test.skipIf(!python).each(["standard", "service-collections", "profile-failure", "profile-only"])("Evaluator runs the %s YAML through the real Harness and rebuilds its report", async scenario => {
  const dual = scenario !== "standard";
  const only = scenario === "profile-only";
  const rejected = scenario === "profile-failure";
  await mkdir(".scratch", { recursive: true });
  const root = await mkdtemp(resolve(".scratch/agentx-e2e-"));
  const helper = await startLocalProcess({ executable: python ?? "python", args: [resolve("tests/fixtures/agentx/check-bridge.py"),
    root, resolve("src/runtimes/agentx/assets/runner.py"), "--serve", ...(dual ? ["--service-collections", ...(rejected ? ["--reject-profile"] : [])] : ["--standard-duration", "--service-engine"])], cwd: resolve("."),
    env: { PYTHONDONTWRITEBYTECODE: "1", PYTHONUNBUFFERED: "1", PYTHONIOENCODING: "utf-8", PYTHONUTF8: "1" }, input: null }, AbortSignal.timeout(dual ? 360000 : 120000));
  const diagnostics = (async () => { for await (const _chunk of helper.stderr) { /* Drain tokenizer diagnostics. */ } })();
  let components: Awaited<ReturnType<typeof bootstrap>> | undefined;
  let passed = false;
  try {
    const readiness = async () => {
      let buffered = "";
      for await (const chunk of helper.stdout) {
        buffered += Buffer.from(chunk).toString("utf8");
        for (const line of buffered.split(/\r?\n/u)) {
          if (line.trim().startsWith("{") && line.trim().endsWith("}")) return JSON.parse(line);
        }
      }
      throw new Error("Controlled server ended before readiness");
    };
    const ready = await readiness();
    vi.stubEnv("HF_ENDPOINT", ready.url);
    const configPath = join(root, "experiment.yaml");
    await writeFile(configPath, stringify({ services: { default: { model: "fixture-model", base_url: ready.url, api_key: "${AGENTX_FIXTURE_KEY}" } },
      benchmark: { name: "agentx", scenario: dual ? "replay" : "standard", config: { cacheDir: join(root, "cache"), ...(dual
        ? { measurementMode: only ? "profiling" : "all", traceCount: 8, concurrency: rejected || only ? [1] : [1, 8], engineMetrics: ["fixture_requests_total"], profiling: { provider: "vllm", preset: "timeline", traceDirectory: join(root, "traces"), exportTimeoutSeconds: 5 } }
        : { durationSeconds: 60, engineMetrics: ["fixture_requests_total"] }) },
        solver: { config: { tokenizer: ready.tokenizer, pythonExecutable: python, cacheDir: join(root, "cache"), requestTimeoutSeconds: dual ? 30 : 10,
          ...(dual ? {} : { networkLatency: { mode: "automatic", pingIntervalSeconds: 0.2 } }) } } },
      environment: "local", output: { directory: join(root, "runs") } }));
    const config = await loadConfig(configPath, {}, { ...process.env, AGENTX_FIXTURE_KEY: ready.key });
    components = await bootstrap(config, root);
    // Use the already installed, pinned test interpreter. The real installer
    // recipe is exercised when preparing the validation environment separately.
    const runtime = join(root, "runtime"); await mkdir(runtime);
    await cp(resolve("src/runtimes/agentx/assets"), join(runtime, "bridge"), { recursive: true });
    await symlink(dirname(dirname(resolve(python ?? "python"))), join(runtime, "venv"), process.platform === "win32" ? "junction" : "dir");
    components.solver.runtimeInstallation = async () => ({ id: "agentx-controlled-runtime", files: [], commands: [], probes: [], localRoot: runtime });
    const snapshot = await runEngine({ components, config, signal: AbortSignal.timeout(dual ? 315000 : 90000) });
    if (!rejected) expect(snapshot.run.status, JSON.stringify(snapshot.records.flatMap(record => record.errors))).toBe("completed");
    if (only) {
      const directory = join(config.experiment.output.directory, snapshot.run.runId);
      expect(await readdir(join(directory, "c1"))).toEqual(expect.arrayContaining(["measurement.json", "files.json", "profiling"]));
      expect(await readdir(join(directory, "c1"))).not.toContain("performance");
      await saveReport(components.store, components.metrics, components.reporter);
      const index = JSON.parse(await readFile(join(directory, "metrics/index.json"), "utf8"));
      expect(index.files["service/requests"]).toEqual({ path: null, status: { c1: "disabled" } });
      expect(index.files["execution/operators"].status.c1).toBe("measured");
      expect(await readdir(join(directory, "metrics"))).not.toContain("service");
      passed = true;
      return;
    }
    if (dual) {
      const concurrencies = rejected ? [1] : [1, 8];
      expect(snapshot.run.taskIds).toEqual(concurrencies.map(c => "agentx-256k-replay-c" + c));
      expect(snapshot.records).toHaveLength(concurrencies.length);
      for (const record of snapshot.records) {
        const directory = join(config.experiment.output.directory, snapshot.run.runId, resultDirectory(snapshot.run, record.key));
        const manifest: { files: { path: string }[] } = JSON.parse(await readFile(join(directory, "files.json"), "utf8"));
        const paths = manifest.files.map(entry => entry.path);
        expect(paths.filter(path => path.endsWith(".tar"))).toEqual([]);
        for (const name of ["harness.log", "profile_export.jsonl", "profile_export_aiperf.json"]) {
          expect(paths.filter(path => path.endsWith("/" + name)).sort()).toEqual(
            (rejected ? ["performance"] : ["performance", "profiling"]).map(phase => phase + "/outputs/" + name));
        }
        expect(paths.filter(path => path.endsWith("replay-coverage.json")).sort()).toEqual([
          "performance/outputs/replay-coverage.json", ...(rejected ? [] : ["profiling/outputs/replay-coverage.json"]),
          "profiling/outputs/warmup/replay-coverage.json",
        ]);
        expect(record.steps?.map(step => step.name)).toEqual(["performance", "profiling"]);
        const [performance, profiling] = record.steps ?? [];
        const formal = parseAgentXSummary(performance?.solve?.observations);
        expect(formal.replayCoverage?.successfulRequests).toBe(56);
        expect(formal.profiling.requests?.mean).toBe(56);
        expect(formal.engine).toBeDefined();
        expect(record.solve?.usage).toEqual(performance?.solve?.usage);
        expect((await stat(join(directory, "performance", "outputs", "replay-coverage.json"))).size).toBeGreaterThan(0);
        const meta = await readFile(join(directory, "profiling", "collections.json"), "utf8");
        expect(meta).not.toContain(ready.key);
        if (rejected) {
          expect(record.executionStatus).toBe("failed");
          expect(profiling?.errors[0]?.message).toContain("HTTP 409");
          expect(meta).toContain("failed");
        } else {
          expect(record.errors).toEqual([]);
          expect(record.collection).toMatchObject({ artifacts: "complete", trajectory: "complete" });
          const diagnostic = parseAgentXSummary(profiling?.solve?.observations);
          expect(profiling?.solve?.usage.totalTokens).toBeNull();
          expect(diagnostic.replayCoverage?.successfulRequests).toBe(7 * formal.workload.concurrency);
          expect(diagnostic.deviceProfile?.status).toBe("measured");
          expect(await readFile(join(directory, "profiling", "trace", formal.workload.concurrency === 1 ? "capture-63" : "capture-133", "rank0", "ASCEND_PROFILER_OUTPUT", "op_statistic.csv"), "utf8")).toContain("MatMul");
          expect((await stat(join(directory, "profiling", "outputs", "replay-coverage.json"))).size).toBeGreaterThan(0);
        }
      }
      const events: unknown = await (await fetch(ready.url + "/events")).json();
      if (!Array.isArray(events)) throw new Error("Missing service events");
      expect(events.filter(event => Array.isArray(event) && event[0] !== "metrics")).toEqual(rejected ? [["/start_profile", 63]] : [
        ["/start_profile", 63], ["/stop_profile", 70], ["/start_profile", 133], ["/stop_profile", 189]]);
      await saveReport(components.store, components.metrics, components.reporter);
      const runDirectory = join(config.experiment.output.directory, snapshot.run.runId);
      const report = await readFile(join(runDirectory, "report.md"), "utf8");
      expect(report).toContain("fixture\\_requests\\_total");
      expect(report).toContain("正式压测 · measured");
      if (rejected) expect(report).toContain("HTTP 409");
      else expect(report.match(/Ascend profiling · measured/gu)).toHaveLength(2);
      expect(await readdir(runDirectory)).not.toContain("tasks");
      expect(await readdir(runDirectory)).not.toContain("metrics.json");
      const metricsPath = join(runDirectory, "metrics/index.json");
      const metrics = await readFile(metricsPath, "utf8");
      const index = JSON.parse(metrics);
      expect(index.files["service/requests"].status.c1).toBe("measured");
      expect(index.files["execution/operators"].status.c1).toBe(rejected ? "unavailable" : "measured");
      const requestsPath = join(runDirectory, "metrics/service/requests.json");
      const requests = await readFile(requestsPath, "utf8");
      expect(JSON.parse(requests).points.map((p: { concurrency: number }) => p.concurrency)).toEqual(concurrencies);
      await components.store.close();
      await helper.stop(500);
      await Promise.all([rm(join(runDirectory, "report.md")), rm(join(runDirectory, "metrics"), { recursive: true })]);
      await rebuildReport(runDirectory);
      expect(await readFile(join(runDirectory, "report.md"), "utf8")).toBe(report);
      expect(await readFile(metricsPath, "utf8")).toBe(metrics);
      expect(await readFile(requestsPath, "utf8")).toBe(requests);
      passed = true;
      return;
    }
    const record = snapshot.records[0]; if (!record) throw new Error("No measurement saved");
    expect(record).toMatchObject({ executionStatus: "completed", evaluationKind: "performance", scoreStatus: "not-applicable",
      verdict: { passed: null }, collection: { artifacts: "complete", trajectory: "complete" } });
    expect(record.verdict).not.toHaveProperty("score");
    const summary = parseAgentXSummary(record.solve?.observations);
    expect(summary.workload).toMatchObject({ mode: "standard", durationSeconds: 60 });
    expect(summary.engine).toMatchObject({ status: "measured", series: [{ series: "fixture_requests_total", delta: expect.any(Number) }] });
    expect(summary.warmup.requests?.mean).toBe(11);
    expect(summary.profiling.duration?.mean).toBeGreaterThanOrEqual(55);
    expect(summary.profiling.duration?.mean).toBeLessThan(75);
    expect(summary.comparable).toBe(false);
    expect(summary.incomparableReasons).toContain("custom_duration");
    expect(summary.networkLatency?.status).toBe("complete");
    expect(summary.networkLatency?.probes?.successful).toBeGreaterThan(0);
    const raw = join(config.experiment.output.directory, snapshot.run.runId, resultDirectory(snapshot.run, record.key), "performance", "outputs", "profile_export_aiperf.json");
    expect((await stat(raw)).size).toBeGreaterThan(0);
    await saveReport(components.store, components.metrics, components.reporter);
    const runDirectory = join(config.experiment.output.directory, snapshot.run.runId);
    const report = await readFile(join(runDirectory, "report.md"), "utf8");
    expect(report).toContain("#### 网络延时校准");
    expect(report).toContain("TTFT 扣除 RTT 后");
    await components.store.close();
    await rebuildReport(runDirectory);
    expect(await readFile(join(runDirectory, "report.md"), "utf8")).toBe(report);
    const controller = new AbortController();
    const running = runEngine({ components, config, signal: controller.signal });
    void running.catch(() => {});
    let childPid: number | undefined;
    await vi.waitFor(async () => {
      if (!components) throw new Error("Missing fixture components");
      const attempts = await components.store.listAttempts();
      const attempt = attempts[0]; if (!attempt) throw new Error("Waiting for attempt allocation");
      const trajectory = join(config.experiment.output.directory, attempt.key.runId, "c1", "agent", "trajectory.jsonl");
      const events = (await readFile(trajectory, "utf8")).trim().split("\n").map(line => JSON.parse(line));
      childPid = events.find(event => event.type === "harness")?.data.pid;
      expect(childPid).toBeTypeOf("number");
    }, { timeout: 20000, interval: 30 });
    controller.abort(new DOMException("Controlled cancellation", "AbortError"));
    const cancelled = await running;
    expect(cancelled.run.status).toBe("cancelled");
    expect(cancelled.records[0]).toMatchObject({ executionStatus: "cancelled", scoreStatus: "not-applicable", verdict: null });
    expect(() => planResume(cancelled.run, [], cancelled.run.configFingerprint)).toThrow(/start a new run/);
    if (childPid === undefined) throw new Error("Missing Harness PID");
    const stoppedPid = childPid;
    expect(() => process.kill(stoppedPid, 0)).toThrow();
    passed = true;
  } finally {
    await components?.dispose();
    await helper.stop(500);
    await diagnostics;
    vi.unstubAllEnvs();
    if (passed) await rm(root, { recursive: true, force: true });
  }
}, 360000);
