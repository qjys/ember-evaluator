# 实验配置示例

正式 YAML 按 Benchmark 分类，均使用[渐进式配置](../docs/users/config.zh-CN.md)。正式质量评测配置默认运行所选版本、场景的全部题目；[GSM8K 快速入门](gsm8k/gsm8k-quick-start.yaml)仅运行两题，用于检查安装和模型配置。

每个 Benchmark 使用一个子目录，YAML 直接放在 `playbook/<benchmark>/` 下，不再按 Solver、版本或场景建立更深目录；这些差异通过文件名区分。

此目录只放真实 Benchmark 使用的实验 YAML 及配套网络 YAML。自建测试题目、测试配置、插件、Bundle 和素材放在 `tests/fixtures/`，临时测试输出放在 `.scratch/`。

第一次使用先完成[安装说明](../docs/users/installation.zh-CN.md)，再按[两题快速上手](../docs/users/quick-start.zh-CN.md)检查环境。示例可能需要专用 Bundle、镜像、裁判或 Ray，运行前先阅读注释并执行 doctor。

| Benchmark | 目录 | 运行配置 |
| --- | --- | --- |
| Recommendation | [recommendation](recommendation) | [五档北极星](recommendation/north-star.yaml)、[自定义负载](recommendation/custom.yaml)、[生成推荐数据](recommendation/generated.yaml)、[SGLang-GR 指南](../docs/users/benchmarks/recommendation.zh-CN.md) |
| AgentX | [agentx](agentx) | [正式并发扫描](agentx/agentx-standard.yaml)、[Docker 裸机 NPU 采样](agentx/agentx-npu-docker.yaml)、[在线模型 API](agentx/agentx-model-api.yaml)、[GPU 服务 API](agentx/agentx-gpu-api.yaml)、[前 50 个会话完整回放](agentx/agentx-replay.yaml)、[两条 Trace 与 Ascend 指标](agentx/agentx-npu-replay.yaml)；[性能评测说明](../docs/users/benchmarks/agentx.zh-CN.md) |
| Kernel | [kernel](kernel) | [已有候选 NPU 评测](kernel/existing.yaml)；[精度、计时与 profiling](../docs/users/benchmarks/kernel-npu.zh-CN.md) |
| DeepSWE | [deepswe](deepswe) | [最简配置](deepswe/deepswe.yaml)、[单机 SimpleAgent](deepswe/deepswe-simpleagent.yaml)、[Ray + AgentBundle](deepswe/deepswe-agentbundle-ray.yaml) |
| WorkBuddy | [workbuddy](workbuddy) | [Office 最简配置](workbuddy/workbuddy-office.yaml)、[Code](workbuddy/workbuddy-code.yaml)、[Web](workbuddy/workbuddy-web.yaml)、[Security](workbuddy/workbuddy-security.yaml) |
| Terminal-Bench | [terminalbench](terminalbench) | [4.0 全量](terminalbench/terminalbench-4.0.yaml)、[2.0 SimpleAgent](terminalbench/terminalbench-simpleagent.yaml)、[AgentBundle](terminalbench/terminalbench-agentbundle.yaml) |
| SWE-bench Verified | [swebench](swebench) | [AgentBundle](swebench/swebench-agentbundle.yaml) |
| GSM8K | [gsm8k](gsm8k) | [两题快速入门](gsm8k/gsm8k-quick-start.yaml)、[SimpleAgent 全量](gsm8k/gsm8k-simpleagent.yaml)、[deepagents + Docker](gsm8k/gsm8k-deepagents-docker.yaml) |
| HumanEval | [humaneval](humaneval) | [SimpleAgent](humaneval/humaneval-simpleagent.yaml) |
| GPQA Diamond | [gpqa](gpqa) | [SimpleAgent 与 HF 认证](gpqa/gpqa-simpleagent.yaml)；需先接受题库访问条件 |
| OfficeQA Pro V2 | [officeqa-pro-v2](officeqa-pro-v2) | [解析 JSON 全部 90 题](officeqa-pro-v2/officeqa-pro-v2-parsed-json-full.yaml)、[解析 JSON + SimpleAgent](officeqa-pro-v2/officeqa-pro-v2-parsed-json-simpleagent.yaml)、[原始 PDF](officeqa-pro-v2/officeqa-pro-v2-original-pdf.yaml)、[解析 JSON + Ray](officeqa-pro-v2/officeqa-pro-v2-parsed-json-ray.yaml)；均运行全部 90 题，[输入口径说明](../docs/users/benchmarks/officeqa-pro-v2.zh-CN.md#输入与测评口径) |
| MMLU | [mmlu](mmlu) | [5-shot 概率评分](mmlu/mmlu-simpleagent.yaml)；模型服务须返回 logprobs/top_logprobs，使用 choice-logprobs Solver |
| MATH-500 | [math500](math500) | [SimpleAgent 与独立等价裁判](math500/math500-simpleagent.yaml)；需配置 Judge 服务 |
| MMLU-Pro | [mmlu-pro](mmlu-pro) | [SimpleAgent](mmlu-pro/mmlu-pro-simpleagent.yaml) 关闭工具并在 Docker 中运行。配置名为 `mmlu_pro` |
| MGSM | [mgsm](mgsm) | [SimpleAgent](mgsm/mgsm-simpleagent.yaml)；运行全部 11 种语言的题目 |
| TriviaQA | [triviaqa](triviaqa) | [SimpleAgent](triviaqa/triviaqa-simpleagent.yaml) |
| DROP | [drop](drop) | [SimpleAgent](drop/drop-simpleagent.yaml) |
| SimpleQA | [simpleqa](simpleqa) | [SimpleAgent 与独立裁判](simpleqa/simpleqa-simpleagent.yaml)；需设置 `JUDGE_MODEL_*` |
| HealthBench | [healthbench](healthbench) | [SimpleAgent 与独立裁判](healthbench/healthbench-simpleagent.yaml)；需设置 `JUDGE_MODEL_*` |
| Harbor 通用协议 | [harbor](harbor) | [SimpleAgent](harbor/harbor-simpleagent.yaml)；使用 Terminal-Bench 2.0 数据，可替换 `dataset` |

按步骤首次运行，可选 [Terminal-Bench 4.0 入门](../docs/users/quick-start/terminalbench.zh-CN.md)或 [AgentX 性能入门](../docs/users/quick-start/agentx.zh-CN.md)。配置字段、测量口径和限制分别在对应专项指南中说明。

AgentX 的 Trace 数据集公开，现有示例不强制要求 HF_TOKEN；需要显式数据认证的题库配置见[数据认证](../docs/users/config.zh-CN.md#hugging-face-受限数据认证)。

网络配置放在独立 YAML 中，通过 `--network` 与实验配置一起传入。例如，从 ModelScope 下载 Terminal-Bench 4.0 任务镜像：

```bash
arsi-evaluator warmup playbook/terminalbench/terminalbench-4.0.yaml --network playbook/network/archives.yaml
arsi-evaluator run playbook/terminalbench/terminalbench-4.0.yaml --network playbook/network/archives.yaml
```

先准备 Docker 和实验引用的模型配置；示例默认全量选题，镜像是否已发布以远端仓库为准。`archives.yaml` 只修改该题库的任务镜像来源；镜像源、代理、组合配置和默认文件的使用步骤见[网络配置指南](../docs/users/network.zh-CN.md#1-先选一份网络配置)。

从仓库根目录执行：

```bash
arsi-evaluator inspect playbook/workbuddy/workbuddy-office-ray.yaml
arsi-evaluator run playbook/deepswe/deepswe-simpleagent.yaml
```

完成[安装](../docs/users/installation.zh-CN.md)后，可以在任意目录使用 YAML 的绝对路径运行，例如 Terminal-Bench 4.0：

```bash
arsi-evaluator run '/path/to/arsi-evaluator/playbook/terminalbench/terminalbench-4.0.yaml'
```

Playbook 省略 `output`，使用仓库根目录的 `results/<Benchmark 名>/<YAML 文件名（不含扩展名）>/<runId>/`。例如 `playbook/gsm8k/gsm8k-agentbundle.yaml` 的结果写入 `results/gsm8k/gsm8k-agentbundle/<runId>/`。显式填写 `output.directory` 时，其中的相对路径仍以 YAML 所在目录为基准。模型环境变量需要在实际运行命令的终端中设置。

运行前设置 YAML 中引用的模型环境变量。质量评测 YAML 默认全量运行；`run` 中保留的超时、重试等字段不限制题目范围。AgentX 标准测评按既有时间窗口和并发点运行，专用 replay 配置仍按 `traceCount` 回放指定数量的会话。新格式默认单题失败后继续其他任务，历史续跑由 CLI --resume 开启。

需要小范围验证时，可自行添加 `run.maxTasks: 2`；需要指定范围时，可添加 `offset: 10`、`maxTasks: 5`，表示跳过前 10 题，再运行 5 题。从少量题目切换到全量时应新建 run。SimpleQA 和 HealthBench 另外声明 `services.judge`，用于评分，请同时设置 YAML 中的 `JUDGE_MODEL_NAME`、`JUDGE_MODEL_ENDPOINT` 和 `JUDGE_MODEL_API_KEY`。

Ray 示例只写 scheduler.name: ray 和并发数；未指定连接地址时，框架在正式运行时准备并使用仓库配套本机集群，无需填写 deployment。查看配置不会启动集群。使用已部署的远端集群时，在 deployment 中指定 kind: ray-jobs、endpoint、caFile，并将 managedLocal 设为 false；nodes 可选择现有执行节点数量。

用户提供的 AGENT_BUNDLE_PATH、DIFY_BUNDLE_PATH 等路径建议使用绝对路径。实验相对路径以 YAML 所在目录为基准；已有示例的输出仍位于仓库 results 下。Ray 示例中的 ./bundles 路径由配套集群挂载到执行节点，Local 的 pi 示例则指向相邻产品仓库。

数据来源、校验摘要、任务解析、验证器和默认超时在插件 Profile 中维护。WorkBuddy Office 默认规则评分；Web 最简配置共享默认模型服务，已有独立 judge 服务的示例保留该路由。Security 必须在 Linux/WSL 使用原生 Linux 缓存目录。

Harbor Benchmark 共用“任务声明镜像优先，无镜像才构建”的[环境选择规则](../docs/users/benchmarks/harbor.zh-CN.md#执行与验证边界)。Terminal-Bench 4.0 示例使用官方预构建任务包，并指定 linux/amd64；ARM64 节点需要可用的 QEMU/binfmt。来源从旧 Git 数据切换到发布包后，应新建实验，不能绕过历史续跑的来源校验。

本地临时测试配置放在 .scratch，不纳入此目录或提交。
