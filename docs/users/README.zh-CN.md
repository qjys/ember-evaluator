# Evaluator 用户文档

> [English](./README.md) | 中文

先完成安装并跑通一个场景，再查通用操作。Benchmark 的版本、评分和限制在 `benchmarks/`，部署条件在 `deployment/`，故障处理在 `faq/`。

[项目主页](../../README.zh-CN.md) · [Benchmark 指南](benchmarks/README.zh-CN.md) · [FAQ](faq/README.zh-CN.md) · [开发文档](../development/README.md)


[图片与 PDF 评测](multimodal.zh-CN.md)：输入模式、Harness 支持情况和运行示例。

## 安装与快速入门

| 阶段 / 场景 | 文档 |
| --- | --- |
| 两仓安装、构建、全局 CLI 与任意目录运行 | [安装指南](installation.zh-CN.md) |
| 第一次质量评测 | [GSM8K 两题快速上手](quick-start.zh-CN.md) |
| Docker 终端任务 | [Terminal-Bench 4.0 入门](quick-start/terminalbench.zh-CN.md) |
| 模型服务性能链路 | [AgentX 性能入门](quick-start/agentx.zh-CN.md) |
| 通过 SSH 压测已有模型服务 | [AISBench 独立插件](../../plugins/aisbench/README.md) |
| 从本地目录或文件读取题库 | [本地数据集](local-datasets.zh-CN.md) |
| 从 Node.js 业务项目调用评测 | [Node.js SDK](sdk.zh-CN.md) |
| 使用 Agent 执行评测 | [Ember Evaluator skill](../../skills/ember-evaluator/SKILL.md) |

## 通用操作

| 操作目标 | 文档 |
| --- | --- |
| YAML、Profile、默认值与环境变量 | [配置指南](config.zh-CN.md) |
| 模型、Judge、SimpleAgent、AgentBundle 与 Dify | [Solver 与模型服务](solvers.zh-CN.md) |
| 抽题、续跑、报告、轨迹与 DSH 完整工具输出 | [日常操作](usage.zh-CN.md) |
| 任务并发、环境准备、流水线与超时 | [并发指南](concurrency.zh-CN.md) |
| 在原 run 中恢复网络失败任务 | [网络故障补测](network-retry.zh-CN.md) |

## 按主题查阅

| 主题 | 入口与范围 |
| --- | --- |
| Benchmark | [场景目录](benchmarks/README.zh-CN.md)：[Harbor](benchmarks/harbor.zh-CN.md)、[WorkBuddy](benchmarks/workbuddy.zh-CN.md)、[DeepSWE](benchmarks/deepswe.zh-CN.md)、[Terminal-Bench](benchmarks/terminalbench.zh-CN.md)、[AgentX](benchmarks/agentx.zh-CN.md) |
| 部署 | [管理容器](deployment/container-toolbox.zh-CN.md)、[Docker 平台](deployment/docker-platform.zh-CN.md)；Ray 连接见[配置指南](config.zh-CN.md#ray-与执行节点) |
| FAQ | [常见问题](faq/README.zh-CN.md)、[下载与镜像](faq/downloads.zh-CN.md)、[Docker 与跨架构](faq/docker.zh-CN.md) |
| 参考 | [评分口径](reference/scoring.zh-CN.md)、[错误码与退出码](reference/errors.zh-CN.md) |
| 架构 | 各模块文档中的 PNG 架构图与 `src/` 源码入口 |
| 开发 | [开发文档](../development/README.md)，包含插件、Benchmark、结构化错误和受控测试 |

![Evaluator 从配置到任务执行、结果保存和报告生成的整体架构](../../imgs/01-framework-project-overview-v2.png.png)

## 现在能测哪些 Benchmark

下表中的名称用于 `benchmark info`、`init --benchmark` 和 YAML。安装外部插件后可能增加其他名称，以 `benchmark list` 输出为准。

| 类型 | 配置名称 | 内容与使用条件 |
| --- | --- | --- |
| 数学 | `gsm8k`、`math500`、`mgsm` | 数学题；MGSM 覆盖多种语言，首次建议 GSM8K |
| 学科知识 | `mmlu`、`mmlu_pro` | MMLU 使用 5-shot 和候选概率评分，服务须返回 logprobs/top_logprobs；MMLU-Pro 使用生成式回答，配置名为 `mmlu_pro` |
| 高难知识 | `gpqa` | [全量配置](../../playbook/gpqa/gpqa-simpleagent.yaml)显式配置 `hfToken: ${HF_TOKEN}`，需先获数据集访问权限 |
| 阅读与事实问答 | `drop`、`triviaqa` | 答案提取、归一化与匹配；DROP 的当前口径见[评分说明](reference/scoring.zh-CN.md) |
| 文档检索与财政问答 | `officeqa-pro-v2` | [OfficeQA Pro V2](benchmarks/officeqa-pro-v2.zh-CN.md)：默认可搜索的解析 JSON，也支持原始 PDF；不含纯图片测评协议，需授权 HF token |
| 代码生成 | `humaneval` | 用 Docker 运行 Python 测试；即使 Solver 用 local，验证仍需要 Docker |
| 模型裁判问答 | `simpleqa` | 需要显式配置 Judge 服务，输出三类答案判定 |
| 医疗对话质量 | `healthbench` | 需要 Judge 服务，逐项 rubric 评分，可只有连续分数而没有通过率 |
| 软件工程 | `deepswe`、`swebench` | 默认版本分别为 1.1、Verified 1.0；需要 Docker 和题目所需镜像 |
| 终端任务 | `terminalbench` | 默认版本 2.0，使用 Docker 和任务内验证器 |
| 办公、代码、网页、安全任务 | `workbuddy` | `scenario` 选 `office`、`code`、`web`、`security`，默认 `code`；使用 Docker |
| 自有 Harbor 任务包 | `harbor` | 配置本地目录、固定归档、GitHub 或 Harbor registry 来源；按任务协议执行 |
| 服务性能 | `agentx` | Trace 驱动流式模型 API，支持 `standard`、`replay`；无正确率或质量分数 |
| 远程服务性能 | `aisbench`（外部插件） | [SSH 部署与压测](../../plugins/aisbench/README.md)；通过 patch 加载，支持公共前缀负载与预热 |
| 算子 | `kernel` | [已有 kernel 的正确性与 NPU 性能评测](benchmarks/kernel-npu.zh-CN.md)；本地串行，不调用模型 |

```bash
ember-evaluator benchmark list
ember-evaluator benchmark info workbuddy
ember-evaluator init --benchmark workbuddy --output workbuddy.yaml
```

WorkBuddy Web 需要裁判模型，Office 的模型评分可选。Security 数据和结果应放在 Linux 原生文件系统，不在 Windows 或 WSL 的 `/mnt/c`、`/mnt/d` 解压。具体限制见 [WorkBuddy 指南](benchmarks/workbuddy.zh-CN.md)。

先限制样本实际运行，再增加题数、并发或节点。安装、评分、续跑和资源问题的说明见 [FAQ](faq/README.zh-CN.md)。

- [网络下载、代理与镜像获取](network.zh-CN.md)
