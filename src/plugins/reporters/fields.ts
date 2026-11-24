import type { JsonValue } from "../../core/contracts/task.js";
import type { MetricResults } from "../../core/contracts/metrics.js";

export function escaped(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
    .replace(/[\\`*_\[\]()|~]/gu, "\\$&").replace(/\r?\n/gu, " ");
}

export function readableDuration(milliseconds: number): string {
  if (milliseconds > 0 && milliseconds < 1000) return `${Number(milliseconds.toFixed(2))} 毫秒`;
  const seconds = Math.round(milliseconds / 1000);
  if (seconds < 60) return `${seconds} 秒`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`;
  return `${Math.floor(seconds / 3600)} 小时 ${Math.floor(seconds % 3600 / 60)} 分 ${seconds % 60} 秒`;
}

function object(value: JsonValue | undefined): Record<string, JsonValue> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : undefined;
}
function number(value: JsonValue | undefined): string {
  return typeof value === "number" ? value.toLocaleString("en-US", { maximumFractionDigits: 4 }) : "—";
}
function percent(value: JsonValue | undefined): string {
  return typeof value === "number" ? `${(value * 100).toFixed(2)}%` : "—";
}
const time = (value: JsonValue | undefined) => typeof value === "number" ? readableDuration(value) : "—";

export function renderMetrics(metrics: MetricResults): string[] {
  const lines: string[] = ["## Metrics", ""];
  const scoreRows: string[] = [];
  const success = object(metrics["success-rate"]);
  if (success && success.applicable !== false) {
    for (const [key, label] of [["selected", "选定题数"], ["denominator", "计分题数"], ["verified", "正常评分题数"],
      ["passed", "答对题数"], ["invalid", "无效评测"], ["pending", "待运行"]] as const)
      scoreRows.push(`| ${label} | ${number(success[key])} |`);
    scoreRows.push(`| 正确率 | ${percent(success.rate)} |`);
  }
  const harbor = object(metrics["harbor-score"]);
  if (harbor && harbor.applicable !== false) {
    scoreRows.push(`| 平均奖励 | ${number(harbor.meanReward)} |`);
    for (const [name, value] of Object.entries(object(harbor.dimensions) ?? {}))
      scoreRows.push(`| 奖励 ${escaped(name)} | ${number(value)} |`);
  }
  const quality = object(metrics["quality-score"]);
  if (quality && quality.applicable !== false) {
    scoreRows.push(`| 平均质量分 | ${number(quality.mean)} |`, `| 质量评分样本数 | ${number(quality.measured)} |`);
    for (const [name, value] of Object.entries(object(quality.simpleqa) ?? {}))
      scoreRows.push(`| ${escaped(name)} | ${/Rate$|accuracy|f1/iu.test(name) ? percent(value) : number(value)} |`);
  }
  if (scoreRows.length) lines.push("### 评分", "", "| 指标 | 结果 |", "| --- | --- |", ...scoreRows, "");

  const duration = object(metrics.duration);
  if (duration) {
    lines.push("### 耗时", "", "| 指标 | 结果 |", "| --- | --- |", `| 整批运行 | ${time(duration.runWallTimeMs)} |`);
    const preparationBudgets = Array.isArray(duration.preparation)
      ? duration.preparation.filter(value => object(value)?.timeoutPolicy === "task-concurrency-v1") : [];
    if (Array.isArray(duration.preparation) && duration.preparation.length) {
      const elapsed = duration.preparation.map(value => object(value)?.wallTimeMs);
      const total = elapsed.every(value => typeof value === "number")
        ? elapsed.reduce<number>((sum, value) => sum + (typeof value === "number" ? value : 0), 0) : null;
      lines.push(`| 环境准备耗时 | ${time(total)} |`);
    }
    const stages: [string, JsonValue | undefined][] = [["单题执行", duration.tasks]];
    const labels: Record<string, string> = { prepare: "任务准备", environment: "环境启动", install: "运行时安装", solve: "解题",
      transfer: "产物传输", verify: "评分", collect: "证据收集", cleanup: "资源清理", store: "结果保存" };
    for (const [phase, value] of Object.entries(object(duration.phases) ?? {})) stages.push([labels[phase] ?? phase, value]);
    lines.push("", "| 阶段 | 平均用时 | 最短用时 | 最长用时 | 任务数 |", "| --- | --- | --- | --- | --- |");
    for (const [label, value] of stages) {
      const stats = object(value);
      if (stats) lines.push(`| ${escaped(label)} | ${time(stats.meanMs)} | ${time(stats.minMs)} | ${time(stats.maxMs)} | ${number(stats.count)} |`);
    }
    lines.push("");
    if (preparationBudgets.length) {
      lines.push("| 准备轮次 | 整轮上限（秒） | 环境基础时限（秒） | 准备并发 | 放宽系数 | 实际环境时限（秒） |",
        "| --- | --- | --- | --- | --- | --- |");
      for (const value of preparationBudgets) {
        const round = object(value);
        if (!round) continue;
        const timings = Array.isArray(round.environmentTimeouts) ? round.environmentTimeouts.map(object) : [];
        const range = (key: string) => {
          const values = timings.flatMap(timing => typeof timing?.[key] === "number" ? [Number(timing[key])] : []);
          if (!values.length) return "—";
          const min = values.reduce((a, b) => Math.min(a, b)), max = values.reduce((a, b) => Math.max(a, b));
          return min === max ? String(min) : `${min}–${max}`;
        };
        lines.push(`| ${escaped(String(round.id))} | ${round.budgetSeconds === null ? "未设置" : number(round.budgetSeconds)} | ${range("baseSeconds")} | ${range("concurrency")} | ${range("multiplier")} | ${range("timeoutSeconds")} |`);
      }
      lines.push("");
    }
  }

  const usage = object(metrics.usage);
  const cumulative = object(metrics["attempt-accounting"]);
  if (usage || cumulative) {
    lines.push("### 模型用量", "", "| 范围 | 输入 token | 输出 token | 总 token | 覆盖记录 | 不完整记录 |",
      "| --- | --- | --- | --- | --- | --- |");
    for (const [label, value, selected] of [["最终结果", usage, usage?.selected], ["运行累计", object(cumulative?.usage), cumulative?.attempts]] as const) {
      if (!value) continue;
      const input = object(value.inputTokens), output = object(value.outputTokens), total = object(value.totalTokens);
      lines.push(`| ${label} | ${number(input?.total)} | ${number(output?.total)} | ${number(total?.total)} | ${number(total?.covered)} / ${number(selected)} | ${number(total?.partialAttempts)} |`);
    }
    lines.push("");
  }

  const builtins = new Set(["success-rate", "harbor-score", "quality-score", "duration", "usage", "attempt-accounting", "agentx-performance", "recommendation-performance", "recommendation-profiling", "kernel"]);
  const extraRows: string[] = [];
  const extra = (name: string, value: JsonValue) => {
    if (value !== null && typeof value === "object" && Object.keys(value).length) {
      for (const [key, item] of Object.entries(value)) extra(`${name}.${key}`, item);
    } else extraRows.push(`| ${escaped(name)} | ${escaped(value === null ? "—" : typeof value === "string" ? value : JSON.stringify(value))} |`);
  };
  for (const [name, value] of Object.entries(metrics)) if (!builtins.has(name)) extra(name, value);
  if (extraRows.length) lines.push("### 其他指标", "", "| 指标 | 结果 |", "| --- | --- |", ...extraRows, "");
  return lines;
}
