import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import { ProfileNode } from "./profile-node.js";
import { captureServiceSamples } from "./service-sampler.js";
import { join } from "node:path";
import { promisify } from "node:util";
import { agentXAssets, resolveAgentXPython } from "./runtime.js";

const exec = promisify(execFile);

type ProfileOptions = {
  endpoint: string; key: string; directory: string; destination: string; exportTimeoutSeconds: number;
  provider?: "vllm" | "sglang"; preset?: "full" | "timeline" | "compute" | "cache" | "bandwidth"; devices?: number[];
  nodeMetrics?: { endpoint: string; names: string[] }; analysisPython?: string; samplerPython?: string;
  pythonExecutable?: string; serviceNode?: string; signal: AbortSignal;
};

export async function captureServiceProfile<T>(options: ProfileOptions, measure: () => Promise<T>, warmup?: () => Promise<void>) {
  const node = options.serviceNode ? await ProfileNode.open(options.serviceNode, options.signal) : undefined;
  let result;
  try { result = await captureWindow(options, node, measure, warmup); }
  catch (error) {
    try { await node?.finish(options.destination); }
    catch (exportError) {
      throw new Error([error, exportError].map(e => e instanceof Error ? e.message : String(e)).join(". "), { cause: error });
    }
    throw error;
  }
  await node?.finish(options.destination);
  return result;
}

async function captureWindow<T>(options: ProfileOptions, node: ProfileNode | undefined, measure: () => Promise<T>, warmup?: () => Promise<void>): Promise<{ measurement: T; profile: unknown }> {
  const { directory, signal } = options;
  const base = new URL(options.endpoint);
  if (!["http:", "https:"].includes(base.protocol) || base.username || base.password || base.search || base.hash)
    throw new TypeError("Service profiling requires a credential-free HTTP(S) service URL");
  const python = node ? { executable: "python3" } : await resolveAgentXPython(options.pythonExecutable, signal);
  const fixed = options.provider === "vllm";
  const full = options.preset === "full";
  const hardware = options.preset && !full && options.preset !== "timeline";
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(base.hostname);
  if (options.devices && !local && !node)
    throw new Error("Run msprof on the inference service host using a loopback service endpoint and explicit physical devices");
  await mkdir(options.destination, { recursive: true });
  const sampler = options.samplerPython ?? python.executable;
  if (options.devices && !full) {
    if (node) await node.run("check", { python: sampler, config: { devices: options.devices, preset: options.preset } }, signal);
    else await exec(sampler, ["-B", join(agentXAssets, "service_sampler.py"), "--check",
      JSON.stringify({ devices: options.devices, preset: options.preset ?? "timeline" })], { signal, timeout: 30000, windowsHide: true });
  }
  if (warmup) await warmup();
  const sampling = node ? { ...options, destination: node.root + "/trace", node } : options;
  if (hardware) {
    const sampled = await captureServiceSamples(sampler, sampling, measure);
    return { measurement: sampled.measurement, profile: sampled.evidence };
  }
  let trace: string;
  if (node) trace = (await node.run("prepare", { directory, fixed }, signal)).trim();
  else {
    await mkdir(directory, { recursive: true });
    const root = await realpath(directory);
    trace = fixed ? root : await mkdtemp(join(root, "agentx-"));
    if (!fixed) await chmod(trace, 0o770);
  }
  const collector = join(agentXAssets, "collect_profile.py");
  const args = [trace, options.destination, String(options.exportTimeoutSeconds)];
  if (fixed || options.analysisPython) {
    const baseline = join(options.destination, "existing-ranks.json");
    if (node) await node.run("baseline", { trace }, signal);
    else {
      const { stdout } = await exec(python.executable, ["-B", collector, "--snapshot", trace], { signal, windowsHide: true });
      await writeFile(baseline, stdout);
    }
    args.push(baseline);
    if (options.analysisPython) args.push(options.analysisPython);
  }
  base.pathname = base.pathname.replace(/\/+$/u, "").replace(/\/chat\/completions$/u, "").replace(/\/v1$/u, "") + "/";
  async function post(route: string, body: object | undefined, controlSignal: AbortSignal) {
    if (node) {
      const status = Number(await node.run("http", { url: new URL(route, base).href, key: options.key, body }, controlSignal));
      if (!Number.isInteger(status) || status < 100 || status > 599) throw new Error("Invalid service node HTTP response");
      return { ok: status >= 200 && status < 300, status };
    }
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
    } catch (cause) { throw new Error("Service stop_profile unconfirmed; check the service before collecting again", { cause }); }
  })();
  let measurement: T;
  let resources: Record<string, unknown> = {};
  try {
    const start = await post("start_profile", fixed ? undefined : { output_dir: trace, activities: ["CPU", "NPU"], record_shapes: true,
      with_stack: false, profile_by_stage: false }, AbortSignal.any([signal, AbortSignal.timeout(60000)]));
    if (!start.ok) {
      stop = start.status >= 500;
      throw new Error(`Service start_profile returned HTTP ${start.status}`);
    }
    // A loopback model URL may also be an SSH tunnel. Only sample the coordinator when node access was configured.
    const localHost = full && (!!node || (local && (!!options.devices || !!options.samplerPython)));
    if (options.nodeMetrics || options.devices || localHost) {
      const sampled = await captureServiceSamples(sampler, { ...sampling, localHost }, measure, stopService);
      measurement = sampled.measurement;
      resources = sampled.evidence;
    } else measurement = await measure();
  } finally {
    // Even a lost response to start may leave the service recording. Cleanup has its own deadline.
    if (stop) await stopService();
  }
  signal.throwIfAborted();
  if (node) {
    const stdout = await node.run("export", { trace, timeout: options.exportTimeoutSeconds, key: options.key,
      full, resources: { ...resources, devices: options.devices ?? [] }, baseline: fixed || !!options.analysisPython,
      analysisPython: options.analysisPython }, signal);
    return { measurement, profile: { ...resources, ...JSON.parse(stdout), preset: full ? "full" : "timeline" } };
  }
  if (full) await writeFile(join(options.destination, "sampling-summary.json"),
    JSON.stringify({ ...resources, devices: options.devices ?? [] }) + "\n");
  const { stdout } = await exec(python.executable, ["-B", collector, ...args], { signal, encoding: "utf8",
    env: { ...process.env, AGENTX_REDACT: options.key, AGENTX_FULL_PROFILE: full ? "1" : "" },
    maxBuffer: 16 * 1024 * 1024, windowsHide: true });
  return { measurement, profile: { ...resources, ...JSON.parse(stdout), preset: full ? "full" : "timeline" } };
}
