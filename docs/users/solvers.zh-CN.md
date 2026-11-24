# 选择 Solver 和模型服务

> [English](./solvers.md) | 中文

Benchmark 决定任务和评分，Solver 决定模型请求或 Agent 怎样执行。普通 Agent 任务可先用默认 SimpleAgent 跑通；MMLU 和 AgentX 使用各自的默认 Solver。修改后先做配置检查，并开始新的 run。

## 控制工具和网页访问

在 `benchmark.solver.config` 中设置以下字段。省略字段或使用 `default` 保留原生行为。显式禁用优先于自动审批。

| 字段 | 可用值 | 实际行为 |
| --- | --- | --- |
| `tools` | `default`、`none` | `none` 关闭 Solver 内置工具，包括 WebSearch、WebFetch 和评测器自动补充的搜索。任务、项目或 Bundle 自行声明的 MCP 保留。再设 `mcp: disabled` 可同时关闭 MCP。只关闭 Codex Shell 可用 `shellTool: disabled`。 |
| `webSearch`、`webFetch` | `default`、`enabled`、`disabled` | 分别控制搜索和网页抓取。设置 `tools: none` 时两者均关闭。 |
| `subagent`、`mcp`、`skills` | `default`、`disabled` | 分别关闭委派、MCP 连接或技能加载。Codex 和 TRAE 向原生应用服务查询技能路径并逐项禁用。 |

### 各 Solver 支持的开关

所有行都接受六个字段，取值见上表。`支持` 表示该 Harness 可以控制此能力。网页列同时说明工具来自哪里；`原生无` 表示缺省没有对应工具，项目或 Bundle 扩展可以另外提供。

| Solver | `tools` | `webSearch` | `webFetch` | `subagent` | `mcp` | `skills` |
| --- | --- | --- | --- | --- | --- | --- |
| Codex | 支持 | 原生或补充 MCP | 独立抓取用 MCP | 支持 | 支持 | 支持 |
| TRAE | 支持 | 原生或补充 MCP | 支持 | 支持 | 支持 | 支持 |
| Claude Code | 支持 | Hook / Exa | 支持 | 支持 | 支持 | 支持 |
| CodeBuddy | 支持 | 原生或补充 MCP | 支持 | 支持 | 支持 | 支持 |
| Qwen Code | 支持 | 原生或补充 MCP | 支持 | 支持 | 支持 | 支持 |
| Kimi Code | 支持 | 原生或补充 MCP | 支持 | 支持 | 支持 | 支持 |
| MiniMax Code | 支持 | 原生或补充 MCP | 支持 | 支持 | 支持 | 支持 |
| ZCode | 支持 | 补充 MCP | 支持 | 支持 | 支持 | 支持 |
| OpenCode | 支持 | 原生 Exa | 支持 | 支持 | 支持 | 支持 |
| SimpleAgent（无 Bundle） | 支持 | Pi / Exa | 原生无 | 原生无 | 支持 | 支持 |
| DSH (Bundle) | 支持 | DSH / Exa | 支持 | 支持 | 支持 | 支持 |
| Pi (Bundle) | 支持 | Pi / Exa | Bundle 提供 | Bundle 提供 | 支持 | 支持 |
| JiuwenSwarm (Bundle) | 支持 | 原生或补充 MCP | 按 Bundle 缺省 | 支持 | 支持 | 支持 |
| DeepAgents (Bundle) | 支持 | 评测器 / Exa | Bundle 提供 | 支持 | 支持 | 支持 |

`tools: none` 可以和 `mcp: disabled` 或任一网页字段的 `disabled` 同用。它与 `webSearch: enabled`、`webFetch: enabled` 分别冲突，因为关闭内置工具也会关闭搜索和抓取。若要使用网页工具，省略 `tools`；若要只保留自行声明的 MCP，省略两个网页字段。

任务网络为 `none` 或 `model-api` 时，默认关闭 WebSearch 和 WebFetch，显式开启任一项会报配置错误。域名白名单允许抓取名单内的地址。当前公共搜索后端无法遵守相同名单，因此白名单任务默认关闭搜索，显式开启会报错。

local 中的文件和 Shell 操作使用当前操作系统用户的权限，可以写任务目录之外该用户有权写入的路径。Docker 保留指定的用户、挂载和网络策略。CodeBuddy 为主 Agent 和子 Agent 分别设置免审批。

网络允许时，保留原生搜索。Claude 通过 WebSearch 结果钩子、DSH 通过搜索服务钩子，在原生工具没有来源时自动查询 Exa，再尝试当前模型服务。支持模型函数调用的 CLI 还可在下一次请求中匹配原生调用及其结果，自动用补充 MCP 的结果补全失败的查询。在原生函数和补充工具同时可用时优先原生函数。仅暴露厂商托管搜索、没有可配对工具结果的 CLI 仍由 Harness 或模型选择补充工具。OpenCode 的原生 websearch 使用 Exa，回退时直接查询模型服务。Pi 通过扩展工具搜索，Claude 和 Pi 在单独关闭 MCP 后仍有搜索接入方式。

补充搜索成功时记录来源 URL，只有模型正文时记为无来源。断网、`model-api` 和域名白名单任务关闭不能遵守网络范围的搜索方式，包括模型厂商代查。Pi 的自定义网页工具名可在 `config.bundle` 或 `config.pi` 声明。

通过 LiteLLM 调用火山方舟联网搜索时，先确认当前模型名已在代理上部署，并且上游账号已开通该模型的联网搜索服务。用 Responses 请求检查 `web_search_call.action.sources` 或回复中的 `url_citation`。HTTP 200 只能确认请求成功。方舟返回 `ToolNotOpen` 或明确拒绝搜索权限时，attempt 会记录服务未开通或未授权。

准备 Hermes 或 DeepAgents 时，可用 `--network network.yaml` 指定包源和代理。WSL local 使用宿主可达的代理，Docker 的 `build` 与 `runtime` 分别填写容器可达的地址。将本地模型网关的主机名列入 `noProxy`。详见[网络配置](network.zh-CN.md)。

网页开关控制模型可调用的网页工具。保留 Bash 时，命令能否联网由求解环境决定。MMLU-Pro 可在 Docker 中设置 `benchmark.config.solveNetwork: model-api`，让每个求解容器只访问模型 API。可直接使用 [MMLU-Pro Playbook](../../playbook/mmlu-pro/mmlu-pro-simpleagent.yaml)。


## 生成限额与附件

在 `benchmark.solver.config` 中填写正整数。`maxTokens` 限制一次模型回复的输出 token 数。`maxTurns` 限制主 Agent 在一次求解中的执行轮数，各 Harness 按自己的循环计数。`contextWindow` 设置 Harness 用于自动压缩的上下文容量。Harness 可以提前压缩，为下一次回复和摘要预留空间。

Solver 的 `maxTokens` 和 `contextWindow` 优先于当前服务的同名字段，省略则沿用服务配置。两处都省略时使用当前 Harness 和模型的默认配置。填写不支持的字段会报告 Harness 和字段名。AgentBundle 先读取 Bundle 确定实际 Harness，再检查限额。

```yaml
benchmark:
  solver:
    name: claudecode
    config:
      maxTokens: 8192
      maxTurns: 12
      contextWindow: 200000
```

下表记录锁定版本的 Docker 行为验收。通过表示模型端点收到指定输出上限或附件字节、主 Agent 在指定轮数停下，或小窗口实际压缩了历史。原生不支持表示当前 Harness 或 Bundle 入口拒绝该配置。本轮覆盖全部表格项。

| Solver / Harness | `maxTokens` | `maxTurns` | `contextWindow` 自动压缩 | 图片 | PDF 页图 | 原始 PDF |
| --- | --- | --- | --- | --- | --- | --- |
| Codex | 原生不支持 | 原生不支持 | 通过 | 通过 | 通过 | 原生不支持 |
| TRAE CLI | 原生不支持 | 原生不支持 | 通过 | 通过 | 通过 | 原生不支持 |
| Claude Code | 通过 | 通过 | 通过 | 通过 | 通过 | 通过 |
| CodeBuddy | 通过 | 通过 | 通过 | 通过 | 通过 | 通过 |
| Qwen Code | 通过 | 通过 | 通过 | 通过 | 通过 | 通过（Chat Completions、Messages）；Responses 原生不支持 |
| Kimi Code | 通过 | 通过 | 通过 | 通过 | 通过 | 原生不支持 |
| MiniMax Code | 通过 | 通过 | 通过 | 通过 | 通过 | 原生不支持 |
| ZCode | 通过 | 原生不支持 | 通过 | 通过 | 通过 | 通过 |
| OpenCode | 通过 | 通过 | 通过 | 通过 | 通过 | 通过 |
| SimpleAgent | 通过 | 原生不支持 | 通过 | 通过 | 通过 | 原生不支持 |
| DSH (AgentBundle) | 通过 | 原生不支持 | 通过 | 通过 | 通过 | 原生不支持 |
| Pi (AgentBundle) | 通过 | 原生不支持 | 通过 | 通过 | 通过 | 原生不支持 |
| JiuwenSwarm (AgentBundle) | 通过 | 通过 | 通过 | 通过 | 通过 | 原生不支持 |
| DeepAgents (AgentBundle) | 原生不支持 | 原生不支持 | 原生不支持 | 通过 | 通过 | 通过 |

MiniMax Code 0.7.8 的安装补丁在主 Agent 发起模型请求前检查 `maxTurns`。Docker 中分别设置 1 和 2 轮，200,000 和 36,000 token 窗口都严格执行该上限。小窗口下的自动摘要单独执行，最后一个允许轮次仍可正常给出答案。

Claude Code 的窗口范围是 100,000–1,000,000 token。Codex 和 TRAE 的 `exec` 支持设置上下文窗口和自动压缩阈值。ZCode 使用模型配置中的 `properties.contextWindow` 和 `optionSpecs.maxOutputTokens.max`。JiuwenSwarm 使用 `react.max_iterations`、模型请求的 `max_tokens` 和原生上下文引擎。DeepAgents 的模型、循环和摘要策略由 Bundle 的 Python 工厂决定，当前接口无法为任意图覆盖三项限额。

图片和 PDF 页图要求模型支持 `image`。页图模式会先把 PDF 渲染为图片；原始 PDF 要求模型支持 `pdf`，并接受该 Harness 使用的文件格式。上表的图片能力不包含音频和视频。[附件模式与示例](multimodal.zh-CN.md)

## 选哪一种 Solver

| Solver | 用途 | 额外准备 |
| --- | --- | --- |
| `simpleagent` | 内置 Pi Agent，普通质量题与需要工具/文件操作的任务 | 支持工具调用的模型 API；可选 Pi Bundle |
| `agentbundle` | 运行已打包的 DSH、deepagents、Hermes、Jiuwenswarm、pi 或 Dify Agent | 可读取且格式正确的 Bundle，满足对应 Harness 运行条件 |
| `codex` | 用 Codex CLI 处理文本、图片和 PDF 页图，执行命令和生成任务文件 | 支持流式 Responses API 和工具调用的模型服务 |
| `claudecode` | 用 Claude Code 处理文本、图片和 PDF，在本机和 Docker 中执行 Bash | 支持流式 Anthropic Messages API 和工具调用的模型服务 |
| `zcode` | 用 ZCode CLI 处理文本、图片和 PDF，在本机和 Docker 中执行 Bash | 支持流式 Chat Completions、Responses 或 Messages 和工具调用的模型服务 |
| `trae` | 用 TRAE CLI 2.0 处理文本、图片和 PDF 页图，执行 shell 命令 | 支持流式 Chat Completions、Responses 或 Messages 和工具调用的模型服务 |
| `codebuddy` | 用 CodeBuddy Code 处理文本、图片和 PDF，执行 shell 命令 | 支持流式 Chat Completions 或 Responses 和工具调用的模型服务 |
| `qwencode`、`kimicode`、`minimaxcode`、`opencode` | 使用对应的正式 Code CLI，处理文本、图片、PDF 页图与工具任务 | 支持流式 Chat Completions、Responses 或 Messages 的模型服务 |
| `agentx-replay` | 按 Trace 请求模型，测量服务性能 | AgentX 所需的流式 API、长上下文、tokenizer 和 Python 或 Docker |
| `choice-logprobs` | 直接请求单个输出位置的候选概率，供 MMLU 评分 | local 环境；模型服务必须实际返回 logprobs/top_logprobs；按需关闭思考 |

`simpleagent` 是框架通用默认值。AgentX Profile 自动选择 `agentx-replay`；MMLU Profile 自动选择 `choice-logprobs`。MMLU 不能仅靠 Agent 最后输出的字母评分，服务要求、候选缺失处理及 Chat 适配差异见[评分规则](reference/scoring.zh-CN.md#mmlu-概率评分与服务要求)。

每次选择一条求解路径。EnvironmentSession 表示运行接口和进程执行边界，不表示 Solver 插件代码被整体移动进容器；Harness 适配器负责读取输出并构造 `SolveResult`。评分仍由 Benchmark 执行，AgentX 的性能回放见[专项指南](benchmarks/agentx.zh-CN.md)。

## 模型服务与独立裁判

这是同时声明被测模型和 Judge 的完整两题示例：

```yaml
services:
  default:
    model: ${MODEL_NAME}
    base_url: ${MODEL_ENDPOINT}
    api_key: ${MODEL_API_KEY}
  judge:
    model: ${JUDGE_NAME}
    base_url: ${JUDGE_ENDPOINT}
    api_key: ${JUDGE_API_KEY}
benchmark:
  name: simpleqa
  config:
    judgeService: judge
environment: local
run:
  maxTasks: 2
output:
  directory: ./results/simpleqa
```

按[快速上手](quick-start.zh-CN.md#3-设置模型变量)的方式设置六个环境变量，然后运行 `doctor` 和 `run`。把 `simpleqa` 换成 `healthbench` 即使用 HealthBench 的 Profile。

- `benchmark.solver.service` 选择求解服务；省略时优先用 `services.default`，否则使用唯一服务。多个非 default 服务必须明确选择。
- **SimpleQA/HealthBench** 用 `benchmark.config.judgeService` 选择裁判，不会自动把被测模型当作裁判。`init` 会为它们生成 judge 服务变量；想显式复用同一个服务，可填 `judgeService: default`。
- **Harbor/WorkBuddy** 的模型验证器使用 `benchmark.verifier.service`。Web 要求裁判，Office 的模型评分可选，详见[Harbor 指南](benchmarks/harbor.zh-CN.md)。这与记录型 Benchmark 的 `judgeService` 不是同一个配置入口。

`api` 缺省为 `openai-completions`。显式 `base_url` 使用 Chat Completions 时，Pi/SimpleAgent 和内置 Judge 在未给当前调用设置 `maxTokens` 时不发送客户端输出上限；填写正整数时才发送。其他 Provider 和外部 Harness 保留各自协议的配置规则。

如需限制当前服务回复，可以在该服务条目增加 `maxTokens: 8192`。模型请求重试使用 `services.<名称>.retry.maxAttempts`，耗尽后结束当前 Attempt，不自动从头求解。

## SimpleAgent（基于 Pi）

无 Bundle 的 SimpleAgent 有搜索工具，缺省没有网页抓取或委派工具。显式关闭 `webFetch` 或 `subagent` 时，求解进度会提示缺少对应的内置能力，关闭策略仍传给工作目录扩展。`webFetch: enabled` 会在首次模型请求前检查实际工具；如果扩展没有注册 `web_fetch`，该次求解报配置错误。

`simpleagent` 是 Evaluator 内置的 Solver，使用 Pi SDK 执行 Agent 循环、模型请求与工具调用。不配置 Bundle 时，使用 Evaluator 默认的指令和工具即可运行；例如 `benchmark: gsm8k` 会选择默认 SimpleAgent，无需额外准备 Pi Bundle。

### 可选：加载 Pi Bundle

需要定制指令、技能、扩展或设置时，可以提供 Pi Bundle。修改为以下片段，保留原 services、environment 等字段：

```yaml
benchmark:
  name: gsm8k
  solver:
    name: simpleagent
    config:
      bundle:
        path: ${PI_BUNDLE_PATH}
```

路径指向已准备好的 Pi Bundle，不是任意源码目录。可用 `bundle.settings` 提供可序列化的 Pi 设置，框架在暂存副本中使用，不直接改原 Bundle。

Pi Bundle 的 `bundle.yaml` 必须声明 `extensionPolicy: run-v1`。每次求解在独立 Pi 进程内运行。加载扩展前，Evaluator 会把本次六项开关写入 `PI_BUNDLE_RUN_POLICY`。在激活函数内读取策略，再注册工具、连接 MCP、加载技能或创建子 Agent。子 Agent 应继承同一策略。

### 工具命令超时

工具命令另有超时，增加任务总预算不会自动让单条 shell 命令无限执行。需要调整时：

```yaml
benchmark:
  name: gsm8k
  solver:
    config:
      toolPolicy:
        shellTimeoutSeconds: 180
        shellMaxTimeoutSeconds: 600
```

两项都要填写，最大值不能小于默认值；该片段保留默认的 `simpleagent`。工具调用时实际超时不超过最大值。

## 使用 Codex

服务的 `reasoningEffort` 映射到 Codex 原生的 `model_reasoning_effort`。

Codex 保留 `exec` 入口。评测器通过进程内的本地 MCP 提供独立的 `web_fetch`，可在关闭搜索时读取网页正文。关闭抓取会同时撤下 Codex 自带的搜索和打开网页组合工具，此时仍开放的搜索只使用 Exa，返回来源 URL。`mcp: disabled` 会停止补充 MCP；此时显式开启独立抓取，或显式要求开启搜索并关闭抓取，都会在启动前报错。`tools: none` 同时移除补充搜索和抓取，自行声明的 MCP 仍按 `mcp` 开关执行。

`codex` 在本机或 Docker 的任务目录运行 Codex CLI。Evaluator 在首次准备时安装固定版本 `0.167.0`，认证来自所选模型服务。将以下配置保存为实验 YAML，设置 `CODEX_MODEL`、`CODEX_ENDPOINT` 和 `CODEX_API_KEY` 后运行。

```yaml
services:
  codex:
    model: ${CODEX_MODEL}
    base_url: ${CODEX_ENDPOINT}
    api: openai-responses
    api_key: ${CODEX_API_KEY}
benchmark:
  name: gsm8k
  solver:
    name: codex
    service: codex
environment: local
run:
  maxTasks: 1
output:
  directory: ./results/codex
```

- `base_url` 填 API 基址，例如 `https://api.openai.com/v1`，Codex 在该地址下请求 `/responses`。可用 `contextWindow` 指定自动压缩阈值。此 Solver 不支持服务字段 `maxTokens` 和 `retry`。
- Codex 在本机和 Docker 都使用 `danger-full-access` 和 `approval_policy="never"`。
- 使用图片或 `pages` 模式的 PDF 时，在模型服务中设置 `inputModalities: [text, image]`。Codex 会把两种附件都作为图片发送。每次 attempt 的 `agent/` 保存 Codex 事件、Evaluator 轨迹和 stderr。见[图片与 PDF 评测](multimodal.zh-CN.md)。

## 使用 Claude Code

服务中显式设置的 `reasoningEffort` 通过原生 `--effort` 设置主 Agent 的档位。CLI 根据模型支持的档位解析该选项，并按原生规则为子 Agent 和工具辅助请求选择档位。

当任务网络允许抓取时，Claude Code 默认向主 Agent 和子 Agent 开放原生 WebFetch，并设置 `skipWebFetchPreflight` 跳过 Anthropic 的域名安全名单查询。任务使用 `none`、`model-api` 网络，或配置 `webFetch: disabled`、`tools: none` 时，会移除 WebFetch。

Evaluator 在本机和 Docker 中安装固定版本的 Claude Code `2.1.322`。保存以下实验配置，设置 `CLAUDE_MODEL`、`CLAUDE_ENDPOINT` 和 `CLAUDE_API_KEY` 后运行。

```yaml
services:
  claude:
    model: ${CLAUDE_MODEL}
    base_url: ${CLAUDE_ENDPOINT}
    api: anthropic-messages
    api_key: ${CLAUDE_API_KEY}
benchmark:
  name: gsm8k
  solver:
    name: claudecode
    service: claude
environment: local
run:
  maxTasks: 1
output:
  directory: ./results/claudecode
```

- `base_url` 填 API 基址。Claude Code 会在该地址下请求 `/v1/messages`，通过 `x-api-key` 传递认证。Anthropic 原生服务可填 `https://api.anthropic.com`，DeepSeek 兼容服务可填 `https://api.deepseek.com/anthropic`。
- Claude 启动时关闭自带沙箱。Linux UID 0 使用 `dontAsk` 并自动允许已开放的工具，其他用户使用 `bypassPermissions`。两种模式都遵守显式禁用的工具配置。本机和 Docker 都开放 Bash，命令按宿主机或容器进程的权限执行。Windows 需要安装 Git for Windows。如果 Claude Code 找不到 Git Bash，将 `CLAUDE_CODE_GIT_BASH_PATH` 设置为对应的 `bash.exe` 路径。
- Linux 运行时通过仅供当前 attempt 使用的本地转发器访问模型，Bash 启动时会清除转发凭据。
- 图片和 PDF 页图需要在模型服务的 `inputModalities` 声明 `image`。原生 PDF 需要声明 `pdf`，并使用接收 `document` 内容块的 Messages 服务。见[图片与 PDF 评测](multimodal.zh-CN.md)。
- 服务字段 `maxTokens` 传给 Claude Code 的输出用量设置，`contextWindow` 设置自动压缩阈值，允许 100000 到 1000000 token。此 Solver 不接受 `retry`。事件、轨迹和 stderr 保存在每次 attempt 的 `agent/` 目录。

## 使用 ZCode

ZCode 的自定义模型路由通过补充 MCP 提供搜索。`webSearch: enabled` 与 `mcp: disabled` 不能同时设置。关闭 MCP 时仍可独立使用原生 `WebFetch`。

Evaluator 在准备运行时时从固定源码归档构建 ZCode CLI `0.17.1`。首次运行或预热需要访问 GitHub 和 npm registry，后续运行复用构建缓存。预热无需模型密钥。镜像源配置见[网络配置指南](network.zh-CN.md)。

```yaml
services:
  zcode:
    model: ${ZCODE_MODEL}
    base_url: ${ZCODE_ENDPOINT}
    api: openai-completions
    api_key: ${ZCODE_API_KEY}
benchmark:
  name: gsm8k
  solver:
    name: zcode
    service: zcode
environment: local
run:
  maxTasks: 1
  preparation:
    environmentTimeoutSeconds: 1800
    roundTimeoutSeconds: 1800
output:
  directory: ./results/zcode
```

示例给首次构建预留 30 分钟，可按网络情况调整。

`base_url` 使用接口基地址。Chat Completions 或 Responses 通常填写以 `/v1` 结尾的地址。还可设置 `api: openai-responses` 或 `api: anthropic-messages`。此 Solver 不接受服务字段 `retry`。

服务的 `reasoningEffort` 写入 ZCode 原生模型选择中的 `reasoningLevel`。ZCode 根据模型能力解析该档位，并按原生规则为 WebFetch、WebSearch 和后台辅助请求选择档位。

本机和 Docker 都开放 Bash。本机 Bash 具有宿主进程权限，只用于可信任务。Windows 下使用 Bash 工具需要安装 Git Bash。任务需要容器隔离时使用 Docker。

图片和 PDF 页图需要在模型服务的 `inputModalities` 声明 `image`。原生 PDF 需要声明 `pdf`，并使用接收 PDF 的模型服务。每次 attempt 在 `agent/` 下保存脱敏的会话事件、轨迹和 stderr。见[图片与 PDF 评测](multimodal.zh-CN.md)。

## 使用 TRAE CLI

当前 TRAE 版本通过原生 `model_reasoning_effort` 为 Chat Completions 设置档位。如需显式设置服务的 `reasoningEffort`，请使用 `api: openai-completions`。Responses 和 Messages 可省略该字段。

TRAE 的原生 WebFetch 可独立于 MCP 使用。原生搜索需要可用的认证；`mcp: disabled` 会移除评测器补充的 Exa 搜索服务。

Evaluator 在 x64 Windows、WSL 和 Linux Docker 中下载并缓存官方 `traecli` 版本 `0.214.1`。首次运行或预热需要访问 TRAE 发布 CDN，预热无需模型密钥。下载代理使用现有的[网络配置](network.zh-CN.md)。

设置 `TRAE_MODEL`、`TRAE_ENDPOINT` 和 `TRAE_API_KEY` 后运行以下实验。

```yaml
services:
  trae:
    model: ${TRAE_MODEL}
    base_url: ${TRAE_ENDPOINT}
    api: openai-responses
    api_key: ${TRAE_API_KEY}
benchmark:
  name: gsm8k
  solver:
    name: trae
    service: trae
environment: local
run:
  maxTasks: 1
  preparation:
    environmentTimeoutSeconds: 900
    roundTimeoutSeconds: 900
output:
  directory: ./results/trae
```

- TRAE 按所选模型服务的 `api` 请求接口。在 `base_url` 后，`openai-completions` 拼接 `/chat/completions`，`openai-responses` 拼接 `/responses`，`anthropic-messages` 拼接 `/messages`。`base_url` 需要包含服务要求的 API 前缀，例如连接 LiteLLM 时包含 `/v1`。服务字段 `maxTokens` 和 `retry` 须省略。
- WSL 使用 Bash，Windows 原生使用 PowerShell。两者都使用 `danger-full-access`，审批设置为 `never`。
- 使用图片或 PDF `pages` 附件时，在服务中设置 `inputModalities: [text, image]`。PDF 使用页图模式。每次 attempt 在 `agent/` 下保存脱敏的会话事件、Evaluator 轨迹和 stderr。见[图片与 PDF 评测](multimodal.zh-CN.md)。

## 使用 CodeBuddy Code

服务中显式设置的 `reasoningEffort` 通过原生 `--effort` 设置主 Agent 的档位。CLI 根据模型支持的档位解析该选项，并按原生规则为子 Agent 和工具辅助请求选择档位。

2.183.0 使用锁定版本补丁，使 `skills: disabled` 同时关闭项目和插件技能。同一插件的 MCP 仍可在 `mcp` 缺省时运行。

Evaluator 在 x64 Windows、WSL 和 Linux Docker 中安装并缓存独立发布的 `@tencent-ai/codebuddy-code` 版本 `2.183.0`。首次预热或运行使用配置的 npm registry，预热无需模型密钥。设置 `CODEBUDDY_MODEL`、`CODEBUDDY_ENDPOINT` 和 `CODEBUDDY_API_KEY` 后运行以下实验。

```yaml
services:
  codebuddy:
    model: ${CODEBUDDY_MODEL}
    base_url: ${CODEBUDDY_ENDPOINT}
    api: openai-completions
    api_key: ${CODEBUDDY_API_KEY}
    contextWindow: 200000  # 按所选模型服务的上下文容量填写。
benchmark:
  name: gsm8k
  solver:
    name: codebuddy
    service: codebuddy
    config:
      maxTurns: 2000
environment: local
run:
  maxTasks: 1
  preparation:
    environmentTimeoutSeconds: 900
    roundTimeoutSeconds: 900
output:
  directory: ./results/codebuddy
```

- `base_url` 填 API 基址，例如 `https://api.openai.com/v1`。也可选 `api: openai-responses`。`services.<名称>.contextWindow` 写入原生 `maxInputTokens`，CodeBuddy 用它计算自动压缩阈值。`maxTokens` 指定模型输出上限。省略 `retry`。
- `solver.config.maxTurns` 接受正整数，映射到 CodeBuddy 原生 `--max-turns`，限制每次求解的 Agent 执行轮数。省略时不传该参数，保留 CLI 默认值。轮数限制与 `run.solveTimeoutSeconds` 分别生效，先达到的限制会结束求解。
- Windows 原生开放 PowerShell，WSL 和 Docker 开放 Bash。本机命令按宿主进程权限运行，只用于可信任务。Docker 命令在任务容器内执行。
- 工作区的 `.codebuddy/models.json` 会覆盖实验指定的模型端点，发现该文件时 Solver 会在启动 CLI 前报错。使用图片或 PDF `pages` 附件时，设置 `inputModalities: [text, image]`。原始 PDF 需声明 `pdf`，CodeBuddy 将其作为文件发送。每次 attempt 在 `agent/` 下保存脱敏的会话事件、轨迹和 stderr。见[图片与 PDF 评测](multimodal.zh-CN.md)。

## 使用 Qwen Code、Kimi Code CLI、MiniMax Code 和 OpenCode

CodeBuddy 2.183.0、Kimi 2.7.0 和 MiniMax 0.7.8 在安装时校验并应用 Evaluator 的版本补丁。CodeBuddy 可以关闭项目和插件技能。Kimi 可关闭技能和项目 MCP，MiniMax 可关闭项目 MCP，并能在派发主请求前执行轮次上限。Solver 来源记录中的 `capabilityPatchSha256` 标识实际补丁，安装目录的 `capability-patch-receipt.json` 保存每个文件修改前后的 SHA-256。

Evaluator 固定安装以下正式 CLI；不读取宿主已有登录状态，也不使用旧版 Python Kimi CLI。

| Solver 名 | 安装包 | 版本 | 轮次配置对应操作 |
| --- | --- | --- | --- |
| `qwencode` | `@qwen-code/qwen-code` | `0.28.0` | `--max-session-turns`、`model.maxSessionTurns`，并限制本次尝试发出的模型请求数，避免 ACP 忽略启动参数 |
| `kimicode` | `@moonshot-ai/kimi-code` | `2.7.0` | `loop_control.max_steps_per_turn` |
| `minimaxcode` | `@minimax-ai/code` | `0.7.8` | `exec --max-steps` |
| `opencode` | `opencode-ai` | `1.19.6` | `agent.build.steps`，另加模型请求数限制；原生 `steps` 只是要求模型收尾的提示，不能阻止模型继续调用工具 |

在现有实验中选择 Solver，其他 Benchmark 参数照常保留：

```yaml
services:
  default:
    model: ${MODEL_NAME}
    base_url: ${MODEL_ENDPOINT}
    api_key: ${MODEL_API_KEY}
    api: openai-completions
    reasoningEffort: low
    maxTokens: 65536
    # 只有所选模型支持图片时才声明 image。
    inputModalities: [text, image]
benchmark:
  name: mmlu_pro
  config:
    solveNetwork: model-api
  solver:
    name: qwencode # 或 kimicode、minimaxcode、opencode
    config:
      tools: none
      mcp: disabled
      webSearch: disabled
      webFetch: disabled
      maxTurns: 2000
environment: docker
run:
  solveTimeoutSeconds: 600
```

`maxTokens` 控制单次回复的输出，`maxTurns` 设置原生步数，`solveTimeoutSeconds` 设置整题时限。Qwen、Kimi、MiniMax 和 OpenCode 的 1 轮与 2 轮对照分别产生 1 次和 2 次主 Agent 请求。省略 Solver 限额时沿用服务配置和 CLI 默认值。MiniMax 自定义模型默认单次输出上限为 16,384 token。Kimi 的原生 Chat 配置不发送输出上限，Evaluator 在模型转发入口补上显式 `maxTokens`。Kimi 和 MiniMax 的未知自定义模型默认使用 200,000 token 上下文，可通过 `contextWindow` 指定服务实际容量。

四者均按所选服务的 `api` 选择协议；显式设置服务 `reasoningEffort` 时，Qwen Code、Kimi Code 和 OpenCode 通过各自的原生会话设置选择档位，MiniMax Code 使用原生 `--effort`。请求格式以及辅助请求是否继承档位均由 CLI 决定。Qwen Code 原生可选的最低档位是 `low`。模型 key 只留在转发进程，子 CLI 使用临时本地令牌。Qwen、Kimi、OpenCode 使用原生 ACP 输入图片，MiniMax 使用原生 `exec --file`。OpenCode 三种协议均可传原始 PDF。Qwen 的 Chat Completions 和 Messages 可传原始 PDF，Responses 使用页图。Kimi 的 ACP 会丢弃二进制资源，MiniMax 的 `--file` 对 PDF 只发送路径说明，这两者使用页图。默认将任务提供的技能目录和 MCP 服务传给所选 CLI。

关闭内置工具时，CLI 模型请求只保留已注册的 MCP 工具声明。评测器也停止自动添加补充搜索，但任务自己声明的搜索 MCP 仍由 `mcp` 控制。任务的网络策略继续生效。

OpenCode 的原生 `websearch` 直接使用 Exa，关闭 MCP 后仍有原生搜索入口。Qwen、Kimi、MiniMax 一旦关闭 MCP，就没有评测器补充的搜索服务；原生搜索能否返回来源取决于当前模型路由和认证。开关允许注册工具，搜索来源以 attempt 中的工具结果为准。

MiniMax 安装时会验证 SQLite 原生模块；如果预编译模块下载失败，原生安装器可能需要 Python、make 和 C++ 编译器。Qwen、Kimi 和 MiniMax 使用 Node.js 24；OpenCode 安装当前平台的正式二进制。下载源、Docker 源和代理使用[网络配置](network.zh-CN.md)，优先用 `--network` 指定可用来源。npm 镜像源尚未同步 MiniMax `0.7.8` 时，将网络 YAML 的 `sources.npm.registry` 改为 `https://registry.npmjs.org`。每次先运行 `warmup`，成功后再 `run`；[MMLU-Pro Playbook](../../playbook/mmlu-pro/) 提供四套示例。

运行产物保存原生 JSONL/ACP 事件、最终答案和用量。ACP 的 `usage_update` 通常表示上下文占用，不能当作累计 Token；优先采用原生最终用量，缺失时采用完整模型响应上报的用量，未上报的值保留为空。

## 使用 AgentBundle

下表按 Bundle 清单的 `harness.name` 说明开关的额外条件。

| Harness | 配置时需要注意的条件 |
| --- | --- |
| DSH | 六项开关针对锁定版 0.2.2-rc.1。显式开启搜索或抓取时，所选 profile 和模型服务须注册对应的 `web_search` 或 `web_fetch`。搜索插件可直接使用 Exa。 |
| Pi | 抓取和委派由扩展提供。`pi.webSearchTools` 和 `pi.webFetchTools` 可指定工具名；同一工具同时归入两列时，不能要求一项 `enabled` 另一项 `disabled`。若 `mcp: disabled`，显式启用的网页工具必须仍能在当前会话注册。`simpleagent.bundle` 的别名遵循相同规则。 |
| JiuwenSwarm | 抓取缺省沿用 Bundle 设置，显式启用可装入原生抓取工具。`mcp: disabled` 会关闭补充搜索；同时显式开启搜索时，主会话必须实际暴露原生搜索工具。配置文件中写有工具名本身不足以证明它可用。 |
| DeepAgents | 内置工具、抓取、委派、MCP 和技能由 `build_agent_for_run` 构建的图控制。仓库维护的示例提供抓取；其他 Bundle 需要自己实现抓取并在构图时报告不支持的设置。评测器注入的搜索工具可在关闭 MCP 后继续使用。 |

JiuwenSwarm 关闭内层沙箱和审批。主 Agent 和三个默认子 Agent（`statusline-setup`、`explore_agent`、`plan_agent`）各自通过原生 `skill_tool` 读取任务或 Bundle 提供的技能。启用的 `code_agent` 和 `browser_agent` 也使用各自的读取器。`skills: disabled` 会关闭这些会话的技能发现和读取器，普通文件工具仍按各自的权限执行。网页抓取缺省沿用 Bundle 的工具配置。`webFetch: enabled` 启用原生 `fetch_webpage`，`webFetch: disabled` 会从模型的工具列表移除它，其他工具仍可用。Hermes 使用本地终端并关闭交互审批。DeepAgents 的工具执行由 Bundle 图配置，Dify 由部署的工作流执行。对于能够自行加载工具的图或远端工作流，适配器会拒绝无法落实的限制。

先按[源码安装](installation.zh-CN.md#直接安装)准备 Evaluator；pnpm 会自动安装 AgentBundle SDK，无需同级源码仓库。下面的 `AGENT_BUNDLE_PATH` 指向已制作好的 **Agent Bundle 目录**，需要另行准备，不是 SDK 安装路径。Bundle 的概念、CLI 和示例见 [AgentBundle 项目](https://github.com/ARSI-LAB/agentbundle)，各 Harness 的目录结构、清单及校验方法见 [Bundle 编写指南](https://github.com/ARSI-LAB/agentbundle/blob/master/docs/bundle-formats.zh-CN.md)。

```yaml
services:
  default:
    model: ${MODEL_NAME}
    base_url: ${MODEL_ENDPOINT}
    api_key: ${MODEL_API_KEY}
benchmark:
  name: gsm8k
  solver:
    name: agentbundle
    config:
      path: ${AGENT_BUNDLE_PATH}
environment: local
run:
  maxTasks: 2
  timeoutSeconds: 900
output:
  directory: ./results/gsm8k-agentbundle
```

`AGENT_BUNDLE_PATH` 建议使用绝对路径。Evaluator 会读取 Bundle 声明的 Harness，检查内容身份，再选择适配器，不通过目录名猜测。本地 Harness 还会检查固定版本是否满足声明范围；远程 Dify 的版本限制见下文。Bundle 修改后应开始新 run。

| Harness 声明 | 对应使用方式 |
| --- | --- |
| `dsh` | 按 DSH 协议准备与运行，工具输出格式见[DSH 说明](usage.zh-CN.md#dsh-工具输出) |
| `deepagents` **Beta** | 在 `langgraph.json` 的 `graphs.agent` 声明 `./agent.py:build_agent_for_run`。Evaluator 将本次策略、任务 MCP、技能目录和中间件传入构图函数，由 Bundle 在创建主图和子图前应用。旧的 `:agent` 声明在准备阶段报错。 |
| `hermes` **Beta** | 使用 Hermes 适配器 |
| `jiuwenswarm` **Beta** | 使用 Jiuwenswarm 适配器 |
| `pi` **Beta** | 使用 pi，检查发布产物与设置摘要 |
| `dify` **Beta** | 通过 SDK 安装远程应用，再运行 Workflow，见下文 |

某些 Harness 需要本机预装运行时，或在 Docker 准备阶段安装依赖；本机目录不会自动变成容器/远端可用路径。先确认 Bundle 和 Harness 的部署条件，再按 [Playbook](../../playbook/README.md) 选对应环境。

已有安装位置可用 `dshhome`、`dshprofile`、`hermeshome`、`jiuwenswarmhome` 等 Solver 配置指定；`jiuwenswarmTimeoutSeconds` 只针对对应 Harness。pi 的额外设置放在 `benchmark.solver.config.pi.settings`，其他 Harness 不接受这个字段。

Docker 下，DSH 默认使用固定版本 0.2.2-rc.1。如果该版本不满足 Bundle 的 `harness.version`，Solver 从配置的 npm 源选择符合范围的最高版本。范围需要显式包含预发布版才能匹配 RC。Local 环境使用同一范围校验本机已安装的 DSH。

支持输出限额的 Bundle 使用 Solver 的 `maxTokens` 覆盖服务同名字段。Evaluator 的配置与执行方式见本页；Bundle 的制作、格式与安装见上述 AgentBundle 项目文档。

使用 DSH 时，`services.<名称>.contextWindow` 设置当前模型用于压缩计算的上下文容量。使用原生 DeepSeek API Key 路由时，显式填写会为所选模型配置本地目录条目。上下文容量需要给单次回复上限和 Profile 的压缩预留量留出空间，默认预留 65,536 Token。DSH 的普通任务循环没有原生 `maxTurns` 配置，可以用 `run.solveTimeoutSeconds` 设置整题时限。

## Docker 环境准备与网络

Solver 决定 Agent 怎样执行；任务环境决定使用现成镜像还是构建 Dockerfile。选择 `simpleagent` 或 `agentbundle` 不会直接决定镜像下载方式。`warmup` 不调用模型，但会准备任务镜像、Evaluator 共享的 Node 运行环境，以及所选 Harness 需要的安装依赖；可用缓存会被复用。

同一次预热可能既有 Dockerfile 的 `FROM` 拉取，也有 Evaluator 主动获取 Node 等现成镜像。前者使用 Docker daemon/BuildKit 的网络；后者才使用网络文件中的 `docker.mirrors` 和 `docker.pull`。即使 `docker.pull.method: docker`，Evaluator 仍会先替换镜像地址，再交给 Docker 下载。镜像获取、构建中安装依赖和运行时安装使用的配置边界见[预热期间的镜像与依赖下载](deployment/network.zh-CN.md#预热期间的镜像与依赖下载)。

## 使用 Dify

Dify 是 AgentBundle 的 Harness。准备声明 `harness.name: dify` 的 Bundle，使用下面的文本题示例：

```yaml
services:
  default:
    model: dify-internal-binding
    base_url: http://127.0.0.1:9/v1
    api_key: ${MODEL_API_KEY}
benchmark:
  name: gsm8k
  solver:
    name: agentbundle
    config:
      path: ${DIFY_BUNDLE_PATH}
      dify:
        baseUrl: ${DIFY_BASE_URL}
        registryPath: ${DIFY_REGISTRY_PATH}  # 可选
environment: local
run:
  maxTasks: 2
  timeoutSeconds: 900
output:
  directory: ./results/gsm8k-dify
```

`path` 指向 Dify Bundle；`dify.baseUrl` 填服务地址，例如 `https://dify.example`，不要带 `/v1`、`/workflows/run`、认证信息、查询参数或片段。安装与执行都使用这个地址，不受 SDK 环境变量 `DIFY_BASE` 覆盖。Workflow 接收名为 `task` 的文本输入，返回文本字段 `report` 或 `answer`；其他输出对象保存为 JSON 文本。

在运行 Evaluator 的进程所在机器上配置 Console 凭证：`DIFY_ADMIN_API_KEY`，或 `DIFY_EMAIL` 与 `DIFY_PASSWORD`，也可使用 SDK 已保存的登录凭证。未配置时直接报错，不等待交互登录。SDK 安装并发布应用后返回 `appId` 和 Service API key，不需要额外配置应用 key。Ray 部署中这些 Console 凭证需在执行安装的节点预先配置，本机环境变量不会自动分发。

services 保留框架要求的服务元数据，上例中的 `MODEL_API_KEY` 仅用于满足服务绑定要求，不会发往占位地址；实际模型由 Dify 应用内部绑定。`services.<名称>.maxTokens` 和 Solver 的 `maxTokens` 不会修改 Dify 工作流里的模型参数。

`dify.registryPath` 是安装记录文件，相对路径按 YAML 所在目录解析。省略时放在 SDK 默认记录目录下的 `dify/<服务地址摘要>/installations.json`。同一台机器上共享记录文件的并发 attempt 使用文件锁，只创建一个应用；远端节点使用各自的记录文件，不保证跨节点只安装一次。显式记录文件包含其他服务的同一 Bundle 时会报错，需换用另一文件。记录文件含 Service API key，不要提交；评测结果中的 `installation.json` 只保存不含密钥的安装证据。应用按 persistent 模式保留，评测结束不删除远程应用。

来源记录保存 Bundle 摘要、Runner 摘要及版本、Bundle 声明的平台版本范围。目前不探测远程 Dify 平台实际版本，也不保证服务端工作流未被外部修改。旧 `solver.name: dify`、`bundlePath`、`apiKeyEnv` 和 `appId` 配置不再接受；请改用上面的 Bundle 写法并开始新 run，已有结果仍可离线生成报告。

**Dify Harness 当前不把工作流生成的文件同步回任务环境。** Office、代码仓库修改等文件交付任务应使用能写入 EnvironmentSession 的 SimpleAgent 或其他 AgentBundle Harness。[Office Dify YAML](../../playbook/workbuddy/workbuddy-office-dify.yaml) 仅展示配置组合。

## 用 AgentX 测服务性能

不需要先制作 AgentBundle。选择 `benchmark.name: agentx` 后，由专用 Solver 发送 Trace 请求；API 必须满足流式、`ignore_eos`、完整上下文与输出长度要求。

- `replay`：显式指定 `traceCount`，完整跑完有限 Trace，适合适配验收。
- `standard`：固定的标准测量窗口及负载规则。

vLLM `/metrics` 和 Ascend 采样端点是可选项，不配置时只测模型 API。`replay` 不能作为正式可比成绩，standard 也要通过上游和本地的有效性检查。完整参数、Python 条件及 NPU 采集方式见 [AgentX 指南](benchmarks/agentx.zh-CN.md)。

[返回用户手册](README.zh-CN.md) · [日常操作](usage.zh-CN.md) · [完整配置参考](config.zh-CN.md)
