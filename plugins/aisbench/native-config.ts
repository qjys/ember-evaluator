import { posix } from "node:path";
import type { JsonValue } from "arsi-evaluator";
import { expectNonEmptyString, expectPositiveInteger, expectRecord, rejectUnknown } from "./validation.js";

import { nativeArguments, aisbenchManagedArgs, parseServiceProfile, type ServiceProfileConfig } from "arsi-evaluator";
import { parseWorkload, type AisbenchWorkload } from "./config.js";

type Dataset = { name: string; abbr?: string; config?: Record<string, JsonValue> };
type ImageScenario = "single_1080p" | "multi_720p_5";
type MultimodalGeneration = {
  imageScenario: ImageScenario[];
  textTokens: number;
  outputTokens?: number;
  mmmuParquetDir: string;
  corpusPath?: string;
  outputDirectory?: string;
};
export type NativeConfig = {
  nativeArgs?: string[]; nativeConcurrency?: boolean;
  syntheticText?: true; syntheticWorkload?: AisbenchWorkload;
  measurementMode?: "performance" | "profiling" | "all";
  serviceProfiler?: ServiceProfileConfig;
  engineMetrics?: string[];
  profiling?: { traceDirectory: string; service?: string; requestsPerPoint?: number; exportTimeoutSeconds?: number };
  backend?: string[]; datasets?: Dataset[]; configFile?: string; files?: string[]; remoteConfigFile?: string;
  multimodalGeneration?: MultimodalGeneration;
  multimodalManifest?: string;
  multimodalAction?: "prepare" | "validate" | "run";
  concurrency?: number[]; dataCount?: number[]; requestRate?: number; warmups?: number; maxOutputTokens?: number;
  stream?: boolean; pressureSeconds?: number; speculativeDecoding?: boolean; generationParams?: Record<string, JsonValue>;
  summarizer?: string; options?: Record<string, JsonValue>;
};

export function nativeBatchSize(args: readonly string[]): number | undefined {
  const index = args.findLastIndex(arg => arg === "--batch-size" || arg.startsWith("--batch-size="));
  const token = args[index];
  if (!token) return undefined;
  const separate = token === "--batch-size";
  const value = separate ? args[index + 1] : token.slice("--batch-size=".length);
  const next = args[index + (separate ? 2 : 1)];
  if (!value || !/^[1-9][0-9]*$/u.test(value) || (next && !next.startsWith("-"))) return undefined;
  const size = Number(value);
  return Number.isSafeInteger(size) ? size : undefined;
}

function list(value: unknown, field: string): unknown[] {
  const items = Array.isArray(value) ? value : [value];
  if (!items.length) throw new TypeError(`${field} cannot be empty`);
  return items;
}

function taskName(value: unknown, field: string): string {
  const name = expectNonEmptyString(value, field);
  if (!/^[a-zA-Z0-9_][a-zA-Z0-9_.-]*(?:\/[a-zA-Z0-9_][a-zA-Z0-9_.-]*)?$/u.test(name))
    throw new TypeError(`${field} must be an AISBench task name`);
  return name;
}

function jsonValue(value: unknown, field: string): JsonValue {
  if (value === null || typeof value === "boolean" || typeof value === "string" || (typeof value === "number" && Number.isFinite(value))) return value;
  if (Array.isArray(value)) return value.map(item => jsonValue(item, field));
  return jsonObject(value, field);
}
function jsonObject(value: unknown, field: string): Record<string, JsonValue> {
  return Object.fromEntries(Object.entries(expectRecord(value, field)).map(([key, item]) => {
    if (["__proto__", "constructor", "prototype"].includes(key)) throw new TypeError(`Invalid key in ${field}`);
    return [key, jsonValue(item, field)];
  }));
}

function dataset(value: unknown): Dataset {
  const item = typeof value === "string" ? { name: value } : expectRecord(value, "datasets[]");
  rejectUnknown(item, ["name", "config", "abbr"], "datasets[]");
  return { name: taskName(item.name, "datasets[].name"),
    ...(item.abbr === undefined ? {} : { abbr: expectNonEmptyString(item.abbr, "datasets[].abbr") }),
    ...(item.config === undefined ? {} : { config: jsonObject(item.config, "datasets[].config") }) };
}

function localFile(value: unknown): string {
  const path = expectNonEmptyString(value, "configFile/files").replaceAll("\\", "/");
  if (/[:\x00-\x1f]/u.test(path) || posix.isAbsolute(path) || path.split("/").includes("..") || !path.endsWith(".py"))
    throw new TypeError("configFile/files require relative .py paths below the experiment directory");
  return posix.normalize(path);
}

const owned = new Set(["help", "models", "datasets", "path", "model-name", "mode", "work-dir", "config-dir", "reuse", "dry-run",
  "search", "endpoint", "model", "api-base", "agent-api-key", "api-key", "host-ip", "host-port", "url", "batch-size", "num-prompts", "request-rate", "num-warmups", "max-out-len", "stream", "summarizer"]);

function remotePath(value: unknown, field: string): string {
  const path = expectNonEmptyString(value, field);
  if (!posix.isAbsolute(path) || /[\r\n\0]/u.test(path) || path.split("/").includes(".."))
    throw new TypeError(`${field} must be an absolute remote path`);
  return path;
}

function parseMultimodalGeneration(value: unknown): MultimodalGeneration {
  const v = expectRecord(value, "multimodalGeneration");
  rejectUnknown(v, ["imageScenario", "textTokens", "outputTokens", "mmmuParquetDir", "corpusPath", "outputDirectory"], "multimodalGeneration");
  const imageScenario = list(v.imageScenario === undefined ? "single_1080p" : v.imageScenario, "imageScenario").map(item => {
    if (item !== "single_1080p" && item !== "multi_720p_5")
      throw new TypeError("multimodalGeneration.imageScenario requires single_1080p or multi_720p_5");
    return item;
  });
  if (new Set(imageScenario).size !== imageScenario.length) throw new TypeError("Duplicate imageScenario");
  return { imageScenario, textTokens: expectPositiveInteger(v.textTokens, "multimodalGeneration.textTokens"),
    ...(v.outputTokens === undefined ? {} : { outputTokens: expectPositiveInteger(v.outputTokens, "multimodalGeneration.outputTokens") }),
    mmmuParquetDir: remotePath(v.mmmuParquetDir, "multimodalGeneration.mmmuParquetDir"),
    ...(v.outputDirectory === undefined ? {} : { outputDirectory: v.outputDirectory === ".evaluator-prepared" ? v.outputDirectory : remotePath(v.outputDirectory, "multimodalGeneration.outputDirectory") }),
    ...(v.corpusPath === undefined ? {} : { corpusPath: remotePath(v.corpusPath, "multimodalGeneration.corpusPath") }) };
}

export function parseNativeConfig(value: unknown): NativeConfig {
  const v = expectRecord(value, "aisbench native config");
  rejectUnknown(v, ["backend", "datasets", "configFile", "files", "remoteConfigFile", "concurrency", "dataCount", "requestRate",
    "warmups", "maxOutputTokens", "stream", "pressureSeconds", "speculativeDecoding", "generationParams", "summarizer", "options",
    "multimodalGeneration", "multimodalManifest", "multimodalAction", "profiling", "engineMetrics", "measurementMode", "serviceProfiler", "nativeArgs", "nativeConcurrency", "syntheticText", "syntheticWorkload"], "aisbench native config");
  const result: NativeConfig = {};
  if (v.nativeArgs !== undefined) result.nativeArgs = nativeArguments(v.nativeArgs, aisbenchManagedArgs);
  if (v.nativeConcurrency === true) {
    if (v.concurrency !== undefined) throw new TypeError("Native concurrency conflicts with benchmark.concurrency");
    result.nativeConcurrency = true;
  }
  if (v.syntheticText === true) {
    result.syntheticText = true;
    const workload = expectRecord(v.syntheticWorkload ?? {}, "syntheticWorkload");
    result.syntheticWorkload = parseWorkload({ ...(!workload.prefixCache || !expectRecord(workload.prefixCache, "prefixCache").enabled ? { dataset: "synthetic" } : {}), ...workload });
  }
  if (v.measurementMode !== undefined) {
    if (v.measurementMode !== "performance" && v.measurementMode !== "profiling" && v.measurementMode !== "all") throw new TypeError("Invalid AISBench collect");
    result.measurementMode = v.measurementMode;
    if (v.measurementMode !== "performance") {
      result.serviceProfiler = parseServiceProfile(v.serviceProfiler ?? v.profiling, "vllm");
      if (result.nativeArgs?.some(arg => ["--pressure", "--pressure-time"].includes(arg.split("=")[0]!)))
        throw new TypeError("Native pressure mode cannot guarantee a bounded profiling window");
      if (v.configFile || v.remoteConfigFile) throw new TypeError("Cannot confirm profiler service binding for an opaque native config file; use native --models/--datasets or workload.type: dataset");
      if (result.nativeConcurrency && !nativeBatchSize(result.nativeArgs ?? []))
        throw new TypeError("Specify a single known concurrency for bounded profiling of native args");
    }
  }
  const multimodal = v.multimodalGeneration !== undefined || v.multimodalManifest !== undefined;
  if (multimodal) {
    if (v.datasets !== undefined || v.configFile !== undefined || v.remoteConfigFile !== undefined)
      throw new TypeError("Choose one multimodal source or an existing dataset/config file");
    if (v.multimodalGeneration !== undefined && v.multimodalManifest !== undefined)
      throw new TypeError("Choose multimodalGeneration or multimodalManifest");
    if (v.multimodalGeneration !== undefined) result.multimodalGeneration = parseMultimodalGeneration(v.multimodalGeneration);
    else result.multimodalManifest = remotePath(v.multimodalManifest, "multimodalManifest");
  }
  if (v.multimodalAction !== undefined) {
    const action = v.multimodalAction;
    if (!multimodal || (action !== "prepare" && action !== "validate" && action !== "run"))
      throw new TypeError("multimodalAction requires a multimodal source and prepare, validate or run");
    if (v.multimodalAction === "prepare" && !result.multimodalGeneration?.outputDirectory)
      throw new TypeError("prepare requires multimodalGeneration.outputDirectory");
    if (v.multimodalAction === "validate" && !result.multimodalManifest)
      throw new TypeError("validate requires multimodalManifest");
    result.multimodalAction = action;
  }
  if (v.configFile !== undefined || v.remoteConfigFile !== undefined) {
    if (v.backend !== undefined || v.datasets !== undefined || (v.configFile !== undefined && v.remoteConfigFile !== undefined))
      throw new TypeError("Choose backend/datasets, configFile, or remoteConfigFile");
    if (v.configFile !== undefined) result.configFile = localFile(v.configFile);
    else result.remoteConfigFile = remotePath(v.remoteConfigFile, "remoteConfigFile");
  } else if (!result.nativeArgs && !result.syntheticText) {
    if (v.backend !== undefined || !["prepare", "validate"].includes(result.multimodalAction ?? "run")) {
      const defaultBackend = result.measurementMode ? (v.stream === false ? "vllm_api_general_chat" : "vllm_api_stream_chat")
        : multimodal ? "vllm_api_general_chat" : undefined;
      result.backend = list(v.backend ?? defaultBackend, "backend").map(name => taskName(name, "backend"));
    }
    if (!multimodal) result.datasets = list(v.datasets, "datasets").map(dataset);
  }
  if (v.files !== undefined) {
    if (!result.configFile || !Array.isArray(v.files)) throw new TypeError("files must be a list accompanying configFile");
    result.files = v.files.map(localFile);
    const names = [result.configFile, ...result.files];
    if (new Set(names).size !== names.length) throw new TypeError("Duplicate configFile/files entry");
  }
  for (const field of ["concurrency", "dataCount"] as const) {
    if (v[field] !== undefined) result[field] = list(v[field], field).map(item => expectPositiveInteger(item, field));
  }
  const count = result.concurrency?.length ?? 1;
  if (result.dataCount && result.dataCount.length !== count) {
    if (Array.isArray(v.dataCount)) throw new TypeError("dataCount list length must match concurrency");
    result.dataCount = Array<number>(count).fill(expectPositiveInteger(v.dataCount, "dataCount"));
  }
  for (const field of ["warmups", "requestRate"] as const) {
    const n = v[field];
    if (n === undefined) continue;
    if (typeof n !== "number" || !Number.isFinite(n) || n < 0 || (field === "warmups" && !Number.isSafeInteger(n))) throw new TypeError(`Invalid ${field}`);
    result[field] = n;
  }
  for (const field of ["stream", "speculativeDecoding"] as const) {
    if (v[field] === undefined) continue;
    if (typeof v[field] !== "boolean") throw new TypeError(`${field} must be boolean`);
    result[field] = v[field];
  }
  if (v.pressureSeconds !== undefined) {
    result.pressureSeconds = expectPositiveInteger(v.pressureSeconds, "pressureSeconds");
    if (result.pressureSeconds > 86400) throw new TypeError("pressureSeconds must be at most 86400");
  }
  if (v.maxOutputTokens !== undefined) result.maxOutputTokens = expectPositiveInteger(v.maxOutputTokens, "maxOutputTokens");
  if (result.multimodalGeneration) {
    if (!result.dataCount) throw new TypeError("multimodalGeneration requires a positive dataCount");
    result.maxOutputTokens ??= result.multimodalGeneration.outputTokens ?? 256;
  }
  if (v.summarizer !== undefined) {
    if (!result.backend) throw new TypeError("Set the summarizer in the selected config file");
    result.summarizer = taskName(v.summarizer, "summarizer");
  }
  if (v.generationParams !== undefined) {
    result.generationParams = jsonObject(v.generationParams, "generationParams");
    if (Object.hasOwn(result.generationParams, "stream")) throw new TypeError("Set stream at benchmark.config.stream");
  }
  if (v.options !== undefined) {
    result.options = jsonObject(v.options, "options");
    if (multimodal && result.options["dataset-abbr"] !== undefined)
      expectNonEmptyString(result.options["dataset-abbr"], "options.dataset-abbr");
    for (const [key, item] of Object.entries(result.options)) {
      const canonical = key.replace(/^no-/u, "");
      if (!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u.test(key) || owned.has(canonical) || canonical.startsWith("agentx-") ||
          (v.pressureSeconds !== undefined && ["pressure", "pressure-time"].includes(canonical)) ||
          (v.generationParams !== undefined && canonical === "generation-kwargs") ||
          (v.speculativeDecoding !== undefined && canonical === "spec-decode"))
        throw new TypeError(`options.${key} conflicts with a managed parameter or is invalid`);
      if (key.startsWith("no-") && Object.hasOwn(result.options, canonical)) throw new TypeError(`Conflicting options.${key} and options.${canonical}`);
      if (item === null || (Array.isArray(item) && item.length === 0)) throw new TypeError(`options.${key} requires a value`);
    }
  }
  if ((v.profiling !== undefined && !result.measurementMode) || v.engineMetrics !== undefined) {
    if ((!result.measurementMode && !result.backend) || ["prepare", "validate"].includes(result.multimodalAction ?? "run"))
      throw new TypeError("Service collections require a native backend with datasets or multimodal inputs in run mode");
    if (v.engineMetrics !== undefined) {
      if (!Array.isArray(v.engineMetrics) || !v.engineMetrics.length ||
          !v.engineMetrics.every((m): m is string => typeof m === "string" && /^[a-zA-Z_:][a-zA-Z0-9_:]*$/u.test(m)) ||
          new Set(v.engineMetrics).size !== v.engineMetrics.length)
        throw new TypeError("engineMetrics must list distinct Prometheus metric names");
      result.engineMetrics = v.engineMetrics;
    }
    if (v.profiling !== undefined && !result.measurementMode) {
      const p = expectRecord(v.profiling, "profiling");
      rejectUnknown(p, ["traceDirectory", "service", "requestsPerPoint", "exportTimeoutSeconds"], "profiling");
      result.profiling = { traceDirectory: remotePath(p.traceDirectory, "profiling.traceDirectory"),
        ...(p.service === undefined ? {} : { service: expectNonEmptyString(p.service, "profiling.service") }),
        ...(p.requestsPerPoint === undefined ? {} : { requestsPerPoint: expectPositiveInteger(p.requestsPerPoint, "profiling.requestsPerPoint") }),
        ...(p.exportTimeoutSeconds === undefined ? {} : { exportTimeoutSeconds: expectPositiveInteger(p.exportTimeoutSeconds, "profiling.exportTimeoutSeconds") }) };
      if (result.dataCount?.some(n => n < (result.profiling?.requestsPerPoint ?? 1)))
        throw new TypeError("profiling.requestsPerPoint exceeds dataCount");
    }
  }
  return result;
}
