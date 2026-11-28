# 实验 YAML 字段参考

> [English](experiment-yaml.md) | 中文

本页列出实验 YAML 的公共字段。各组件 `config` 里的专属参数见[插件参数索引](#插件参数索引)。独立配置文件见[网络 YAML 参考](network.zh-CN.md)和[插件 patch 格式](../../development/plugins.md#用---patch-引用外部插件)。

下文的默认值是框架兜底值，表中另有说明的除外。框架先应用 Benchmark Profile（含版本和场景）及 Solver Profile，再应用实验 YAML 和适用的 CLI 覆盖项。数组整体替换。`services.<name>.model` 等路径中的 `<name>` 指实际服务名。[渐进式实验配置](../config.zh-CN.md)

## 顶层字段

| 字段 | 类型 | 必填条件或默认值 | 用途与限制 |
| --- | --- | --- | --- |
| `hardware` | 枚举 | 可选，框架默认 `npu` | 取 `npu` 或 `gpu`，作用于整个实验。实际支持范围由组件决定。 |
| `services` | 映射 | 必填，至少一个服务 | 按服务名声明模型服务。 |
| `benchmark` | 字符串或对象 | 必填 | Benchmark 名，或包含版本、场景和组件选择的对象。 |
| `environment` | 字符串或对象 | 可选，框架默认 `docker` | 选择任务执行环境。 |
| `scheduler` | 字符串或对象 | 可选，框架默认 `local` | 选择调度器。框架的本地调度并发默认 `1`。 |
| `store` | 字符串或对象 | 可选，框架默认 `local` | 选择保存 Attempt 证据和运行结果的组件。 |
| `reporter` | 字符串或对象 | 可选，框架默认 `markdown` | 选择报告生成组件。 |
| `metrics` | 非空数组 | 可选，框架默认 `[success-rate, duration, usage]` | 每项是指标名或选择对象。显式列表整体替换 Profile 列表。 |
| `run` | 对象 | 可选 | 控制选题、运行时限和环境准备。 |
| `output` | 对象 | 可选 | 设置实验结果目录。 |
| `deployment` | 对象 | 可选，Ray 简写时自动补齐 | 选择 Ray Jobs 提交目标。自动补齐条件见部署表。 |

## 模型服务

| 字段 | 类型 | 必填条件或默认值 | 用途与限制 |
| --- | --- | --- | --- |
| `services.<name>` | 对象 | 每个声明的服务必填 | 服务名可含字母、数字、下划线和连字符，首字符为字母或下划线。 |
| `services.<name>.model` | 非空字符串 | 必填 | 发送给服务的模型标识。 |
| `services.<name>.base_url` | 非空字符串 | 必填 | 模型请求的基础地址，须符合所选协议。 |
| `services.<name>.api_key` | 环境变量引用字符串 | 绑定服务执行时需要，可由支持的 CLI 选项提供 | YAML 使用完整引用，如 `${MODEL_API_KEY}`。CLI 凭证覆盖只作用于 Solver 服务。`inspect` 允许缺少凭证。 |
| `services.<name>.api` | 枚举 | 可选，默认 `openai-completions` | 取 `openai-completions`、`openai-responses`、`anthropic-messages` 或 `google-generative-ai`。适配器支持范围各不相同。 |
| `services.<name>.provider` | 枚举 | 可选，默认未设置 | 取 `amazon-bedrock`、`anthropic`、`azure-openai`、`deepseek`、`google`、`groq`、`mistral`、`openai` 或 `xai`。 |
| `services.<name>.maxTokens` | 正整数 | 可选，默认未设置 | 支持该字段的适配器用它限制输出 token。省略时由适配器或服务决定。 |
| `services.<name>.contextWindow` | 正整数 | 可选，默认未设置 | 支持该字段的适配器使用的模型上下文窗口，单位为 token。 |
| `services.<name>.retry` | 对象 | 可选，省略时由适配器决定 | 为支持该配置的适配器设置模型请求重试规则。 |
| `services.<name>.retry.maxAttempts` | 正整数 | 填写 `retry` 时必填 | 单次模型请求最多尝试多少次，含首次请求。 |
| `services.<name>.inputModalities` | 非空枚举数组 | 可选，省略时由适配器决定 | 从 `text`、`image`、`pdf` 中声明支持的输入类型，元素不可重复。 |

各适配器的配置行为见 [Solver 与模型服务](../solvers.zh-CN.md#模型服务与独立裁判)和[图片与 PDF 评测](../multimodal.zh-CN.md)。

Claude Code 等使用 Evaluator Messages 转发层的 CLI 只需设置 `model`、`base_url`、`api: anthropic-messages` 和 `api_key`。转发层持有服务 Key，先用 `x-api-key`，收到上游 HTTP 401 时改用 `Authorization: Bearer` 再尝试一次。成功后，本次转发生命周期内沿用该请求头。两种鉴权方式都使用原生 Messages 协议。接入网关时，同样在这几个字段中填写网关地址和 Key。

## Benchmark、Solver 与 Verifier

| 字段 | 类型 | 必填条件或默认值 | 用途与限制 |
| --- | --- | --- | --- |
| `benchmark.name` | 非空字符串 | 使用对象写法时必填 | 选择已注册的 Benchmark 或 Benchmark Profile。`benchmark: gsm8k` 是 `benchmark: { name: gsm8k }` 的简写。 |
| `benchmark.version` | 非空字符串 | 可选，采用 Profile 的 `defaultVersion`（如有） | 使用所选 Profile 声明的版本。给 `"1.0"` 这类版本号加引号。 |
| `benchmark.scenario` | 非空字符串 | 可选，采用 Profile 的 `defaultScenario`（如有） | 使用所选 Profile 声明的场景。 |
| `benchmark.evaluationScenario` | `task` 或 `inference-engine` | 可省略，由 Benchmark Profile 选择 | 控制结果目录。GSM8K 按题保存。AgentX 和 AISBench 压测按并发保存。AISBench 原生模式只制数或校验数据时按任务保存。 |
| `benchmark.config` | 对象 | 可选，由 Profile 提供或为空对象 | 所选 Benchmark 的专属参数。 |
| `benchmark.solver` | 字符串或对象 | 可选，取 Profile 或框架默认 `simpleagent` | 选择本 Benchmark 使用的 Solver。对象支持 `name`、`config` 和 `service`。 |
| `benchmark.solver.name` | 非空字符串 | 可选，取所选 Profile 或 `simpleagent` | 已注册的 Solver 名或 Solver Profile 名。 |
| `benchmark.solver.config` | 对象 | 可选，取合并后的设置或空对象 | 所选 Solver 的专属参数。 |
| `benchmark.solver.service` | 非空字符串 | 能确定默认服务时可选 | 引用 `services` 下的服务。合并后未指定时，使用 `services.default` 或唯一服务。多服务且无 `default` 时须显式指定。 |
| `benchmark.verifier` | 字符串或对象 | 可选，取 Profile 或保持未设置 | 为使用独立 Verifier 的 Benchmark 选择验证器。对象支持 `name`、`config` 和 `service`。 |
| `benchmark.verifier.name` | 非空字符串 | 选择 Verifier 时，合并后必须有值 | 已注册的 Verifier 名。 |
| `benchmark.verifier.config` | 对象 | 可选，取合并后的设置或空对象 | 所选 Verifier 的专属参数。 |
| `benchmark.verifier.service` | 非空字符串 | 可选，取 Profile 或保持未设置 | 需要模型的 Verifier 可绑定服务。显式设为 `$default` 时按 Solver 的默认服务规则查找。 |

用 `arsi-evaluator benchmark list` 查看可用 Benchmark，用 `arsi-evaluator benchmark info <name>` 查看指定 Benchmark 的版本、场景和解析后的设置。

## Environment、Scheduler、Store、Reporter 与 Metrics

组件可写成 `reporter: markdown`，也可写成 `reporter: { name: markdown, config: {} }`。`metrics` 数组里的每项也支持这两种写法。`platform`、`concurrency` 和 `nodes` 可以平铺或放在 `config` 下，同一选项写两处会报错。

| 字段 | 类型 | 必填条件或默认值 | 用途与限制 |
| --- | --- | --- | --- |
| `environment.name`, `scheduler.name`, `store.name`, `reporter.name`, `metrics[].name` | 非空字符串 | 合并默认配置后必须有值 | 按注册名选择实现。字符串简写直接设置名称。 |
| `environment.config`, `scheduler.config`, `store.config`, `reporter.config`, `metrics[].config` | 对象 | 可选，取合并后的设置或空对象 | 参数由所选实现校验。更换实现名时清除上一实现的专属参数。 |
| `environment.platform` | 枚举 | Docker 可选，默认 `auto` | `environment.config.platform` 的简写。取 `auto`、`linux/amd64` 或 `linux/arm64`。任务声明的平台优先。 |
| `scheduler.concurrency` | 正整数 | 可选，Local 默认 `1`，Ray 未设置时使用可用执行槽位 | `scheduler.config.concurrency` 的简写。限制同时执行的任务数。 |
| `scheduler.nodes` | 正整数 | Ray 可选 | `scheduler.config.nodes` 的简写。从已有集群选择指定数量的执行节点。符合条件的节点不足时会报错。 |

## 选题和执行

| 字段 | 类型 | 必填条件或默认值 | 用途与限制 |
| --- | --- | --- | --- |
| `run.taskIds` | 非空字符串数组或 null | 可选，框架默认 `null` | 按任务 ID 筛选。`null` 表示不按 ID 筛选。未知 ID 会报配置错误。 |
| `run.sampling` | 对象 | 可选，省略时保留数据来源顺序 | 启用可复现的随机排列，随后应用偏移和题数上限。 |
| `run.sampling.strategy` | 枚举 | 填写 `sampling` 时必填 | 取 `random`。 |
| `run.sampling.seed` | 整数 | 填写 `sampling` 时必填 | 随机种子，范围 `0` 至 `4294967295`，含两端。 |
| `run.offset` | 非负整数 | 可选，等效默认 `0` | 在筛选和抽样后跳过指定数量的题目。 |
| `run.maxTasks` | 正整数或 null | 可选，框架默认 `null` | 限制应用偏移后运行的题数。`null` 表示不设此上限。 |
| `run.timeoutSeconds` | 正整数 | 可选，框架默认 `7200` | 整题 Attempt 的时限，单位为秒。派发前已完成的环境准备单独计时。 |
| `run.solveTimeoutSeconds` | 正整数 | 可选，省略时沿用任务声明或整题时限 | 覆盖任务的解题时限，单位为秒，仍受整题剩余时间限制。 |
| `run.verifyTimeoutSeconds` | 正整数 | 可选，省略时沿用任务声明或整题时限 | 覆盖任务的验证时限，单位为秒，仍受整题剩余时间限制。 |
| `run.scoreAfterSolveTimeout` | 布尔值 | 可选，等效默认 `true` | 质量评测解题超时后，在整题剩余时间内尝试用已有产物评分。设为 `false` 时跳过验证并记有效 0 分。 |
| `run.onError` | 枚举 | 可选，框架默认 `continue` | 对受此配置控制的任务故障，选择继续 `continue` 或中止 `abort`。 |
| `run.includeTaskAnswer` | 布尔值 | 可选，等效默认 `false` | 在结果中保存任务提示词，以及 Benchmark 允许公开的答案（如有）。 |

选题顺序是先按任务 ID 筛选，再按需随机排列，最后应用偏移和题数上限。CLI 的 `--task-ids-file` 会替换配置里的任务 ID，并清除抽样、偏移和题数上限。部分基础设施故障会直接停止派发，具体行为见错误码说明。[选题示例](../usage.zh-CN.md#查看并保存实际任务-id) · [时限规则](../config.zh-CN.md#整题与阶段超时) · [错误码](errors.zh-CN.md)

## 环境准备

| 字段 | 类型 | 必填条件或默认值 | 用途与限制 |
| --- | --- | --- | --- |
| `run.preparation` | 对象 | 可选 | 覆盖所选调度器的环境准备行为。 |
| `run.preparation.mode` | 枚举 | 可选，Local 默认 `pipeline`，其他调度器默认 `batch` | 选择边准备边执行的 `pipeline`，或整批准备后执行的 `batch`。Profile 可选择其他受支持的模式。 |
| `run.preparation.concurrency` | 正整数 | 可选，跟随执行并发 | 限制同时准备的环境数，实际并发受可用槽位和题数限制。 |
| `run.preparation.lookahead` | 正整数 | 流水线可选，默认 `max(10, preparation.concurrency)` | 限制准备中和已就绪但尚未执行的题数。仅用于 `pipeline`，且不得小于准备并发。 |
| `run.preparation.environmentTimeoutSeconds` | 有限正数 | 可选，省略时取任务声明或 Benchmark 默认值 | 求解或验证环境的基础准备时限，单位为秒。实际时限随准备并发放宽，倍率最多为 10。 |
| `run.preparation.roundTimeoutSeconds` | 有限正数 | 可选，默认无显式整轮上限 | 设置整轮准备上限，单位为秒。该上限不乘准备并发。 |

准备时限乘以适用的并发倍率后，须能转换为不超过 2,147,483,647 毫秒的定时器。显式设置整轮上限时，batch 按实际经过时间计算，本地 pipeline 只累计有准备工作进行的时间。[准备时限](../config.zh-CN.md#环境准备时限) · [并发与环境准备](../concurrency.zh-CN.md)

## 输出和 Ray Jobs 部署

| 字段 | 类型 | 必填条件或默认值 | 用途与限制 |
| --- | --- | --- | --- |
| `output.directory` | 非空字符串 | 可选，按 Benchmark 名和 YAML 文件名生成 | 默认位于 Evaluator 包根目录或仓库根目录下的 `results/<benchmark>/<yaml-stem>/`，各 Run 目录在其下创建。显式相对路径以实验 YAML 所在目录为基准。 |
| `deployment.kind` | 枚举 | 显式填写 `deployment` 时必填 | 与 Ray 调度器搭配使用，取 `ray-jobs`。 |
| `deployment.endpoint` | HTTPS origin | 可选，默认 `https://localhost:9443` | Ray Jobs 网关地址。使用 HTTPS 主机和可选端口，仅允许根路径 `/`，地址不得带认证信息、查询参数或片段。 |
| `deployment.caFile` | 非空路径字符串 | 使用默认本机地址之外的端点时必填 | 用于验证网关的 CA 证书。默认本机端点使用配套本机 Ray 的证书路径。 |
| `deployment.tokenEnv` | 环境变量名 | 可选，默认 `EVALUATOR_JOBS_TOKEN` | 存放网关令牌的变量名。可含字母、数字和下划线，首字符为字母或下划线。 |
| `deployment.managedLocal` | 布尔值 | 显式块默认 `false`，自动补齐的本机部署使用 `true` | 设为 `true` 时准备配套本机集群，要求地址为 `https://localhost:9443`。 |

当 `scheduler.name` 为 `ray`，且省略 `deployment` 与 `scheduler.config.endpoint` 时，框架会自动补齐托管本机 Ray Jobs 配置。连接现有 Ray Client 时，显式填写 `scheduler.config.endpoint`，由当前进程协调。使用 Ray Jobs 部署时，`scheduler.config` 只接收 `concurrency` 和 `nodes`。[Ray 配置示例](../config.zh-CN.md#ray-与执行节点)

## 插件参数索引

`config` 内的字段由所选组件的校验器决定。可按实现查阅对应指南。指南仅介绍常用设置时，表中也提供注册入口或校验源码。`metrics[].name` 也可以使用 Profile 声明的指标别名。

| YAML 路径 | 参数说明入口 |
| --- | --- |
| `benchmark.config` | [Benchmark 指南](../benchmarks/README.zh-CN.md) · [Harbor 默认配置](../benchmarks/harbor.zh-CN.md) · [AgentX 配置](../benchmarks/agentx.zh-CN.md#并发与配置) · [Kernel 性能采集](../benchmarks/kernel-npu.zh-CN.md#详细性能采集) · [OfficeQA Pro V2](../benchmarks/officeqa-pro-v2.zh-CN.md) |
| `benchmark.solver.config` | [Solver 指南](../solvers.zh-CN.md) · [AgentX 遥测](../benchmarks/agentx.zh-CN.md#vllm-与-ascend-npu-指标) · [Solver 注册入口](../../../src/plugins/solvers/index.ts) |
| `benchmark.verifier.config` | [验证器与裁判模型](../config.zh-CN.md#验证器与裁判模型) · [Harbor 验证说明](../benchmarks/harbor.zh-CN.md) · [Verifier 注册入口](../../../src/plugins/verifiers/index.ts) |
| `environment.config` | [Docker 平台选择](../deployment/docker-platform.zh-CN.md) · [Local 与 Docker 校验器](../../../src/plugins/environments/index.ts) |
| `scheduler.config` | [并发指南](../concurrency.zh-CN.md) · [Ray 连接示例](../config.zh-CN.md#ray-与执行节点) · [Ray Client 校验器](../../../src/config/ray.ts) |
| `store.config` | [Local Store 校验器](../../../src/plugins/stores/index.ts)，包括 `runIndexDirectory` |
| `metrics[].config` | [评分与指标分母](scoring.zh-CN.md) · [Metrics 注册入口](../../../src/plugins/metrics/index.ts) |
| `reporter.config` | [阅读报告](../usage.zh-CN.md#如何读结果) · [Markdown Reporter 校验器](../../../src/plugins/reporters/index.ts) |

外部插件以其文档和校验器为准。给 `inspect` 和 `run` 传同一份 `--patch`，使两条命令选择相同的注册组件。[加载外部插件](../../development/add-external-plugin.md)

## 从可运行配置开始

在仓库根目录运行下面的命令。执行 `inspect` 前先设置生成的 YAML 引用的模型环境变量。该命令会展示应用框架和 Profile 默认值后的配置，并校验所选组件的参数。插件在运行时补齐的默认值可查对应插件说明。

```bash
arsi-evaluator init --benchmark gsm8k --output experiment.yaml
arsi-evaluator inspect experiment.yaml
```

[模型配置与两题快速入门](../quick-start.zh-CN.md) · [可运行的 Playbook](../../../playbook/README.md) · [CLI 命令参考](cli.zh-CN.md)
