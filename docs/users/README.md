# Evaluator User Documentation

> English | [中文](./README.zh-CN.md)

Install and complete one scenario before exploring common operations. `benchmarks/` describes versions, scoring, and limitations; `deployment/` covers deployment requirements; `faq/` covers troubleshooting.

[Project home](../../README.md) · [Benchmark guides](benchmarks/README.md) · [FAQ](faq/README.md) · [Development documentation](../development/README.en.md)

## Installation and Quick Starts

| Stage / scenario | Guide |
| --- | --- |
| Install and build both repositories, register the global CLI, and run from any directory | [Installation](installation.md) |
| First quality evaluation | [Two GSM8K questions](quick-start.md) |
| Docker terminal tasks | [Terminal-Bench 4.0](quick-start/terminalbench.md) |
| Model service performance | [AgentX performance](quick-start/agentx.md) |
| Load-test existing model services over SSH | [Standalone AISBench plugin](../../plugins/aisbench/README.md) |
| Read downloaded dataset files | [Local datasets](local-datasets.md) |
| Call evaluations from a Node.js project | [Node.js SDK](sdk.md) |
| Run evaluations with an agent | [Ember Evaluator skill (中文)](../../skills/ember-evaluator/SKILL.md) |

[Image and PDF evaluation](multimodal.md): input modes, Harness matrix, and runnable examples.

## Common Operations

| Goal | Guide |
| --- | --- |
| YAML, profiles, defaults, and environment variables | [Configuration](config.md) |
| Models, judges, SimpleAgent, AgentBundle, and Dify | [Solvers and model services](solvers.md) |
| Task selection, resume, reports, trajectories, and full DSH tool output | [Daily operations](usage.md) |
| Task concurrency, preparation, pipelines, and timeouts | [Concurrency](concurrency.md) |
| Recover network failures in the original run | [Retrying network failures](network-retry.md) |

## Browse by Topic

| Topic | Entry points and scope |
| --- | --- |
| Benchmark | [Scenario index](benchmarks/README.md): [Harbor](benchmarks/harbor.md), [WorkBuddy](benchmarks/workbuddy.md), [DeepSWE](benchmarks/deepswe.md), [Terminal-Bench](benchmarks/terminalbench.md), [AgentX](benchmarks/agentx.md) |
| Deployment | [Management container](deployment/container-toolbox.md), [Docker platforms](deployment/docker-platform.md); see [configuration](config.md#ray-and-execution-nodes) for Ray |
| FAQ | [Common questions](faq/README.md), [downloads and mirrors](faq/downloads.md), [Docker and cross-architecture execution](faq/docker.md) |
| Reference | [Scoring](reference/scoring.md), [error and exit codes](reference/errors.md) |
| Architecture | PNG architecture diagrams in module guides and source entry points in `src/` |
| Development | [Development documentation](../development/README.en.md): plugins, benchmarks, structured errors, and controlled tests |

![Evaluator architecture from configuration to task execution, result storage, and reporting](../../imgs/01-framework-project-overview-v2.png.png)

## Supported Benchmarks

These names are used by `benchmark info`, `init --benchmark`, and YAML. External plugins may add names; use `benchmark list` as the authoritative list.

| Category | Configuration name | Content and requirements |
| --- | --- | --- |
| Math | `gsm8k`, `math500`, `mgsm` | Math questions; MGSM covers multiple languages. Start with GSM8K |
| Subject knowledge | `mmlu`, `mmlu_pro` | MMLU uses 5-shot candidate probability scoring and requires logprobs/top_logprobs; MMLU-Pro generates answers and uses configuration name `mmlu_pro` |
| Difficult knowledge | `gpqa` | The [full configuration](../../playbook/gpqa/gpqa-simpleagent.yaml) explicitly uses `hfToken: ${HF_TOKEN}`; obtain dataset access first |
| Reading and factual QA | `drop`, `triviaqa` | Answer extraction, normalization, and matching; see [scoring](reference/scoring.md) for current DROP rules |
| Document retrieval and fiscal QA | `officeqa-pro-v2` | [OfficeQA Pro V2](benchmarks/officeqa-pro-v2.md): searchable parsed JSON by default, with original PDFs supported; no image-only protocol; authorized HF token required |
| Code generation | `humaneval` | Python tests in Docker; verification requires Docker even with a local solver |
| Model-judged QA | `simpleqa` | Explicit judge service required; three answer classes |
| Medical conversation quality | `healthbench` | Judge service and item-level rubric scoring; continuous scores may have no pass rate |
| Software engineering | `deepswe`, `swebench` | Defaults: 1.1 and Verified 1.0 respectively; Docker and task images required |
| Terminal tasks | `terminalbench` | Version 2.0 by default; Docker and task verifiers |
| Office, `code`, `web`, and `security` | `workbuddy` | `scenario`: `office`, `code`, `web`, or `security`; defaults to `code`; Docker required |
| Custom Harbor task packages | `harbor` | Local directories, pinned archives, GitHub, or Harbor registry sources; executes the task protocol |
| Service performance | `agentx` | Trace-driven streaming model API; `standard` and `replay`; no accuracy or quality score |
| Remote service performance | `aisbench` (external plugin) | [SSH deployment and load testing](../../plugins/aisbench/README.md); loaded through a patch, with shared-prefix workloads and warmup |
| Operators | `kernel` | [Correctness and NPU performance of existing kernels](benchmarks/kernel-npu.md); local serial execution without model calls |

```bash
ember-evaluator benchmark list
ember-evaluator benchmark info workbuddy
ember-evaluator init --benchmark workbuddy --output workbuddy.yaml
```

WorkBuddy Web requires a judge; Office model scoring is optional. Store Security data and results on a native Linux filesystem. Do not extract under Windows or WSL `/mnt/c` or `/mnt/d`. See [WorkBuddy](benchmarks/workbuddy.md).

Run a small sample before increasing tasks, concurrency, or nodes. See the [FAQ](faq/README.md) for installation, scoring, resume, and resource issues.

- [Network downloads, proxies and image acquisition](network.md)
