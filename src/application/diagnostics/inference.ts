import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { agentXAssets } from "../../runtimes/agentx/runtime.js";
import { join } from "node:path";
import type { LoadedConfig } from "../../config/loaded.js";
import { expectRecord } from "../../core/validation/input.js";

type Check = (name: string, probe: () => Promise<unknown>) => Promise<void>;
const quote = (text: string) => "'" + text.replaceAll("'", "'\"'\"'") + "'";

export async function diagnoseInference(config: LoadedConfig, signal: AbortSignal, check: Check) {
  const { benchmark, solver, services } = config.experiment;
  if (benchmark.evaluationScenario !== "inference-engine" || !benchmark.config.measurementMode) return;
  const model = services[solver.service]!;
  const credential = config.auths[solver.service]?.value ?? "";
  const profile = expectRecord(benchmark.config.profiling ?? {}, "profiling");
  const remote = solver.config.remote ? expectRecord(solver.config.remote, "remote") : undefined;
  const ssh = remote ? expectRecord(remote.ssh, "ssh") : solver.config.loadNode ? { host: solver.config.loadNode } : undefined;
  const sshOptions = ["-T", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes", "-o", "ConnectTimeout=10"];
  const script = await readFile(join(agentXAssets, "check_inference.py"), "utf8");
  async function probe(role: string, executable: string, options: string[], fields: object) {
    await check(role, () => new Promise<void>((resolve, reject) => {
      const process = execFile(executable, options, { signal, timeout: 30000, windowsHide: true },
        (error, _stdout, stderr) => error ? reject(new Error(role + ": " + stderr.trim().slice(-1000))) : resolve());
      process.stdin?.on("error", () => {});
      process.stdin?.end(JSON.stringify({ model: model.name, endpoint: model.endpoint, key: credential, ...fields }));
    }));
  }
  const localPython = !solver.config.loadNode && typeof solver.config.pythonExecutable === "string" ? solver.config.pythonExecutable : process.env.PYTHON_BIN ?? (process.platform === "win32" ? "python" : "python3");
  const python = String(remote?.pythonExecutable ?? solver.config.pythonExecutable ?? (ssh ? "python3" : localPython));
  const loadArgs = ssh ? [...sshOptions, ...(ssh.port ? ["-p", String(ssh.port)] : []), ...(ssh.identityFile ? ["-i", String(ssh.identityFile)] : []),
    (ssh.user ? String(ssh.user) + "@" : "") + String(ssh.host), quote(python) + " -c " + quote(script)] : ["-c", script];
  await probe("Load generator: model service and workload inputs", ssh ? "ssh" : python, loadArgs,
    { paths: [solver.config.tokenizerPath, ...(solver.config.loadNode ? [solver.config.tokenizer] : []), remote?.workingDirectory, remote?.aisbenchWorkPath, benchmark.config.multimodalManifest,
      benchmark.config.multimodalGeneration && expectRecord(benchmark.config.multimodalGeneration, "generation").mmmuParquetDir].filter(Boolean),
      version: remote?.aisbenchVersion });
  if (benchmark.config.measurementMode === "performance") return;
  const node = profile.serviceNode;
  await probe("Serving node: model, profiler routes and trace directory", node ? "ssh" : localPython,
    node ? [...sshOptions, String(node), "python3 -c " + quote(script)] : ["-c", script],
    { trace: profile.traceDirectory, preset: profile.preset ?? "full", devices: profile.devices, samplerPython: profile.samplerPython, analysisPython: profile.analysisPython });
}
