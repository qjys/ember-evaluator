# 推荐测评与 gr-a2 北极星指标对照

承接[推荐性能测评接入](2026-11-19-feature-recommendation.md)。本次以 gr-a2 的 `gr_diag.py`、`c1_stage_report.py` 和 `north_star_report.py` 的可执行逻辑为准。目标是对同一批正式样本和同一份计数器快照，离线得到相同的延迟分布、吞吐、阶段占比、快路和历史预算判定。

| 之前已有 | 本次补充或修正 |
| --- | --- |
| 完整请求 E2E p50 | mean、p95、p99；非流式 TTFT、逐请求 per-token、全部候选 token 数和聚合 TPOT |
| 正式请求数与有效请求数 | 正式窗口与 QPS；分别统计成功响应、失败、SID 合法、分数有限 |
| 服务端 span、prefill、pf_sel、decode1、decode2、tail 均值 | 各段占比、主段、client gap 和 cli%、admission/commit、每步与 selection、overshoot |
| 快路 forward 次数和比例 | groups、rows、skip、异常、decode 分支和 PID；标准 fast 以 L=128 的实际命中比例判定 |
| 可选同 session eager 对照 | 原脚本 910B2 eager 五档预算与差额、910B1 graph 比值、L=128 子目标和五档整体判定 |

每次请求的证据保存在 attempt，汇总从持久化数据重算。旧 run 未采集的分母留空。完整服务端快照不可用时，该标准档不能作为有效结论。Profiler 仍按原流程在计时结束后单独采集。

## 验收

- 同一份固定样本分别进入原 Python 统计函数和编译后的 Evaluator。全部成功、混合错误、全失败三组的 E2E、token、TPOT、QPS、SID/分数计数、分阶段均值、占比与有效性一致。
- 模拟 HTTP 服务收到的 catalog 请求和每档 2 次预热、8 次正式生成请求正文与原客户端相同。验证了并发 3、HTTP 错误、截断响应、非法候选、计数器重置失败和不可用快照。
- 最终依赖检查（`node scripts/check-dependencies.mjs`）、类型检查和构建通过。构建版 CLI dry-run 按顺序列出五档。推荐专项 3 个文件、9 个用例全部通过，覆盖逐请求 TTFT、混合失败、L=128 零命中但长档命中、L=128 达标但整体未达标、缺档、旧数据以及停服后离线重建。
- 全仓 `pnpm test --run` 有 2412 个用例通过、30 个失败、117 个跳过。失败来自原有 Kernel profiling/计时 28 个、AISBench synthetic 1 个、包管理器路径 1 个。日志包含 Windows 上 `python3` 不可执行、符号链接权限、profiling 产物缺失、临时目录长短路径不一致。
- 目标 NPU、真实词表与五档数据在服务主机上。此次验证不产生真实 NPU 性能读数。
