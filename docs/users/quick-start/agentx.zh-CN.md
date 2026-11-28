# AgentX 性能评测快速入门

> [English](./agentx.md) | 中文

AgentX 使用与其他 Benchmark 相同的 `doctor → run --dry-run → run` 命令。推理服务由用户提前手动启动，Evaluator 只调用 YAML 中的 HTTP 接口；推荐 local 回放，不创建 AgentX 任务容器，硬件采样在 `run` 时自动在裸机启动，结束后停止。

[项目主页](../../../README.zh-CN.md) · [用户文档](../README.zh-CN.md) · [AgentX 完整指南](../benchmarks/agentx.zh-CN.md)

## 1. 选择运行环境并构建

使用管理容器时，在 Linux Docker 宿主机的 Evaluator 仓库执行以下命令。直接在宿主机运行时，从后面的构建命令开始。

```bash
bash scripts/toolbox/run.sh
```

管理容器是可选项。不使用时，按[源码安装](../installation.zh-CN.md#直接安装)准备 Node/pnpm，另需已有 Python 3.11–3.13 和 venv 支持；不必运行 toolbox，也不要求 Docker daemon。下面的构建和评测命令可直接在裸机执行，Harness 只安装到独立缓存 venv，不修改全局 Python 或自动安装系统包。

使用管理容器时，以下命令在容器内执行。`PNPM_HOME`、全局命令 PATH 和目录已自动配置，无需手动执行 `pnpm setup` 或导出 PATH；裸机运行按安装指南配置全局命令目录。

```bash
pnpm install --frozen-lockfile
pnpm build
pnpm add --global .
arsi-evaluator --help
```

工具箱共享 Evaluator 仓库，Node/pnpm、Python 和编译器由管理镜像提供。AgentBundle 随项目依赖自动安装到容器的专用依赖卷中。AgentX 首次执行时自动创建独立缓存 venv 并安装 Harness，后续各并发档复用；无需手动创建 venv、任务容器或 SSH Worker。裸机无需安装这些容器内依赖。

## 2. 填写 YAML 和模型变量

先按模型服务的接入方式选择 YAML。标准场景每个并发点默认测量一小时；在 `benchmark.config` 中设置 `durationSeconds: 60` 可改为 60 秒测量，准备、预热及收尾另外耗时。自定义时长的结果不能当作正式一小时可比成绩，详见[测量窗口配置](../benchmarks/agentx.zh-CN.md#并发与配置)。

| 配置项 | 自己部署的推理服务 | 直接调用在线模型 API |
| --- | --- | --- |
| `MODEL_NAME` | 推理服务 `/v1/models` 返回的模型 ID；设置了模型别名就填别名 | 服务商文档或模型列表中的模型 ID |
| `MODEL_ENDPOINT` | 自建服务的 OpenAI 兼容 base URL，如 `http://127.0.0.1:8000/v1` | 服务商提供的 OpenAI 兼容 base URL，如 `https://api.example.com/v1`；不是网页聊天地址 |
| `MODEL_API_KEY` | 服务配置的密钥；无鉴权时填非空占位值 `EMPTY` | 服务商签发的有效 API key |
| YAML | 采集同机 NPU 和 vLLM 时用 [agentx-npu-local.yaml](../../../playbook/agentx/agentx-npu-local.yaml)；只测请求时用 [agentx-standard.yaml](../../../playbook/agentx/agentx-standard.yaml) | 使用 [agentx-model-api.yaml](../../../playbook/agentx/agentx-model-api.yaml)，不配置 `telemetry` |
| 可采集指标 | 请求和回放性能；能访问监控端点时再采集推理引擎指标，同机裸机可采集指定 NPU | 客户端观测的延迟、吞吐、token 等请求和回放指标；**不能采集服务端推理引擎及 GPU/NPU 硬件指标** |

### 自己部署的推理服务

先手动启动推理服务。假设服务的 `/v1/models` 返回模型 ID `my-qwen`，接口在同机 8000 端口且无鉴权，可填写：

```bash
export MODEL_NAME='my-qwen'
export MODEL_ENDPOINT='http://127.0.0.1:8000/v1'
export MODEL_API_KEY='EMPTY'
export EVALUATOR_CONFIG="$EVALUATOR_DIR/playbook/agentx/agentx-npu-local.yaml"
```

`127.0.0.1` 适用于推理服务与 Evaluator 位于同一宿主机；远端服务要换成实际可访问地址。NPU 自动采样只能读取 Evaluator 所在裸机的设备，不能用本机卡号代替远端服务的硬件。YAML 中的 `vllm.endpoint` 是监控地址，例如 `http://127.0.0.1:8000/metrics`，不带 `/v1`。未部署 vLLM 或未开放监控时删除 `telemetry.vllm`。

在 YAML 中把 `devices` 改为推理实际使用的物理 NPU 卡号，把 `tokenizer` 改为匹配模型的 Hugging Face 仓库或 tokenizer 目录。`my-qwen` 只是服务别名，不能直接用作 tokenizer 仓库；目录应在 Evaluator 所在环境可读，管理容器需要能访问该目录。无需增加 tokenizer 环境变量。

### 直接调用在线模型 API

按服务商文档填写三个模型变量并选择在线 API 示例。以下是占位示例，需要替换地址和模型 ID：

```bash
export MODEL_NAME='provider-model-id'
export MODEL_ENDPOINT='https://api.example.com/v1'
read -rsp '服务商 API key: ' MODEL_API_KEY
printf '\n'
export MODEL_API_KEY
export EVALUATOR_CONFIG="$EVALUATOR_DIR/playbook/agentx/agentx-model-api.yaml"
```

在线 API 示例省略整个 `telemetry`，不会启动 NPU 采样，也不会访问本机 `/metrics`。普通模型 API 不开放服务端推理引擎和硬件监控，不能从 Chat Completions 响应推算这些指标；报告只包含实际采集到的请求和回放性能。不要把本机 NPU 或无关推理服务的指标填入在线 API 测评。

在线模型 ID 往往也不是 tokenizer 仓库名，必须在 YAML 中将 `tokenizer` 改成与服务模型匹配、可获取的仓库或本地目录。无法获得匹配 tokenizer，或接口不支持 AgentX 需要的 `ignore_eos`、流式请求、完整上下文与输出长度时，不能认定该 API 可以完成标准测评。

### 使用交互输入

两种方式也都可以交互输入模型变量，然后按上面选择的方式设置 `EVALUATOR_CONFIG`：

```bash
read -rp '模型 ID: ' MODEL_NAME
read -rp '模型 base URL（例如 http://服务地址:8000/v1）: ' MODEL_ENDPOINT
read -rsp '模型 API key: ' MODEL_API_KEY
printf '\n'
export MODEL_NAME MODEL_ENDPOINT MODEL_API_KEY
```

本地无鉴权服务也要为 `MODEL_API_KEY` 输入非空占位值，如 `EMPTY`。模型需支持流式 Chat Completions、`ignore_eos` 和 Trace 指定的输出长度；256k 数据需至少 256k 上下文及足够余量。推理启动参数和上下文条件见[准备与运行](../benchmarks/agentx.zh-CN.md#准备与运行)。

自建服务的采集配置示例（在线 API 不添加 `telemetry`）：

```yaml
benchmark:
  name: agentx
  scenario: standard
  config:
    concurrency: [1, 4, 8]
  solver:
    config:
      tokenizer: /path/to/tokenizer
      telemetry:
        vllm:
          endpoint: http://127.0.0.1:8000/metrics
        ascend:
          mode: local
          devices:
            - deviceId: 4
environment: local
```

需要同时保留原始延迟和扣除网络 RTT 后的延迟时，在上述 `benchmark.solver.config` 下添加 `networkLatency: { mode: automatic }`。默认每秒探测一次，报告会显示 RTT、探测状态及两组延迟；手动 RTT 和字段说明见[网络延时校准](../benchmarks/agentx.zh-CN.md#网络延时校准)。省略该配置时关闭。

local 回放直接在 Evaluator 所在环境执行，不创建 AgentX 任务镜像或任务容器。管理容器不映射 NPU、不使用 privileged。硬件采样始终在裸机运行，只调用现成 `npu-smi info`，不安装裸机依赖、不改驱动参数或 device-share。toolbox 启动时仅准备空闲控制通道，不查询设备；实际 `run` 才按 YAML 卡号启动采样。直接在裸机运行时自动启动本机采样子进程，不要求管理容器。正常、失败、取消或客户端断开都会停止对应采样。

使用管理容器时，裸机采样需已有 Python 3.9+ 和驱动自带 npu-smi；直接裸机 local 回放则需 Python 3.11–3.13、venv 和 npu-smi。容器内没有裸机通道时，`doctor` 会报错，不会在容器内尝试采样。仍需独立任务容器时可选用 [Docker 示例](../../../playbook/agentx/agentx-npu-docker.yaml)，同样只在裸机采样。

## 3. 检查和运行

```bash
arsi-evaluator doctor "$EVALUATOR_CONFIG"
arsi-evaluator run "$EVALUATOR_CONFIG" --dry-run
arsi-evaluator run "$EVALUATOR_CONFIG"
```

按顺序执行，上一条失败时先处理错误。`doctor` 执行网络下载探针，不推理、不采样；`--dry-run` 按需读取或下载来源并列出测量点，不安装 Harness 或启动采样；`run` 自动准备 venv 和数据、启动已配置的采样、预热、测量并生成报告。首次安装和完整语料重建可能耗时较长。普通前台 CLI 运行期间保持终端连接；需要后台任务时使用调用方现有的任务管理方式。

`[1, 4, 8]` 是三档活动会话树数，依次执行，每档默认一小时；配置 `durationSeconds: 60` 后每档测量 60 秒，另加准备、预热及收尾。不是固定的同时 HTTP 请求数。配置检查通过后执行测评。

## 4. 查看和离线重建报告

在 YAML 的 `output.directory` 下打开 `<RUN_ID>/report.md`。例如，比较各档的 TTFT P95 时读取 `metrics/service/requests.json`，查询分类文件路径时读取 `metrics/index.json`。各档的原始文件在 `c1/`、`c4/`、`c8/`。报告记录 Harness 有效性、请求错误和采集覆盖。

```bash
arsi-evaluator report /path/to/results/RUN_ID
```

离线重建仅需已保存的运行目录。重新测量时再次执行原 YAML。更多指标口径见[AgentX 指南](../benchmarks/agentx.zh-CN.md)。
