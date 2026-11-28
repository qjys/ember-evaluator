# AISBench SSH 插件

通过 SSH 在远端 Linux 已有 Python 环境中运行 AISBench，获取吞吐、延迟和 Prefix Cache 测量结果。模型服务、AISBench 和 tokenizer 由使用者提前准备；插件不部署模型或安装远端依赖。

本插件随 Evaluator 构建和发布，由 CLI 和 SDK 默认注册。插件只依赖 `arsi-evaluator` 包根公开 API。

## 选择场景

默认场景使用固定长度 GSM8K / synthetic 负载。选择 `scenario: native` 可直接使用远端 AISBench 安装的文本、图像等数据集，在同一份 YAML 设置并发、请求数、持续压测和生成参数。完整示例见 [TextVQA 压测](playbook/02-native-textvqa.yaml)，字段映射和自定义多模态 JSONL 示例见[原生压测配置](../../docs/users/benchmarks/aisbench.zh-CN.md#用-yaml-运行原生压测)。

[原生多模态制数示例](playbook/03-generated-multimodal.yaml)组合单图 1080p、五图 720p 与并发 1、8。报告按四个组合展示，支持在正式压测前单独生成、保存并校验请求清单。

[服务端 profiling 示例](playbook/04-service-profiling.yaml)在正式压测后复用同一数据采集 SGLang Ascend 算子耗时，支持单服务和独立诊断服务。

## 安装和构建

需要按图片规格、文本长度和请求数生成负载时，使用[生成多模态数据示例](playbook/03-generated-multimodal.yaml)。压测机安装 AISBench 官方 Prefix Cache 插件后，Evaluator 会在同一次测评中生成一次数据，再逐档测量。[制数配置说明](../../docs/users/benchmarks/aisbench.zh-CN.md#按图片规格生成数据)

需要 Node.js 24.22.1（24.x）及 pnpm 11.22.0，宿主版本 `0.1.0`。在仓库根目录执行：

```bash
pnpm install --frozen-lockfile
pnpm build
```

插件有独立的 package、lockfile、workspace、TypeScript 和 Vitest 配置；根目录构建会自动构建插件。独立插件测试可用 `pnpm --dir plugins/aisbench test`。`dist/index.js` 是单文件入口，`dist/profiles/` 和 `dist/runtime/` 是随包资源。构建将资源哈希写入入口，加载时检查完整性；修改 Python、上游脚本或 profile 后必须重新 build。不要手工修改 `dist`。

使用 `pnpm --dir plugins/aisbench pack --out <plugin.tgz>` 创建本地分发包。旧版 Evaluator 可安装兼容的独立插件包，并用 `--patch` 指定其中的 `cordis.patch.yaml`。

## 准备和执行

编辑 [playbook/01-ssh.yaml](playbook/01-ssh.yaml)，填写远端服务器、AISBench 精确安装版本、Python、AISBench 目录、tokenizer 和工作目录。Conda/venv 直接指定环境中的 Python 绝对路径，无需 `activate`。

本机需要 OpenSSH，使用密钥或 ssh-agent，服务器密钥已加入 `known_hosts`。不支持交互密码。`identityFile` 是本机路径，相对实验 YAML 目录解析；其他目录是远端 POSIX 绝对路径。

示例中的 `MODEL_NAME`、`MODEL_ENDPOINT`、`MODEL_API_KEY`、`AISBENCH_VERSION`、`SSH_IDENTITY_FILE` 从环境变量读取。使用 ssh-agent 时可删除 `identityFile`。模型地址从远端视角解释，远端 `127.0.0.1` 不指本机。无认证模型可设 `MODEL_API_KEY=EMPTY`。模型需兼容 AISBench 所用的 Chat Completions、流式/非流式请求及 `ignore_eos`，兼容性应实际验证。

以下命令在仓库根目录运行：

```bash
arsi-evaluator benchmark list
arsi-evaluator benchmark info aisbench
arsi-evaluator doctor plugins/aisbench/playbook/01-ssh.yaml
arsi-evaluator run plugins/aisbench/playbook/01-ssh.yaml --dry-run
arsi-evaluator run plugins/aisbench/playbook/01-ssh.yaml
```

`doctor` 和 `--dry-run` 需要解析配置中的环境变量，但不连接 SSH、不调用模型；真正运行才检查远端依赖、版本和目录权限。默认组合是 `aisbench` benchmark、`aisbench-ssh` solver、`local` environment/scheduler（并发 1）、`aisbench-performance`/`duration`/`usage` metrics、`aisbench-markdown` reporter。

## 负载与 Prefix Cache

一个实验对应一个测量点，点内并发由 AISBench 控制。不同并发档位分别运行，避免相互影响。`scheduler.concurrency` 必须为 1，不支持 Ray 调度。

| 配置 | 含义 |
| --- | --- |
| `inputLength` | 生成数据的目标输入 token 长度，不含模型模板增加的 token |
| `outputLength` | 输出长度设置 |
| `dataCount` | 正式压测数据条数，预热另计 |
| `concurrency` | 请求最大并发 |
| `requestRate` | 请求速率，0 使用上游不限速行为 |
| `testType` | `stream` 或 `text` |
| `prefixCache.enabled` | 生成公共前缀数据 |
| `prefixCache.prefixCount` | 公共前缀种类数 |
| `prefixCache.prefixRatio` | 公共前缀占输入长度的比例 |
| `prefixCache.warmup` | 测量前发送公共前缀预热 |
| `prefixCache.dp` | 预热使用的数据并行域数量 |
| `prefixCache.seed` | 数据生成随机种子 |

这些参数控制负载，不会打开服务端缓存，也不保证实际命中率。测量命中率时填写 `benchmark.solver.config.podInfo`，其值为远端可访问的 vLLM 指标节点 `host:port`，与模型 API 地址分开。缺少指标不会伪造结果。不启用公共前缀时将 `enabled`、`warmup` 设为 false，并删除 `prefixRatio` 或设为 0。目前支持生成负载的性能模式，不支持任意数据集或精度评测。

## 恢复、产物和离线报告

每档并发的 `cN/performance/agent/session.jsonl` 记录 SSH 作业的配置指纹、启动确认、轮询观察到的状态变化和退出码。同目录下的 `trajectory.jsonl` 记录 Solver 的开始时间，以及成功下载并解析性能结果后的结束时间。中断时可结合同目录下的 `remote.log` 定位最后执行的阶段。请求时延和整组吞吐见 AISBench 性能产物。

远端 supervisor 独立于单次 SSH 连接，Evaluator 轮询阶段、心跳和增量日志。同一次执行重连时核对配置指纹。需要重新压测时启动一个新 run，各次测量分别保留。`supervisor-lost` 不自动重启，需先确认远端是否仍有压测进程。

取消或超时会尝试终止对应远端进程组。SSH 不可用时无法确认取消，应检查日志和服务器；Evaluator 意外退出也可能留下远端任务。每项任务使用独立目录，不修改共享 AISBench 安装。

下载 CSV、脱敏日志、原始输出和执行元数据时验证文件大小和 SHA-256。远端目录保留用于恢复。下载失败、证据缺失或校验不完整时，不记为完整测量。`aisbench-performance` 保留原始 CSV 字段、负载、版本和脚本摘要；性能结果没有质量分数，`passed` 为 null。

```bash
arsi-evaluator report <run-directory>
```

`report` 根据已保存的 provider 元数据加载插件，不接受 `--patch`，也不需要模型凭据、SSH 或重新压测。需保留原 patch 位置与匹配版本的插件资源；移动或修改插件后应先恢复原位置/版本。缺少 provider、入口版本变化或资源损坏会报错。报告器消费公开快照，不猜测宿主内部产物路径。

旧内置 AISBench 分支的 run 不自动转换为插件 run；它们缺少新 provider 记录，不能保证直接续跑或重建性能报告。保留旧版本查看旧 run，新的实验使用本插件。

## 目录与开发检查

```text
plugins/aisbench/
├── index.ts, cordis.patch.yaml      # 四类组件注册、显式加载
├── config.ts, validation.ts        # 插件配置校验
├── benchmark.ts, solver.ts         # 测量点、SSH 生命周期
├── evidence.ts, metrics.ts, reporter.ts
├── ssh/{client,csv,bundle}.ts       # 传输、解析、资源完整性
├── profiles/aisbench.yaml          # 默认组合
├── runtime/remote.py               # 远端 supervisor
├── runtime/upstream/               # 锁定脚本、数据、许可证
├── resources.json                 # 有序资源与上游 revision
├── playbook/01-ssh.yaml
├── scripts/{build,check-package}.mjs
├── tests/{unit,integration,fixtures}/
├── package.json, pnpm-lock.yaml, pnpm-workspace.yaml
├── tsconfig.json, vitest.config.ts
└── README.md
```

`pnpm --dir plugins/aisbench check` 执行独立构建和测试。Python supervisor 测试需将 `AISBENCH_TEST_PYTHON` 设为支持 POSIX 进程组的 Python 3；未设置时明确跳过。Windows 可在 WSL 内执行 `tests/fixtures/check-remote.py dist/runtime/remote.py`，不连接真实服务器。

`pnpm --dir plugins/aisbench check:package` 打包已构建的宿主和插件，在源码目录外新建消费者安装 tarball，验证加载隔离、doctor、dry-run、provider 版本和无凭据离线报告。需能安装宿主依赖；私有依赖不可访问时可用 `--dependency-overrides <json-file>` 显式提供本地 `.tgz`，结果会记录替代项。

上游 [aisbench_auto_tools_prefix](https://github.com/rayn-zzz/aisbench_auto_tools_prefix/tree/ac06bd619726663ac8c7b0c84c9b3cdbb041b062) 固定 revision 为 `ac06bd619726663ac8c7b0c84c9b3cdbb041b062`，来源和许可见 [NOTICE](runtime/upstream/NOTICE.md) 与 [LICENSE](runtime/upstream/LICENSE)。
