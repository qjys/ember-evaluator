# AISBench SSH 插件

> [English](./aisbench.md) | 中文

AISBench 随 Evaluator 发布，CLI 和 SDK 默认注册。

安装、配置、执行、离线报告与限制统一见 [AISBench 插件说明](../../../plugins/aisbench/README.md)。

## 固定长度合成工作负载

设置 `benchmark.config.workload.dataset: synthetic` 使用 AISBench 原生 SyntheticDataset；通过 `inputLength`、`outputLength`、`dataCount`、`concurrency`、`requestRate` 和 `warmups`（默认 0）配置负载。例如 4096/2048 token、1320 请求、并发 330、8 次预热。此模式使用流式请求，不生成共享前缀；这不等于关闭服务端前缀缓存，也不证明实际缓存命中率。

SSH solver 检查成功请求数、零失败、实际输入输出 token 总量及毫秒时延。合成性能结果不代表精度验证。省略 `dataset` 时，原有 GSM8K/前缀负载不变。远程失败即使未触发本地取消也会尝试停止任务；取消未确认会留下 `cleanup-unconfirmed.json`，调用方必须先核对再重启。

合成负载使用 `aisbench:synthetic` 来源标识。内置指标和报告支持该标识并保留实际测量行，不要求数据集实现哈希。RSI 调用方也需支持合成负载字段与来源标识。

现有 `aisbench-performance` 指标结果在每个测量点提供 `workload` 和规范化标量 `metrics`：指标名对应 `{ value, unit, source }`，缺失值为 `null`，证据位置是相对该测量点的 JSON Pointer。原始 `measurement` 证据仍供报告使用。仅执行完成且产物收集完整的测量点输出指标。AISBench 解析、请求/token 完整性及来源验证由本插件负责，调用方无需再次解析 CSV。

## 用 YAML 运行原生压测

### 在压测机上准备 MMMU 图片

同时跑单图 1080p 和五图 720p 时，只需从 MMMU 官方数据集下载两个测试分片，合计约 193 MB。Sociology 分片含 1920×1080 原图，Literature 分片含 1280×720 原图。在运行 AISBench 的 Linux 压测机上，用 Hugging Face CLI 执行以下命令。[MMMU 官方数据集](https://huggingface.co/datasets/MMMU/MMMU) · [Hugging Face CLI 安装说明](https://huggingface.co/docs/huggingface_hub/guides/cli)

```bash
hf download MMMU/MMMU \
  Sociology/test-00000-of-00001.parquet \
  Literature/test-00000-of-00001.parquet \
  --repo-type dataset \
  --local-dir /data/MMMU
```

在 YAML 中填写 `multimodalGeneration.mmmuParquetDir: /data/MMMU`。AISBench 会递归读取该目录下的 Parquet 文件。如果下载到其他位置，将这个字段改为压测机上的实际绝对路径。

### 按图片规格生成数据

在压测机运行 AISBench 的 Python 环境中，从匹配版本的 AISBench 源码根目录执行 `python -m pip install -e ./plugins/prefix_cache`。已验证 AISBench 3.1.0 与官方插件 0.5.0。若宿主 wheel 缺少 `ais_bench.benchmark.datasets.utils`，在同一源码根目录执行 `python -m pip install -e .` 以使用完整源码。准备含目标尺寸原图的 MMMU Parquet 目录和模型 tokenizer。复制[完整制数与压测 YAML](../../../plugins/aisbench/playbook/03-generated-multimodal.yaml)，填写模型服务、SSH 和远端路径。生成模式的核心字段如下。

```yaml
benchmark:
  name: aisbench
  scenario: native
  config:
    backend: vllm_api_general_chat
    multimodalGeneration:
      imageScenario: [single_1080p, multi_720p_5]
      textTokens: 32
      mmmuParquetDir: /data/MMMU
    dataCount: 16
    maxOutputTokens: 32
    concurrency: [1, 8]
    stream: true
    warmups: 0
```

`single_1080p` 每条请求带一张 1920×1080 原图。`multi_720p_5` 每条带五份相同的 1280×720 原图。生成器按 `benchmark.solver.config.tokenizerPath` 将每条请求的文本调整为指定 token 数；图像和对话模板占用的 token 另计。默认文本语料使用随 Evaluator 分发的 GSM8K。可用 `multimodalGeneration.corpusPath` 指向压测机上的兼容 JSONL，其中需有足够多的不同问题。`maxOutputTokens` 为输出上限，生成模式默认 256。

上述实验产生四组结果。每种图片规格在每档并发各发 16 条正式请求，共 64 条。各组使用相同文本，报告按规格和并发展示吞吐与时延。流式请求可测首 token 时延（TTFT）、每个输出 token 耗时（TPOT）及相邻 token 时延（ITL）。`imageScenario` 也接受单值，省略时使用单图 1080p。`dataCount: [4, 16]` 表示每种规格准备 16 条，并发 1 使用前 4 条，并发 8 使用全部 16 条。制数摘要保存在 `artifacts/aisbench/native-plan.json` 的 `multimodalGeneration.datasets`。[官方生成器说明](https://github.com/AISBench/benchmark/blob/7ace6948a3a2726578aed869db0d5885ace11d55/plugins/prefix_cache/MULTIMODAL.md)

需要分别控制样本记录的输出长度和模型后端的输出上限时，在 `multimodalGeneration` 中填 `outputTokens`，在外层填 `maxOutputTokens`。只填其中一个会为两者使用同一数值。

**只生成数据**时，在上例的 `benchmark.config` 下添加 `multimodalAction: prepare`，并在 `multimodalGeneration` 下添加 `outputDirectory: /data/aisbench/prepared`。每次生成使用独立子目录。运行报告给出远端 manifest 绝对路径，清单和请求 JSONL 供后续实验复用。默认的生成并压测也可用 `outputDirectory` 保留这批数据。

**复用同一批数据**时，把 `multimodalGeneration` 整段替换成 `multimodalManifest: /data/aisbench/prepared/实际子目录/multimodal-prefix-cache.manifest.json`。设置 `multimodalAction: validate` 只检查清单、图片和请求文件，或设置 `multimodalAction: run` 校验后压测。沿用同一台压测机及清单引用的原始路径。省略 `dataCount` 和 `maxOutputTokens` 会沿用清单中的条数和输出长度。prepare 和 validate 均不向模型发请求。对已完成的 run 使用 `arsi-evaluator report <运行目录>` 可离线重出各档报告。

### 使用现有图片、视频和音频数据集

原生压测也接受 `datasets: [videomme_gen]`（视频）或 `datasets: [vocalsound_gen_base64]`（音频）。自备数据使用 `mm_custom_gen`，可配置 `mm_type: path` 或 `base64`，视频还可设置 `num_frames`。选择支持该媒体类型的模型后端，媒体文件按相应加载器要求部署。自动合成图片规格只用于上面的图文生成器。[上游多模态输入指南](https://github.com/AISBench/benchmark/blob/7ace6948a3a2726578aed869db0d5885ace11d55/docs/source_zh_cn/advanced_tutorials/multimodal_benchmark.md)

使用[完整 TextVQA 示例](../../../plugins/aisbench/playbook/02-native-textvqa.yaml)。在 `services` 指定已经启动的模型服务，在 `benchmark.solver.config.remote` 指定安装 AISBench 的 Linux 压测机和 Python 环境。该环境需要有数据、tokenizer 和相应多模态依赖。公开数据集按其上游说明部署。[TextVQA 部署说明](https://github.com/AISBench/benchmark/blob/master/ais_bench/benchmark/configs/datasets/textvqa/README.md)

```yaml
benchmark:
  name: aisbench
  scenario: native
  config:
    backend: vllm_api_general_chat
    datasets: [textvqa_gen_base64]
    concurrency: [1, 8]
    dataCount: 100
    stream: true
```

这个实验由 AISBench 读取图片和问题，分别以 1 和 8 并发向服务发送真实请求，每档最多取 100 条数据。预热另算。换题库只需改 `datasets`。例如自有图文数据可以这样写，绝对路径从压测机解释，样本格式和媒体的可访问性遵循上游数据集要求。[原生自定义多模态数据集](https://github.com/AISBench/benchmark/tree/master/ais_bench/benchmark/configs/datasets/mm_custom)

```yaml
datasets:
  - name: mm_custom_gen
    config:
      path: /data/receipts/requests.jsonl
      mm_type: base64
      infer_cfg:
        prompt_template:
          template:
            round:
              - role: HUMAN
                prompt_mm:
                  text: {type: text, text: "{question}"}
                  image: {type: image_url, image_url: {url: "data:image/jpeg;base64,{image}"}}
```

这个例子用于 JPEG。原生 `mm_custom_gen` 的默认模板使用 `file://`。`mm_type` 控制加载器怎样读取媒体，`prompt_mm` 控制服务收到的内容格式，二者需要匹配。路径模式要求服务能读到媒体路径。音频可以使用上游的 `vocalsound_gen_base64` 模板；自定义视频的 Base64 模式按 `num_frames` 抽取 PNG 帧，服务后端需接受对应表示。

| YAML 字段 | 对应 AISBench 参数 | 用法 |
| --- | --- | --- |
| `backend`、`datasets` | `--models`、`--datasets` | 任务名由远端安装解析。多个服务化后端共用所绑定的服务。 |
| `concurrency`、`dataCount` | `--batch-size`、`--num-prompts` | 并发可填单值或列表。条数填单值时每档相同，填列表时与并发逐项对应。 |
| `requestRate`、`warmups` | `--request-rate`、`--num-warmups` | 限定发请求的速率、预热次数。可显式填 0。 |
| `stream`、`maxOutputTokens` | `--stream` / `--no-stream`、`--max-out-len` | 首 token 等流式时延需要开启流式，输出上限以 token 计。 |
| `pressureSeconds` | `--pressure --pressure-time` | 正整数秒，启用持续施压。例如 `60` 表示持续 60 秒。 |
| `speculativeDecoding` | `--spec-decode` | 启用上游投机解码指标采集，需要服务提供相应指标。 |
| `generationParams` | `--generation-kwargs` | 例如 `{temperature: 0.2}`，作为一个 JSON 对象传入。 |
| `summarizer` | `--summarizer` | 命名任务默认 `default_perf`。 |
| `options` | 远端版本的其他性能参数 | 例如 `{cooldown: 0}`。布尔、列表、对象按原生参数定义编码。服务、输出目录和已映射字段有冲突会报错。 |

Solver 使用 `aisbench-ssh`。其中 `tokenizerPath` 映射到 `--path`。省略时使用原生模型配置的 tokenizer 设置。`remote.workingDirectory` 可指定上游执行时的当前目录，复用旧 SSH 配置时也可沿用 `remote.aisbenchWorkPath`。数据集覆盖作用于本次进程加载的原生配置，字典按键合并，数组整体替换。一个任务名包含多项时用 `datasets[].abbr` 选择需要修改的那项，其他项照常运行。

已有完整原生配置时，可用 `configFile: ./bench/run.py` 及可选 `files: [./bench/helper.py]`，或用 `remoteConfigFile: /bench/run.py` 替代 `backend` 和 `datasets`。配置文件自行定义模型和服务，可读环境变量 `EVALUATOR_AISBENCH_MODEL`、`EVALUATOR_AISBENCH_BASE_URL`、`EVALUATOR_AISBENCH_API_KEY`。本地 Python 文件按摘要核对并上传，数据与模型在远端准备。

`run --dry-run` 在本地校验并列出任务。正式运行时检查远端版本，原生参数和数据集须由该版本支持。脱敏调用见 attempt 下 `artifacts/aisbench/native-plan.json`，文本产物在同目录的 `outputs/`，跳过的私有配置或不支持格式见 `collection.json`。报告按原生模型和数据集分组，保留请求数、吞吐和已有时延分位数的单位。缺组、请求失败或无法识别的结果在报告中单独标出。

## 一次运行采集推理性能和 Ascend profiling

[TextVQA 双轮示例](../../../plugins/aisbench/playbook/04-service-profiling.yaml)使用同一服务先跑完并发 1、8 的正式压测，再依次采两档 trace。正式结果仍包括吞吐、请求时延和流式首 token 时延。图片和请求由 AISBench 发送；生成式多模态输入在同一作业内只制数一次。填写服务、SSH 和共享目录后运行：

```bash
arsi-evaluator run plugins/aisbench/playbook/04-service-profiling.yaml
```

在 `benchmark.config` 设置以下独立可选项，省略两项时沿用普通压测：

| 参数 | 用法 |
| --- | --- |
| `engineMetrics` | 填写普通服务的 Prometheus `/metrics` 样本名。每档先预热，随后在正式压测前后各读一次。按标签保存两次读数，对有类型声明的 counter 给出增量。服务未提供的指标、重置的计数器及采集失败会标为部分结果。 |
| `profiling.traceDirectory` | 压测机与 SGLang Ascend 服务以相同绝对路径挂载的可写目录。服务须支持 `POST /start_profile`、`POST /stop_profile` 和 NPU 自动导出。按部署启用 `SGLANG_NPU_PROFILE_AUTO_EXPORT=1`。控制接口影响整个实例，采集期间请独占服务。 |
| `profiling.service` | 默认复用 solver 的服务。使用独立诊断实例时填 `services` 下的名称，两端提供相同的模型、权重与候选版本。第二轮推理请求及控制调用使用该服务的 URL 和凭据。 |
| `profiling.requestsPerPoint` | 每档每个数据集的诊断请求数，默认取并发数与该档正式请求数的较小值。诊断轮复用数据和生成参数，关闭持续压测。按 `warmups` 先独立预热，省略时诊断轮预热一次，填 0 可关闭。 |
| `profiling.exportTimeoutSeconds` | 每个窗口等待导出文件的上限，默认 1800 秒。为整个 run 留足时间。 |

这些选项适用于 `scenario: native` 下由 evaluator 绑定服务的 `backend` + `datasets`、`multimodalGeneration` 或 `multimodalManifest`。独立 Python 配置文件自行选择服务。一个诊断窗口覆盖一档并发的一次 AISBench 命令，包含命令启动、请求和汇总；若命令同时选择多个原生数据集，trace 覆盖它们的合计负载。各个生成图片规格有独立窗口。

在 `report.md` 查看正式压测和每档服务端读数。在 `metrics.json` 的 `aisbench-native-performance` 中，`groups` 保存普通压测结果，`collections` 保存引擎快照及每个 rank 的算子、Kernel、阶段耗时和 Top 算子。完整原始导出留在共享目录，用于解析的 CSV/JSON 随 attempt 保存在 `artifacts/aisbench/profiling/point-*/trace/`。诊断请求不会计入正式吞吐。正式请求不完整时跳过 profiling，只有 Host 数据时标为 `host-only`，接口或导出失败时记录错误并保留已取得的普通性能数据。
