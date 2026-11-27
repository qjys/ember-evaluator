import { isAbsolute, posix } from "node:path";
import type { JsonValue } from "../../../../../core/contracts/task.js";
import { assertJsonValue, expectNonEmptyString, expectPositiveInteger, expectRecord, rejectUnknown } from "../../../../../core/validation/input.js";

export type AgentXProfileConfig = { traceDirectory: string; service?: string; traceCount?: number; exportTimeoutSeconds: number };
export type AgentXCollection = { type: "performance"; engineMetrics?: string[] } | { type: "profiling"; profiling: AgentXProfileConfig };

export function parseEngineMetrics(value: unknown): string[] {
  if (!Array.isArray(value) || !value.length || !value.every((name): name is string =>
    typeof name === "string" && /^[a-zA-Z_:][a-zA-Z0-9_:]*$/u.test(name)) || new Set(value).size !== value.length)
    throw new TypeError("engineMetrics requires distinct Prometheus sample names");
  return value;
}

export function parseProfileConfig(value: unknown): AgentXProfileConfig {
  const v = expectRecord(value, "agentx.profiling");
  rejectUnknown(v, ["traceDirectory", "service", "traceCount", "exportTimeoutSeconds"], "agentx.profiling");
  const traceDirectory = expectNonEmptyString(v.traceDirectory, "profiling.traceDirectory");
  if (!(isAbsolute(traceDirectory) || posix.isAbsolute(traceDirectory)) || /[\r\n\0]/u.test(traceDirectory) || traceDirectory.split(/[/\\]/u).includes(".."))
    throw new TypeError("profiling.traceDirectory must be an absolute shared path");
  return { traceDirectory, exportTimeoutSeconds: expectPositiveInteger(v.exportTimeoutSeconds ?? 1800, "profiling.exportTimeoutSeconds"),
    ...(v.traceCount === undefined ? {} : { traceCount: expectPositiveInteger(v.traceCount, "profiling.traceCount") }),
    ...(v.service === undefined ? {} : { service: expectNonEmptyString(v.service, "profiling.service") }) };
}

export function parseCollection(value: unknown): AgentXCollection {
  const v = expectRecord(value, "AgentX collection");
  if (v.type === "profiling") {
    rejectUnknown(v, ["type", "profiling"], "AgentX profiling collection");
    return { type: "profiling", profiling: parseProfileConfig(v.profiling) };
  }
  rejectUnknown(v, ["type", "engineMetrics"], "AgentX performance collection");
  if (v.type !== "performance") throw new TypeError("Invalid AgentX collection");
  return { type: "performance", ...(v.engineMetrics === undefined ? {} : { engineMetrics: parseEngineMetrics(v.engineMetrics) }) };
}

export function collectionEvidence(value: unknown, kind: "engine" | "profiling"): Record<string, JsonValue> {
  const raw = expectRecord(value, "AgentX " + kind);
  assertJsonValue(raw, "AgentX " + kind);
  if (kind === "engine") {
    if (!["measured", "partial"].includes(String(raw.status)) || !Array.isArray(raw.series) ||
        !Array.isArray(raw.missing) || !Array.isArray(raw.errors)) throw new TypeError("Invalid AgentX engine metrics");
  } else {
    if (!["measured", "host-only"].includes(String(raw.status)) || !Array.isArray(raw.exports) || raw.exports.length === 0 ||
        typeof raw.traceDirectory !== "string") throw new TypeError("Invalid AgentX profile");
    const flags = raw.exports.map(item => expectRecord(item, "Ascend export").deviceEvidence);
    if (flags.some(flag => typeof flag !== "boolean") || (raw.status === "measured") !== flags.every(flag => flag === true))
      throw new TypeError("Invalid Ascend device evidence");
  }
  return raw;
}
