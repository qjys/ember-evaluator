# CLI 命令参考

> [English](cli.md) | 中文

表中每行都是完整命令。执行时将 `<yaml>` 等占位符替换成实际值，方括号表示其中的参数或值可省略。`ember` 是 `ember-evaluator` 的别名。

## 查看帮助

| 完整命令 | 用途 | 可选参数 |
| --- | --- | --- |
| `ember-evaluator --help` | 查看当前安装版本提供的命令。`-h` 是 `--help` 的简写。 | — |
| `ember-evaluator <command> --help` | 查看具体命令或子命令的帮助，例如 `ember-evaluator kernel profile --help`。 | — |
| `ember-evaluator help [command]` | 查看某个顶层命令的帮助。直接运行 `ember-evaluator` 或 `ember-evaluator help` 会显示顶层帮助。 | — |

## 选择 Benchmark 和配置实验

| 完整命令 | 用途 | 可选参数 |
| --- | --- | --- |
| `ember-evaluator benchmark list` | 列出已注册 Benchmark 的版本、默认版本和场景。用 `--json` 输出结构化数据。 | `--json`, `--patch <path>` |
| `ember-evaluator benchmark info <name>` | 查看指定 Benchmark 的详情及各版本解析后的设置。 | `--patch <path>` |
| `ember-evaluator init --benchmark <name> --output <yaml>` | 从指定 Benchmark 的默认配置生成实验 YAML。目标文件已存在时保留原文件。 | `--patch <path>` |
| `ember-evaluator inspect <yaml>` | 显示解析后的实验配置与网络设置。该命令跳过下载和网络探测。 | `--patch <path>`, `--network <yaml>` |

## 准备环境与清理镜像

| 完整命令 | 用途 | 可选参数 |
| --- | --- | --- |
| `ember-evaluator doctor <yaml>` | 检查实验配置、运行环境前置条件和网络连通性。 | `--patch <path>`, `--network <yaml>` |
| `ember-evaluator warmup <yaml>` | 提前准备所选任务的镜像和运行时依赖。求解和评分在正式评测时执行。 | `--patch <path>`, `--network <yaml>`, `--progress <mode>`, `--task-ids-file <json>` |
| `ember-evaluator cleanup images [yaml]` | 默认预览待清理的评测镜像引用。传 `--yes` 才执行删除。省略实验 YAML 时必须传 `--all`，指定 `--patch` 时必须提供实验 YAML。 | `--all`, `--yes`, `--patch <path>` |

## 运行评测、补测和重建报告

| 完整命令 | 用途 | 可选参数 |
| --- | --- | --- |
| `ember-evaluator run <yaml>` | 执行评测并保存结果。 | `--patch <path>`, `--network <yaml>`, `--progress <mode>`, `--task-ids-file <json>`, `--model <name>`, `--endpoint <url>`, `--api-key <key>`, `--api-key-env <name>` |
| `ember-evaluator run <yaml> --dry-run` | 解析数据集并列出所选任务 ID，必要时会下载数据集。 | 见 `run` 一行 |
| `ember-evaluator run <yaml> --resume [run-id]` | 续跑已有评测。省略 ID 时自动选择可续跑的 Run。 | 见 `run` 一行 |
| `ember-evaluator run <yaml> --tracer [url]` | 运行评测并将 Attempt 证据同步到 Tracer。传入 URL 可指定本次使用的 Collector 地址。 | 见 `run` 一行 |
| `ember-evaluator retry --run <id-or-directory>` | 在原 Run 内补测符合条件的网络失败任务。可重复传入 `--task-id` 缩小范围，用 `--request-id` 避免重复提交，并用 `--reason` 记录原因。 | `--task-id <id>`, `--request-id <id>`, `--reason <text>`, `--network <yaml>`, `--progress <mode>` |
| `ember-evaluator report <run-dir>` | 从已保存结果离线重建指标和 `report.md`，无需模型 API key。 | — |

`--dry-run` 与 `--resume` 互斥。 [网络补测条件](../network-retry.zh-CN.md#命令)

## Tracer

在仓库根目录沿用 [GSM8K 快速入门](../quick-start.zh-CN.md)的模型配置。第一条命令运行评测，并按需启动或复用本地 Collector。评测启动后，可在另一个终端运行第二条命令查看 Collector 状态。

```bash
ember-evaluator run playbook/gsm8k/gsm8k-quick-start.yaml --tracer
ember-evaluator tracer status
```

需要单独启动 Collector 时，执行 `ember-evaluator tracer serve`。在浏览器打开 `http://127.0.0.1:8787` 查看采集结果。[Tracer 配置](../tracer.zh-CN.md#collector-配置)

| 完整命令 | 用途 | 可选参数 |
| --- | --- | --- |
| `ember-evaluator tracer serve` | 启动或复用健康的 Collector。`--timeout` 是启动等待时间，默认 `30000` 毫秒。 | `--url <url>`, `--db <path>`, `--spool <path>`, `--port <n>`, `--timeout <ms>` |
| `ember-evaluator tracer status` | 输出 Collector 的 JSON 状态。Collector 不健康时返回非零退出码。 | `--url <url>`, `--db <path>`, `--spool <path>`, `--port <n>` |
| `ember-evaluator tracer logs` | 查看 Collector 日志，默认输出最后 `200` 行。用 `--follow` 或 `-f` 持续查看新增行。 | `--url <url>`, `--db <path>`, `--spool <path>`, `--log <path>`, `--lines <n>`, `--follow`, `-f` |
| `ember-evaluator tracer stop` | 停止 `tracer.pid` 记录的 Collector 进程。 | `--url <url>`, `--db <path>`, `--spool <path>`, `--port <n>` |

管理 Collector 时，`--url` 指定地址，`--port` 覆盖端口，`--db` 和 `--spool` 分别指定数据库和待传输目录，`--log` 指定要读取的日志文件。

## 算子测量

| 完整命令 | 用途 | 可选参数 |
| --- | --- | --- |
| `ember-evaluator kernel precision --problem <path> --kernel <path> --out <json>` | 在 NPU 上对照参考结果验证候选算子。`--seeds` 接受带引号的空格分隔列表，默认 `"0 1"`。 | `--seeds <list>`, `--device <n>`, `--python <executable>` |
| `ember-evaluator kernel bench --problem <path> --kernel <path> --out <json>` | 测量候选算子在 NPU 上的运行耗时。精度验证使用 `kernel precision`。 | `--device <n>`, `--python <executable>` |
| `ember-evaluator kernel profile --problem <path> --kernel <path> --out <json>` | 单独采集候选算子的 NPU 性能数据。轮次、回放种子和采集前预热次数分别默认 `0`、`0`、`25`。 | `--round <n>`, `--seed <n>`, `--warmup <n>`, `--device <n>`, `--python <executable>` |

`kernel` 子命令的 `--problem` 指向问题和参考实现定义，`--kernel` 指向候选实现，`--out` 指定结果 JSON。`--device` 接收逻辑 NPU 编号，`--python` 指定 Python 可执行文件。设备值为 `0` 时由 worker 从环境中选择，环境未指定时使用设备 `0`。[算子命令示例](../benchmarks/kernel-npu.zh-CN.md#独立测量原子)

## 多个命令共用的选项

- `--patch <path>` 加载指定的插件 patch，路径相对于当前工作目录。已安装的扩展和显式 patch 可以增加命令或 `run` 选项。插件命令也接受 `--patch` 以发现插件。[外部插件加载](../../development/add-external-plugin.md)
- `--network <yaml>` 为本次命令指定网络配置。`--progress <mode>` 接受 `auto`（默认）、`tty` 或 `plain`。[网络配置](../network.zh-CN.md) · [实时执行预览](../usage.zh-CN.md#实时执行预览)
- `--task-ids-file <json>` 读取含 `taskIds` 数组的 JSON 对象，替换配置里的选题 ID，并清除偏移、最大任务数和抽样设置。`--resume [run-id]` 省略 ID 时自动选择可续跑的 Run。`--dry-run` 与 `--resume` 互斥。[选题](../usage.zh-CN.md#查看并保存实际任务-id) · [续跑](../usage.zh-CN.md#续跑与重建报告)
- `run --model` 和 `run --endpoint` 分别覆盖 Solver 模型和 API 地址。凭证可通过 `--api-key-env <name>` 或 `--api-key <key>` 提供，两者互斥。使用环境变量名可避免将 key 写在命令行中。[模型服务](../solvers.zh-CN.md)

命令失败的退出码见[错误码与退出码](errors.zh-CN.md)。
