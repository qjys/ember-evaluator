import { glob, readFile } from "node:fs/promises";
import { dirname, join, posix } from "node:path";
import type { AttemptRecord, JsonValue, Metrics, Reporter, ResultSnapshot } from "arsi-evaluator";
import { parseCsv } from "./ssh/csv.js";
import { pointStatus, recordsByTask } from "./metrics.js";
import { expectRecord } from "./validation.js";
import { escaped } from "./reporter.js";
import { aisbenchMeasurementFiles } from "./measurement-files.js";
import { measurementDirectory } from "arsi-evaluator";
import type { NativeConfig } from "./native-config.js";

type Group = { model: string; dataset: string; concurrency: number | null; status: string; file: string | null;
  totals: Record<string, JsonValue>; statistics: Record<string, string>[] };

async function jsonObjectFile(path: string): Promise<Record<string, JsonValue> | null> {
  const text = await readFile(path, "utf8");
  try {
    const value: JsonValue = JSON.parse(text);
    return value !== null && typeof value === "object" && !Array.isArray(value) ? value : null;
  } catch (error) {
    if (error instanceof SyntaxError) return null;
    throw error;
  }
}

export async function readServiceCollections(root: string, config: NativeConfig) {
  const data = await jsonObjectFile(join(root, "collections.json"));
  if (!Array.isArray(data?.points) || !data.points.length) throw new TypeError("Missing AISBench service collection points");
  for (const raw of data.points) {
    const point = expectRecord(raw, "AISBench service point");
    if (typeof point.dataset !== "string" || typeof point.concurrency !== "number" ||
        !(config.concurrency ?? [1]).includes(point.concurrency) || !["partial", "measured"].includes(String(point.performanceStatus)))
      throw new TypeError("Invalid AISBench service point");
    if (config.engineMetrics) {
      const engine = expectRecord(point.engine, "engine metrics");
      if (!Array.isArray(engine.series) || !["measured", "partial"].includes(String(engine.status))) throw new TypeError("Invalid engine metrics");
    }
    if (config.profiling) {
      const profile = expectRecord(point.profiling, "profiling");
      if (!["measured", "host-only", "failed", "skipped"].includes(String(profile.status)) ||
          (profile.status === "measured" && (!Array.isArray(profile.exports) || !profile.exports.length ||
            !profile.exports.every(row => expectRecord(row, "Ascend export").deviceEvidence === true))))
        throw new TypeError("Invalid AISBench profiling evidence");
    }
  }
  return data.points;
}

function count(totals: Record<string, JsonValue>, field: string) {
  const stages = totals[field];
  if (!stages || typeof stages !== "object" || Array.isArray(stages)) return null;
  const match = /^(\d+)(?:\.0+)?(?:\s+\S.*)?$/u.exec(String(stages.total ?? ""));
  return match ? Number(match[1]) : null;
}

export async function readNativeGroups(root: string, concurrency?: number[], expectedRequests?: number | number[]): Promise<Group[]> {
  const groups = new Map<string, Group>();
  for await (const file of glob(["outputs/**/combos_manifest.json", "outputs/**/evaluator-expected.json"], { cwd: root })) {
    const manifest = await jsonObjectFile(join(root, file));
    if (!Array.isArray(manifest?.combos)) throw new TypeError(`Cannot read native group list ${file}; see collected outputs`);
    for (const raw of manifest.combos) {
      const row = expectRecord(raw, "AISBench combo");
      if (typeof row.model_abbr !== "string" || typeof row.dataset_abbr !== "string") continue;
      const key = posix.join(dirname(file).replaceAll("\\", "/"), "performances", row.model_abbr, row.dataset_abbr + ".json");
      groups.set(key, { model: row.model_abbr, dataset: row.dataset_abbr, concurrency: typeof row.batch_size === "number" ? row.batch_size : null,
        status: "missing", file: null, totals: {}, statistics: [] });
    }
  }
  for await (const path of glob("outputs/**/performances/*/*.json", { cwd: root })) {
    const file = path.replaceAll("\\", "/");
    const totals = await jsonObjectFile(join(root, path));
    if (!totals || (!Object.hasOwn(totals, "Total Requests") && !Object.hasOwn(totals, "Success Requests"))) continue;
    const success = count(totals, "Success Requests"), failed = count(totals, "Failed Requests");
    const total = count(totals, "Total Requests");
    const batch = groups.get(file)?.concurrency ?? (concurrency?.length === 1 ? concurrency[0] ?? null : null);
    const expected = Array.isArray(expectedRequests)
      ? (expectedRequests.length === 1 ? expectedRequests[0] : expectedRequests[concurrency?.indexOf(batch ?? -1) ?? -1])
      : expectedRequests;
    let status = success === null || failed === null ? "unverified" :
      success > 0 && failed === 0 && (total === null || success === total) &&
        (expectedRequests === undefined || success === expected) ? "measured" : "partial";
    let statistics: Record<string, string>[] = [];
    try { statistics = parseCsv(await readFile(join(root, path.slice(0, -5) + ".csv"), "utf8")); }
    catch (error) {
      if (error instanceof TypeError) status = "unverified";
      else if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
    groups.set(file, { model: posix.basename(posix.dirname(file)), dataset: posix.basename(file, ".json"),
      concurrency: batch,
      status, file, totals, statistics });
  }
  return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, group]) => group);
}

function phaseResults(record: AttemptRecord | undefined, taskId: string, digest: unknown) {
  if (!record) return;
  const steps = record.steps ?? [{ name: "", solve: record.solve, verdict: record.verdict, errors: record.errors }];
  const groups: JsonValue[] = [], collections: JsonValue[] = [];
  let managed = false, formal = false;
  for (const step of steps) {
    const raw = step.solve?.observations;
    const data = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : undefined;
    const phase = step.name || data?.phase;
    if (phase !== "profiling" && phase !== "performance") continue;
    managed = true;
    if (phase === "performance") formal = true;
    if (!data || !step.verdict || step.errors.length) {
      if (phase === "profiling") collections.push({ dataset: "diagnostic", profiling: { status: "failed", error: step.errors.map(e => e.message).join(", ") || "Incomplete diagnostic" } });
      continue;
    }
    if (data.phase !== phase || data.kind !== "aisbench-native" || data.taskId !== taskId || data.bundleDigest !== digest || !Array.isArray(data.groups))
      throw new TypeError("Invalid AISBench phase evidence");
    if (phase === "performance") groups.push(...data.groups);
    if (Array.isArray(data.collections)) collections.push(...data.collections);
  }
  if (!managed) return;
  const success = (!formal || groups.length > 0) && groups.every(g => expectRecord(g, "group").status === "measured") &&
    collections.every(c => { const p = expectRecord(c, "collection"); return [p.engine, p.profiling].every(s => s === undefined || expectRecord(s, "section").status === "measured"); });
  const state = pointStatus(record);
  if (record.steps && !record.steps.some(s => s.name === "profiling"))
    collections.push({ dataset: "diagnostic", profiling: { status: "skipped", error: "Formal measurement did not complete" } });
  return { taskId, status: state === "completed" && (groups.length || collections.length) && success ? "measured"
    : groups.length || collections.length ? "partial" : state, groups, collections, managed: true };
}

export class NativePerformanceMetrics implements Metrics {
  readonly measurementFiles = aisbenchMeasurementFiles;
  readonly name = "aisbench-native-performance";
  async compute(snapshot: ResultSnapshot) {
    if (snapshot.run.evaluationKind !== "performance" || snapshot.run.source?.source !== "aisbench:native") return { applicable: false, points: [] };
    const records = recordsByTask(snapshot);
    const digest = expectRecord(snapshot.run.source.metadata, "AISBench source").bundleDigest;
    const points = snapshot.run.taskIds.map((taskId): { taskId: string; status: string; groups: JsonValue[]; collections?: JsonValue[]; manifestPath?: string; managed?: boolean } => {
      const record = records.get(taskId);
      const status = pointStatus(record);
      const phases = phaseResults(record, taskId, digest);
      if (phases) return phases;
      if (status !== "completed") return { taskId, status, groups: [] };
      const evidence = expectRecord(record?.solve?.observations, "native AISBench evidence");
      if (evidence.kind !== "aisbench-native" || evidence.schemaVersion !== 1 || evidence.bundleDigest !== digest ||
          evidence.taskId !== taskId || !Array.isArray(evidence.groups)) throw new TypeError("Invalid native AISBench evidence");
      const groups: JsonValue[] = evidence.groups;
      if (evidence.datasetOperation) {
        const op = expectRecord(evidence.datasetOperation, "multimodal operation");
        if ((op.action !== "prepare" && op.action !== "validate") || typeof op.manifestPath !== "string" || groups.length)
          throw new TypeError("Invalid AISBench multimodal operation evidence");
        return { taskId, status: op.action === "prepare" ? "prepared" : "validated", manifestPath: op.manifestPath, groups };
      }
      const collections = evidence.collections;
      if (collections !== undefined && !Array.isArray(collections)) throw new TypeError("Invalid AISBench service collections");
      const complete = groups.length > 0 && groups.every(group => expectRecord(group, "AISBench group").status === "measured") &&
        (collections === undefined || collections.every(item => {
          const p = expectRecord(item, "AISBench service point");
          return p.performanceStatus === "measured" && [p.engine, p.profiling].every(part =>
            part === undefined || expectRecord(part, "AISBench collection").status === "measured");
        }));
      return { taskId, status: !groups.length ? "unrecognized" : complete ? "measured" : "partial", groups,
        ...(collections ? { collections } : {}) };
    });
    return { applicable: true, points };
  }
}

export class NativeMarkdownReporter implements Reporter {
  async render(snapshot: ResultSnapshot) {
    const { points } = await new NativePerformanceMetrics().compute(snapshot);
    const lines = ["# AISBench 原生性能报告", "", `Run ${escaped(snapshot.run.runId)} · ${escaped(snapshot.run.status)}`, ""];
    if (snapshot.run.resultLayout) lines.push("[分类指标](metrics/index.json)", "");
    for (const point of points) {
      const root = snapshot.run.resultLayout ? measurementDirectory(snapshot.run.resultLayout.points[point.taskId]) + "/" : "";
      lines.push(`## ${escaped(point.taskId)} · ${escaped(point.status)}`, "");
      if (point.manifestPath) lines.push(`远端多模态数据清单 ${escaped(point.manifestPath)}`, "");
      else if (!point.groups.length && !point.collections?.some(c => expectRecord(c, "collection").profiling)) lines.push("未取得可识别的原生性能测量。请查看该测量点的日志和 outputs 目录。", "");
      for (const value of point.groups) {
        const group = expectRecord(value, "native performance group");
        lines.push(`### ${escaped(String(group.model))} / ${escaped(String(group.dataset))}`, "",
          `状态 ${escaped(String(group.status))} · 配置并发 ${escaped(String(group.concurrency ?? "—"))}`, "");
        if (typeof group.file === "string") lines.push(`原生文件 ${escaped((root ? root + "performance/" : "") + group.file)}`, "");
        lines.push("| 原生指标 | 结果 |", "| --- | --- |");
        for (const [key, amounts] of Object.entries(expectRecord(group.totals, "native totals")))
          lines.push(`| ${escaped(key)} | ${escaped(JSON.stringify(amounts))} |`);
        lines.push("");
        if (Array.isArray(group.statistics) && group.statistics.length) {
          const headers = Object.keys(expectRecord(group.statistics[0], "native statistics"));
          lines.push("| " + headers.map(escaped).join(" | ") + " |", "| " + headers.map(() => "---").join(" | ") + " |");
          for (const row of group.statistics) {
            const fields = expectRecord(row, "native statistics");
            lines.push("| " + headers.map(key => escaped(String(fields[key] ?? ""))).join(" | ") + " |");
          }
          lines.push("");
        }
      }
      for (const item of ("collections" in point ? point.collections : undefined) ?? []) {
        const p = expectRecord(item, "AISBench service point");
        const title = point.managed ? (p.profiling ? "诊断轮" : "正式轮") : "服务端采集";
        lines.push(`### ${title} · ${escaped(String(p.dataset ?? "—"))} · 并发 ${escaped(String(p.concurrency ?? "—"))}`, "");
        if (p.error) lines.push(escaped(String(p.error)), "");
        if (p.engine) {
          const engine = expectRecord(p.engine, "engine metrics");
          const window = expectRecord(engine.window ?? {}, "engine window");
          lines.push(`推理引擎指标 · ${escaped(String(engine.status))}`, "",
            "| 服务端指标 | 压测前 | 窗口均值 | 窗口峰值 | 压测后 | 计数器增量 |", "| --- | ---: | ---: | ---: | ---: | ---: |");
          for (const raw of Array.isArray(engine.series) ? engine.series : []) {
            const row = expectRecord(raw, "engine metric");
            const samples = expectRecord(window[String(row.series)] ?? {}, "engine samples");
            lines.push("| " + [row.series, row.before, samples.mean, samples.peak, row.after, row.delta].map(v => escaped(String(v ?? "—"))).join(" | ") + " |");
          }
          lines.push("");
          if (Array.isArray(engine.missing) && engine.missing.length) lines.push("缺少指标 " + escaped(engine.missing.join(", ")), "");
          if (Array.isArray(engine.errors)) for (const error of engine.errors) lines.push(escaped(String(error)), "");
        }
        if (p.profiling) {
          const profile = expectRecord(p.profiling, "profiling");
          lines.push(`Ascend profiling · ${escaped(String(profile.status))}`, "");
          if (profile.error) lines.push(escaped(String(profile.error)), "");
          if (profile.categories) {
            lines.push("| 诊断指标 | 采集状态 | 数据来源或缺失原因 |", "| --- | --- | --- |");
            for (const [name, raw] of Object.entries(expectRecord(profile.categories, "profiling categories"))) {
              const category = expectRecord(raw, "profiling category");
              lines.push("| " + [name, category.status, category.reason ?? category.source].map(v => escaped(String(v ?? "—"))).join(" | ") + " |");
            }
            lines.push("");
          }
          if (profile.traceDirectory) lines.push("服务端 trace 目录 " + escaped(String(profile.traceDirectory)), "");
          for (const raw of Array.isArray(profile.exports) ? profile.exports : []) {
            const rank = expectRecord(raw, "Ascend export");
            lines.push("导出文件 " + escaped(root + (point.managed ? "profiling/" : "") + String(rank.artifactDirectory)), "",
              "| 设备证据 | 算子设备耗时 (µs) | 算子 Host 耗时 (µs) | Kernel 数 | Kernel 执行 (µs) | Kernel 等待 (µs) |",
              "| --- | ---: | ---: | ---: | ---: | ---: |",
              "| " + [rank.deviceEvidence, rank.operatorDeviceUs, rank.operatorHostUs, rank.kernelCount, rank.kernelDurationUs,
                rank.kernelWaitUs].map(v => escaped(String(v ?? "—"))).join(" | ") + " |", "");
          }
        }
      }
    }
    return lines.join("\n");
  }
}
