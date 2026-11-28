import type { JsonValue } from "../../core/contracts/task.js";
import { expectRecord } from "../../core/validation/input.js";
import { parseAgentXSummary, type AgentXStatistic } from "../benchmarks/inference-engine/agentx/evidence/summary.js";

const escape = (value: string) => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
  .replace(/[\\`*_\[\]()|~]/gu, "\\$&").replace(/\r?\n/gu, " ");
const number = (value: number | null | undefined) => value == null ? "—" : value.toFixed(3).replace(/\.?0+$/u, "");

function renderDiagnostics(p: Record<string, unknown>): string[] {
  const lines: string[] = [];
  lines.push("Ascend profiling · " + escape(String(p.status)), "");
  if (p.error) lines.push(escape(String(p.error)), "");
  if (p.artifactDirectory) lines.push("诊断产物 · " + escape(String(p.artifactDirectory)), "");
  if (p.traceDirectory) lines.push("服务端 trace · " + escape(String(p.traceDirectory)), "");
  if (p.worstRankByExposedCommunication) lines.push("未被计算覆盖的通信时间最长的 Rank · " + escape(String(p.worstRankByExposedCommunication)), "");
  if (p.categories) {
    lines.push("指标类型覆盖 · " + escape(String(p.coverageStatus)), "");
    const labels: Record<string, string> = { timeline: "计算时间线", operators: "算子与 Shape", runtime: "Runtime 下发", memcpy: "Memcpy",
      allocator: "框架显存分配", pipeline: "Cube / Vector / MTE", communication: "HCCL 通信与重叠", links: "卡间链路",
      cpu: "主机 CPU", memory: "主机内存", disk: "磁盘 I/O", network: "主机网络", npuMemory: "NPU 显存",
      npuUtilization: "NPU 利用率", hbmBandwidth: "HBM 读写带宽", l2Cache: "L2 Cache" };
    lines.push("| 优化指标类型 | 采集状态 | 来源 | 覆盖数 / 目标数 | 缺失原因 |", "| --- | --- | --- | --- | --- |");
    for (const [key, raw] of Object.entries(expectRecord(p.categories, "profile categories"))) {
      const c = expectRecord(raw, "category coverage");
      lines.push("| " + [labels[key] ?? key, c.status, c.source, c.observed + " / " + c.expected, c.reason ?? "—"].map(v => escape(String(v))).join(" | ") + " |");
    }
    lines.push("");
  }
  if (Array.isArray(p.frontendTraces)) for (const path of p.frontendTraces) lines.push("API 进程 trace · " + escape(String(path)), "");
  for (const evidence of [p.localMetrics, p.nodeMetrics]) {
    if (!evidence) continue;
    const node = expectRecord(evidence, "AgentX node metrics");
    lines.push("服务节点采样 · " + escape(String(node.endpoint)) + " · " + escape(String(node.status)), "",
      "| 序列 | 均值 | 峰值 | 计数器增量 | 每秒增量 | 样本 |", "| --- | ---: | ---: | ---: | ---: | ---: |");
    for (const [series, sample] of Object.entries(expectRecord(node.series, "node metrics series"))) {
      const r = expectRecord(sample, "node metric");
      lines.push("| " + [series, r.mean, r.counter ? null : r.peak, r.delta, r.ratePerSecond, r.count].map(v => escape(String(v ?? "—"))).join(" | ") + " |");
    }
    lines.push("", "未采到的序列 · " + escape(String(node.missing || "—")) + "，抓取失败次数 " + String(node.errors), "");
  }
  if (Array.isArray(p.exports)) {
    lines.push(`诊断轮回放 ${p.traceCount} 棵会话树，完成 ${p.requests} 条请求。`, "");
    if (p.preset === "full" || p.preset === "timeline" || !p.preset) {
      lines.push("| Rank 导出 | 设备证据 | 算子 Device (µs) | 算子 Host (µs) | Kernel 数 | Kernel 执行 (µs) | Kernel 等待 (µs) |",
      "| --- | --- | ---: | ---: | ---: | ---: | ---: |");
      for (const raw of p.exports) {
        const rank = expectRecord(raw, "Ascend export");
        lines.push("| " + [rank.artifactDirectory, rank.deviceEvidence, rank.operatorDeviceUs, rank.operatorHostUs, rank.kernelCount,
          rank.kernelDurationUs, rank.kernelWaitUs].map(v => escape(String(v ?? "—"))).join(" | ") + " |");
      }
      lines.push("");
    }
    for (const raw of [...p.exports, ...(Array.isArray(p.hardwareExports) ? p.hardwareExports : [])]) {
      const rank = expectRecord(raw, "Ascend export");
      if (rank.artifacts) {
        const a = expectRecord(rank.artifacts, "native artifacts");
        lines.push("原生产物清单 · " + escape(String(a.manifest)) + " · " + a.files + " 个文件，跳过 " + a.omitted + " 个", "");
      }
      if (rank.native) {
        const native = expectRecord(rank.native, "native profile");
        const comm = expectRecord(native.communication, "HCCL");
        lines.push("Rank · " + escape(String(rank.artifactDirectory)), "");
        for (const errors of [native.databaseErrors, comm.errors]) if (Array.isArray(errors))
          for (const error of errors) lines.push(escape(String(error)), "");
        for (const [unit, stats] of [["Kernel PMU（原始列单位）", native.pipeline], ["显存分配（MB）", native.allocatorMB],
          ["HCCL 逐调用耗时（ms）", comm.timeMs]] as const) {
          const entries = Object.entries(expectRecord(stats, "native statistics"));
          if (!entries.length) continue;
          lines.push("| " + unit + " | 均值 | 最大值 | 样本数 |", "| --- | ---: | ---: | ---: |");
          for (const [name, item] of entries) {
            const s = expectRecord(item, "native statistic");
            lines.push("| " + [name, s.mean, s.max, s.count].map(v => escape(String(v))).join(" | ") + " |");
          }
          lines.push("");
        }
        if (Array.isArray(native.hbmChannels) && native.hbmChannels.length) {
          lines.push("| NPU | HBM 通道 | 方向 | 均值 (MB/s) | 峰值 (MB/s) | 样本数 |", "| --- | --- | --- | ---: | ---: | ---: |");
          for (const item of native.hbmChannels) {
            const h = expectRecord(item, "HBM sample");
            lines.push("| " + [h.device, h.channel, h.direction, h.meanMBps, h.peakMBps, h.count].map(v => escape(String(v))).join(" | ") + " |");
          }
          lines.push("");
        }
        if (Array.isArray(comm.links) && comm.links.length) {
          lines.push("| HCCL 操作 | Rank 链路 | 传输 | MB | ms | GB/s |", "| --- | --- | --- | ---: | ---: | ---: |");
          for (const item of comm.links) {
            const link = expectRecord(item, "HCCL link");
            lines.push("| " + [link.op, link.pair, link.transport, link.sizeMB, link.timeMs, link.bandwidthGBps].map(v => escape(String(v ?? "—"))).join(" | ") + " |");
          }
          lines.push("");
        }
      }
      if (rank.counters) {
        lines.push(`物理 NPU ${rank.physicalDevice} · msprof ${escape(String(p.preset))}`, "",
          "| CANN 表 / 指标（原始单位） | 导出行均值 | 导出行最大值 | 行数 |", "| --- | ---: | ---: | ---: |");
        for (const [name, value] of Object.entries(expectRecord(rank.counters, "PMU counters"))) {
          const r = expectRecord(value, "PMU counter");
          lines.push("| " + [name, r.mean, r.max, r.count].map(v => escape(String(v))).join(" | ") + " |");
        }
        lines.push("");
        if (rank.hitOverHitsAndMissAllocations) {
          const ratios = expectRecord(rank.hitOverHitsAndMissAllocations, "cache event fractions");
          for (const [name, fraction] of Object.entries(ratios)) {
            lines.push(escape(name) + " · 命中 /（命中 + 缺失后重分配） = " +
              (typeof fraction === "number" ? number(fraction * 100) + "%" : "—"), "");
          }
        }
      }
      if (!rank.timeline) continue;
      const timeline = expectRecord(rank.timeline, "Ascend timeline");
      lines.push("Rank · " + escape(String(rank.artifactDirectory)), "",
        "| 计算 (µs) | HCCL (µs) | 重叠 (µs) | 未被计算覆盖的通信 (µs) |", "| ---: | ---: | ---: | ---: |",
        "| " + [timeline.computeUs, timeline.communicationUs, timeline.overlapUs, timeline.exposedCommunicationUs].map(v => escape(String(v ?? "—"))).join(" | ") + " |", "",
        "| 热点 | 名称 | 输入 Shape | 次数 | 累计耗时 (µs) |", "| --- | --- | --- | ---: | ---: |");
      const top = expectRecord(timeline.top, "timeline events");
      for (const [category, entries] of Object.entries({ "设备算子": rank.topDevice, "算子 / Shape": rank.topShapes,
        "Runtime": top.runtime, "Memcpy": top.copy, "HCCL": top.communication })) {
        if (Array.isArray(entries)) for (const entry of entries.slice(0, 10)) {
          const r = expectRecord(entry, "profile hotspot");
          lines.push("| " + [category, r.name, r.shape, r.count, r.durationUs ?? r.deviceUs].map(v => escape(String(v ?? "—"))).join(" | ") + " |");
        }
      }
      lines.push("");
    }
  }
  return lines;
}

export function renderAgentXTables(value: JsonValue | undefined): string[] {
  if (value === undefined) return [];
  const metric = expectRecord(value, "agentx-performance metric");
  if (metric.applicable !== true) return [];
  if (!Array.isArray(metric.points)) throw new TypeError("Invalid AgentX report points");
  const lines = ["## AgentX serving performance", "",
    "会话并发是同时活动的会话树数，实际请求并发可能更高。下表取自正式压测的测量窗口，预热单列。分位数分别属于各测量点。", "",
    "| 测量点 | 状态 | 会话并发 | 场景 / 语料 | 上游有效 | 可比正式结果 | 成功请求 / 错误请求 | 测量秒数 |",
    "| --- | --- | --- | --- | --- | --- | --- | --- |"];
  const diagnosticOnly = (point: Record<string, unknown>) => Array.isArray(point.collections) &&
    point.collections.some(c => c?.profiling && c.performanceStatus === undefined);
  const hasPerformance = metric.points.some(value => !diagnosticOnly(expectRecord(value, "AgentX report point")));
  if (!hasPerformance) lines.splice(0, lines.length, "## AgentX serving diagnostics", "");
  const summaries = metric.points.map(value => {
    const point = expectRecord(value, "AgentX report point");
    const summary = point.measurement === null ? null : parseAgentXSummary(point.measurement);
    if (!diagnosticOnly(point)) lines.push(`| ${escape(String(point.taskId))} | ${escape(String(point.status))} | ${summary?.measuredConcurrency ?? summary?.workload.concurrency ?? "—"} | ${summary ? `${summary.workload.mode} / ${summary.workload.variant}` : "—"} | ${summary?.upstreamSubmissionValid ?? "—"} | ${summary?.comparable ?? "—"} | ${number(summary?.profiling.requests?.mean)} / ${number(summary?.profiling.errors?.mean)} | ${number(summary?.profiling.duration?.mean)} |`);
    return { taskId: String(point.taskId), summary, collections: point.collections };
  });
  if (hasPerformance) lines.push("", metric.points.length > 1 ? "### 并发点性能对比" : "### 测量点性能", "",
    "| 测量点 | 会话并发 | 输出吞吐 (tokens/sec) | 总 token 吞吐 (tokens/sec) | TTFT P50 / P95 (ms) | ITL P50 / P95 (ms) | 请求延迟 P95 (ms) | TPOT P50 / P95 (ms) | 吞吐 (req/s) |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- |");
  for (const { taskId, summary } of summaries) {
    if (!hasPerformance) continue;
    const stats = summary?.profiling;
    lines.push(`| ${escape(taskId)} | ${summary?.measuredConcurrency ?? summary?.workload.concurrency ?? "—"} | ${number(stats?.outputThroughput?.mean)} | ${number(stats?.totalThroughput?.mean)} | ${number(stats?.ttft?.p50)} / ${number(stats?.ttft?.p95)} | ${number(stats?.itl?.p50)} / ${number(stats?.itl?.p95)} | ${number(stats?.requestLatency?.p95)} | ${number(stats?.tpot?.p50)} / ${number(stats?.tpot?.p95)} | ${number(stats?.requestThroughput?.mean)} |`);
  }
  const labels: Record<string, string> = { ttft: "TTFT", tpot: "TPOT", requestThroughput: "请求吞吐", itl: "ITL", requestLatency: "请求延迟",
    inputThroughput: "输入吞吐", outputThroughput: "输出吞吐", totalThroughput: "总 token 吞吐",
    interactivity: "Interactivity", fullResponseInteractivity: "Full-response Interactivity" };
  const row = (taskId: string, name: string, stat: AgentXStatistic | null | undefined) =>
    `| ${escape(taskId)} | ${name} | ${stat?.unit ?? "—"} | ${number(stat?.mean)} | ${number(stat?.p50)} | ${number(stat?.p95)} | ${number(stat?.p99)} | ${stat?.count ?? "—"} |`;
  for (const { taskId, summary, collections } of summaries) {
    lines.push("", `### 测量点 ${escape(taskId)}`, "");
    if (Array.isArray(collections)) for (const item of collections) {
      const c = expectRecord(item, "AgentX collection");
      if (c.performanceStatus !== undefined) lines.push("正式压测 · " + escape(String(c.performanceStatus)), "");
      if (typeof c.performanceDirectory === "string") lines.push("正式产物 · " + escape(c.performanceDirectory), "");
      if (c.engine) {
        const engine = expectRecord(c.engine, "AgentX engine metrics");
        lines.push("推理引擎指标 · " + escape(String(engine.status)), "",
          "| 指标 | 压测前 | 压测后 | Gauge 均值 | Gauge 峰值 | 计数器增量 | 样本 |", "| --- | ---: | ---: | ---: | ---: | ---: | ---: |");
        for (const raw of Array.isArray(engine.series) ? engine.series : []) {
          const r = expectRecord(raw, "engine series");
          lines.push("| " + [r.series, r.before, r.after, r.mean, r.peak, r.delta, r.samples].map(v => escape(String(v ?? "—"))).join(" | ") + " |");
        }
        lines.push("");
        if (engine.rawSeries) lines.push("原始时序 · " + escape(String(engine.rawSeries)), "");
        if (Array.isArray(engine.missing) && engine.missing.length) lines.push("缺少指标 " + escape(engine.missing.join(", ")), "");
        if (Array.isArray(engine.errors)) for (const error of engine.errors) lines.push(escape(String(error)), "");
      }
      if (c.profiling) {
        const p = expectRecord(c.profiling, "AgentX profiling");
        lines.push(...renderDiagnostics(p));
      }
    }
    if (!summary && !hasPerformance) continue;
    if (!summary) {
      lines.push("暂无有效测量摘要；状态见上方测量点表。推理服务与硬件指标采集状态未知。", "");
      continue;
    }
    lines.push("| 测量点 | 指标 | 单位 | 均值 | P50 | P95 | P99 | 样本数 |",
      "| --- | --- | --- | --- | --- | --- | --- | --- |");
    for (const [key, label] of Object.entries(labels)) lines.push(row(taskId, label, summary.profiling[key]));
    lines.push("", `Harness ${summary.harnessVersion}；数据 ${escape(summary.workload.dataset)} @ ${summary.workload.revision}；tokenizer ${escape(summary.lexicon.source)} @ ${escape(summary.lexicon.revision)}。`, "",
      `预热：请求 ${number(summary.warmup.requests?.mean)}；输入 token ${number(summary.warmup.inputTokens?.mean)}；输出 token ${number(summary.warmup.outputTokens?.mean)}。`, "",
      `上游无效原因：${escape(summary.upstreamInvalidReasons.join(", ")) || "—"}；本地不可比原因：${escape(summary.incomparableReasons.join(", ")) || "—"}。`, "");
    if (summary.networkLatency) {
      const network = summary.networkLatency;
      const mode = network.config.mode === "automatic"
        ? `自动 TCP RTT 探测，间隔 ${number(network.config.pingIntervalSeconds)} 秒`
        : `手动 RTT，配置值 ${number(network.config.meanMs)} ms`;
      lines.push("#### 网络延时校准", "",
        `方式：${mode}；校准数据状态：${network.status}；官方用于校准的平均 RTT：${number(network.rttMs)} ms。`, "",
        network.probes ? `TCP 探测：总计 ${network.probes.total}；成功 ${network.probes.successful}；失败 ${network.probes.failed}。`
          : `TCP 探测：${network.config.mode === "manual" ? "不适用（手动指定 RTT）" : "未记录"}。`, "",
        `校准告警：${escape(network.warnings.join("; ")) || "—"}。`, "",
        "| 测量点 | 指标与口径 | 单位 | 均值 | P50 | P95 | P99 | 样本数 |",
        "| --- | --- | --- | --- | --- | --- | --- | --- |");
      for (const [key, label] of Object.entries({ ttft: "TTFT", ttfo: "TTFO（首个输出 token）", requestLatency: "请求延迟" })) {
        lines.push(row(taskId, `${label} 原始`, summary.profiling[key]));
        lines.push(row(taskId, `${label} 扣除 RTT 后`, network.adjusted[key]));
      }
      lines.push("", "修正值直接读取官方 Harness 导出，保留原始延迟；ITL、吞吐及上方性能对比表不做 RTT 扣减。平均 TCP RTT 只校准客户端到端点的往返估算，不能消除所有代理、传输或客户端开销。未导出的值显示 —，不补算。", "");
    }
    const rawPoint = metric.points.find((p: Record<string, unknown>) => String(p.taskId) === taskId) as Record<string, unknown> | undefined;
    const measurement = rawPoint?.measurement as Record<string, unknown> | undefined;
    const msprof = measurement?.msprof as Record<string, unknown> | undefined;
    const msprofAttempt = measurement?.msprofAttempt as Record<string, unknown> | undefined;
    if (msprof) {
      const agg = msprof.aggregate as Record<string, unknown> | undefined;
      const devices = msprof.devices as Record<string, Record<string, unknown>> | undefined;
      const mean = agg?.mac_fp16_ratio_mean;
      const requested = Array.isArray(msprof.resolvedDevices) && msprof.resolvedDevices.length ? msprof.resolvedDevices
        : Array.isArray(msprof.requestedDevices) ? msprof.requestedDevices.filter(v => typeof v === "number") : [];
      const withSamples = devices ? Object.entries(devices).filter(([, d]) => typeof d.samples === "number" && d.samples > 0) : [];
      const parseErrors = msprof.csv_parse_errors && Array.isArray(msprof.csv_parse_errors) ? msprof.csv_parse_errors.length : 0;
      const status = withSamples.length === 0 ? "missing（无有效样本）"
        : `partial${requested.length && withSamples.length < requested.length ? `（${withSamples.length}/${requested.length} 卡）` : ""}${parseErrors ? `（${parseErrors} 条解析告警）` : ""}`;
      const complete = withSamples.length > 0 && (!requested.length || withSamples.length >= requested.length) && parseErrors === 0;
      const statusText = complete ? "complete" : status;
      lines.push("#### msprof 服务级 profiling", "",
        `采集状态：${statusText}；`
        + `设备数：${agg?.device_count ?? "—"}；mac_fp16_ratio 均值：${typeof mean === "number" ? mean.toFixed(4) : "—"}。`, "");
      if (devices && Object.keys(devices).length) {
        lines.push("| 设备 | mac_fp16_ratio | mac_int8_ratio | 样本数 |", "| --- | --- | --- | --- |");
        for (const [id, dev] of Object.entries(devices)) {
          const fp16 = typeof dev.mac_fp16_ratio === "number" ? dev.mac_fp16_ratio.toFixed(4) : "—";
          const int8 = typeof dev.mac_int8_ratio === "number" ? dev.mac_int8_ratio.toFixed(4) : "—";
          lines.push(`| ${id} | ${fp16} | ${int8} | ${dev.samples ?? "—"} |`);
        }
        lines.push("", "mac_fp16_ratio 是 msprof sample-based 采集的 AICore FP16 MAC 占空比真值，与 npu-smi AICore% 无对应关系。0.85 为 compute_bound 参考阈值（待标定）；低于该值且吞吐停滞时墙型为 host_overhead。", "");
      }
    } else if (msprofAttempt && msprofAttempt.status === "error") {
      const requestedText = Array.isArray(msprofAttempt.requestedDevices)
        ? (msprofAttempt.requestedDevices.join(", ") || "—")
        : String(msprofAttempt.requestedDevices ?? "—");
      lines.push("#### msprof 服务级 profiling", "",
        `采集失败：${typeof msprofAttempt.code === "string" ? msprofAttempt.code : "unknown"}；请求设备：${requestedText}。证据见 msprof-telemetry.json。`, "");
    }
    if (summary.replayCoverage) {
      const coverage = summary.replayCoverage;
      lines.push(`完整回放覆盖率：${coverage.completedTraces} / ${coverage.selectedTraces} 个 trace；${coverage.observedRequests} / ${coverage.expectedRequests} 次请求；成功 ${coverage.successfulRequests}，失败 ${coverage.failedRequests}，取消 ${coverage.cancelledRequests}；缺失 ${coverage.missingRequests}，重复 ${coverage.duplicateRequests}，未知 ${coverage.unexpectedRequests}。`, "");
    }
    if (summary.telemetry) {
      const vllm = summary.telemetry.sources.filter(source => source.kind === "vllm");
      const npu = summary.telemetry.sources.filter(source => source.kind === "ascend");
      const status = (sources: typeof npu) => sources.length ? sources.every(source => source.status === "complete") ? "complete"
        : sources.every(source => source.status === "unavailable") ? "unavailable" : "partial" : "未启用";
      lines.push(`采集状态：推理服务 ${status(vllm)}；${npu.length ? `NPU ${status(npu)}` : "硬件指标未启用"}。`, "",
        "采集状态表示已保存指标的数据可用性，不要求每次监控抓取都成功；请求测评有效性以 Harness 判断为准。", "",
        `监控抓取失败次数：${summary.telemetry.collectionErrors ?? "未记录"}（全部端点合计，不能归属到某个来源）。临时失败后继续采集，保留已获得的统计。`, "",
        "Gauge 沿用上游采样统计；Counter 按各端点的采集顺序计算窗口内增量与每秒速率，不按可回拨的时间戳重排。窗口外快照不计入，可能与逐请求 token 汇总存在采样边界差额。各标签序列独立展示。硬件是指定设备与芯片的观察值，不代表单个请求独占的消耗。", "");
      for (const source of summary.telemetry.sources) {
        lines.push(`#### ${source.kind === "vllm" ? "推理服务" : `NPU ${source.deviceId} / chip ${source.chipId ?? "未发现"}`}`, "",
          `来源 ${source.kind}：${escape(source.endpoint ?? "未启动")}；采集状态 ${source.status}；profiling 样本 ${source.samples}；预热样本 ${source.warmupSamples}${source.kind === "ascend" ? `；物理 NPU ${source.deviceId} / chip ${source.chipId ?? "未发现"}` : ""}。`, "",
          `profiling 聚合窗口（Unix ns）：${source.window ? `${source.window.startNs} — ${source.window.endNs}` : "—"}；预热窗口：${source.warmupWindow ? `${source.warmupWindow.startNs} — ${source.warmupWindow.endNs}` : "—"}。窗口沿用 Harness，可能包含最终采样边界。`, "",
          `未提供指标：${escape(source.missingMetrics.join(", ")) || "—"}；采集问题：${escape(source.errors.join("; ")) || "—"}。`, "",
          `采样告警：${escape(source.warnings?.join("; ") ?? "") || "—"}。`, "",
          "| 阶段 | 指标 | 标签 | 单位 | 均值 | 最小 | 最大 | 增量 | 每秒速率 |",
          "| --- | --- | --- | --- | --- | --- | --- | --- | --- |");
        for (const [phase, series] of [["profiling", source.series], ["warmup", source.warmupSeries]] as const) {
          for (const s of series) lines.push(`| ${phase} | ${escape(s.metric)} | ${escape(JSON.stringify(s.labels))} | ${s.unit} | ${number(s.mean)} | ${number(s.min)} | ${number(s.max)} | ${number(s.total)} | ${number(s.rate)} |`);
          const labelKey = (tags: Record<string, string>) => JSON.stringify(Object.entries(tags).sort(([a], [b]) => a.localeCompare(b)));
          for (const hits of series.filter(s => s.metric === "vllm:prefix_cache_hits")) {
            const queries = series.find(s => s.metric === "vllm:prefix_cache_queries" && labelKey(s.labels) === labelKey(hits.labels));
            const ratio = hits.total !== null && queries?.total && queries.total > 0 ? hits.total / queries.total : null;
            lines.push(`| ${phase} | prefix cache 命中率 | ${escape(JSON.stringify(hits.labels))} | ratio | ${number(ratio)} | — | — | — | — |`);
          }
        }
        lines.push("");
      }
      lines.push("监控缺失或告警不改变请求吞吐、延迟和 Harness 的测评有效性；使用硬件统计时需同时核对可用样本和采集问题。", "");
    } else if (!summary.workload.collection) {
      lines.push("采集状态：推理服务未启用；硬件指标未启用。", "");
    }
  }
  lines.push("缺失值显示 —，不补成 0。usage 仅汇总预热与 profiling 均有统计的已知 token 数，不代表服务商账单。", "");
  return lines;
}
