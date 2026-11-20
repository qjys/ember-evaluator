import type { JsonValue } from "../../core/contracts/task.js";
import { expectRecord } from "../../core/validation/input.js";
import { escaped } from "./fields.js";

function fields(value: unknown): Record<string, unknown> {
  return value == null ? {} : expectRecord(value, "recommendation report fields");
}

function number(value: unknown, digits = 3): string {
  return typeof value === "number" ? value.toFixed(digits) : "—";
}

function table(headers: string[], rows: unknown[][]): string[] {
  const line = (cells: unknown[]) => "| " + cells.map(cell => escaped(String(cell ?? "—"))).join(" | ") + " |";
  return [line(headers), line(headers.map(() => "---")), ...rows.map(line), ""];
}

export function renderRecommendationTable(value: JsonValue | undefined): string[] {
  if (!value || typeof value !== "object" || Array.isArray(value) || value.applicable !== true) return [];
  if (!Array.isArray(value.points)) throw new TypeError("Invalid recommendation report points");
  const rows = value.points.map(fields);
  const verdict: Record<string, string> = { pass: "达标", fail: "未达标", invalid: "无效", unassessed: "未判定" };
  const tag: Record<string, string> = { "not-requested": "base", hit: "已命中", miss: "零命中", unverified: "未验证" };
  const lines = ["## 推荐性能", "", `场景 ${escaped(String(value.scenario))} · 快路 ${tag[String(value.fast)] ?? "未知"}`, ""];
  if (value.scenario === "north-star") {
    const north = fields(value.northStar);
    const missing = Array.isArray(north.missingLengths) && north.missingLengths.length ? `（缺档 ${north.missingLengths.join(" / ")}）` : "";
    lines.push(`五档有效测量 ${value.complete ? "齐全" : "不完整"}${missing} · 910B2 历史预算 L=128 ${verdict[String(north.l128)] ?? "未判定"}，五档整体${verdict[String(north.overall)] ?? "未判定"} · 同 session L=128 ${verdict[String(value.l128)] ?? "未判定"}`, "");
  }
  lines.push(...table(["目标长度", "状态", "有效请求 / 计划", "正式 prompt 数", "E2E p50 (ms)", "同 session eager (ms)", "差额 (ms)", "快路 / decode forward", "快路 (%)"], rows.map(r => [
    r.length, r.valid ? "有效" : (Array.isArray(r.invalidReasons) && r.invalidReasons.length ? r.invalidReasons.join("，") : "缺少有效测量"),
    `${r.successfulRequests}/${r.requests}`, r.prompts, number(r.p50Ms), r.baselineStatus === "mismatch" ? "条件不匹配" : number(r.baselineMs),
    number(r.deltaMs), `${r.fastpathForward ?? "—"}/${r.decodeForward ?? "—"}`, typeof r.fastpathRatio === "number" ? number(100 * r.fastpathRatio, 1) : "—",
  ])));
  lines.push("### 客户端正式请求", "",
    "时延单位为 ms。成功响应进入时延分布，SID 和分数分别校验。非流式 TTFT 等于完整响应 E2E。", "",
    ...table(["长度", "请求成功 / 失败", "SID 合法 / 分数有限", "E2E mean", "p50", "p95", "p99", "输出 token 总数 / 均值", "TPOT (ms)", "窗口 (s)", "QPS"], rows.map(r => {
      const c = fields(r.client), t = fields(c.e2eMs);
      return [r.length, `${c.success ?? "—"}/${c.failed ?? "—"}`, `${c.sidValidRequests ?? "—"}/${c.scoresFiniteRequests ?? "—"}`,
        ...["mean", "p50", "p95", "p99"].map(key => number(t[key])), `${c.outputTokens ?? "—"}/${number(c.meanOutputTokens)}`, number(c.tpotMs), number(c.wallElapsedSeconds, 6), number(c.qps)];
    })));
  if (rows.some(r => r.diagnostics != null)) {
    const stages = ["prefill", "pf_sel", "decode1", "decode2", "tail"];
    lines.push("### 服务端阶段", "", "阶段占比以 span 均值为分母。client 为 E2E 均值减去 span 均值，cli% 以 E2E 均值为分母。", "",
      ...table(["长度", "span (ms)", "client (ms)", "cli%", ...stages.map(name => name + " (ms / %)"), "占比最大阶段"], rows.map(r => {
        const d = fields(r.diagnostics), times = fields(d.stageMs), shares = fields(d.shares);
        return [r.length, number(times.span), number(d.clientGapMs), number(d.clientPercent, 1),
          ...stages.map(key => number(times[key]) + " / " + number(shares[key], 1)), d.dominant];
      })),
      ...table(["长度", "admission (ms)", "prefill commit (ms)", "decode commit (ms)", "overshoot (ms)", "step (ms)", "selection (ms)", "步数/请求", "overshoot 次数比", "overshoot 时间比"], rows.map(r => {
        const d = fields(r.diagnostics), times = fields(d.stageMs);
        return [r.length, ...["admission", "prefillCommit", "decodeCommit", "overshoot"].map(key => number(times[key])),
          ...["stepMs", "selectionMs", "stepsPerRequest", "overshootRatio", "overshootWallShare"].map(key => number(d[key]))];
      })),
      ...table(["长度", "admitted / finished groups", "prefill forward", "decode steps", "decode forward / selection"], rows.map(r => {
        const c = fields(fields(r.diagnostics).counts);
        return [r.length, `${c.groups_admitted ?? "—"} / ${c.groups_finished ?? "—"}`, c.prefill_forward, c.decode_steps,
          `${c.decode_forward ?? "—"} / ${c.decode_selection ?? "—"}`];
      })),
      ...table(["长度", "快路 groups / rows", "skip no_plan / gate / group", "异常次数", "异常摘要", "schema", "decode calls / graph / FIA / FA / paged / sinks / beam graph / SDPA", "PID snapshot / sched / attn"], rows.map(r => {
        const d = fields(r.diagnostics), c = fields(d.counts), p = fields(d.processIds);
        const counts = (keys: string[]) => keys.map(k => c[k] ?? "—").join(" / ");
        return [r.length, counts(["shared_prefix_groups", "shared_prefix_rows"]), counts(["shared_prefix_skip_no_plan", "shared_prefix_skip_gate", "shared_prefix_skip_group"]),
          c.shared_prefix_exception, d.exceptionNote, c.gr_counter_schema, counts(["decode_api_calls", "decode_api_graph", "decode_api_fia", "decode_api_fa", "decode_api_paged", "decode_api_sinks", "decode_api_beam_graph", "sdpa_decode_calls"]),
          ["gr_pid_snapshot", "gr_pid_sched", "gr_pid_attn"].map(k => p[k] ?? "—").join(" / ")];
      })));
  }
  if (value.scenario === "north-star") {
    lines.push("### 原脚本历史预算", "", "910B2 eager 来自历史软件版本与测量窗口，910B1 graph 来自另一台机器。差额为本次 p50 减去预算。", "",
      ...table(["长度", "910B2 eager (ms)", "差额 (ms)", "p50 / eager", "910B1 graph (ms)", "p50 / graph"], rows.map(r => {
        const h = fields(r.historical);
        return [r.length, number(h.eagerMs), number(h.deltaEagerMs), number(h.eagerRatio), number(h.graphMs), number(h.graphRatio)];
      })));
    const profile = fields(fields(value.northStar).historicalEagerProfile);
    if (profile.length) lines.push(`历史 910B2 eager 在 L=${profile.length} 时记录了 ${profile.kernels} 个 kernel，Stage ${profile.stageUs} μs，op_total ${profile.opTotalUs} μs，Free ${profile.freeUs} μs。`, "");
  }
  return lines;
}
