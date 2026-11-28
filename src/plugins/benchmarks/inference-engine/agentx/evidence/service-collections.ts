import { isAbsolute, posix } from "node:path";
import type { JsonValue } from "../../../../../core/contracts/task.js";
import { assertJsonValue, expectNonEmptyString, expectPositiveInteger, expectRecord, rejectUnknown } from "../../../../../core/validation/input.js";

export type AgentXProfileConfig = {
  provider?: "vllm" | "sglang";
preset?: "full" | "timeline" | "compute" | "bandwidth" | "cache";
  devices?: number[];
  nodeMetrics?: { endpoint: string; names: string[] };
  analysisPython?: string;
  samplerPython?: string;
  traceDirectory: string;
  service?: string;
  traceCount?: number;
  exportTimeoutSeconds: number;
};
export type AgentXCollection = { type: "performance"; sampleWindow?: true; engineMetrics?: string[] } | { type: "profiling"; profiling: AgentXProfileConfig };

export function parseEngineMetrics(value: unknown): string[] {
  if (!Array.isArray(value) || !value.length || !value.every((name): name is string =>
    typeof name === "string" && /^[a-zA-Z_:][a-zA-Z0-9_:]*$/u.test(name)) || new Set(value).size !== value.length)
    throw new TypeError("engineMetrics requires distinct Prometheus sample names");
  return value;
}

export function parseProfileConfig(value: unknown, defaultProvider?: "vllm"): AgentXProfileConfig {
  const v = expectRecord(value, "agentx.profiling");
  rejectUnknown(v, ["traceDirectory", "service", "traceCount", "exportTimeoutSeconds", "provider", "preset", "devices", "nodeMetrics", "analysisPython", "samplerPython"], "agentx.profiling");
  const traceDirectory = expectNonEmptyString(v.traceDirectory, "profiling.traceDirectory");
  if (!(isAbsolute(traceDirectory) || posix.isAbsolute(traceDirectory)) || /[\r\n\0]/u.test(traceDirectory) || traceDirectory.split(/[/\\]/u).includes(".."))
    throw new TypeError("profiling.traceDirectory must be an absolute shared path");
  const provider = v.provider ?? defaultProvider;
  if (provider !== undefined && provider !== "vllm" && provider !== "sglang") throw new TypeError("profiling.provider must be vllm or sglang");
  const preset = v.preset ?? (defaultProvider ? "full" : undefined);
  if (preset !== undefined && preset !== "full" && preset !== "timeline" && preset !== "compute" && preset !== "cache" && preset !== "bandwidth")
    throw new TypeError("profiling.preset must be full, timeline, compute, bandwidth or cache");
  const devices = v.devices;
  if (devices !== undefined && (!Array.isArray(devices) || !devices.length || devices.some(d => !Number.isSafeInteger(d) || d < 0) ||
    new Set(devices).size !== devices.length)) throw new TypeError("profiling.devices requires distinct physical NPU IDs");
  if (preset && ["compute", "bandwidth", "cache"].includes(preset) && !devices) throw new TypeError("msprof presets require profiling.devices on the service host");
  let nodeMetrics: AgentXProfileConfig["nodeMetrics"];
  if (v.nodeMetrics !== undefined) {
    const node = expectRecord(v.nodeMetrics, "profiling.nodeMetrics");
    rejectUnknown(node, ["endpoint", "names"], "profiling.nodeMetrics");
    const endpoint = expectNonEmptyString(node.endpoint, "profiling.nodeMetrics.endpoint");
    const url = new URL(endpoint);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash)
      throw new TypeError("profiling.nodeMetrics.endpoint must be a credential-free HTTP(S) exporter URL");
    nodeMetrics = { endpoint, names: parseEngineMetrics(node.names) };
  }
  return { traceDirectory, ...(provider ? { provider } : {}), ...(preset ? { preset } : {}),
    ...(devices ? { devices } : {}), ...(nodeMetrics ? { nodeMetrics } : {}),
    ...(v.samplerPython === undefined ? {} : { samplerPython: expectNonEmptyString(v.samplerPython, "profiling.samplerPython") }),
    ...(v.analysisPython === undefined ? {} : { analysisPython: expectNonEmptyString(v.analysisPython, "profiling.analysisPython") }),
    exportTimeoutSeconds: expectPositiveInteger(v.exportTimeoutSeconds ?? 1800, "profiling.exportTimeoutSeconds"),
    ...(v.traceCount === undefined ? {} : { traceCount: expectPositiveInteger(v.traceCount, "profiling.traceCount") }),
    ...(v.service === undefined ? {} : { service: expectNonEmptyString(v.service, "profiling.service") }) };
}

export function parseCollection(value: unknown): AgentXCollection {
  const v = expectRecord(value, "AgentX collection");
  if (v.type === "profiling") {
    rejectUnknown(v, ["type", "profiling"], "AgentX profiling collection");
    return { type: "profiling", profiling: parseProfileConfig(v.profiling) };
  }
  rejectUnknown(v, ["type", "engineMetrics", "sampleWindow"], "AgentX performance collection");
  if (v.type !== "performance") throw new TypeError("Invalid AgentX collection");
  if (v.sampleWindow !== undefined && v.sampleWindow !== true) throw new TypeError("Invalid AgentX sampleWindow");
  return { type: "performance", ...(v.sampleWindow ? { sampleWindow: true } : {}), ...(v.engineMetrics === undefined ? {} : { engineMetrics: parseEngineMetrics(v.engineMetrics) }) };
}

export function collectionEvidence(value: unknown, kind: "engine" | "profiling"): Record<string, JsonValue> {
  const raw = expectRecord(value, "AgentX " + kind);
  assertJsonValue(raw, "AgentX " + kind);
  if (kind === "engine") {
    if (!["measured", "partial"].includes(String(raw.status)) || !Array.isArray(raw.series) ||
        !Array.isArray(raw.missing) || !Array.isArray(raw.errors)) throw new TypeError("Invalid AgentX engine metrics");
  } else {
    if (!["measured", "host-only", "partial"].includes(String(raw.status)) || !Array.isArray(raw.exports) || raw.exports.length === 0 ||
        typeof raw.traceDirectory !== "string") throw new TypeError("Invalid AgentX profile");
    if (raw.coverageStatus !== undefined) {
      const categories = Object.values(expectRecord(raw.categories, "profiling categories"));
      const states = categories.map(item => expectRecord(item, "profiling category").status);
      if (!states.length || states.some(state => !["measured", "partial", "unavailable"].includes(String(state))) ||
          raw.coverageStatus !== (states.every(state => state === "measured") ? "measured" : "partial"))
        throw new TypeError("Invalid AgentX profiling category coverage");
    }
    const flags = raw.exports.map(item => expectRecord(item, "Ascend export").deviceEvidence);
    if (raw.status === "partial" && !["compute", "cache", "bandwidth"].includes(String(raw.preset))) throw new TypeError("Invalid partial hardware profile");
    if (flags.some(flag => typeof flag !== "boolean") || (raw.status === "measured") !== flags.every(flag => flag === true))
      throw new TypeError("Invalid Ascend device evidence");
  }
  return raw;
}
