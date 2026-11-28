# Experiment YAML Field Reference

> English | [中文](experiment-yaml.zh-CN.md)

This page describes the shared fields of an experiment YAML. For options under a component's `config`, use the [plugin option index](#plugin-option-index). For separate files, see the [network YAML reference](network.md) and [plugin patch format](../../development/plugins.en.md#reference-external-plugins-with---patch).

The defaults below are framework fallbacks unless a row names another source. The resolver applies the Benchmark Profile, including its version and scenario, and the Solver Profile before applying the experiment YAML and applicable CLI overrides. Arrays replace earlier arrays. A path such as `services.<name>.model` uses the service key in place of `<name>`. [Progressive configuration](../config.md)

## Top-level fields

| Field | Type | Requirement or default | Purpose and constraints |
| --- | --- | --- | --- |
| `hardware` | enum | Optional, framework `npu` | Select `npu` or `gpu` for the experiment. Hardware support depends on the selected components. |
| `services` | mapping | Required, at least one service | Model service definitions keyed by a service name. |
| `benchmark` | string or object | Required | Benchmark name or an object with version, scenario, and component selections. |
| `environment` | string or object | Optional, framework `docker` | Select the task execution environment. |
| `scheduler` | string or object | Optional, framework `local` | Select the task scheduler. The framework's local scheduler starts with concurrency `1`. |
| `store` | string or object | Optional, framework `local` | Select where attempt evidence and run results are saved. |
| `reporter` | string or object | Optional, framework `markdown` | Select how reports are rendered. |
| `metrics` | non-empty array | Optional, framework `[success-rate, duration, usage]` | Each entry is a metric name or a selection object. An explicit list replaces the Profile list. |
| `run` | object | Optional | Controls task selection, execution limits, and preparation. |
| `output` | object | Optional | Sets the experiment results directory. |
| `deployment` | object | Optional, derived for bare Ray selection | Select a Ray Jobs submission target. See the deployment table for when this block is derived. |

## Model services

| Field | Type | Requirement or default | Purpose and constraints |
| --- | --- | --- | --- |
| `services.<name>` | object | Required for each declared service | Use letters, digits, underscores, and hyphens for the name, beginning with a letter or underscore. |
| `services.<name>.model` | non-empty string | Required | Model identifier sent to the service. |
| `services.<name>.base_url` | non-empty string | Required | Base endpoint for model requests. Use a URL compatible with the selected protocol. |
| `services.<name>.api_key` | environment reference string | Required for a bound service at execution unless supplied by a supported CLI override | In YAML, use a complete reference such as `${MODEL_API_KEY}`. CLI key overrides target the Solver service. `inspect` accepts missing credentials. |
| `services.<name>.api` | enum | Optional, `openai-completions` | Accepts `openai-completions`, `openai-responses`, `anthropic-messages`, or `google-generative-ai`. Adapter support varies. |
| `services.<name>.provider` | enum | Optional, unset | Accepts `amazon-bedrock`, `anthropic`, `azure-openai`, `deepseek`, `google`, `groq`, `mistral`, `openai`, or `xai`. |
| `services.<name>.maxTokens` | positive integer | Optional, unset | Output token limit for adapters that consume it. Omission leaves the limit to the adapter or service. |
| `services.<name>.contextWindow` | positive integer | Optional, unset | Model context window in tokens for adapters that consume it. |
| `services.<name>.retry` | object | Optional, adapter behavior | Set model request retry policy for a compatible adapter. |
| `services.<name>.retry.maxAttempts` | positive integer | Required when `retry` is present | Maximum number of attempts for a model request, including the first. |
| `services.<name>.inputModalities` | non-empty array of enums | Optional, adapter behavior | List supported inputs from `text`, `image`, and `pdf`. Values must be unique. |

See [Solver and model service configuration](../solvers.md#model-services-and-independent-judges) and [image and PDF inputs](../multimodal.md) for adapter-specific behavior.

For Claude Code and other CLI adapters that use Evaluator's Messages relay, set `model`, `base_url`, `api: anthropic-messages`, and `api_key`. The relay holds the service key and sends it as `x-api-key`, or as `Authorization: Bearer` if the upstream responds with HTTP 401. It remembers the successful header for the relay's lifetime and keeps both requests in the Messages protocol. A gateway URL and gateway key can be configured in the same fields.

## Benchmark, Solver, and Verifier

| Field | Type | Requirement or default | Purpose and constraints |
| --- | --- | --- | --- |
| `benchmark.name` | non-empty string | Required in object form | Select a registered benchmark or Benchmark Profile. `benchmark: gsm8k` is shorthand for `benchmark: { name: gsm8k }`. |
| `benchmark.version` | non-empty string | Optional, Profile `defaultVersion` if present | Use a version declared by the selected Profile. Quote numeric-looking versions such as `"1.0"`. |
| `benchmark.scenario` | non-empty string | Optional, Profile `defaultScenario` if present | Use a scenario declared by the selected Profile. |
| `benchmark.evaluationScenario` | `task` or `inference-engine` | Optional, selected by the benchmark profile | Selects the result layout. GSM8K stores results per question. AgentX and AISBench load tests store results per concurrency. Native AISBench dataset preparation and validation use the task layout. |
| `benchmark.config` | object | Optional, Profile settings or empty object | Options for the selected Benchmark. |
| `benchmark.solver` | string or object | Optional, Profile or framework `simpleagent` | Select the Solver for this Benchmark. Object form supports `name`, `config`, and `service`. |
| `benchmark.solver.name` | non-empty string | Optional, selected Profile or `simpleagent` | Registered Solver name or a Solver Profile name. |
| `benchmark.solver.config` | object | Optional, merged settings or empty object | Options for the selected Solver. |
| `benchmark.solver.service` | non-empty string | Optional if a default service can be resolved | Name under `services`. If the selection has no service, use `services.default` or the sole service. Otherwise specify the name explicitly. |
| `benchmark.verifier` | string or object | Optional, Profile or unset | Select a Verifier for benchmarks that use a separate verifier. Object form supports `name`, `config`, and `service`. |
| `benchmark.verifier.name` | non-empty string | Required after merging if a Verifier is selected | Registered Verifier name. |
| `benchmark.verifier.config` | object | Optional, merged settings or empty object | Options for the selected Verifier. |
| `benchmark.verifier.service` | non-empty string | Optional, Profile or unset | Bind a model service when the verifier requires one. The explicit value `$default` uses the same default-service lookup as the Solver. |

Run `arsi-evaluator benchmark list` to see available Benchmarks, and `arsi-evaluator benchmark info <name>` to see the selected Benchmark's versions, scenarios, and resolved settings.

## Environment, Scheduler, Store, Reporter, and Metrics

Each component selection accepts a name such as `reporter: markdown` or an object such as `reporter: { name: markdown, config: {} }`. The same forms apply to individual `metrics` entries. Use either the flat spelling or its equivalent under `config` for `platform`, `concurrency`, and `nodes`. Specifying both spellings in the same selection is a configuration error.

| Field | Type | Requirement or default | Purpose and constraints |
| --- | --- | --- | --- |
| `environment.name`, `scheduler.name`, `store.name`, `reporter.name`, `metrics[].name` | non-empty string | Required after merging defaults | Choose the implementation by its registered name. A string selection sets the name directly. |
| `environment.config`, `scheduler.config`, `store.config`, `reporter.config`, `metrics[].config` | object | Optional, merged settings or empty object | Options validated by the selected implementation. Changing the implementation name clears its previous options. |
| `environment.platform` | enum | Optional for Docker, `auto` | Shorthand for `environment.config.platform`. Accepts `auto`, `linux/amd64`, or `linux/arm64`. Task platform declarations take precedence over this fallback. |
| `scheduler.concurrency` | positive integer | Optional, Local `1`, Ray uses available slots if unset | Shorthand for `scheduler.config.concurrency`. Limit concurrent task execution. |
| `scheduler.nodes` | positive integer | Optional for Ray | Shorthand for `scheduler.config.nodes`. Request this many existing execution nodes. Insufficient eligible nodes cause an error. |

## Task selection and execution

| Field | Type | Requirement or default | Purpose and constraints |
| --- | --- | --- | --- |
| `run.taskIds` | non-empty array of strings or null | Optional, framework `null` | Filter by task IDs. `null` keeps all IDs eligible. Unknown IDs cause a configuration error. |
| `run.sampling` | object | Optional, source order when omitted | Enable reproducible shuffling before offset and count limits are applied. |
| `run.sampling.strategy` | enum | Required with `sampling` | The supported strategy is `random`. |
| `run.sampling.seed` | integer | Required with `sampling` | Seed from `0` through `4294967295`, inclusive. |
| `run.offset` | non-negative integer | Optional, effective `0` | Skip this many tasks after filtering and sampling. |
| `run.maxTasks` | positive integer or null | Optional, framework `null` | Cap the number of tasks after the offset. `null` leaves that count uncapped. |
| `run.timeoutSeconds` | positive integer | Optional, framework `7200` | Whole-attempt time limit in seconds. Preparation completed before dispatch is accounted for separately. |
| `run.solveTimeoutSeconds` | positive integer | Optional, task limit or whole-attempt limit | Override the task's solving limit in seconds. Remaining whole-attempt time still applies. |
| `run.verifyTimeoutSeconds` | positive integer | Optional, task limit or whole-attempt limit | Override the task's verification limit in seconds. Remaining whole-attempt time still applies. |
| `run.scoreAfterSolveTimeout` | boolean | Optional, effective `true` | For quality evaluations, try to score collected outputs within the remaining whole-attempt time. Set `false` to skip verification and record a valid zero for a solve timeout. |
| `run.onError` | enum | Optional, framework `continue` | Choose `continue` or `abort` for task failures governed by this setting. |
| `run.includeTaskAnswer` | boolean | Optional, effective `false` | Persist the task prompt and any answer the Benchmark discloses in the result. |

Selection order is task ID filter, optional shuffle, offset, then count limit. The CLI option `--task-ids-file` replaces the configured task IDs and clears sampling, offset, and count settings. Some infrastructure failures stop dispatch regardless of `onError`. [Task selection examples](../usage.md#preview-and-save-actual-task-ids) · [Timeout rules](../config.md#whole-task-and-phase-timeouts) · [Error actions](errors.md)

## Environment preparation

| Field | Type | Requirement or default | Purpose and constraints |
| --- | --- | --- | --- |
| `run.preparation` | object | Optional | Override environment preparation behavior for the selected scheduler. |
| `run.preparation.mode` | enum | Optional, Local `pipeline`, other schedulers `batch` | Choose rolling preparation (`pipeline`) or prepare the batch before execution (`batch`). A Profile may choose a different supported mode. |
| `run.preparation.concurrency` | positive integer | Optional, follows execution concurrency | Cap concurrent environment preparation. Actual concurrency is bounded by available slots and task count. |
| `run.preparation.lookahead` | positive integer | Optional in pipeline, `max(10, preparation.concurrency)` | Limit tasks that are preparing or ready but have not started execution. Requires `pipeline` and a value at least as large as preparation concurrency. |
| `run.preparation.environmentTimeoutSeconds` | finite positive number | Optional, task or Benchmark default | Base limit in seconds for each solve or verification environment. The effective limit is scaled by preparation concurrency, up to a factor of 10. |
| `run.preparation.roundTimeoutSeconds` | finite positive number | Optional, no explicit round cap by default | Limit the preparation round in seconds. The limit is independent of preparation concurrency. |

Preparation timeouts must fit within 2,147,483,647 milliseconds after applying any concurrency multiplier. For an explicit round limit, batch mode uses elapsed time and the local pipeline counts time while preparation is active. [Preparation timeouts](../config.md#environment-preparation-timeouts) · [Concurrency and preparation](../concurrency.md)

## Output and Ray Jobs deployment

| Field | Type | Requirement or default | Purpose and constraints |
| --- | --- | --- | --- |
| `output.directory` | non-empty string | Optional, generated from the Benchmark and YAML filename | Defaults to `results/<benchmark>/<yaml-stem>/` under the Evaluator package or repository root. Run directories are created beneath it. Explicit relative paths resolve from the experiment YAML directory. |
| `deployment.kind` | enum | Required when `deployment` is explicit | Use `ray-jobs` with the Ray scheduler. |
| `deployment.endpoint` | HTTPS origin | Optional, `https://localhost:9443` | Ray Jobs gateway origin. Use an HTTPS host and optional port, with no embedded credentials, path beyond `/`, query, or fragment. |
| `deployment.caFile` | non-empty path string | Required for an endpoint other than the default local endpoint | CA certificate used for the gateway. The default local endpoint uses the local Ray certificate path. |
| `deployment.tokenEnv` | environment variable name | Optional, `EVALUATOR_JOBS_TOKEN` | Name of the variable containing the gateway token. Use letters, digits, and underscores, starting with a letter or underscore. |
| `deployment.managedLocal` | boolean | Explicit block defaults to `false`, derived local deployment uses `true` | Use `true` to prepare the bundled local cluster. Requires `https://localhost:9443`. |

If `scheduler.name` is `ray` and both `deployment` and `scheduler.config.endpoint` are absent, Evaluator derives a managed local Ray Jobs deployment. With an explicit Ray Client endpoint, omit `deployment` to coordinate the run in the current process. For a Ray Jobs deployment, use `scheduler.config` only for `concurrency` and `nodes`. [Ray examples](../config.md#ray-and-execution-nodes)

## Plugin option index

Component validators own the fields under `config`. Use the guide for the selected implementation, or the registration and validator source where the guide covers only common settings. A Profile can also provide aliases for `metrics[].name`.

| YAML path | Where to look |
| --- | --- |
| `benchmark.config` | [Benchmark guides](../benchmarks/README.md) · [Harbor defaults](../benchmarks/harbor.md) · [AgentX configuration](../benchmarks/agentx.md#concurrency-and-configuration) · [Kernel profiling](../benchmarks/kernel-npu.md#detailed-profiling) · [OfficeQA Pro V2](../benchmarks/officeqa-pro-v2.md) |
| `benchmark.solver.config` | [Solver guide](../solvers.md) · [AgentX telemetry](../benchmarks/agentx.md#vllm-and-ascend-npu-metrics) · [Solver registration](../../../src/plugins/solvers/index.ts) |
| `benchmark.verifier.config` | [Verifier and judge configuration](../config.md#verifiers-and-judge-models) · [Harbor verification](../benchmarks/harbor.md) · [Verifier registration](../../../src/plugins/verifiers/index.ts) |
| `environment.config` | [Docker platform selection](../deployment/docker-platform.md) · [Local and Docker validators](../../../src/plugins/environments/index.ts) |
| `scheduler.config` | [Concurrency guide](../concurrency.md) · [Ray connection examples](../config.md#ray-and-execution-nodes) · [Ray Client validator](../../../src/config/ray.ts) |
| `store.config` | [Local Store validator](../../../src/plugins/stores/index.ts), including `runIndexDirectory` |
| `metrics[].config` | [Scoring and metric denominators](scoring.md) · [Metrics registration](../../../src/plugins/metrics/index.ts) |
| `reporter.config` | [Reading reports](../usage.md#read-results) · [Markdown Reporter validator](../../../src/plugins/reporters/index.ts) |

For an external plugin, use its documentation and validator. Pass the same `--patch` to `inspect` and `run` so they select the same registered components. [External plugin loading](../../development/add-external-plugin.en.md)

## Start from a runnable configuration

Run these commands from the repository root. Set the model environment variables referenced in the generated YAML before running `inspect`. The command displays the configuration after framework and Profile defaults are applied and checks the selected component options. For defaults applied inside a plugin at runtime, see that plugin's reference.

```bash
arsi-evaluator init --benchmark gsm8k --output experiment.yaml
arsi-evaluator inspect experiment.yaml
```

[Model setup and two-question quick start](../quick-start.md) · [Runnable Playbooks](../../../playbook/README.md) · [CLI command reference](cli.md)
