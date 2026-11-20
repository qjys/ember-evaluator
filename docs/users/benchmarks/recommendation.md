# Generative recommendation service performance

[中文](recommendation.zh-CN.md) · [Five-length experiment](../../../playbook/recommendation/north-star.yaml) · [Custom workload](../../../playbook/recommendation/custom.yaml)

Start SGLang-GR with your model and tokenizer on the NPU host. Run Evaluator on the same host and set the service root URL, for example `http://127.0.0.1:30000`. Reserve the service for this experiment because measurement resets its GR counters after warmup.

```bash
export MODEL_API_KEY=EMPTY
export GR_PROMPT_DIR=/path/to/prompts
export GR_TOKENIZER_DIR=/path/to/Qwen3-0.6B-OneRecVocab
export GR_PREFIX1_FILE=/path/to/catalog/prefix1.json
export GR_PREFIX2_FILE=/path/to/catalog/prefix2.json
arsi-evaluator run playbook/recommendation/north-star.yaml --dry-run
arsi-evaluator run playbook/recommendation/north-star.yaml
arsi-evaluator report <run-directory>
```

Both processes must see the catalog files at the same absolute paths. The examples use local Transformers to validate SID offsets and count raw prompt tokens with an eight-token tolerance. Adjust `lengthToleranceTokens` for your corpus. Select the serving environment's Python with `benchmark.solver.config.pythonExecutable`. Omitting both tokenizer settings records nominal lengths only. SID and score checks still run.

The client installs the catalog via `/v1/gr/catalog`. Both warmup and measurement cycle from the first prompt and send one string per `/v1/gr/beam_search` request with `n=1`. The timer includes JSON encoding, HTTP, reading the entire body and JSON decoding. SID and finite-score checks follow the timer. A standard point takes the fourth ordered duration out of eight. Custom depths 1 and 2 validate A and AB prefixes, while depth 3 validates the full ABC item. Each attempt stores raw samples in `agent/session.jsonl`. Failed requests, insufficient samples or failed counter reset invalidate the point.

North Star reads the five `prompts_<L>_batch_4.json` arrays in order. L is the nominal input length in tokens. The source lock pins the exact bytes of each prompt and catalog file. The custom scenario accepts length/file pairs in `inputs` and configurable `beamWidth`, `decodeSteps`, `concurrency`, `warmup` and `requests`.

Run base and fast separately. For fast, start the server with `SGLANG_NPU_SHARED_PREFIX_DECODE=1` and `SGLANG_NPU_SHARED_PREFIX_MIN_LEN=32`, then use `tag: fast`. The report shows measured shared-prefix forwards, and converts server microsecond counters into milliseconds per group. Collect profiler traces in a separate run.

For a comparable eager baseline, set the string fields `session`, `machine`, `devices`, `modelRevision` and `tokenizerRevision` under `benchmark.config.comparison`. Each point exports a comparison key covering these declarations, input digests, workload and timing protocol. Supply measured eager rows as `{ length, comparisonKey, p50Ms }` under the `recommendation-performance` metric's `config.eagerBaseline`. The report assesses the same-session L=128 target only for a complete standard run with matching baseline and valid fast-path evidence when requested.

The baseline producer hashes compact UTF-8 JSON with recursively sorted keys and SHA-256. The object contains `identity` (the five declared fields), `length`, `digests` (SHA-256 hex for `prompts-<L>.json`, `prefix1.json`, `prefix2.json`), `requests`, `warmup`, `concurrency`, `beamWidth`, `decodeSteps` and `timing: "recommendation-http-e2e-v1"`. Use the eager run's actual files and settings. The older 910B2 budgets in the gr-a2 reference script were measured in a different software window.

## Reported measurements

The client table includes E2E mean, p50, p95 and p99 over successful formal responses with choices. Percentiles use nearest rank, so p50 is sample 4 of 8 and both p95 and p99 are sample 8. SID validity and finite scores are counted independently. A bad candidate invalidates the point while its response time remains in the diagnostic distribution. With no successful responses the distribution reads zero and the headline p50 stays empty.

Each request records the candidate count, first candidate IDs, score and finish reason, all-candidate token total, validation details and per-token latency. Non-streaming TTFT equals the full request E2E. Per-token latency divides each request's E2E by its output token count. Aggregate TPOT divides mean E2E by mean output tokens. QPS divides all formal attempts including failures by the unrounded wall time of the batch, including worker startup, validation and drain. Warmup, counters and writing evidence are outside the window.

The report shows per-group server times, five shares of span and the dominant segment, client gap (mean E2E minus mean span) and its percentage of mean E2E. Decode diagnostics include per-step and per-selection time, steps per request, overshoot, fast-path skip and exception counters, API branches and PIDs. A missing snapshot leaves the standard length uncovered. Counters absent from an available snapshot default to zero as in the reference.

For standard fast runs L=128 must have a nonzero shared-prefix forward ratio. The historical comparison shows each delta against the 910B2 eager budget, each ratio to the cross-machine 910B1 graph reading, the L=128 subgoal and whether all five lengths meet their eager budgets. Custom workloads have no historical gate. Offline reports for older runs leave unavailable measurements blank, including the formal wall window.
