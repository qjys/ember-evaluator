import type { MeasurementMetricFile } from "../../core/contracts/metrics.js";
import type { ResultSnapshot } from "../../core/contracts/result.js";
import type { JsonValue } from "../../core/contracts/task.js";
import { evidencePath, measurementDirectory } from "../../core/artifacts/artifacts.js";

type Row = Record<string, JsonValue>;
type Status = "measured" | "partial" | "unavailable";
type Section = { status: Status; values: Row; source?: string; reason?: string };

const groups = {
  "service/requests": [], "engine/engine": [],
  "resource/host": ["cpu", "memory", "disk", "network"],
  "resource/npu": ["npuMemory", "npuUtilization", "allocator"],
  "execution/operators": ["operators"], "execution/runtime": ["runtime", "memcpy"],
  "hardware/hbm": ["hbmBandwidth"], "hardware/pmu": ["pipeline"], "hardware/cache": ["l2Cache"],
  "parallelism/communication": ["communication", "links"], "parallelism/timeline": ["timeline"],
} as const;
type Group = keyof typeof groups;

function row(value: JsonValue | undefined): Row {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}
function rows(value: JsonValue | undefined): Row[] {
  return Array.isArray(value) ? value.map(row) : [];
}
function pick(value: Row, keys: string[]): Row {
  return Object.fromEntries(keys.filter(k => value[k] != null).map(k => [k, value[k]!]));
}
function status(states: JsonValue[]): Status {
  if (states.length && states.every(v => v === "measured" || v === "complete")) return "measured";
  return states.some(v => ["measured", "complete", "partial"].includes(String(v))) ? "partial" : "unavailable";
}
function hasData(value: JsonValue): boolean {
  if (Array.isArray(value)) return value.some(hasData);
  if (value && typeof value === "object") return Object.values(value).some(hasData);
  return typeof value === "number";
}

const rankFiles: Partial<Record<Group, RegExp>> = {
  "execution/operators": /^(?:op_statistic|operator_details|kernel_details)\.csv$/u,
  "execution/runtime": /^(?:api_statistic\.csv|trace_view\.json)$/u,
  "resource/npu": /^(?:memory_record|npu_module_mem)\.csv$/u,
  "hardware/hbm": /^(?:ascend_pytorch_profiler.*\.db|hbm.*\.csv)$/iu,
  "hardware/cache": /^l2_cache\.csv$/iu, "hardware/pmu": /^kernel_details\.csv$/u,
  "parallelism/communication": /^(?:communication(?:_matrix)?|trace_view)\.json$/u,
  "parallelism/timeline": /^(?:trace_view\.json|step_trace_time\.csv)$/u,
};
function rankValues(group: Group, rank: Row): Row {
  const native = row(rank.native), timeline = row(rank.timeline);
  switch (group) {
    case "execution/operators": return pick(rank, ["operatorSource", "operatorDeviceUs", "operatorHostUs", "topDevice", "topHost",
      "operatorInstances", "operatorTypes", "byCore", "kernelCount", "kernelDurationUs", "topShapes", "kernelWaitUs", "topKernelWait"]);
    case "execution/runtime": return pick(row(timeline.top), ["runtime", "copy"]);
    case "resource/npu": return pick(native, ["allocatorMB"]);
    case "hardware/hbm": return pick(native, ["hbmChannels"]);
    case "hardware/pmu": return pick(native, ["pipeline"]);
    case "hardware/cache": return pick(native, ["l2Cache"]);
    case "parallelism/communication": return { ...pick(native, ["communication"]), ...pick(timeline, ["communicationUs", "exposedCommunicationUs"]) };
    case "parallelism/timeline": return { ...pick(timeline, ["source", "computeUs", "communicationUs", "overlapUs", "exposedCommunicationUs"]),
      ...pick(rank, ["stageUs", "stepSpansUs"]) };
    default: return {};
  }
}

export function serviceDiagnosticSection(path: string, profile: Row, directory: string): Section {
  if (!Object.hasOwn(groups, path)) throw new TypeError("Unknown profiling category " + path);
  const group = path as Group;
  const coverage = pick(row(profile.categories), [...groups[group]]);
  const values: Row = {};
  const ranks = rows(profile.exports).filter(rank => rank.physicalDevice === undefined).flatMap(rank => {
    if (typeof rank.artifactDirectory !== "string") return [];
    const statistics = rankValues(group, rank);
    if (!Object.keys(statistics).length) return [];
    const source = directory + "/" + evidencePath(rank.artifactDirectory);
    const output = row(rank.artifacts).outputs;
    const files = Array.isArray(output) ? output.flatMap(path => {
      if (typeof path !== "string") return [];
      const name = evidencePath(path).split("/").at(-1)!;
      return rankFiles[group]?.test(name) ? [source + "/" + name] : [];
    }) : [];
    return [{ source, files, statistics }];
  });
  if (ranks.length) values.ranks = ranks;
  for (const key of ["localMetrics", "nodeMetrics"]) {
    if (group !== "resource/host" && group !== "resource/npu") continue;
    const sample = row(profile[key]);
    const npu = /(?:npu|ascend|hbm|dcgm)/iu;
    const series = Object.fromEntries(Object.entries(row(sample.series)).filter(([label]) =>
      group === "resource/npu" ? npu.test(label) : !npu.test(label)));
    if (Object.keys(series).length) values[key] = { series, ...(typeof sample.rawSeries === "string" ?
      { source: directory + "/" + evidencePath(sample.rawSeries) } : {}) };
  }
  const counterFilters: Partial<Record<Group, RegExp>> = {
    "hardware/hbm": /hbm|bandwidth/iu, "hardware/cache": /cache|l2/iu, "hardware/pmu": /cube|vec|mte|pipe|mac/iu,
  };
  const filter = counterFilters[group];
  if (filter) {
    const devices = [...rows(profile.hardwareExports), ...rows(profile.exports).filter(r => r.physicalDevice !== undefined)].flatMap(r => {
      const counters = Object.fromEntries(Object.entries(row(r.counters)).filter(([k]) => filter.test(k) && (group !== "hardware/pmu" || !/cache/iu.test(k))));
      if (!Object.keys(counters).length) return [];
      return [{ ...pick(r, ["physicalDevice", "logicalDevice"]), counters,
        ...(group === "hardware/cache" ? pick(r, ["hitOverHitsAndMissAllocations"]) : {}),
        ...(typeof r.artifactDirectory === "string" ? { source: directory + "/" + evidencePath(r.artifactDirectory) } : {}) }];
    });
    if (devices.length) values.devices = devices;
  }
  const states = Object.values(coverage).map(c => row(c).status ?? "unavailable");
  const measured = states.length ? status(states) : hasData(values) ? profile.status === "partial" ? "partial" : "measured" : "unavailable";
  return { ...(profile.artifactDirectory ? { source: directory } : {}), status: measured, values: { ...values, coverage, ...pick(profile, ["preset", "requests", "traceCount"]) },
    ...(measured === "unavailable" ? { reason: String(profile.error ?? "No samples for this metric in the diagnostic pass") } : {}) };
}

/** Classify already verified observations. Source paths are relative to the run, including per-rank evidence. */
export function agentXMeasurementFiles(snapshot: ResultSnapshot, metric: JsonValue): MeasurementMetricFile[] {
  const layout = snapshot.run.resultLayout;
  if (!layout || row(metric).applicable !== true) return [];
  const results = new Map(rows(row(metric).points).map(point => [point.taskId, point]));
  const ids = snapshot.run.source ? snapshot.run.taskIds : Object.keys(layout.points);
  return (Object.keys(groups) as Group[]).map(path => {
    const file: MeasurementMetricFile = { path, status: {}, points: [] };
    for (const id of ids) {
      const concurrency = layout.points[id];
      if (concurrency === undefined) throw new Error(`Missing AgentX measurement point for ${id}`);
      const label = measurementDirectory(concurrency);
      if (!layout.requestedMetrics.includes(path)) { file.status[label] = "disabled"; continue; }
      const point = results.get(id.replace(/-profiling$/u, "")) ?? {};
      const summary = row(point.measurement), formalDir = label + "/performance", profileDir = label + "/profiling";
      const collection = rows(point.collections)[0] ?? {}, profile = row(collection.profiling);
      const data: Record<string, Section> = {};
      const telemetry = rows(row(summary.telemetry).sources);
      if (path === "service/requests" && summary.profiling) {
        data.performance = { source: formalDir + "/outputs", status: status([collection.performanceStatus ?? (point.status === "completed" ? "measured" : point.status ?? "unavailable")]),
          values: { statistics: summary.profiling, ...pick(summary, ["warmup", "replayCoverage", "networkLatency", "comparable", "incomparableReasons"]) } };
      }
      const engine = row(summary.engine);
      const sources = telemetry.filter(t => (path === "engine/engine" && t.kind === "vllm") || (path === "resource/npu" && t.kind === "ascend"));
      if ((path === "engine/engine" && summary.engine) || sources.length) {
        data.performance = { source: formalDir, status: status([...(path === "engine/engine" && summary.engine ? [rows(engine.series).length ? engine.status ?? "unavailable" : "unavailable"] : []), ...sources.map(t => t.status ?? "unavailable")]),
          values: { ...(path === "engine/engine" && summary.engine ? { engine, ...(typeof engine.rawSeries === "string" ?
            { source: formalDir + "/" + evidencePath(engine.rawSeries) } : {}) } : {}), ...(sources.length ? { telemetry: sources } : {}) } };
      }
      if (groups[path].length && collection.profiling) data.profiling = serviceDiagnosticSection(path, profile, profileDir);
      const state = status(Object.values(data).map(p => p.status));
      file.status[label] = state;
      const record = snapshot.records.find(r => r.key.taskId === id);
      file.points.push({ concurrency, status: state, ...data, ...(state === "unavailable" ? { reason: String(profile.error ??
        record?.errors[0]?.message ?? snapshot.run.failure?.message ?? "No usable samples in the requested measurement") } : {}) });
    }
    return file;
  });
}
