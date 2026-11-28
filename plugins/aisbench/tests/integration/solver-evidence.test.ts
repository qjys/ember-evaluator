import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bootstrap, loadConfig, runEngine } from "arsi-evaluator";
import { expect, test, vi } from "vitest";
import { parseAisbenchSshConfig } from "../../config.js";
import { AisbenchSshSolver } from "../../solver.js";
import { AisbenchRemoteClient } from "../../ssh/client.js";

test.each(["standard", "native"])("%s SSH measurements commit a complete trajectory and session", async scenario => {
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
      benchmark: { name: "aisbench", scenario, solver: { config: sshConfig },
        config: scenario === "native" ? { backend: "vllm_api_general_chat", datasets: ["textvqa_gen_base64"], concurrency: [1, 8] } : { workload: { dataCount: 2 } } },
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
        if (scenario === "native") {
          const outputs = join(dir, "outputs", "run");
          const combos = [1, 8].map(n => ({ batch_size: n, model_abbr: `vl-bs${n}`, dataset_abbr: "textvqa" }));
          for (const group of combos) {
            const target = join(outputs, "performances", group.model_abbr);
            await mkdir(target, { recursive: true });
            await writeFile(join(target, "textvqa.json"), JSON.stringify({ "Success Requests": { total: "2" }, "Failed Requests": { total: "0" } }));
          }
          await writeFile(join(outputs, "combos_manifest.json"), JSON.stringify({ combos }));
        } else {
          await writeFile(join(dir, "aisbench_result.csv"), "total_req,qps\n2,1.5\n");
        }
      });
      const allocate = vi.spyOn(components.store, "allocate");
      const snapshot = await runEngine({ components, config, signal });
      const [record] = snapshot.records;
      expect(record).toMatchObject({ executionStatus: "completed", errors: [], trajectory: "agent/trajectory.jsonl",
        collection: { trajectory: "complete", artifacts: "complete" } });
      if (scenario === "native") expect(record?.solve?.observations).toMatchObject({
        groups: [{ concurrency: 1, status: "measured" }, { concurrency: 8, status: "measured" }],
      });
      expect(start).toHaveBeenCalledTimes(scenario === "native" ? 1 : 0);
      const paths = await allocate.mock.results[0]?.value;
      if (!paths) throw new Error("Missing attempt directory");
      const manifest = JSON.parse(await readFile(join(paths.root, "files.json"), "utf8"));
      expect(manifest.missing).toEqual([]);
      expect(manifest.files.map((file: { path: string }) => file.path)).toEqual(expect.arrayContaining(["agent/session.jsonl", "agent/trajectory.jsonl"]));
      const session = await readFile(join(paths.agent, "session.jsonl"), "utf8");
      expect(session).not.toContain(secret);
      const states = session.trimEnd().split("\n").map(line => JSON.parse(line)).filter(entry => entry.operation === "status");
      expect(states.map(entry => entry.state)).toEqual(scenario === "native" ? ["missing", "completed"] : ["completed"]);
      expect(states.at(-1)).toMatchObject({ phase: "finished", exitCode: 0 });
    } finally { await components.dispose(); }
  } finally { vi.restoreAllMocks(); await rm(root, { recursive: true, force: true }); }
}, 30000);
