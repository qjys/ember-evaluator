# AISBench SSH Plugin

> English | [中文](./aisbench.zh-CN.md)

AISBench ships with Evaluator. The CLI and SDK register it by default.

See the [AISBench plugin guide](../../../plugins/aisbench/README.md) for installation, configuration, execution, offline reports, and limitations.

## Synthetic fixed-length workloads

Set `benchmark.config.workload.dataset: synthetic` to use AISBench's native SyntheticDataset with `inputLength`, `outputLength`, `dataCount`, `concurrency`, `requestRate`, and `warmups` (default 0). For example, 4096/2048 tokens, 1320 requests, concurrency 330 and 8 warmups reproduce that load shape. Streaming and no generated shared prefixes are required; this does not disable server prefix caching or assert a cache hit rate.

The SSH solver validates successful requests, zero failures, exact input/output token totals, and millisecond latencies. A synthetic performance result is not an accuracy measurement. Existing GSM8K/prefix workloads are unchanged when `dataset` is omitted. Remote failures attempt cancellation even without local abort; unconfirmed cancellation leaves `cleanup-unconfirmed.json`, which callers must reconcile before restarting.

Synthetic results use the `aisbench:synthetic` source identity. The built-in metrics and reporter accept that identity and retain the measured rows; a dataset implementation hash is not required. RSI consumers must support the synthetic workload fields and source identity as well.

The existing `aisbench-performance` metrics result includes each point’s `workload` and normalized scalar `metrics`: metric ID maps to `{ value, unit, source }`, with `null` for unavailable values and a JSON evidence pointer relative to the point. Native `measurement` evidence remains available for reporting. Only completed points with complete artifact collection emit metrics. AISBench parsing, request/token completeness and source validation belong to this plugin; consumers should not reparse CSV rows.

## Configure native performance runs in YAML

### Download the MMMU images on the benchmark host

Two test shards from the official MMMU dataset cover both image presets and total about 193 MB. The Sociology shard contains a native 1920×1080 image, and the Literature shard contains a native 1280×720 image. Run the following command with the Hugging Face CLI on the Linux host that runs AISBench. [Official MMMU dataset](https://huggingface.co/datasets/MMMU/MMMU) · [Hugging Face CLI installation](https://huggingface.co/docs/huggingface_hub/guides/cli)

```bash
hf download MMMU/MMMU \
  Sociology/test-00000-of-00001.parquet \
  Literature/test-00000-of-00001.parquet \
  --repo-type dataset \
  --local-dir /data/MMMU
```

Set `multimodalGeneration.mmmuParquetDir` to `/data/MMMU` in the YAML. AISBench searches its subdirectories for Parquet files. If you download the shards elsewhere, use that directory's absolute path on the benchmark host.

### Generate multimodal requests

Install the matching upstream generator in the load generator's AISBench Python environment with `python -m pip install -e ./plugins/prefix_cache` from the AISBench source tree. AISBench 3.1.0 and plugin 0.5.0 have been verified together. If the host wheel omits `ais_bench.benchmark.datasets.utils`, run `python -m pip install -e .` from the same source tree. Prepare the MMMU Parquet files and the model tokenizer there. The [generated multimodal playbook](../../../plugins/aisbench/playbook/03-generated-multimodal.yaml) uses `multimodalGeneration` in place of `datasets`. Set `imageScenario` to `single_1080p` for one native 1920×1080 image or `multi_720p_5` for five copies of a native 1280×720 image. Set `mmmuParquetDir` to the remote directory containing the matching image.

`imageScenario: [single_1080p, multi_720p_5]` selects both presets. Omit it for a single 1080p image. `textTokens` counts the text using the SSH solver's `tokenizerPath`. The generator uses the bundled GSM8K corpus or a remote `corpusPath` with enough distinct questions. With both presets, `concurrency: [1, 8]` and `dataCount: 16` produce four groups of 16 requests each. Use `dataCount: [4, 16]` for the first four and all sixteen requests respectively. The report includes per-group throughput and latency. Generated workloads default to streaming and a 256-token output limit. The summary in `artifacts/aisbench/native-plan.json` records counts, dimensions and digests per preset. [Upstream generator](https://github.com/AISBench/benchmark/blob/7ace6948a3a2726578aed869db0d5885ace11d55/plugins/prefix_cache/MULTIMODAL.md)

To set the fixed output length recorded in the dataset independently of the backend limit, use `multimodalGeneration.outputTokens` and the outer `maxOutputTokens`. If only one is set, both use that value.

To prepare data without sending requests, set `benchmark.config.multimodalAction: prepare` and `multimodalGeneration.outputDirectory` to a remote directory. Each invocation creates a separate subdirectory. The report gives the absolute manifest path. A regular generation and performance run can also retain its dataset using `outputDirectory`.

To reuse the exact inputs, replace the entire `multimodalGeneration` block with `multimodalManifest: /absolute/remote/path/to/file.manifest.json`. Use `multimodalAction: validate` for a data-only integrity check or `multimodalAction: run` to validate and send requests. Keep the original Parquet and JSONL paths accessible on the benchmark host. When omitted, request count and output length come from the manifest. Run `arsi-evaluator report <run-directory>` to rebuild the performance report offline.

### Use an existing dataset

Select an installed upstream dataset using `datasets`, for example `[videomme_gen]` for video or `[vocalsound_gen_base64]` for audio. For your own media, `mm_custom_gen` accepts `mm_type: path` or `base64` and the video frame count `num_frames`. The selected service backend must accept that media type. [Upstream multimodal guide](https://github.com/AISBench/benchmark/blob/7ace6948a3a2726578aed869db0d5885ace11d55/docs/source_en/advanced_tutorials/multimodal_benchmark.md)

Start with the [TextVQA playbook](../../../plugins/aisbench/playbook/02-native-textvqa.yaml). Put the running model endpoint in `services` and the load generator's SSH connection and Python environment in `benchmark.solver.config.remote`. Install the requested AISBench version and prepare its dataset, tokenizer and multimodal dependencies on that Linux host. [TextVQA setup](https://github.com/AISBench/benchmark/blob/master/ais_bench/benchmark/configs/datasets/textvqa/README_en.md)

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

AISBench sends live requests containing the images and questions at concurrency 1 and 8, taking up to 100 samples per setting. Warmups are separate. For custom JSONL with service-readable file paths, select `{name: mm_custom_gen, config: {path: /data/receipts/requests.jsonl, mm_type: path}}`. For Base64, set both `mm_type: base64` and the prompt template for the service's media format. The stock custom template uses `file://`. For JPEG, set the image URL in the template to `data:image/jpeg;base64,{image}`. Audio has a native `vocalsound_gen_base64` template. The custom Base64 video loader samples PNG frames according to `num_frames`. [Complete JPEG YAML](./aisbench.zh-CN.md#使用现有图片视频和音频数据集) · [Custom multimodal dataset](https://github.com/AISBench/benchmark/tree/7ace6948a3a2726578aed869db0d5885ace11d55/ais_bench/benchmark/configs/datasets/mm_custom)

| YAML field | Native parameter | Meaning |
| --- | --- | --- |
| `backend`, `datasets` | `--models`, `--datasets` | Names from the remote installation. All selected service backends use the bound service. |
| `concurrency`, `dataCount` | `--batch-size`, `--num-prompts` | Use one concurrency or a list. A scalar count applies to every setting. A list pairs by position. |
| `requestRate`, `warmups` | `--request-rate`, `--num-warmups` | Request rate and warmup count, including zero. |
| `stream`, `maxOutputTokens` | `--stream` / `--no-stream`, `--max-out-len` | Streaming and output token cap. First-token latency requires streaming. |
| `pressureSeconds` | `--pressure --pressure-time` | Enable sustained load for this many seconds. |
| `speculativeDecoding` | `--spec-decode` | Collect speculative decoding counters exposed by the service. |
| `generationParams` | `--generation-kwargs` | Pass a JSON object such as `{temperature: 0.2}`. |
| `summarizer` | `--summarizer` | Defaults to `default_perf` for named tasks. |
| `options` | Additional performance options | For example, `{cooldown: 0}`. Booleans, lists and objects use the installed CLI's argument definitions. Managed routing or duplicate settings cause a configuration error. |

The `aisbench-ssh` solver maps `tokenizerPath` to `--path`. Omit it to keep the native tokenizer setting. Set `remote.workingDirectory` when upstream expects a particular current directory. Existing SSH configurations can also supply `remote.aisbenchWorkPath` as the fallback. Dataset overrides apply to the upstream configuration loaded in the job process. Mappings merge by key and arrays replace existing arrays. If a task expands to multiple datasets, use `datasets[].abbr` to identify the member to modify.

You can also select an existing full native configuration with `configFile: ./bench/run.py` and optional sibling `files: [./bench/helper.py]`, or with `remoteConfigFile: /bench/run.py`. Omit `backend` and `datasets` in that case. The file owns model routing and can read `EVALUATOR_AISBENCH_MODEL`, `EVALUATOR_AISBENCH_BASE_URL` and `EVALUATOR_AISBENCH_API_KEY`. Local Python files are hashed and transferred. Data and weights stay on the load generator.

Evaluator's dry run validates the local configuration and lists tasks. During execution, the selected remote version must support the requested options and datasets. The redacted command is saved under `artifacts/aisbench/native-plan.json` in the attempt. Native text artifacts live in the adjacent `outputs/` directory, and `collection.json` lists omitted private configs and unsupported file formats. Reports preserve per-group request counts, throughput and available latency percentiles with their upstream units. Missing groups, failed requests and unrecognized output are identified in the report.

## Collect serving performance and Ascend profiles in one run

Run the [TextVQA service profiling playbook](../../../plugins/aisbench/playbook/04-service-profiling.yaml) after configuring the endpoint, SSH host and shared trace directory. AISBench completes all ordinary loads first, then runs diagnostic loads at concurrency 1 and 8 using the same datasets. Generated multimodal data is prepared once.

```bash
arsi-evaluator run plugins/aisbench/playbook/04-service-profiling.yaml
```

The following options under `benchmark.config` are independent. Both are optional for native named backends with datasets, generated multimodal inputs or a manifest. Standalone Python configs select their own endpoints.

| Field | Behavior |
| --- | --- |
| `engineMetrics` | List Prometheus sample names exposed at the ordinary service’s `/metrics`. Warmup finishes before the first snapshot. The second snapshot follows the measured load. Results preserve label sets, gauge readings and deltas for declared counters. Missing series, counter resets or scrape errors give partial results. |
| `profiling.traceDirectory` | Writable absolute directory mounted at the same path on the SSH host and the SGLang Ascend server. The deployment must support `POST /start_profile`, `POST /stop_profile` and NPU auto-export. Enable `SGLANG_NPU_PROFILE_AUTO_EXPORT=1` where required. Reserve the instance because the profiler controls the whole service. |
| `profiling.service` | Defaults to the solver service. Select a second named service to use its endpoint and credentials for both diagnostic inference and control requests. Use the same model, weights and candidate build. |
| `profiling.requestsPerPoint` | Requests per dataset in each diagnostic window. Defaults to one concurrency wave, capped by that point’s configured request count. Timed pressure is disabled for this pass. A separate warmup honors `warmups` and defaults to one request; zero disables it. |
| `profiling.exportTimeoutSeconds` | Maximum wait for each export, default 1800 seconds. Allow enough time for all windows in the run timeout. |

A trace covers one native command, including its startup, requests and reporting. Datasets selected in that command share a window. Generated image presets have independent windows. Read ordinary throughput and latency in `groups` and server evidence in `collections` under `aisbench-native-performance` in `metrics.json`. The Markdown report shows engine readings and per-rank operator and kernel times in microseconds. Full raw exports remain in the shared directory. CSV/JSON evidence is also collected under the attempt’s `artifacts/aisbench/profiling/point-*/trace/`. Incomplete ordinary workloads skip profiling. Host-only traces, control failures and export failures remain visible alongside completed baseline measurements.
