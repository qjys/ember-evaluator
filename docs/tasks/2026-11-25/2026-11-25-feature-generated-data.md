# 推荐生成数据验收

实现 YAML 数据来源选择。验收覆盖生成参数、固定种子复现、整条 prompt 的实际 token 数、非法输入提前终止、文件回放与双服务共享。见[设计](../../design/2026-11-25/2026-11-25-recommendation-dataset.md)。

- 已在 recommendation 来源准备阶段接入离线生成器，保存 prompt 数组和带 SHA-256 的清单。文件回放使用原有的 source revision 规则。新增自定义生成示例、中英文使用指南和报告中的数据来源。
- 依赖边界检查（`node scripts/check-dependencies.mjs`）、`pnpm typecheck`、`pnpm build` 通过。
- 推荐测评的 5 个测试文件共 18 项通过，覆盖旧配置、非法配置、固定种子、损坏检测、预热与正式请求的轮换、双采集使用相同输入和离线报告。通过本地 HTTP 夹具比对生成及回放的请求。
- 另用 Transformers 4.57.6 和本地构造的 SID 词表重跑生成与回放的两个测试，均通过。构建后的 CLI 离线检查 custom 的 500 条和 north-star 的 20 条样本，各档实际长度均在示例的 8 token 容差内。
- Windows 全仓默认测试 2521 项通过、135 项跳过、32 项失败。失败位于 kernel、package-manager、AISBench 和 Docker 测试，包含 `python3` 命令缺失和超时；推荐测试全部通过。
- 部署词表、业务 catalog 和真实 SGLang-GR/NPU 上的端到端性能留待部署环境验收。本地测试使用合成数据。
