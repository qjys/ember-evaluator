import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { bootstrap, loadConfig, rebuildReport, runEngine, saveReport } from "arsi-evaluator";
import { expect, test, vi } from "vitest";
import { parseAisbenchSshConfig } from "../../config.js";
import { AisbenchSshSolver } from "../../solver.js";
import { AisbenchRemoteClient } from "../../ssh/client.js";

test.each(["standard", "native", "configured"])("%s SSH measurements commit a complete trajectory and session", async scenario => {
  const root = await mkdtemp(join(tmpdir(), "ais-evidence-"));
  const signal = new AbortController().signal;
  const sshConfig = { remote: { ssh: { host: "fixture.invalid", user: "bench" }, workRoot: "/jobs",
    aisbenchWorkPath: "/bench", aisbenchVersion: "fixture", pythonExecutable: "/python" }, tokenizerPath: "/model" };
  const experiment = join(root, "experiment.yaml");
  const networkConfigPath = join(root, "network.json");
  const service = { name: "fixture", endpoint: "http://fixture.invalid/v1", provider: null, api: null };
  const secret = "fixture-private-key";
  try {
    await writeFile(networkConfigPath, "{}");
    await writeFile(experiment, JSON.stringify({
      services: { default: { model: service.name, base_url: service.endpoint } },
      benchmark: { name: "aisbench", scenario: scenario === "configured" ? "native" : scenario, solver: { config: sshConfig },
        config: scenario === "configured" ? { remoteConfigFile: "/native.py" } : scenario === "native" ? { backend: "vllm_api_general_chat", datasets: ["textvqa_gen_base64"], concurrency: [1, 8], engineMetrics: ["vllm:running"], profiling: { traceDirectory: "/trace" } } : { workload: { dataCount: 2 } } },
      output: { directory: join(root, "runs") },
    }));
    const config = await loadConfig(experiment, {}, {}, { networkConfigPath, allowMissingAuth: true });
    const components = await bootstrap(config, root);
    try {
      components.solver = new AisbenchSshSolver(parseAisbenchSshConfig(sshConfig), { services: { default: { model: service,
        auth: { value: secret, reference: null } } }, solverService: "default", configDirectory: root, resolvePath: path => join(root, path) });
      vi.spyOn(AisbenchRemoteClient.prototype, "deploy").mockResolvedValue();
      const start = vi.spyOn(AisbenchRemoteClient.prototype, "call").mockResolvedValue({});
      const completed = { state: "completed", phase: "finished", exitCode: 0, offset: 0, log: "", heartbeat: null };
      vi.spyOn(AisbenchRemoteClient.prototype, "status")
        .mockResolvedValueOnce(scenario === "native" ? { ...completed, state: "missing", phase: secret, exitCode: null } : completed)
        .mockResolvedValue(completed);
      vi.spyOn(AisbenchRemoteClient.prototype, "download").mockImplementation(async (_job, _fingerprint, dir) => {
        if (scenario !== "standard") {
          const outputs = join(dir, "outputs", "run");
          const concurrency = scenario === "configured" ? 4 : Number(basename(dirname(dir)).slice(1));
          if (scenario === "native") {
            const rank = "profiling/point-1/trace/rank0";
            await mkdir(join(dir, rank), { recursive: true });
            await writeFile(join(dir, rank, "op_statistic.csv"), "OP Type,Count,Total Time(us)\nMatMul,1,12\n");
            await writeFile(join(dir, "collections.json"), JSON.stringify({ points: [{ dataset: "textvqa", concurrency,
              performanceStatus: "measured", engine: { status: "measured", series: [{ series: "vllm:running", before: 0, after: 1 }] },
              profiling: { status: "measured", exports: [{ deviceEvidence: true, artifactDirectory: rank, operatorDeviceUs: 12, stageUs: { Computing: 12 } }] } }] }));
          }
          const group = { batch_size: concurrency, model_abbr: `vl-bs${concurrency}`, dataset_abbr: "textvqa" };
          const combos = [group];
          const target = join(outputs, "performances", group.model_abbr);
          await mkdir(target, { recursive: true });
          await writeFile(join(target, "textvqa.json"), JSON.stringify({ "Success Requests": { total: "2" }, "Failed Requests": { total: "0" } }));
          await writeFile(join(outputs, "combos_manifest.json"), JSON.stringify({ combos }));
        } else {
          await writeFile(join(dir, "aisbench_result.csv"), "total_req,qps\n2,1.5\n");
        }
      });
      const allocate = vi.spyOn(components.store, "allocate");
      const snapshot = await runEngine({ components, config, signal });
      expect(Object.values(snapshot.run.resultLayout?.points ?? {})).toEqual(scenario === "native" ? [1, 8] : scenario === "configured" ? [null] : [16]);
      const [record] = snapshot.records;
      expect(record).toMatchObject({ executionStatus: "completed", errors: [],
        collection: { trajectory: "complete", artifacts: "complete" } });
      if (scenario === "native") expect(record?.solve?.observations).toMatchObject({
        groups: [{ concurrency: 1, status: "measured" }],
      });
      expect(start).toHaveBeenCalledTimes(scenario === "native" ? 1 : 0);
      const paths = await allocate.mock.results[0]?.value;
      if (!paths) throw new Error("Missing attempt directory");
      const manifest = JSON.parse(await readFile(join(paths.root, "files.json"), "utf8"));
      expect(manifest.missing).toEqual([]);
      expect(manifest.files.map((file: { path: string }) => file.path)).toEqual(expect.arrayContaining(["performance/agent/session.jsonl", "performance/agent/trajectory.jsonl"]));
      const session = await readFile(join(paths.root, "performance/agent/session.jsonl"), "utf8");
      expect(session).not.toContain(secret);
      const run = dirname(paths.root);
      expect(await readdir(run)).not.toContain("tasks");
      await saveReport(components.store, components.metrics, components.reporter);
      const requests = join(run, "metrics/service/requests.json");
      const original = await readFile(requests, "utf8");
      const data = JSON.parse(original);
      expect(data.points.map((p: { status: string }) => p.status)).toEqual(scenario === "native" ? ["measured", "measured"] : ["measured"]);
      if (scenario === "configured") {
        expect(basename(paths.root)).toBe("configured");
        expect(data.points[0]).toMatchObject({ concurrency: null, performance: { values: { groups: [{ concurrency: 4 }] } } });
      }
      if (scenario === "native") {
        for (const c of [1, 8]) {
          const point = join(run, "c" + c);
          expect((await readdir(point)).sort()).toEqual(["files.json", "measurement.json", "performance", "profiling"]);
          expect(await readdir(join(point, "performance"))).not.toContain("profiling");
          expect(await readFile(join(point, "profiling/point-1/trace/rank0/op_statistic.csv"), "utf8")).toContain("MatMul");
        }
        for (const category of ["engine/engine", "execution/operators", "parallelism/timeline"])
          expect(JSON.parse(await readFile(join(run, "metrics", category + ".json"), "utf8")).points).toHaveLength(2);
      }
      await components.store.close();
      await rm(requests);
      await rebuildReport(run);
      expect(await readFile(requests, "utf8")).toBe(original);
      const states = session.trimEnd().split("\n").map(line => JSON.parse(line)).filter(entry => entry.operation === "status");
      expect(states.map(entry => entry.state)).toEqual(scenario === "native" ? ["missing", "completed"] : ["completed"]);
      expect(states.at(-1)).toMatchObject({ phase: "finished", exitCode: 0 });
    } finally { await components.dispose(); }
  } finally { vi.restoreAllMocks(); await rm(root, { recursive: true, force: true }); }
}, 30000);
