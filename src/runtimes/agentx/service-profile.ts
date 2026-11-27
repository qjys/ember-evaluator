import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, realpath } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { agentXAssets, resolveAgentXPython } from "./runtime.js";

const exec = promisify(execFile);

export async function captureAgentXProfile<T>(options: {
  endpoint: string; key: string; directory: string; destination: string; exportTimeoutSeconds: number;
  pythonExecutable?: string; signal: AbortSignal;
}, measure: () => Promise<T>): Promise<{ measurement: T; profile: unknown }> {
  const { directory, signal } = options;
  const base = new URL(options.endpoint);
  if (!["http:", "https:"].includes(base.protocol) || base.username || base.password || base.search || base.hash)
    throw new TypeError("AgentX profiling requires a credential-free HTTP(S) service URL");
  const python = await resolveAgentXPython(options.pythonExecutable, signal);
  await mkdir(directory, { recursive: true });
  const trace = await mkdtemp(join(await realpath(directory), "agentx-"));
  await chmod(trace, 0o770);
  base.pathname = base.pathname.replace(/\/+$/u, "").replace(/\/chat\/completions$/u, "").replace(/\/v1$/u, "") + "/";
  async function post(route: string, body: object, controlSignal: AbortSignal) {
    const response = await fetch(new URL(route, base), { method: "POST", redirect: "error", signal: controlSignal,
      headers: { "Content-Type": "application/json", ...(options.key ? { Authorization: "Bearer " + options.key } : {}) },
      body: JSON.stringify(body) });
    await response.body?.cancel();
    return response;
  }

  signal.throwIfAborted();
  let stop = true;
  let measurement: T;
  try {
    const start = await post("start_profile", { output_dir: trace, activities: ["CPU", "NPU"], record_shapes: true,
      with_stack: false, profile_by_stage: false }, AbortSignal.any([signal, AbortSignal.timeout(60000)]));
    if (!start.ok) {
      stop = start.status >= 500;
      throw new Error(`AgentX start_profile returned HTTP ${start.status}`);
    }
    measurement = await measure();
  } finally {
    // Even a lost response to start may leave the service recording. Cleanup has its own deadline.
    if (stop) {
      try {
        const result = await post("stop_profile", {}, AbortSignal.timeout(60000));
        if (!result.ok) throw new Error(`HTTP ${result.status}`);
      } catch (cause) { throw new Error("AgentX stop_profile unconfirmed; check the service before collecting again", { cause }); }
    }
  }
  signal.throwIfAborted();
  const { stdout } = await exec(python.executable, ["-B", join(agentXAssets, "collect_profile.py"), trace,
    options.destination, String(options.exportTimeoutSeconds)], { signal, encoding: "utf8", env: { ...process.env, AGENTX_REDACT: options.key }, maxBuffer: 16 * 1024 * 1024, windowsHide: true });
  return { measurement, profile: JSON.parse(stdout) };
}
