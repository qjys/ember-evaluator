# AgentX Performance Quick Start

> English | [中文](./agentx.zh-CN.md)

AgentX uses `doctor → run --dry-run → run` like other benchmarks. Start inference services manually beforehand; Evaluator calls YAML HTTP endpoints only. Prefer local replay without task containers. Host hardware sampling starts during `run` and stops afterward.

[Project home](../../../README.md) · [User documentation](../README.md) · [Full AgentX guide](../benchmarks/agentx.md)

## 1. Choose an Environment and Build

For the optional management container, run this command from the Evaluator repository on a Linux Docker host. To run directly on the host, start with the build commands below.

```bash
bash scripts/toolbox/run.sh
```

The container is optional. Otherwise prepare Node/pnpm through [source installation](../installation.md#install-from-source), plus Python 3.11–3.13/venv. No toolbox/Docker daemon is required. Commands run directly on the host; the harness installs only in an isolated cached venv, without global Python changes/system package installation.

With toolbox, run commands inside it. PNPM_HOME/global PATH/directories are automatic, without pnpm setup/manual exports. Direct hosts configure global bins through installation instructions.

```bash
pnpm install --frozen-lockfile
pnpm build
pnpm add --global .
arsi-evaluator --help
```

Toolbox shares the Evaluator repository and supplies Node/pnpm/Python/compilers. AgentBundle installs automatically with project dependencies in the dedicated dependency volume. First AgentX run creates a cached venv and installs the harness, reused across concurrency points. No manual venv/task container/SSH worker is needed. Host installation of these container dependencies is unnecessary.

## 2. Configure YAML and Model Variables

Select YAML by service type. Standard defaults to one hour per point. `benchmark.config.durationSeconds: 60` sets 60-second measurements plus preparation/warmup/teardown. Custom durations are not formally comparable one-hour scores; see [measurement windows](../benchmarks/agentx.md#concurrency-and-configuration).

| Setting | Self-hosted inference | Online model API |
| --- | --- | --- |
| `MODEL_NAME` | ID from `/v1/models`, or configured alias | Provider's documented/listed model ID |
| `MODEL_ENDPOINT` | OpenAI-compatible base, e.g. `http://127.0.0.1:8000/v1` | Provider base, e.g. `https://api.example.com/v1`; not web chat |
| `MODEL_API_KEY` | Configured key; nonempty `EMPTY` if unauthenticated | Valid provider-issued key |
| YAML | [agentx-npu-local.yaml](../../../playbook/agentx/agentx-npu-local.yaml) for host NPU/vLLM, [agentx-standard.yaml](../../../playbook/agentx/agentx-standard.yaml) for requests only | [agentx-model-api.yaml](../../../playbook/agentx/agentx-model-api.yaml), without `telemetry` |
| Available metrics | Requests/replay; engine metrics if endpoints accessible; selected host NPUs | Client latency/throughput/tokens/replay only; **no server engine or GPU/NPU metrics** |

### Self-Hosted Inference

Start inference first. For an unauthenticated service on local port8000 whose `/v1/models` returns `my-qwen`:

```bash
export MODEL_NAME='my-qwen'
export MODEL_ENDPOINT='http://127.0.0.1:8000/v1'
export MODEL_API_KEY='EMPTY'
export EVALUATOR_CONFIG="$EVALUATOR_DIR/playbook/agentx/agentx-npu-local.yaml"
```

`127.0.0.1` applies only on the same host; replace for remote services. Automatic NPU sampling reads only Evaluator's host, not remote hardware through local card IDs. `vllm.endpoint` is a metrics URL such as `http://127.0.0.1:8000/metrics`, without /v1. Remove `telemetry.vllm` if unavailable.

Set `devices` to actual physical NPU IDs and `tokenizer` to a matching HF repository/directory. `my-qwen` is only an alias, not a `tokenizer` repository. Paths must be readable in Evaluator's environment, including toolbox mounts. No extra `tokenizer` variable is needed.

### Online Model APIs

Fill the three variables from provider documentation and choose the online example. Replace these placeholder model/URL values:

```bash
export MODEL_NAME='provider-model-id'
export MODEL_ENDPOINT='https://api.example.com/v1'
read -rsp 'Provider API key: ' MODEL_API_KEY
printf '\n'
export MODEL_API_KEY
export EVALUATOR_CONFIG="$EVALUATOR_DIR/playbook/agentx/agentx-model-api.yaml"
```

Online YAML omits `telemetry` entirely, starting no NPU sampling or local `/metrics` requests. Ordinary APIs expose no server engine/hardware monitoring, which cannot be inferred from Chat Completions. Reports contain only collected request/replay metrics. Do not attach unrelated local hardware/services.

Online model IDs also may not identify `tokenizer` repositories. Supply a matching accessible `tokenizer` repository/path. Without it, or without `ignore_eos`, streaming, full context/output lengths, the API cannot be assumed standard-compatible.

### Interactive Input

Both modes can prompt for model variables, then set `EVALUATOR_CONFIG` as selected above:

```bash
read -rp 'Model ID: ' MODEL_NAME
read -rp 'Model base URL (e.g. http://service-host:8000/v1): ' MODEL_ENDPOINT
read -rsp 'Model API key: ' MODEL_API_KEY
printf '\n'
export MODEL_NAME MODEL_ENDPOINT MODEL_API_KEY
```

Unauthenticated services still need a nonempty key placeholder such as EMPTY. Models need streaming Chat Completions, `ignore_eos`, and trace output lengths. 256k data requires at least 256k context plus headroom. See [preparation](../benchmarks/agentx.md#preparation-and-execution).

Self-hosted collection example (omit `telemetry` for online APIs):

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

To retain raw and network-adjusted latency, add `networkLatency: { mode: automatic }` under benchmark.solver.config. It probes each second by default; reports include RTT, probe status, and both latency sets. Omission disables it. See [network calibration](../benchmarks/agentx.md#network-latency-calibration).

Local replay runs in Evaluator's environment without AgentX images/containers. Toolbox maps no NPU and uses no privileged mode. Sampling always runs on the host using existing `npu-smi info`, without installs, driver changes, or device-share. Toolbox startup prepares an idle control channel without device queries; `run` starts sampling selected cards. Direct-host runs start a local sampler automatically without toolbox. Completion, failure, cancellation, or disconnect stops it.

Toolbox sampling requires host Python 3.9+/driver npu-smi; direct-host replay needs Python 3.11–3.13/venv/npu-smi. Inside containers without a host channel, `doctor` fails rather than sampling container devices. For separate task containers, use [Docker](../../../playbook/agentx/agentx-npu-docker.yaml), still sampling only on the host.

## 3. Check and Run

```bash
arsi-evaluator doctor "$EVALUATOR_CONFIG"
arsi-evaluator run "$EVALUATOR_CONFIG" --dry-run
arsi-evaluator run "$EVALUATOR_CONFIG"
```

Run in order and fix failures before proceeding. `doctor` performs network download probes without inference or device sampling. dry-run resolves/downloads sources and lists points without harness installation/sampling. `run` prepares venv/data, configured samplers, warmup, measurements, and reports. Initial installs/full corpus rebuilds may take time. Keep foreground terminals connected; use your existing job manager for background execution.

`[1, 4, 8]` are sequential active-session-tree levels, each one hour by default or 60 seconds with `durationSeconds: 60`, plus other stages. They are not fixed concurrent HTTP request counts. Run after configuration checks pass.

## 4. Read and rebuild the report

Open `<RUN_ID>/report.md` under the YAML's `output.directory`. To compare TTFT P95 across points, open `metrics/service/requests.json`. Read `metrics/index.json` for category paths and coverage. Find raw evidence in `c1/`, `c4/` and `c8/`. Check Harness validity, request errors and collection coverage in the report.

```bash
arsi-evaluator report /path/to/results/RUN_ID
```

Offline rebuilding uses the saved run directory. Execute the YAML again for a fresh measurement. See the [AgentX guide](../benchmarks/agentx.md) for metric definitions.
