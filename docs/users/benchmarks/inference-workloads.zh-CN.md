# 用同一份配置测推理服务

[English](./inference-workloads.md)

下面的实验让 AISBench 向视觉模型发送 TextVQA 的前 100 条输入。并发 1 和 8 各测这 100 条，分别输出吞吐、TTFT 和 TPOT。

~~~yaml
target: blue-vllm-tp2
benchmark:
  name: aisbench
  workload: { type: dataset, dataset: textvqa_gen_base64, requests: 100 }
  concurrency: [1, 8]
  collect: all
~~~

换成 AgentX 时，写 `name: agentx` 和 `workload: {type: replay, traces: 8}`。每档回放前 8 个完整会话，每个会话可以产生多条模型请求。

## 登记机器

把以下内容保存到实验 YAML 同级的 `targets.yaml`，或用 `EVALUATOR_TARGETS` 指定共享文件。相对路径从实验文件所在目录解析。密钥留在环境变量。也可以沿用实验中的 `services`。

~~~yaml
targets:
  blue-vllm-tp2:
    hardware: npu
    services:
      default:
        model: my-vision-model
        base_url: http://model-server:8000/v1
        api_key: ${MODEL_API_KEY}
    agentx:
      loadNode: load-host
      tokenizer: /models/my-vision-model
      pythonExecutable: /opt/python/bin/python3.12
    aisbench:
      tokenizerPath: /models/my-vision-model
      remote:
        ssh: { host: load-host }
        pythonExecutable: /opt/aisbench/bin/python
        aisbenchVersion: "3.1.0"
        workingDirectory: /opt/benchmark
    data:
      mmmuParquetDir: /data/MMMU
    serviceNode: inference-host
    profiling:
      provider: vllm
      traceDirectory: /data/vllm-traces
      devices: [0, 1]
~~~

AISBench 的指定 Python 环境需要已安装相应版本。AgentX 的 `loadNode` 是可选 SSH 别名，省略时使用 evaluator 的执行环境，指定时在发压机缓存固定版本的 Harness。远端 Python 使用 3.11–3.13。SSH 别名需支持免交互认证、已验证的主机密钥和文件传输。

数据和 tokenizer 路径属于发压机。`serviceNode` 是推理节点的 SSH 别名。vLLM 启动时需要启用 torch profiler，并将输出目录挂载到 `traceDirectory`。使用 SGLang 时选 `provider: sglang`。`devices` 取服务的物理 NPU 号。在服务节点直接运行 evaluator 时可省略 `serviceNode`，用回环地址和设备号启用本机采样。驱动和 CANN 工具的可见性决定能读取哪些硬件计数器。若 `msprof` 只装在推理容器里，可在 target 的 `profiling.samplerPython` 指向能在该容器中执行 Python 的入口。采样脚本和产物路径须在容器内以相同的绝对路径可见。`doctor` 会用该入口检查设备和 `msprof`。

## 选择负载

| 工具 | workload.type | 常用字段 |
| --- | --- | --- |
| AgentX | time-window | `durationSeconds`，标准窗口 3600 秒 |
| AgentX | replay | `traces`，前几个完整会话 |
| AISBench | dataset | `dataset` 是原生数据集配置名，可选 `requests` 和 `backend`。GSM8K 和 TextVQA 使用各自的配置名 |
| AISBench | synthetic-text | `inputTokens`、`outputTokens`、`requests`，可选 `prefixCache` |
| AISBench | synthetic-multimodal | `images`、`textTokens`、`outputTokens`、`requests`，或用 `manifest` 复用已有输入 |
| 两者 | native | `args` 逐项传给原生工具。AISBench 可用 `file` 和 `files` 上传实验目录下的 Python 配置与配套模块 |

生成图文输入时可以写 `workload: {type: synthetic-multimodal, images: single_1080p, textTokens: 256, outputTokens: 32, requests: 100}`。`images` 也支持 `multi_720p_5` 或两种规格的列表。选 `action: prepare` 只制数，结果中会给出 manifest 的路径；用 `action: validate` 和 `manifest` 校验清单。只制数或校验时省略 `collect` 和 `concurrency`。前缀缓存压测另需在 target 的 `aisbench.remote.aisbenchWorkPath` 登记工具源码目录。

原生调用可以写 `workload: {type: native, args: [--models, vllm_api_stream_chat, --datasets, textvqa_gen_base64, --debug]}`。无值开关占一个元素，重复参数按顺序写入列表。支持 `--stream` 的版本可直接传这个开关；通过模板开启流式的版本可选 `vllm_api_stream_chat`。省略并发时沿用工具配置，结果落在 `configured/`。显式分档时会核对工具实际使用的并发。原生 Python 配置可能自带服务地址，文件入口仅支持 `collect: performance`。按题测 GSM8K 延用原有 Benchmark 和结果目录。

已有 AISBench Python 配置时，可以直接上传文件。

~~~yaml
benchmark:
  name: aisbench
  workload: {type: native, file: ./perf.py}
  collect: performance
~~~

保留实验的 `target` 或 `services`。文件随每档作业上传，运行时可读取环境变量 `EVALUATOR_AISBENCH_MODEL`、`EVALUATOR_AISBENCH_BASE_URL` 和 `EVALUATOR_AISBENCH_API_KEY`。省略 `concurrency` 会使用文件中的 `batch_size`。需要核对实际调用时，查看 AISBench 的 `native-plan.json` 或 AgentX 的 `native-command.json`。

## 运行与读取结果

~~~bash
arsi-evaluator inspect experiment.yaml
arsi-evaluator doctor experiment.yaml
arsi-evaluator run experiment.yaml
arsi-evaluator report results/<run-id>
~~~

`inspect` 展示展开的配置与原生参数来源，实际 argv 随各档产物保存。`doctor` 检查发压机上的路径、模型可达性和服务节点的采集条件。

| collect | 每档并发的执行顺序 | 数据用途 |
| --- | --- | --- |
| performance（默认） | 正式压测 | 请求延迟、吞吐、服务公布的 KV Cache 和队列指标 |
| profiling | 预热、开启 profiler、有界诊断负载、停止并导出 | 诊断原始证据和分类指标 |
| all | 先正式压测，成功后执行 profiling | 保留两轮各自的来源 |

每档的证据在 `c1/performance/`、`c1/profiling/` 等目录。`metrics/` 下的 `service/`、`engine/`、`resource/`、`execution/`、`hardware/`、`parallelism/` 按类记录测量值、覆盖情况与来源。诊断失败时可以读取已完成的正式结果。服务未确认停止 profiler 时，后续档位会暂停。
