import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import { captureServiceSamples } from "./service-sampler.js";
import { join } from "node:path";
import { promisify } from "node:util";
import { agentXAssets, resolveAgentXPython } from "./runtime.js";

const exec = promisify(execFile);

export async function captureAgentXProfile<T>(options: {
  endpoint: string; key: string; directory: string; destination: string; exportTimeoutSeconds: number;
  provider?: "vllm" | "sglang"; preset?: "full" | "timeline" | "compute" | "cache" | "bandwidth"; devices?: number[];
  nodeMetrics?: { endpoint: string; names: string[] }; analysisPython?: string; samplerPython?: string;
  pythonExecutable?: string; signal: AbortSignal;
}, measure: () => Promise<T>, warmup?: () => Promise<void>): Promise<{ measurement: T; profile: unknown }> {
  const { directory, signal } = options;
  const base = new URL(options.endpoint);
  if (!["http:", "https:"].includes(base.protocol) || base.username || base.password || base.search || base.hash)
    throw new TypeError("AgentX profiling requires a credential-free HTTP(S) service URL");
  const python = await resolveAgentXPython(options.pythonExecutable, signal);
  const fixed = options.provider === "vllm";
  const full = options.preset === "full";
  const hardware = options.preset && !full && options.preset !== "timeline";
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(base.hostname);
  if (options.devices && !local)
    throw new Error("Run msprof on the inference service host using a loopback service endpoint and explicit physical devices");
  await mkdir(options.destination, { recursive: true });
  const sampler = options.samplerPython ?? python.executable;
  if (options.devices && !full) {
    await exec(sampler, ["-B", join(agentXAssets, "service_sampler.py"), "--check",
      JSON.stringify({ devices: options.devices, preset: options.preset ?? "timeline" })], { signal, timeout: 30000, windowsHide: true });
  }
  if (warmup) await warmup();
  if (hardware) {
    const sampled = await captureServiceSamples(sampler, options, measure);
    return { measurement: sampled.measurement, profile: sampled.evidence };
  }
  await mkdir(directory, { recursive: true });
  const root = await realpath(directory);
  const trace = fixed ? root : await mkdtemp(join(root, "agentx-"));
  if (!fixed) await chmod(trace, 0o770);
  const collector = join(agentXAssets, "collect_profile.py");
  const args = [trace, options.destination, String(options.exportTimeoutSeconds)];
  if (fixed || options.analysisPython) {
    const baseline = join(options.destination, "existing-ranks.json");
    const { stdout } = await exec(python.executable, ["-B", collector, "--snapshot", trace], { signal, windowsHide: true });
    await writeFile(baseline, stdout);
    args.push(baseline);
    if (options.analysisPython) args.push(options.analysisPython);
  }
  base.pathname = base.pathname.replace(/\/+$/u, "").replace(/\/chat\/completions$/u, "").replace(/\/v1$/u, "") + "/";
  async function post(route: string, body: object | undefined, controlSignal: AbortSignal) {
    const response = await fetch(new URL(route, base), { method: "POST", redirect: "error", signal: controlSignal,
      headers: { "Content-Type": "application/json", ...(options.key ? { Authorization: "Bearer " + options.key } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}) });
    await response.body?.cancel();
    return response;
  }

  signal.throwIfAborted();
  let stop = true;
  let stopping: Promise<void> | undefined;
  const stopService = () => stopping ??= (async () => {
    try {
      const result = await post("stop_profile", fixed ? undefined : {}, AbortSignal.timeout(60000));
      if (!result.ok) throw new Error(`HTTP ${result.status}`);
    } catch (cause) { throw new Error("AgentX stop_profile unconfirmed; check the service before collecting again", { cause }); }
  })();
  let measurement: T;
  let resources: Record<string, unknown> = {};
  try {
    const start = await post("start_profile", fixed ? undefined : { output_dir: trace, activities: ["CPU", "NPU"], record_shapes: true,
      with_stack: false, profile_by_stage: false }, AbortSignal.any([signal, AbortSignal.timeout(60000)]));
    if (!start.ok) {
      stop = start.status >= 500;
      throw new Error(`AgentX start_profile returned HTTP ${start.status}`);
    }
    // A loopback model URL may also be an SSH tunnel. Only sample the coordinator when node access was configured.
    const localHost = full && local && (!!options.devices || !!options.samplerPython);
    if (options.nodeMetrics || options.devices || localHost) {
      const sampled = await captureServiceSamples(sampler, { ...options, localHost }, measure, stopService);
      measurement = sampled.measurement;
      resources = sampled.evidence;
    } else measurement = await measure();
  } finally {
    // Even a lost response to start may leave the service recording. Cleanup has its own deadline.
    if (stop) await stopService();
  }
  signal.throwIfAborted();
  if (full) await writeFile(join(options.destination, "sampling-summary.json"),
    JSON.stringify({ ...resources, devices: options.devices ?? [] }) + "\n");
  const { stdout } = await exec(python.executable, ["-B", collector, ...args], { signal, encoding: "utf8",
    env: { ...process.env, AGENTX_REDACT: options.key, AGENTX_FULL_PROFILE: full ? "1" : "" },
    maxBuffer: 16 * 1024 * 1024, windowsHide: true });
  return { measurement, profile: { ...resources, ...JSON.parse(stdout), preset: full ? "full" : "timeline" } };
}
