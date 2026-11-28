import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { parse } from "yaml";
import { expectNonEmptyString, expectRecord, rejectUnknown } from "../core/validation/input.js";

type Row = Record<string, unknown>;
function record(value: unknown, path: string): Row { return expectRecord(value ?? {}, path); }

/** Resolve a target before validating services. Saved execution configs carry the resolved values. */
export async function bindInferenceTarget(source: Row, file: string, env: Record<string, string | undefined>) {
  if (source.target === undefined) return { source };
  const name = expectNonEmptyString(source.target, "target");
  const path = resolve(dirname(file), env.EVALUATOR_TARGETS ?? "targets.yaml");
  const registry = expectRecord(parse(await readFile(path, "utf8"), { maxAliasCount: 100 }), "targets file");
  const targets = expectRecord(registry.targets, "targets");
  if (!Object.hasOwn(targets, name)) throw new TypeError("Unknown inference target " + name + " in " + path);
  const target = expectRecord(targets[name], "targets." + name);
  rejectUnknown(target, ["services", "hardware", "agentx", "aisbench", "data", "profiling", "serviceNode"], "targets." + name);
  const raw = typeof source.benchmark === "string" ? { name: source.benchmark } : expectRecord(source.benchmark, "benchmark");
  const workload = record(raw.workload, "benchmark.workload");
  const tool = expectNonEmptyString(raw.name, "benchmark.name");
  if (!["agentx","aisbench","aisbench-native"].includes(tool)) throw new TypeError("target requires an inference benchmark");
  const solver = typeof raw.solver === "string" ? { name: raw.solver } : record(raw.solver, "benchmark.solver");
  const machine = record(target[tool === "aisbench-native" ? "aisbench" : tool], "target load generator");
  const explicit = record(solver.config, "benchmark.solver.config");
  const solverOptions = { ...machine, ...explicit };
  if (machine.remote && explicit.remote) {
    const remote = record(machine.remote, "target.aisbench.remote"), overrides = record(explicit.remote, "benchmark.solver.config.remote");
    solverOptions.remote = { ...remote, ...overrides, ...(remote.ssh && overrides.ssh ? {
      ssh: { ...record(remote.ssh, "target SSH"), ...record(overrides.ssh, "benchmark SSH") },
    } : {}) };
  }
  const config = { ...record(raw.config, "benchmark.config") };
  const data = record(target.data, "target.data");
  if (workload.type === "synthetic-multimodal" && workload.manifest === undefined) {
    config.multimodalGeneration = { ...data, ...record(config.multimodalGeneration, "multimodalGeneration") };
    if (workload.action === "prepare") {
      const generation = expectRecord(config.multimodalGeneration, "generation");
      generation.outputDirectory ??= data.outputDirectory ?? ".evaluator-prepared";
    }
  }
  if (!["prepare", "validate"].includes(String(workload.action)) && raw.workload && (raw.collect === undefined || raw.collect === "performance") && record(target.profiling, "target.profiling").provider === "sglang")
    config.engineMetrics ??= ["sglang:token_usage", "sglang:num_running_reqs", "sglang:num_queue_reqs"];
  if (raw.collect === "profiling" || raw.collect === "all") {
    config.profiling = { ...(target.serviceNode ? { serviceNode: target.serviceNode } : {}), ...record(target.profiling, "target.profiling"), ...record(config.profiling, "benchmark.config.profiling") };
  }
  const { target: _target, ...rest } = source;
  const result = { ...(target.hardware ? { hardware: target.hardware } : {}), ...rest,
    services: { ...record(target.services, "target.services"), ...record(source.services, "services") },
    benchmark: { ...raw, config, solver: { ...solver, config: solverOptions } } };
  return { source: result, name, path };
}
