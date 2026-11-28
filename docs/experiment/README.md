# 实验结果

按题库和模型查找实验。每组由 9 至 11 种 Solver 完成同一份题单。打开实验说明可以看三张中文图表，运行报告列出成绩、统计样本数和题目覆盖范围。抽样实验另附入选题目 ID。

| Benchmark | 模型 | 每种 Solver 的题量 | 实验说明与图表 | 运行报告 | 原始报告 |
| --- | --- | ---: | --- | --- | --- |
| DeepSWE 1.1 | `deepseek-v4.1-flash-1017` | 20 | [代码修复与测试](deepswe-1.1/deepseek-v4.1-flash-1017/README.md) | [报告](deepswe-1.1/deepseek-v4.1-flash-1017/report.md) | [下载](deepswe-1.1/deepseek-v4.1-flash-1017/run-reports.zip) |
| MMLU-Pro | `deepseek-v4.1-flash-1017` | 210 | [禁用工具的选择题测评](mmlu-pro/deepseek-v4.1-flash-1017/README.md) | [报告](mmlu-pro/deepseek-v4.1-flash-1017/report.md) | [下载](mmlu-pro/deepseek-v4.1-flash-1017/run-reports.zip) |
| OfficeQA Pro V2 | `deepseek-v4.1-flash-1017` | 90 | [财政文档问答](officeqa-pro-v2/deepseek-v4.1-flash-1017/README.md) | [报告](officeqa-pro-v2/deepseek-v4.1-flash-1017/report.md) | [下载](officeqa-pro-v2/deepseek-v4.1-flash-1017/run-reports.zip) |
| OfficeQA Pro V2 | `glm-5.3-flash`（`low`） | 90 | [财政文档问答，低推理强度](officeqa-pro-v2/glm-5.3-flash/README.md) | [报告](officeqa-pro-v2/glm-5.3-flash/report.md) | [下载](officeqa-pro-v2/glm-5.3-flash/run-reports.zip) |
| OfficeQA Pro V2 | `MiniMax-M3.1-Flash`（`low`） | 90 | [财政文档问答](officeqa-pro-v2/minimax-m3.1-flash/README.md) | [报告](officeqa-pro-v2/minimax-m3.1-flash/report.md) | [下载](officeqa-pro-v2/minimax-m3.1-flash/run-reports.zip) |
| OfficeQA Pro V2 | `hy4-flash`（`max`） | 90 | [财政文档问答](officeqa-pro-v2/hy4-flash/README.md) | [报告](officeqa-pro-v2/hy4-flash/report.md) | [下载](officeqa-pro-v2/hy4-flash/run-reports.zip) |
| OfficeQA Pro V2 | `qwen3.8-flash`（`max`） | 90 | [财政文档问答](officeqa-pro-v2/qwen3.8-flash/README.md) | [报告](officeqa-pro-v2/qwen3.8-flash/report.md) | [下载](officeqa-pro-v2/qwen3.8-flash/run-reports.zip) |

准确率按每种 Solver 的全部题目计算。耗时和 Token 只统计最终计分尝试。DeepSWE 和 OfficeQA 的用量图以万 Token 为单位，MMLU-Pro 用量图右侧直接列出 Token 个数。每组报告都列出统计分母，便于对照超时和用量缺失。

Evaluator 为每次运行分别生成 `report.md`。同一 Solver 分批执行或补测时，实验目录中的 `report.md` 汇总最终选中的记录，`run-reports.zip` 保存这些运行生成的原始 Markdown。原报告里的轨迹、配置和清单链接使用原运行目录的相对路径，需在对应运行目录中打开。

## OfficeQA Pro V2

五组运行使用相同的 90 道题、`parsed-json` 财政文档和评分规则，题库版本均为 `65a2b315780417bc50d7bfe6e5bdb904e63fda65`，数值容忍度为 0。下表比较五组共有的 11 种 Solver。每组共 990 题次。

| 模型 | 11 种 Solver 合计答对 | 准确率 |
| --- | ---: | ---: |
| [`deepseek-v4.1-flash-1017`](officeqa-pro-v2/deepseek-v4.1-flash-1017/README.md) | 577/990 | 58.28% |
| [`hy4-flash`](officeqa-pro-v2/hy4-flash/README.md) | 538/990 | 54.34% |
| [`qwen3.8-flash`](officeqa-pro-v2/qwen3.8-flash/README.md) | 505/990 | 51.01% |
| [`MiniMax-M3.1-Flash`](officeqa-pro-v2/minimax-m3.1-flash/README.md) | 458/990 | 46.26% |
| [`glm-5.3-flash`](officeqa-pro-v2/glm-5.3-flash/README.md) | 396/990 | 40.00% |

<details>
<summary>查看 5 个模型和 11 种 Solver 的准确率</summary>

| Solver | [`deepseek-v4.1-flash-1017`](officeqa-pro-v2/deepseek-v4.1-flash-1017/report.md) | [`glm-5.3-flash`](officeqa-pro-v2/glm-5.3-flash/report.md) | [`MiniMax-M3.1-Flash`](officeqa-pro-v2/minimax-m3.1-flash/report.md) | [`hy4-flash`](officeqa-pro-v2/hy4-flash/report.md) | [`qwen3.8-flash`](officeqa-pro-v2/qwen3.8-flash/report.md) |
| --- | ---: | ---: | ---: | ---: | ---: |
| DeepSeek Harness | 64.44% (58/90) | 42.22% (38/90) | 44.44% (40/90) | 48.89% (44/90) | 45.56% (41/90) |
| Codex | 61.11% (55/90) | 43.33% (39/90) | 48.89% (44/90) | 57.78% (52/90) | 44.44% (40/90) |
| Pi | 60.00% (54/90) | 38.89% (35/90) | 42.22% (38/90) | 56.67% (51/90) | 48.89% (44/90) |
| Claude Code | 58.89% (53/90) | 26.67% (24/90) | 42.22% (38/90) | 53.33% (48/90) | 53.33% (48/90) |
| ZCode | 58.89% (53/90) | 47.78% (43/90) | 48.89% (44/90) | 55.56% (50/90) | 55.56% (50/90) |
| TRAE | 58.89% (53/90) | 38.89% (35/90) | 48.89% (44/90) | 50.00% (45/90) | 45.56% (41/90) |
| SimpleAgent | 56.67% (51/90) | 40.00% (36/90) | 43.33% (39/90) | 62.22% (56/90) | 52.22% (47/90) |
| JiuwenSwarm | 55.56% (50/90) | 45.56% (41/90) | 45.56% (41/90) | 52.22% (47/90) | 57.78% (52/90) |
| CodeBuddy | 53.33% (48/90) | 27.78% (25/90) | 46.67% (42/90) | 56.67% (51/90) | 57.78% (52/90) |
| MiniMax Code | 54.44% (49/90) | 44.44% (40/90) | 53.33% (48/90) | 53.33% (48/90) | 48.89% (44/90) |
| Qwen Code | 58.89% (53/90) | 44.44% (40/90) | 44.44% (40/90) | 51.11% (46/90) | 51.11% (46/90) |

</details>

在推理强度均为 `max` 的两组中，HY 在 11 种 Solver 上合计比 Qwen 多答对 33 题次（3.33 个百分点）。SimpleAgent 在 HY 上领先（56/90），CodeBuddy 与 JiuwenSwarm 在 Qwen 上并列领先（52/90）。按 Solver 配对比较，HY 的 11 个求解耗时中位数都低于 Qwen。Qwen 有 4 道超时题按统计口径排除于耗时样本。各批的推理强度、求解时限、网页工具策略与补测方式需随成绩一起比较。

GLM 和 MiniMax 使用 `low` 推理强度，HY 和 Qwen 使用 `max`。HY 和 Qwen 均开启 WebFetch 并关闭 MCP。除同时开启两种网页工具的 Codex 外，其余 Solver 关闭 WebSearch。Pi 和 SimpleAgent 使用 Evaluator 提供的 `web_fetch`。每题求解限时 2 小时，验证限时 1 小时。MiniMax 搭配原有九种 Solver 和 Qwen Code 时，每题求解限时 4 小时。原有批次的验证时限由 5 分钟延长至 1 小时，Qwen Code 的验证时限为 1 小时。

## 其他 Benchmark 的评测结果

以下结果使用 **DeepSeek V4.1 Flash 1017**，各 Benchmark 按自身规则评分。

| Benchmark | Agent Harness | 结果 |
| --- | --- | --- |
| GSM8K | SimpleAgent | 92.34% (1,218 / 1,319) |
| MMLU | choice-logprobs | 88.83% (12,474 / 14,042) |
| WorkBuddy | SimpleAgent | Office 0.8502 · Code 0.9009 · Web 0.7957 |
