# Generative recommendation service performance

[中文](recommendation.zh-CN.md) · [Five-length experiment](../../../playbook/recommendation/north-star.yaml) · [Custom workload](../../../playbook/recommendation/custom.yaml)

## Choose a data source

The default `benchmark.config.dataMode: files` reads the existing north-star prompt directory or the custom length/file pairs. Set `dataMode: generated` to create prompts from complete legal A/B/C SIDs in your local catalogs. Configure the local tokenizer under `benchmark.solver.config.tokenizerPath`. Both modes validate the input before any HTTP request; supplying a tokenizer also checks whole-prompt token lengths.

```bash
arsi-evaluator run playbook/recommendation/generated.yaml --dry-run
arsi-evaluator run playbook/recommendation/generated.yaml
```

The [generated workload](../../../playbook/recommendation/generated.yaml) sets `generator.seed` (default 42), `lengths` and `samplesPerLength` (default 4). The request count controls how often the saved pool is traversed. North-star retains its five ordered lengths, four prompts each, two warmups and eight measured requests. Keep a token tolerance appropriate for complete SIDs. Omit both `inputs` and `promptDir` for generation.

Generation does not require a prompt directory. Each draw chooses a nonempty (A,B) group uniformly and then draws a C from that group. Small catalogs can generate repeated histories; the manifest records both total and distinct prompt counts.

Find the replayable files in `datasets/<manifest-sha256>/` under the experiment output root, beside the run directory. The linked `dataset.json` records the seed, generator version, serialized tokenizer and catalog digests, actual token lengths and file hashes. Performance and profiling consume the same files. For exact replay, pass them as custom file inputs, or pass the directory as the north-star prompt directory for a five-length batch-of-four dataset. Archive this directory alongside the run.

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

## Performance and operator profiling in one run

Use [north-star-collections.yaml](../../../playbook/recommendation/north-star-collections.yaml) to route the same locked inputs to two externally started instances of the same GR build and model. Set the same base or fast options on both. The performance service listens on port 30000. Launch the profiling service with the same model and engine flags on port 30001 and set `SGLANG_NPU_PROFILE_AUTO_EXPORT=1` **before** starting its Python process. The gr-a2 client requests CPU and NPU activities with `POST /start_profile`; its diagnostics identify this environment variable for automatic export. Check the private server implementation to establish additional build-specific prerequisites. Both services must read the two catalog files. The profiler process must be able to write the evaluator's absolute attempt output path and the evaluator must be able to read it; mount the results directory at the same path when using separate containers.

Run `arsi-evaluator run playbook/recommendation/north-star-collections.yaml --dry-run`, then run the same command without `--dry-run`. The evaluator runs the selected performance lengths before issuing any profiler calls. For each profiling length it warms up the first prompt (one to five attempts, 1000 ms threshold), starts capture with shapes enabled, resets counters, sends one constrained beam request and stops capture. Export waits up to 1800 seconds per point, configurable with `benchmark.solver.config.exportTimeoutSeconds`. In a combined run, incomplete performance points or an unverified fast path (L=128 for north-star) skip profiling. Missing device activity makes a profiling point invalid; host evidence is preserved.

Remove one entry from both `collections` and `services` to run a single collection. Set profiling `lengths: [128, 10240]` to capture only those traces. The parent `metrics.json` carries separate `recommendation-performance` and `recommendation-profiling` metrics. Child reports at `performance/report.md` and `profiling/report.md` share the parent run ID and source revision. Profiler intervals, including profiled request latency, stay separate from performance distributions. Each profiling attempt stores its raw export in `agent/trace/`; `arsi-evaluator report <run-directory>` rebuilds reports from persisted observations offline.
