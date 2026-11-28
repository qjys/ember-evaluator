import { isDeepStrictEqual } from "node:util";
import { expectNonEmptyString, expectPositiveInteger, expectRecord, rejectUnknown } from "../core/validation/input.js";
import type { ConfigProfile } from "./profile-schema.js";
import type { BenchmarkSelection } from "./user-schema.js";

export type WorkloadPreset = { scenario: string; fields: Record<string, string>; defaults: Record<string, unknown> };

export function workloadPresets(value: unknown): Record<string, WorkloadPreset> {
  return Object.fromEntries(Object.entries(expectRecord(value, "profile.workloads")).map(([type, raw]) => {
    const preset = expectRecord(raw, type);
    rejectUnknown(preset, ["scenario", "fields", "defaults"], "workloads." + type);
    const fields = Object.fromEntries(Object.entries(expectRecord(preset.fields ?? {}, "fields")).map(([key, dest]) => {
      const path = expectNonEmptyString(dest, key);
      if (!path.split(".").every(part => /^[a-z][a-zA-Z0-9]*$/u.test(part) && !["prototype","constructor"].includes(part))) throw new TypeError("Invalid workload mapping " + path);
      return [key, path];
    }));
    return [type, { scenario: expectNonEmptyString(preset.scenario, "scenario"), fields, defaults: expectRecord(preset.defaults ?? {}, "defaults") }];
  }));
}

export function expandWorkload(benchmark: BenchmarkSelection, chain: ConfigProfile[]): BenchmarkSelection {
  const { workload, collect, concurrency, ...selection } = benchmark;
  if (workload === undefined && collect === undefined && concurrency === undefined) return selection;
  const type = expectNonEmptyString(workload?.type, "benchmark.workload.type");
  const preset = chain.flatMap(p => p.workloads?.[type] ? [p.workloads[type]] : []).at(-1);
  if (!preset || !workload) throw new TypeError("Unknown benchmark.workload.type " + type + " for " + benchmark.name);
  if (selection.scenario !== undefined && selection.scenario !== preset.scenario) throw new TypeError("benchmark.scenario conflicts with benchmark.workload.type");
  rejectUnknown(workload, ["type", ...Object.keys(preset.fields)], "benchmark.workload");
  const config = structuredClone(selection.config ?? {});
  function set(path: string, value: unknown, source: string) {
    const keys = path.split(".");
    let parent = config;
    for (const key of keys.slice(0, -1)) {
      parent[key] ??= {};
      parent = expectRecord(parent[key], "benchmark.config." + key);
    }
    const key = keys.at(-1)!;
    if (Object.hasOwn(parent, key) && !isDeepStrictEqual(parent[key], value)) {
      const previous = parent[key];
      const compatible = ["datasets", "backend", "multimodalGeneration.imageScenario", "dataCount"].includes(path) &&
        Array.isArray(previous) && previous.length > 0 && previous.every(item => isDeepStrictEqual(item, value)) &&
        (previous.length === 1 || path === "dataCount");
      if (!compatible) throw new TypeError(source + " conflicts with benchmark.config." + path);
    }
    parent[key] = value;
  }
  if (type === "native" && !workload.file && !Array.isArray(workload.args)) throw new TypeError("benchmark.workload native requires args or file");
  for (const [key, value] of Object.entries(preset.defaults)) set(key, value, "benchmark.workload.type");
  for (const [key, dest] of Object.entries(preset.fields)) if (workload[key] !== undefined) set(dest, workload[key], "benchmark.workload." + key);
  if (concurrency !== undefined) {
    if (!Array.isArray(concurrency) || !concurrency.length || new Set(concurrency).size !== concurrency.length) throw new TypeError("benchmark.concurrency must list distinct positive integers");
    concurrency.forEach(n => expectPositiveInteger(n, "benchmark.concurrency"));
    set("concurrency", concurrency, "benchmark.concurrency");
  }
  if (type !== "native" && concurrency === undefined && !["prepare","validate"].includes(String(config.multimodalAction))) config.concurrency ??= [1];
  if (type === "native" && concurrency === undefined) {
    if (config.concurrency !== undefined) throw new TypeError("Native concurrency conflicts with benchmark.config.concurrency; move it to benchmark.concurrency");
    set("nativeConcurrency", true, "benchmark.workload.type");
  }
  if (["prepare", "validate"].includes(String(config.multimodalAction))) {
    if (collect !== undefined || concurrency !== undefined) throw new TypeError("Data-only workloads cannot specify benchmark.collect or benchmark.concurrency");
  } else {
    const mode = collect ?? config.measurementMode ?? "performance";
    if (typeof mode !== "string" || !["performance", "profiling", "all"].includes(mode)) throw new TypeError("benchmark.collect must be performance, profiling or all");
    set("measurementMode", mode, "benchmark.collect");
    if (mode === "performance" && config.profiling !== undefined) throw new TypeError("benchmark.collect: performance conflicts with benchmark.config.profiling");
  }
  return { ...selection, scenario: preset.scenario, config };
}
