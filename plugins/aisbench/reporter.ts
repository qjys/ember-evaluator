import type { AttemptRecord, JsonValue, MetricResults, ReportContext, Reporter, ResultSnapshot } from "arsi-evaluator";
import { AisbenchPerformanceMetrics, readAisbenchMetric } from "./metrics.js";

export function escaped(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
    .replace(/[\\`*_\[\]()|~#]/gu, "\\$&").replace(/[\r\n\u2028\u2029]+/gu, " ");
}

function cell(value: JsonValue | undefined): string {
  return value === undefined || value === null ? "—" : escaped(typeof value === "object" ? JSON.stringify(value) : String(value));
}

function table(lines: string[], rows: [string, JsonValue | undefined][]): void {
  lines.push("| 项目 | 结果 |", "| --- | --- |", ...rows.map(([label, value]) => `| ${escaped(label)} | ${cell(value)} |`), "");
}

function object(value: JsonValue | undefined): Record<string, JsonValue> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : undefined;
}

function metricRows(value: JsonValue, prefix = ""): [string, JsonValue][] {
  if (value === null || typeof value !== "object") return [[prefix, value]];
  return Object.entries(value).flatMap(([key, field]) => metricRows(field, prefix ? `${prefix}.${key}` : key));
}

function renderDiagnostics(lines: string[], snapshot: ResultSnapshot): void {
  const diagnostics = [
    ...(snapshot.run.failure ? [{ owner: "Run", kind: "error", diagnostic: snapshot.run.failure }] : []),
    ...(snapshot.run.initializationFailures ?? []).map(diagnostic => ({ owner: "Initialization", kind: "error", diagnostic })),
    ...snapshot.records.flatMap(record => [
      ...record.errors.map(diagnostic => ({ owner: record.key.taskId, kind: "error", diagnostic })),
      ...(record.warnings ?? []).map(diagnostic => ({ owner: record.key.taskId, kind: "warning", diagnostic })),
    ]),
  ];
  if (!diagnostics.length) return;
  lines.push("## 错误与警告", "", "| 任务 / 范围 | 类型 | 阶段 | 代码 | 说明 |", "| --- | --- | --- | --- | --- |");
  for (const { owner, kind, diagnostic } of diagnostics)
    lines.push(`| ${escaped(owner)} | ${kind} | ${escaped(diagnostic.phase)} | ${escaped(diagnostic.code)} | ${escaped(diagnostic.message)} |`);
  lines.push("");
}

function renderAttempt(lines: string[], record: AttemptRecord | undefined): void {
  if (!record) return;
  const usage = record.solve?.usage;
  table(lines, [
    ["Attempt", record.key.attemptId], ["执行状态", record.executionStatus], ["清理状态", record.cleanupStatus],
    ["开始 / 结束（UTC）", `${record.startedAt} / ${record.finishedAt}`], ["总耗时（毫秒）", record.durationMs],
    ...Object.entries(record.phaseDurationMs).map(([phase, elapsed]): [string, JsonValue | undefined] => [`${phase} 耗时（毫秒）`, elapsed]),
    ["输入 token", usage?.inputTokens], ["输出 token", usage?.outputTokens], ["总 token", usage?.totalTokens],
    ["collection.trajectory", record.collection.trajectory], ["collection.artifacts", record.collection.artifacts],
  ]);
  lines.push("产物名称：`aisbench_result.csv`、`aisbench-summary.json`、`remote-job.json`、`remote.log`。", "",
    "collection 表示收集状态；文件是否存在请查看运行结果目录中的文件清单。", "");
  if (record.trajectory) lines.push(`轨迹名称：${escaped(record.trajectory)}。`, "");
}

export class AisbenchMarkdownReporter implements Reporter {
  async render(snapshot: ResultSnapshot, metrics: MetricResults, _context?: ReportContext): Promise<string> {
    const value = metrics["aisbench-performance"] ?? await new AisbenchPerformanceMetrics().compute(snapshot);
    const metric = readAisbenchMetric(snapshot, value);
    const measured = metric.points.filter(point => point.measurement !== null).length;
    const complete = metric.applicable && metric.taskSetKnown !== false && snapshot.run.status === "completed" &&
      snapshot.pendingTaskIds.length === 0 && measured === snapshot.run.taskIds.length && measured > 0;
    const incompleteCollection = snapshot.records.some(record => [record.collection.trajectory, record.collection.artifacts]
      .some(state => state === "partial" || state === "missing"));
    const diagnostics = snapshot.records.some(record => record.cleanupStatus === "unconfirmed" || record.errors.length || record.warnings?.length) ||
      snapshot.run.failure || snapshot.run.initializationFailures?.length;
    const summary = !complete ? "**未完成：本报告包含部分运行结果或缺失测量证据。**" :
      incompleteCollection || diagnostics ? "性能测量已完成；存在诊断或证据收集不完整，请核对下方状态。" : "性能测量已完成。";
    const lines = ["# AISBench 性能报告", "", summary, "", `Run: ${escaped(snapshot.run.runId)} · Status: ${escaped(snapshot.run.status)}`, "", "## 运行概况", ""];
    const configuration = object(snapshot.run.configSummary);
    if (snapshot.run.resultLayout) lines.push("[分类指标](metrics/index.json)", "");
    const selection = (key: string): JsonValue | undefined => {
      const value = configuration?.[key];
      return object(value)?.name ?? (typeof value === "string" ? value : undefined);
    };
    table(lines, [
      ["Benchmark", selection("benchmark")], ["模型", selection("model")], ["Solver", selection("solver")],
      ["环境", selection("environment")], ["调度器", selection("scheduler")],
      ["开始 / 结束（UTC）", `${snapshot.run.startedAt} / ${snapshot.run.finishedAt ?? "未结束"}`],
      ["总耗时（毫秒）", snapshot.run.durationMs], ["Config fingerprint", snapshot.run.configFingerprint], ["Snapshot digest", snapshot.digest],
    ]);
    if (metric.taskSetKnown === false) lines.push("来源准备尚未完成，任务集合未确定。", "");
    else if (!metric.applicable) lines.push("本次运行不适用 AISBench 性能测量。", "");
    else lines.push(`有效测量覆盖率：${measured}/${snapshot.run.taskIds.length}；已保存 ${snapshot.records.length} 条记录；待运行 ${snapshot.pendingTaskIds.length} 个测量点。`, "");
    lines.push("## 版本与来源", "");
    const identity = snapshot.run.identity;
    table(lines, [
      ["Evaluator", identity ? `${identity.evaluator.name} ${identity.evaluator.version}` : undefined],
      ["Runtime", identity ? `${identity.runtime.node} / ${identity.runtime.platform} / ${identity.runtime.arch}` : undefined],
      ...Object.entries(snapshot.run.pluginVersions).map(([name, version]): [string, JsonValue] => [`Plugin ${name}`, version]),
      ["Source", snapshot.run.source?.source], ["Revision", snapshot.run.source?.revision],
      ["Bundle digest", object(snapshot.run.source?.metadata)?.bundleDigest],
    ]);
    for (const [name, title] of [["duration", "耗时（毫秒）"], ["usage", "模型用量"], ["attempt-accounting", "累计用量"]] as const) {
      const value = metrics[name];
      if (value !== undefined) { lines.push(`## ${title}`, ""); table(lines, metricRows(value)); }
    }
    const records = new Map(snapshot.records.map(record => [record.key.taskId, record]));
    lines.push("## AISBench 性能测量", "");
    for (const point of metric.points) {
      lines.push(`### ${escaped(point.taskId)}`, "", `状态：${escaped(point.status)}。`, "");
      renderAttempt(lines, records.get(point.taskId));
      if (!point.measurement) { lines.push("无有效测量证据。", ""); continue; }
      const summary = point.measurement, workload = summary.workload, prefix = workload.prefixCache;
      table(lines, [
        ["AISBench version", summary.aisbenchVersion], ["inputLength", workload.inputLength], ["outputLength", workload.outputLength],
        ["dataCount", workload.dataCount], ["concurrency", workload.concurrency], ["requestRate", workload.requestRate], ["testType", workload.testType],
        ["prefixCache.enabled", prefix.enabled], ["prefixCache.prefixCount", prefix.prefixCount], ["prefixCache.prefixRatio", prefix.prefixRatio],
        ["prefixCache.warmup", prefix.warmup], ["prefixCache.dp", prefix.dp], ["prefixCache.seed", prefix.seed], ["脚本摘要", summary.bundleDigest],
      ]);
      summary.rows.forEach((row, index) => {
        if (summary.rows.length > 1) lines.push(`测量行 ${index + 1}：`, "");
        lines.push("| AISBench 原始字段 | 结果 |", "| --- | --- |", ...Object.entries(row).map(([name, value]) => `| ${escaped(name)} | ${escaped(value)} |`), "");
      });
    }
    renderDiagnostics(lines, snapshot);
    const remote = (snapshot.run.remoteAttempts ?? []).filter(item => item.key.runId === snapshot.run.runId &&
      snapshot.run.taskIds.includes(item.key.taskId) && (!records.has(item.key.taskId) || records.get(item.key.taskId)?.key.attemptId === item.key.attemptId));
    if (remote.length) {
      lines.push("## Remote collection", "", "| 任务 | 节点 / 主机 | 收集状态 | 说明 |", "| --- | --- | --- | --- |");
      for (const item of remote)
        lines.push(`| ${escaped(item.key.taskId)} | ${cell(item.nodeId)} / ${cell(item.hostname)} | ${escaped(item.state)} | ${cell(item.message)} |`);
      lines.push("");
    }
    // ResultSnapshot has no attempt root or file manifest. Names and collection state are
    // intentionally plain text; even a ReportContext cannot supply the missing paths.
    return lines.join("\n");
  }
}
