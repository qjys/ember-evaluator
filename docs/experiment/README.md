# 实验结果

按题库和模型查找实验。每组由九种 Solver 完成同一份题单。打开实验说明可以看三张原图，运行报告列出每种 Solver 的成绩、统计样本数和本次使用的题单。

| Benchmark | 模型 | 每种 Solver 的题量 | 实验说明与图表 | 运行报告 | 原始报告 |
| --- | --- | ---: | --- | --- | --- |
| DeepSWE 1.1 | `deepseek-v4.1-flash-1017` | 20 | [代码修复与测试](deepswe-1.1/deepseek-v4.1-flash-1017/README.md) | [报告](deepswe-1.1/deepseek-v4.1-flash-1017/report.md) | [下载](deepswe-1.1/deepseek-v4.1-flash-1017/run-reports.zip) |
| MMLU-Pro | `deepseek-v4.1-flash-1017` | 210 | [禁用工具的选择题测评](mmlu-pro/deepseek-v4.1-flash-1017/README.md) | [报告](mmlu-pro/deepseek-v4.1-flash-1017/report.md) | [下载](mmlu-pro/deepseek-v4.1-flash-1017/run-reports.zip) |
| OfficeQA Pro V2 | `deepseek-v4.1-flash-1017` | 90 | [财政文档问答](officeqa-pro-v2/deepseek-v4.1-flash-1017/README.md) | [报告](officeqa-pro-v2/deepseek-v4.1-flash-1017/report.md) | [下载](officeqa-pro-v2/deepseek-v4.1-flash-1017/run-reports.zip) |
| OfficeQA Pro V2 | `glm-5.3-flash`（`low`） | 90 | [财政文档问答，低推理强度](officeqa-pro-v2/glm-5.3-flash/README.md) | [报告](officeqa-pro-v2/glm-5.3-flash/report.md) | [下载](officeqa-pro-v2/glm-5.3-flash/run-reports.zip) |

准确率按每种 Solver 的全部题目计算。耗时和 Token 只统计最终计分尝试。DeepSWE 和 OfficeQA 的用量图以万 Token 为单位，MMLU-Pro 用量图右侧直接列出 Token 个数。每组报告都列出统计分母，便于对照超时和用量缺失。

Evaluator 为每次运行分别生成 `report.md`。同一 Solver 分批执行或补测时，实验目录中的 `report.md` 汇总最终选中的记录，`run-reports.zip` 保存这些运行生成的原始 Markdown。原报告里的轨迹、配置和清单链接使用原运行目录的相对路径，需在对应运行目录中打开。

## 其他 Benchmark 的评测结果

以下结果使用 **DeepSeek V4.1 Flash 1017**，各 Benchmark 按自身规则评分。

| Benchmark | Agent Harness | 结果 |
| --- | --- | --- |
| GSM8K | SimpleAgent | 92.34% (1,218 / 1,319) |
| MMLU | choice-logprobs | 88.83% (12,474 / 14,042) |
| WorkBuddy | SimpleAgent | Office 0.8502 · Code 0.9009 · Web 0.7957 |
