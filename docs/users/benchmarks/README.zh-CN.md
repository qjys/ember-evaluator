# Benchmark 指南

> [English](./README.md) | 中文

先按任务选择指南，再选可执行 YAML。题目列表由 Profile 和来源锁确定，实际运行范围以 `--dry-run` 输出及 manifest 为准。

[用户文档](../README.zh-CN.md) · [Playbook 配置](../../../playbook/README.md) · [评分口径](../reference/scoring.zh-CN.md)

| 场景 | 指南 | 入门 / 配置 |
| --- | --- | --- |
| 推荐服务时延 | [SGLang-GR](recommendation.zh-CN.md) | [五档北极星](../../../playbook/recommendation/north-star.yaml)、[自定义负载](../../../playbook/recommendation/custom.yaml) |
| 数学、知识和记录型问答 | [通用两题入门](../quick-start.zh-CN.md)、[评分口径](../reference/scoring.zh-CN.md) | [全部 Playbook](../../../playbook/README.md) |
| 自有 Harbor 任务包 | [来源、镜像、网络与验证](harbor.zh-CN.md) | [自定义来源配置](harbor.zh-CN.md#一个新数据集只增加-yaml) |
| Office、Code、Web、Security | [WorkBuddy](workbuddy.zh-CN.md) | [场景配置](../../../playbook/workbuddy/) |
| 全量文档检索与财政问答 | [OfficeQA Pro V2](officeqa-pro-v2.zh-CN.md) | [解析 JSON 两题](../../../playbook/officeqa-pro-v2/officeqa-pro-v2-parsed-json-simpleagent.yaml)、[原始 PDF](../../../playbook/officeqa-pro-v2/officeqa-pro-v2-original-pdf.yaml)、[解析 JSON + Ray](../../../playbook/officeqa-pro-v2/officeqa-pro-v2-parsed-json-ray.yaml)；不含纯图片协议 |
| 软件工程代码修改 | [DeepSWE](deepswe.zh-CN.md) | [单机配置](../../../playbook/deepswe/deepswe-simpleagent.yaml) |
| 终端操作 | [Terminal-Bench](terminalbench.zh-CN.md) | [4.0 快速入门](../quick-start/terminalbench.zh-CN.md) |
| SWE-bench Verified | [Harbor 执行规则](harbor.zh-CN.md) | [AgentBundle 配置](../../../playbook/swebench/swebench-agentbundle.yaml) |
| 模型服务吞吐与延迟 | [AgentX](agentx.zh-CN.md) | [性能快速入门](../quick-start/agentx.zh-CN.md) |
| SSH 远程服务压测与 Prefix Cache | [AISBench 插件](../../../plugins/aisbench/README.md) | [SSH 配置](../../../plugins/aisbench/playbook/01-ssh.yaml) |

同一 Benchmark 的版本、评分和限制放在对应指南；通用 Docker 或下载问题见 [FAQ](../faq/README.zh-CN.md)。新增 Benchmark 的代码和插件开发见[开发文档](../../development/README.md)。
