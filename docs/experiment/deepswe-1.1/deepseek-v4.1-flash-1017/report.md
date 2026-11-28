# DeepSWE 1.1 运行报告

`deepseek-v4.1-flash-1017`。九种 Solver 各运行 20 题，共 180 条最终计分记录，其中 122 条答对，7 条求解超时。[实验设置与图表](README.md)

## 各 Solver 的最终成绩

表中求解耗时按分:秒显示，Token 栏以万为单位。最后一列为两项分位数各自采用的题数。

| Solver | 答对 / 题数 | 准确率 | 求解超时 | 耗时中位数 | 耗时 P90 | Token 中位数 | Token P90 | 耗时与用量样本数 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| DeepSeek Harness | 15/20 | 75.00% | 0 | 9:25 | 15:32 | 591 | 1,053 | 20/20 |
| Codex | 15/20 | 75.00% | 0 | 11:07 | 20:28 | 659 | 1,834 | 20/20 |
| Pi | 15/20 | 75.00% | 0 | 9:17 | 15:12 | 442 | 974 | 20/20 |
| Claude Code | 15/20 | 75.00% | 0 | 11:12 | 15:25 | 729 | 1,233 | 20/20 |
| TRAE | 15/20 | 75.00% | 0 | 12:24 | 28:11 | 1,204 | 2,287 | 20/20 |
| ZCode | 13/20 | 65.00% | 0 | 16:39 | 24:42 | 1,395 | 1,836 | 20/20 |
| SimpleAgent | 12/20 | 60.00% | 0 | 9:07 | 16:08 | 437 | 962 | 20/20 |
| JiuwenSwarm | 12/20 | 60.00% | 1 | 9:35 | 17:49 | 872 | 1,426 | 19/20 |
| CodeBuddy | 10/20 | 50.00% | 6 | 31:04 | 48:18 | 1,535 | 2,602 | 14/20 |

准确率以每个 Solver 的全部 20 题为分母。耗时取最终尝试的求解阶段，含已完成的错题，剔除求解超时。Token 取最终尝试上报的总量，缺失值跳过。P90 按排序样本的 `0.9 × (n − 1)` 位置线性插值。

## 本次运行题单

九种 Solver 使用相同的 20 个代码任务，从固定版本的 113 个任务中选出。以下为 DeepSWE 1.1 的原始任务 ID，按名称排序。[本次使用的 DeepSWE 1.1 题库](https://github.com/datacurve-ai/deep-swe/tree/0b9fabbb63b9104d678fe965e1632f2dd9eaa2ea/tasks)

1. `abs-module-cache-flags`
2. `anko-typed-variable-bindings`
3. `bandit-structured-nosec-directives`
4. `csstree-shorthand-expansion-compression`
5. `effect-sse-httpapi-streaming`
6. `fastapi-implicit-head-options`
7. `goreleaser-retry-publish-auditing`
8. `httpx-deterministic-cookie-store`
9. `katex-multicolumn-array-spans`
10. `koota-composite-trait-aspects`
11. `langchain-request-coalescing`
12. `numba-stencil-boundary-modes`
13. `opa-rego-rule-profiling`
14. `pest-character-class-coalescing`
15. `query-persist-restored-query-state`
16. `skrub-duration-encoding`
17. `tengo-callable-instance-isolation`
18. `textual-richlog-follow-state`
19. `vitest-duration-sharding`
20. `ytt-jsonpath-query-api`
