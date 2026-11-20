# 推荐性能测评接入

目标是接入同机已启动的 SGLang-GR 服务，以真实客户端协议测量五档 E2E。依据[本次设计](../../design/2026-11-19/2026-11-19-recommendation-performance.md)实现并验证。vLLM-GR 实测与引擎代码改动属于后续阶段。

已按 north_star_report、c1_stage_report 和 gr_diag 核对 HTTP 和计时口径。已在仓库实现两种场景、数据来源锁、Python 压测客户端、公开服务绑定、离线指标、报告与 Playbook。Python 客户端独立运行。真实 NPU 对照待验收。

## 验证

- 推荐专项 3 个测试文件、7 个用例通过。模拟服务验证五档逐请求执行、输入轮换、快路、离线重建，以及源文件变更后续跑被拒绝。词表检查使用受控夹具。
- 构建版 CLI 发现 `recommendation`，两个正式 Playbook 通过 dry-run，分别枚举五档和单档。
- 同一模拟服务对比原版 gr_diag 和本仓库客户端。catalog 注册和 10 次生成请求的 POST 正文逐字节相同。同一批正式样本的 p50 相同。自定义并发 3、HTTP 错误、截断响应、非法 SID、非有限分数、重置失败及探针缺失均已验证。
- 构建版 CLI 收到 1 个合法和 1 个非法 SID 时返回退出码 1，保留非法 token ID，有效请求数为 1，p50 为 null。停服后重建相同指标。
- 类型检查、构建和直接运行依赖检查脚本通过，静态依赖违规为 0。当前 package.json 未提供 `check:dependencies` 命令。
- 最终 `pnpm test --run` 共 2409 个用例通过、31 个失败、117 个跳过。推荐场景全部通过。失败分布为 Kernel profiling/计时 28 个、Docker 构建准备 1 个、包管理器路径 1 个、AISBench synthetic 1 个。日志包含 Windows 上找不到可执行的 python3、profiling 产物缺失、Docker 步骤超时和临时目录长短路径不一致。

本机没有监听 30000 端口的 GR 服务，也没有实验使用的 NPU、权重或完整数据。真实五档延迟、阶段时间、fast 命中以及真实词表校验留给目标机验收。vLLM-GR 运行接入属于第二阶段。
