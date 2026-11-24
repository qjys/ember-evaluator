import { join } from "node:path";
import { expectNonEmptyString, expectPositiveInteger, expectRecord, rejectUnknown } from "../../../core/validation/input.js";

export const northStarLengths = [128, 512, 1024, 5120, 10240] as const;
export type Workload = { beamWidth: number; decodeSteps: number; concurrency: number; requests: number; warmup: number };
export type CollectionRoute = { type: "performance" | "profiling"; service: string; lengths?: number[] };
export type RecommendationConfig = Workload & {
  scenario: "north-star" | "custom";
  tag: "base" | "fast";
  generator?: { seed: number; samplesPerLength: number };
  inputs: { length: number; file: string }[];
  prefix1File: string;
  prefix2File: string;
  collections?: CollectionRoute[];
  comparison?: { session: string; machine: string; devices: string; modelRevision: string; tokenizerRevision: string };
};

export function parseRecommendationConfig(value: unknown): RecommendationConfig {
  const v = expectRecord(value, "recommendation");
  rejectUnknown(v, ["scenario", "tag", "dataMode", "generator", "promptDir", "inputs", "prefix1File", "prefix2File", "beamWidth", "decodeSteps", "concurrency", "requests", "warmup", "comparison", "collections"], "recommendation");
  const scenario = v.scenario ?? "north-star";
  const tag = v.tag ?? "base";
  if (scenario !== "north-star" && scenario !== "custom") throw new TypeError("Unknown recommendation scenario");
  if (tag !== "base" && tag !== "fast") throw new TypeError("recommendation.tag must be base or fast");
  const workload = {
    beamWidth: expectPositiveInteger(v.beamWidth ?? 128, "beamWidth"),
    decodeSteps: expectPositiveInteger(v.decodeSteps ?? 3, "decodeSteps"),
    concurrency: expectPositiveInteger(v.concurrency ?? 1, "concurrency"),
    requests: expectPositiveInteger(v.requests ?? 8, "requests"),
    warmup: v.warmup === 0 ? 0 : expectPositiveInteger(v.warmup ?? 2, "warmup"),
  };
  if (workload.decodeSteps > 3) throw new TypeError("Two prefix catalogs support one to three SID components");
  let inputs: RecommendationConfig["inputs"];
  let generator: RecommendationConfig["generator"];
  if (scenario === "north-star") {
    if (workload.beamWidth !== 128 || workload.decodeSteps !== 3 || workload.concurrency !== 1 ||
      workload.requests !== 8 || workload.warmup !== 2) throw new TypeError("Use scenario custom to change north-star inputs or workload");
  }
  const mode = v.dataMode ?? "files";
  if (mode !== "files" && mode !== "generated") throw new TypeError("dataMode must be files or generated");
  if (mode === "files" && v.generator !== undefined) throw new TypeError("generator requires dataMode: generated");
  if (mode === "generated") {
    if (v.inputs !== undefined || v.promptDir !== undefined) throw new TypeError("generated data cannot also specify inputs or promptDir");
    const g = expectRecord(v.generator ?? {}, "generator");
    rejectUnknown(g, ["seed", "lengths", "samplesPerLength"], "generator");
    const seed = g.seed ?? 42;
    if (typeof seed !== "number" || !Number.isSafeInteger(seed)) throw new TypeError("generator.seed must be a safe integer");
    const lengths = g.lengths ?? (scenario === "north-star" ? northStarLengths : undefined);
    if (!Array.isArray(lengths) || !lengths.length) throw new TypeError("generator.lengths requires a non-empty array");
    const targets = lengths.map(n => expectPositiveInteger(n, "generator.lengths[]"));
    if (new Set(targets).size !== targets.length) throw new TypeError("Duplicate generator length");
    const samplesPerLength = expectPositiveInteger(g.samplesPerLength ?? 4, "generator.samplesPerLength");
    if (scenario === "north-star" && (samplesPerLength !== 4 || targets.join(",") !== northStarLengths.join(",")))
      throw new TypeError("north-star requires its five lengths in order and four prompts per length; use custom");
    generator = { seed, samplesPerLength };
    inputs = targets.map(length => ({ length, file: `prompts_${length}_batch_${samplesPerLength}.json` }));
  } else if (scenario === "north-star") {
    if (v.inputs !== undefined) throw new TypeError("north-star uses promptDir; use custom for individual inputs");
    const dir = expectNonEmptyString(v.promptDir, "promptDir");
    inputs = northStarLengths.map(length => ({ length, file: join(dir, `prompts_${length}_batch_4.json`) }));
  } else {
    if (v.promptDir !== undefined || !Array.isArray(v.inputs) || !v.inputs.length) throw new TypeError("custom requires an inputs array of length/file pairs");
    inputs = v.inputs.map(entry => {
      const item = expectRecord(entry, "inputs[]");
      rejectUnknown(item, ["length", "file"], "inputs[]");
      return { length: expectPositiveInteger(item.length, "inputs[].length"), file: expectNonEmptyString(item.file, "inputs[].file") };
    });
    if (new Set(inputs.map(input => input.length)).size !== inputs.length) throw new TypeError("Duplicate recommendation length");
  }
  let collections: CollectionRoute[] | undefined;
  if (v.collections !== undefined) {
    if (!Array.isArray(v.collections) || !v.collections.length) throw new TypeError("collections requires at least one entry");
    collections = v.collections.map(entry => {
      const item = expectRecord(entry, "collections[]");
      rejectUnknown(item, ["type", "service", "lengths"], "collections[]");
      if (item.type !== "performance" && item.type !== "profiling") throw new TypeError("Unknown recommendation collection");
      const service = expectNonEmptyString(item.service, "collections[].service");
      if (item.lengths === undefined) return { type: item.type, service };
      if (item.type !== "profiling" || !Array.isArray(item.lengths) || !item.lengths.length) throw new TypeError("Only profiling accepts a nonempty lengths list");
      const lengths = item.lengths.map(value => expectPositiveInteger(value, "profiling length"));
      if (new Set(lengths).size !== lengths.length || lengths.some(n => !inputs.some(i => i.length === n))) throw new TypeError("Unknown or duplicate profiling length");
      return { type: item.type, service, lengths };
    });
    if (new Set(collections.map(c => c.type)).size !== collections.length) throw new TypeError("Duplicate collection type");
    collections.sort((a, b) => a.type.localeCompare(b.type));
  }
  let comparison: RecommendationConfig["comparison"];
  if (v.comparison !== undefined) {
    const identity = expectRecord(v.comparison, "comparison");
    rejectUnknown(identity, ["session", "machine", "devices", "modelRevision", "tokenizerRevision"], "comparison");
    comparison = { session: expectNonEmptyString(identity.session, "comparison.session"), machine: expectNonEmptyString(identity.machine, "comparison.machine"),
      devices: expectNonEmptyString(identity.devices, "comparison.devices"), modelRevision: expectNonEmptyString(identity.modelRevision, "comparison.modelRevision"),
      tokenizerRevision: expectNonEmptyString(identity.tokenizerRevision, "comparison.tokenizerRevision") };
  }
  return { scenario, tag, inputs, ...(generator && { generator }), ...(collections && { collections }), ...workload, ...(comparison && { comparison }), prefix1File: expectNonEmptyString(v.prefix1File, "prefix1File"),
    prefix2File: expectNonEmptyString(v.prefix2File, "prefix2File") };
}
