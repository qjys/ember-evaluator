import type { MetricResults } from "../../core/contracts/metrics.js";
import type { CollectionReportDocument } from "../../core/contracts/reporter.js";
import type { ResultSnapshot } from "../../core/contracts/result.js";
import type { JsonValue } from "../../core/contracts/task.js";
import { expectRecord } from "../../core/validation/input.js";
import { escaped } from "./fields.js";
import { renderRecommendationTable } from "./recommendation-table.js";

export function recommendationDataSource(snapshot: ResultSnapshot, runRoot = ""): string[] {
  const source = snapshot.run.source;
  if (source?.source !== "recommendation:local") return [];
  const meta = expectRecord(source.metadata, "recommendation source"), digest = meta.generatedManifestSha256;
  const manifest = typeof digest === "string" && /^[a-f0-9]{64}$/u.test(digest)
    ? ` · [生成数据清单](${runRoot}../datasets/${digest}/dataset.json) · 清单 SHA-256 \`${digest}\`` : "";
  return [`数据模式 \`${manifest ? "generated" : "files"}\` · 输入 revision \`${source.revision}\`${manifest}`, ""];
}

export function profilingTable(value: JsonValue | undefined, root = ""): string[] {
  if (!value || typeof value !== "object" || Array.isArray(value) || value.applicable !== true || !Array.isArray(value.points)) return [];
  const lines = ["## NPU 算子采集", "", "| 长度 | 设备证据 | 导出目录 | Stage (μs) | Computing (μs) | Free (μs) | Kernel 数 | 设备耗时最高的算子 |",
    "| --- | --- | --- | --- | --- | --- | --- | --- |"];
  for (const point of value.points) {
    const p = expectRecord(point, "profiling point");
    const profile = p.profile ? expectRecord(p.profile, "profile") : {};
    const exports = Array.isArray(profile.exports) ? profile.exports : [];
    if (!exports.length) lines.push(`| ${p.length} | 缺少采集 | — | — | — | — | — | — |`);
    for (const data of exports) {
      const e = expectRecord(data, "profile export"), stage = expectRecord(e.stageUs, "stage");
      const top = Array.isArray(e.topDevice) && e.topDevice.length ? expectRecord(e.topDevice[0], "operator") : null;
      const target = String(p.attempt) + "/agent/trace/" + String(e.directory).split("/").map(encodeURIComponent).join("/");
      lines.push(`| ${p.length} | ${p.valid ? "有效" : "不完整"} | [trace](${root}${target}/) | ${stage.Stage ?? "—"} | ${stage.Computing ?? "—"} | ${stage.Free ?? "—"} | ${e.kernelCount ?? "—"} | ${top ? escaped(String(top.name)) + " (" + top.deviceUs + " μs)" : "—"} |`);
    }
    if (Array.isArray(p.errors) && p.errors.length) lines.push(`| ${p.length} | 采集诊断 | ${escaped(p.errors.join(" / "))} | — | — | — | — | — |`);
  }
  for (const point of value.points) {
    const p = expectRecord(point, "profiling point");
    if (!p.profile) continue;
    const profile = expectRecord(p.profile, "profile");
    const counters = expectRecord(profile.counters, "profile counters");
    lines.push("", "### L=" + p.length, "",
      `采集窗口内快路 / Decode forward 为 ${counters.shared_prefix_forward ?? "—"} / ${counters.decode_forward ?? "—"}。`);
    for (const data of Array.isArray(profile.exports) ? profile.exports : []) {
      const e = expectRecord(data, "profile export");
      lines.push("", `导出 ${escaped(String(e.directory))} · 算子来源 ${escaped(String(e.operatorSource ?? "—"))}`,
        "", `设备算子合计 ${e.operatorDeviceUs ?? "—"} μs，Host 算子合计 ${e.operatorHostUs ?? "—"} μs，Kernel Duration / Wait 为 ${e.kernelDurationUs ?? "—"} / ${e.kernelWaitUs ?? "—"} μs。`);
      for (const [field, label, time] of [["topDevice", "设备算子", "deviceUs"], ["topHost", "Host 算子", "hostUs"], ["topKernelWait", "Kernel 等待", "waitUs"]] as const) {
        const list = e[field];
        if (!Array.isArray(list) || !list.length) continue;
        lines.push("", "| " + label + " | 次数 | 合计 (μs) |", "| --- | --- | --- |");
        for (const item of list) {
          const row = expectRecord(item, "operator");
          lines.push(`| ${escaped(String(row.name))} | ${row.count ?? "—"} | ${row[time] ?? "—"} |`);
        }
      }
    }
  }
  return [...lines, ""];
}

export function collectionReports(snapshot: ResultSnapshot, metrics: MetricResults): CollectionReportDocument[] {
  const source = snapshot.run.source, meta = source?.metadata;
  if (!meta || typeof meta !== "object" || Array.isArray(meta) || !Array.isArray(meta.collections)) return [];
  return meta.collections.map(item => {
    const route = expectRecord(item, "collection route"), directory = route.type;
    if (directory !== "performance" && directory !== "profiling") throw new TypeError("Unknown collection report");
    const key = "recommendation-" + directory, metric = metrics[key] ?? null;
    const section = directory === "performance" ? renderRecommendationTable(metric) : profilingTable(metric, "../");
    return { directory, metrics: { [key]: metric, collection: { type: directory, service: String(route.service),
      scenario: String(meta.scenario), tag: String(meta.tag) } },
      markdown: ["# " + directory, "", `Run ${snapshot.run.runId} · ${escaped(String(meta.tag))} · service ${escaped(String(route.service))}`,
        "", "[完整测评](../report.md) · [采集指标](metrics.json)", "", ...recommendationDataSource(snapshot, "../"), ...section].join("\n") };
  });
}
