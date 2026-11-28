import { dirname, resolve } from "node:path";
import { loadConfig } from "./config.js";
import { openPluginRegistry } from "./plugins/open-registry.js";
import { createBenchmark } from "./plugins/create-components.js";
import { redactDiagnostic } from "../core/errors/diagnostics.js";
import { exportConfig } from "../config/export.js";
import { redactNetwork } from "../config/network-schema.js";
import type { LoadedConfig } from "../config/loaded.js";
import type { CliOverrides } from "../core/contracts/config.js";
import type { ProgressListener } from "../core/progress/progress.js";
import { progressOperation } from "../core/progress/progress-operation.js";
import { enumerateSelectedTasks } from "../core/selection/task-selection.js";
import { diagnose } from "./diagnostics/doctor.js";
import { diagnoseDownloads } from "./diagnostics/downloads.js";

type InspectionOptions = {
  file: string;
  overrides: CliOverrides;
  patchPath?: string;
  networkConfigPath?: string;
  onLoaded?: (config: LoadedConfig) => void;
};

export async function inspectExperiment(options: InspectionOptions) {
  const config = await loadConfig(resolve(options.file), options.overrides, process.env, {
    allowMissingAuth: true, validatePlugins: true,
    ...(options.patchPath === undefined ? {} : { patchPath: options.patchPath }),
    ...(options.networkConfigPath === undefined ? {} : { networkConfigPath: options.networkConfigPath }),
  });
  options.onLoaded?.(config);
  if (!config.network) throw new Error("Loaded configuration has no network settings");
  const origins = config.resolution?.origins ?? {};
  const benchmark = config.experiment.benchmark;
  const settings = benchmark.config;
  const native = origins["benchmark.workload.type"] === "native";
  const secrets = Object.values(config.auths).map(auth => auth.value);
  const argumentsFromYaml = [...(settings.configFile ? [String(settings.configFile)] : []), ...(Array.isArray(settings.nativeArgs) ? settings.nativeArgs : [])].map(s => redactDiagnostic(String(s), secrets));
  const batches = settings.nativeConcurrency ? [null] : Array.isArray(settings.concurrency) ? settings.concurrency : [null];
  const invocation = native ? {
    executable: benchmark.name === "agentx" ? "agentx profile" : "ais_bench",
    arguments: argumentsFromYaml,
    actualCommandArtifact: benchmark.name === "agentx" ? "native-command.json" : "native-plan.json",
    plannedCommands: batches.map(batch => {
      const agentx = benchmark.name === "agentx";
      const model = config.experiment.services[config.experiment.solver.service]!;
      const service = model.endpoint ? new URL(model.endpoint) : undefined;
      const path = service?.pathname.replace(/\/+$/u, "") || "/v1";
      const base = service ? service.origin + (path.replace(/\/v1(?:\/chat\/completions)?$/u, "") || "") + "/" : "<service-url>";
      const tokenizer = config.experiment.solver.config[agentx ? "tokenizer" : "tokenizerPath"];
      const point = batch === null ? "configured" : "c" + batch;
      if (agentx) {
        const pointArgs = batch === null || argumentsFromYaml.some(a => a.split("=")[0] === "--concurrency") ? [] : ["--concurrency", String(batch)];
        return { point, argv: ["agentx", "profile", "--scenario", "agentx", "--url", service?.origin ?? "<service-url>",
          "--endpoint", path.endsWith("/chat/completions") ? path : path + "/chat/completions", "--model", model.name,
          "--tokenizer", tokenizer ?? "<resolved-tokenizer>", "--output-artifact-dir", "<phase-artifacts>",
          "<harness-defaults>", ...argumentsFromYaml, ...pointArgs, "<telemetry-options>"] };
      }
      const binding = settings.configFile ? [] : ["--model-name=" + model.name, "--url=" + base,
        "--host-ip=" + (service?.hostname ?? "<host>"), "--host-port=" + (service?.port || (service?.protocol === "https:" ? "443" : "80")),
        "--api-key=[redacted]"];
      const raw = settings.configFile ? ["<uploaded-config>/" + argumentsFromYaml[0], ...argumentsFromYaml.slice(1)] : argumentsFromYaml;
      return { point, argv: ["ais_bench", ...binding, ...raw, "--mode", "perf", "--work-dir", "<remote-job>/outputs",
        ...(tokenizer ? ["--path", tokenizer] : []), ...(batch === null ? [] : ["--batch-size=" + batch])] };
    }),
    service: config.experiment.solver.service, concurrency: settings.nativeConcurrency ? "configured" : settings.concurrency,
    managed: benchmark.name === "agentx" ? ["service", "credentials", "output directory", "scenario"] : ["service binding", "credentials", "--mode perf", "--work-dir"],
    sources: Object.fromEntries(Object.entries(origins).filter(([key]) => key === "target" || ["benchmark.config.nativeArgs","benchmark.config.configFile","benchmark.config.measurementMode","benchmark.config.concurrency"].includes(key))),
  } : undefined;
  return {
    document: { ...(invocation ? { invocation } : {}), experiment: exportConfig(config), network: {
      configPath: config.network.origin, digest: config.network.digest, settings: redactNetwork(config.network.settings),
    } },
    runtimeCredentials: JSON.stringify(config.persisted).includes("[runtime-provided]"),
  };
}

export async function diagnoseExperiment(options: InspectionOptions & { env?: NodeJS.ProcessEnv }, signal: AbortSignal, log: (text: string) => void) {
  const registry = await openPluginRegistry(options.patchPath);
  try {
    const config = await loadConfig(resolve(options.file), options.overrides, options.env ?? process.env, { registry,
      ...(options.networkConfigPath === undefined ? {} : { networkConfigPath: options.networkConfigPath }) });
    options.onLoaded?.(config);
    signal.throwIfAborted();
    await createBenchmark(registry, config, dirname(resolve(options.file)));
    const checks = await diagnose(config, options.file, signal);
    const network = await diagnoseDownloads({ config, configPath: options.file,
      ...(options.patchPath === undefined ? {} : { patchPath: options.patchPath }) }, signal, log);
    return { checks, network };
  } finally { await registry.dispose(); }
}

export async function previewExperiment(options: InspectionOptions & {
  taskIds?: readonly string[];
  onProgress: ProgressListener;
  onDiagnostic: (phase: string, error: unknown) => void;
}, signal: AbortSignal): Promise<{ taskIds: string[] | null; exitCode: number }> {
  const { onProgress: progress } = options;
  let registry: Awaited<ReturnType<typeof openPluginRegistry>> | undefined;
  let phase = "config";
  let exitCode = 0;
  let taskIds: string[] | null = null;
  try {
    progress({ phase, message: `Loading and validating ${resolve(options.file)}` });
    registry = await openPluginRegistry(options.patchPath);
    const config = await loadConfig(resolve(options.file), options.overrides, process.env, {
      registry, allowMissingAuth: true,
      ...(options.networkConfigPath === undefined ? {} : { networkConfigPath: options.networkConfigPath }),
    });
    if (options.taskIds !== undefined) {
      const run = { ...config.experiment.run };
      delete run.sampling;
      delete run.offset;
      config.experiment.run = { ...run, maxTasks: null, taskIds: [...options.taskIds] };
    }
    options.onLoaded?.(config);
    phase = "bootstrap";
    progress({ phase, message: `Initializing benchmark plugin: ${config.experiment.benchmark.name}` });
    const benchmark = await createBenchmark(registry, config, dirname(resolve(options.file)));
    phase = "source";
    const source = await progressOperation(progress, { phase, message: `Preparing dataset ${config.experiment.benchmark.name} (checking the cache and downloading as needed)` }, signal,
      activity => benchmark.resolveSource(null, signal, activity));
    phase = "enumerate";
    const { selected } = await progressOperation(progress, { phase, message: `Reading tasks from ${source.source} revision=${source.revision}` }, signal,
      activity => enumerateSelectedTasks(benchmark, source, config.experiment.run, signal, activity));
    signal.throwIfAborted();
    taskIds = selected.map(ref => ref.id);
  } catch (error) {
    options.onDiagnostic(phase, error);
    exitCode = signal.aborted ? 130 : 2;
  } finally {
    try {
      progress({ phase: "dispose", message: "Releasing benchmark resources" });
    } finally {
      try { await registry?.dispose(); }
      catch (error) { options.onDiagnostic("dispose", error); if (exitCode !== 130) exitCode = 1; }
    }
  }
  return { taskIds, exitCode };
}
