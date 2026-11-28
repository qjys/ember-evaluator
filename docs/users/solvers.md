# Choosing Solvers and Model Services

> English | [中文](./solvers.zh-CN.md)

Benchmarks define tasks and scoring; solvers define model requests and agent execution. Start ordinary agent tasks with default SimpleAgent. MMLU and AgentX have dedicated defaults. Check configuration and start a new run after changes.

## Configure tools and web access

Set the following fields under `benchmark.solver.config`. Omitted fields and `default` preserve the harness defaults. Explicit restrictions take precedence over automatic permission approval.

| Field | Values | Effect |
| --- | --- | --- |
| `tools` | `default`, `none` | `none` disables built-in tools, including WebSearch, WebFetch and Evaluator’s automatic search fallback. MCP servers declared by the task, project or bundle remain available. Add `mcp: disabled` to disable MCP as well. Use `shellTool: disabled` to disable just the Codex shell. |
| `webSearch`, `webFetch` | `default`, `enabled`, `disabled` | Control search and page fetching separately. With `tools: none`, both are disabled. |
| `subagent`, `mcp`, `skills` | `default`, `disabled` | Disable delegation, MCP connections or skill discovery. Codex and TRAE query their native skill list and disable each path. |

### Switches by Solver

All rows accept the six fields and values listed above. “Yes” means the harness can control that capability. The web columns also identify the tool source. “No built-in” refers to the default toolset. A project or Bundle extension can supply its own implementation.

| Solver | `tools` | `webSearch` | `webFetch` | `subagent` | `mcp` | `skills` |
| --- | --- | --- | --- | --- | --- | --- |
| Codex | Yes | Native or fallback MCP | Independent fetch via MCP | Yes | Yes | Yes |
| TRAE | Yes | Native or fallback MCP | Yes | Yes | Yes | Yes |
| Claude Code | Yes | Native / supplementary | Yes | Yes | Yes | Yes |
| CodeBuddy | Yes | Native or fallback MCP | Yes | Yes | Yes | Yes |
| Qwen Code | Yes | Native or fallback MCP | Yes | Yes | Yes | Yes |
| Kimi Code | Yes | Native or fallback MCP | Yes | Yes | Yes | Yes |
| MiniMax Code | Yes | Native or fallback MCP | Yes | Yes | Yes | Yes |
| ZCode | Yes | Fallback MCP | Yes | Yes | Yes | Yes |
| OpenCode | Yes | Native Exa | Yes | Yes | Yes | Yes |
| SimpleAgent (no Bundle) | Yes | Pi / supplementary | Direct HTTP when explicitly enabled | No built-in | Yes | Yes |
| DSH (Bundle) | Yes | Native / supplementary | Yes | Yes | Yes | Yes |
| Pi (Bundle) | Yes | Pi / supplementary | Direct HTTP when explicitly enabled | Bundle-provided | Yes | Yes |
| JiuwenSwarm (Bundle) | Yes | Native or fallback MCP | Bundle default | Yes | Yes | Yes |
| DeepAgents (Bundle) | Yes | Evaluator supplementary | Bundle or supplementary fetch when enabled | Yes | Yes | Yes |

`tools: none` is compatible with `mcp: disabled` and either web field set to `disabled`. It conflicts with `webSearch: enabled` and `webFetch: enabled` because disabling built-ins disables both web tools. Omit `tools` to enable a web tool. Omit both web fields to keep only explicitly declared MCP tools.

Task networks `none` and `model-api` disable both WebSearch and WebFetch by default. Explicitly enabling either tool reports a configuration error. A domain allowlist permits fetching allowed URLs. Public search is disabled on allowlisted networks because the available search backends cannot enforce the same domain list.

Local file and shell operations run with the operating system user's permissions, including writable paths outside the task directory. Docker retains its configured user, mounts and network policy. CodeBuddy configures bypass for both the parent and child.

Evaluator prefers the harness's native web tools. Supplemental tools can help when native tools have no usable backend or require credentials the user has not provided. Hooks and model relays append supplemental evidence when a native failure can be paired with its call. With hosted tools or opaque results, the harness or model can select the supplemental tool.

With unrestricted web access, Exa-backed search and fetch call the public MCP tools `web_search_exa` and `web_fetch_exa` without model API keys. Search results require structured sources. Trajectories or web-tool logs record the backends and failed attempts. Pi and SimpleAgent use direct HTTP for their supplementary fetch. Supplementary fetch on a domain allowlist also uses direct HTTP and checks every redirect. See [web tool network policy](network.md#web-tool-network-policy).

For Hermes or DeepAgents installation, use `--network network.yaml` to configure package sources and proxies. WSL local needs a host-accessible proxy. Docker needs container-accessible addresses for the `build` and `runtime` stages. Include the local model gateway hostname in `noProxy`. See the [network guide](network.md).

The environment controls whether shell commands can access the network. For MMLU-Pro, `benchmark.config.solveNetwork: model-api` with Docker allows the solve container to reach only the model API. See the [MMLU-Pro Playbook](../../playbook/mmlu-pro/mmlu-pro-simpleagent.yaml).


## Generation limits and attachments

Set positive integers under `benchmark.solver.config`. `maxTokens` caps the output tokens in one model response. `maxTurns` caps iterations of the main agent during one solve, as counted by the harness. `contextWindow` configures the context capacity used for automatic compaction. Harnesses can compact earlier to reserve space for a response or a summary.

Solver values for `maxTokens` and `contextWindow` take precedence over the same service fields. Omitting both levels preserves harness and model defaults. An unsupported setting reports the harness and field name. AgentBundle checks limits after reading the Bundle to identify its harness.

```yaml
benchmark:
  solver:
    name: claudecode
    config:
      maxTokens: 8192
      maxTurns: 12
      contextWindow: 200000
```

The table reports Docker behavior for the pinned versions. A pass requires an observed output cap or attachment bytes at the model endpoint, a stop at the requested main-agent turn count, or an actual compaction with the smaller window. Unsupported means the current harness or Bundle entry rejects the setting. Every cell was exercised.

| Solver / harness | `maxTokens` | `maxTurns` | `contextWindow` compaction | Image | PDF pages | Original PDF |
| --- | --- | --- | --- | --- | --- | --- |
| Codex | Unsupported | Unsupported | Pass | Pass | Pass | Unsupported |
| TRAE CLI | Unsupported | Unsupported | Pass | Pass | Pass | Unsupported |
| Claude Code | Pass | Pass | Pass | Pass | Pass | Pass |
| CodeBuddy | Pass | Pass | Pass | Pass | Pass | Pass |
| Qwen Code | Pass | Pass | Pass | Pass | Pass | Pass on Chat Completions and Messages. Unsupported on Responses |
| Kimi Code | Pass | Pass | Pass | Pass | Pass | Unsupported |
| MiniMax Code | Pass | Pass | Pass | Pass | Pass | Unsupported |
| ZCode | Pass | Unsupported | Pass | Pass | Pass | Pass |
| OpenCode | Pass | Pass | Pass | Pass | Pass | Pass |
| SimpleAgent | Pass | Unsupported | Pass | Pass | Pass | Unsupported |
| DSH (AgentBundle) | Pass | Unsupported | Pass | Pass | Pass | Unsupported |
| Pi (AgentBundle) | Pass | Unsupported | Pass | Pass | Pass | Unsupported |
| JiuwenSwarm (AgentBundle) | Pass | Pass | Pass | Pass | Pass | Unsupported |
| DeepAgents (AgentBundle) | Unsupported | Unsupported | Unsupported | Pass | Pass | Pass |

The Evaluator patch for MiniMax Code 0.7.8 checks `maxTurns` before dispatching a main-agent model request. Docker runs with 200,000- and 36,000-token windows stopped at the requested 1 or 2 turns. Automatic checkpoints use a separate request path, and the last allowed turn can still produce a final answer.

Claude Code accepts windows from 100,000 to 1,000,000 tokens. Codex and TRAE configure the context window and automatic compaction threshold in `exec`. ZCode uses the model rules `properties.contextWindow` and `optionSpecs.maxOutputTokens.max`. JiuwenSwarm uses `react.max_iterations`, the model request's `max_tokens` and its native context engine. The DeepAgents Bundle's Python factory owns model construction, the loop and summarization. Its current interface cannot override these limits for arbitrary graphs.

Images and rendered PDF pages require an image-capable model. Original PDFs require a PDF-capable model endpoint that accepts the harness's file format. The image column covers still images only. [Attachment modes and examples](multimodal.md)

## Choose a Solver

| Solver | Purpose | Prerequisites |
| --- | --- | --- |
| `simpleagent` | Built-in Pi Agent for quality tasks and tool/file operations | Model API with tool calling; optional Pi Bundle |
| `agentbundle` | Packaged DSH, deepagents, Hermes, Jiuwenswarm, pi, or Dify agents | Readable, valid bundle and harness requirements |
| `codex` | Codex CLI for text, images, PDF pages, commands, and workspace files | Model service with streaming Responses API and tool calling |
| `claudecode` | Claude Code for text, images, PDFs, and Bash in local and Docker runs | Model service with streaming Anthropic Messages API and tool calling |
| `zcode` | ZCode CLI for text, images, PDFs, and Bash in local and Docker runs | Model service with streaming Chat Completions, Responses, or Messages and tool calling |
| `trae` | TRAE CLI 2.0 for text, images, PDF pages, and shell commands | Model service with streaming Chat Completions, Responses, or Messages and tool calling |
| `codebuddy` | CodeBuddy Code for text, images, PDFs, and shell commands | Model service with streaming Chat Completions or Responses and tool calling |
| `qwencode`, `kimicode`, `minimaxcode`, `opencode` | Official Code CLIs for text, images, PDF pages and tool tasks | A streaming Chat Completions, Responses or Messages service |
| `agentx-replay` | Trace-driven model requests for service performance | Streaming API, long context, tokenizer, and Python or Docker |
| `choice-logprobs` | Candidate probabilities at one output position for MMLU | local environment; actual logprobs/top_logprobs support; disable thinking when needed |

`simpleagent` is the framework default. AgentX profiles select `agentx-replay`; MMLU profiles select `choice-logprobs`. MMLU cannot be scored solely from an agent's final letter. See [scoring](reference/scoring.md#mmlu-probability-scoring-and-service-requirements) for service requirements, missing candidates, and Chat adaptation differences.

Select one solving path per configuration. EnvironmentSession represents execution interfaces and process boundaries; it does not move all solver plugin code into containers. Harness adapters read output and construct `SolveResult`. Benchmarks still score tasks. See [AgentX](benchmarks/agentx.md) for performance replay.

## Model Services and Independent Judges

This complete two-task example declares both the evaluated model and a judge:

```yaml
services:
  default:
    model: ${MODEL_NAME}
    base_url: ${MODEL_ENDPOINT}
    api_key: ${MODEL_API_KEY}
  judge:
    model: ${JUDGE_NAME}
    base_url: ${JUDGE_ENDPOINT}
    api_key: ${JUDGE_API_KEY}
benchmark:
  name: simpleqa
  config:
    judgeService: judge
environment: local
run:
  maxTasks: 2
output:
  directory: ./results/simpleqa
```

Set all six environment variables as shown in [quick start](quick-start.md#3-set-model-variables), then `run` `doctor` and `run`. Replace `simpleqa` with `healthbench` to use its profile.

- `benchmark.solver.service` selects the solving service. If omitted, it prefers `services.default`, otherwise the sole service. Multiple non-default services require explicit selection.
- **SimpleQA/HealthBench** select judges through `benchmark.config.judgeService`; the evaluated model is not automatically used as judge. `init` generates judge variables. Use `judgeService: default` to reuse the default service explicitly.
- **Harbor/WorkBuddy** model verifiers use `benchmark.verifier.service`. Web requires a judge; Office model scoring is optional. See [Harbor](benchmarks/harbor.md). This differs from record-based benchmarks' `judgeService` field.

`api` defaults to `openai-completions`. With an explicit Chat Completions `base_url`, Pi/SimpleAgent and built-in judges send a client output cap only when an effective `maxTokens` is set. For SimpleAgent, `solver.config.maxTokens` takes precedence over the selected service value. Other providers and external harnesses retain their protocol-specific rules.

Add `maxTokens: 8192` to a service to limit replies. Configure model request retries with `services.<name>.retry.maxAttempts`; exhaustion ends the current attempt without restarting the solution.

## SimpleAgent (Based on Pi)

SimpleAgent without a Bundle provides supplementary search. Set `webFetch: enabled` to read known URLs through the Evaluator's direct HTTP tool. The tool needs no Exa account or MCP and respects the task network policy. Keep `webSearch: disabled` to expose fetch without search. Disabling subagents reports that no delegation tool is built in.

`simpleagent` is Evaluator's built-in solver, using the Pi SDK for the agent loop, model requests and tool calls. Without a bundle, it runs with Evaluator's default instructions and tools. For example, `benchmark: gsm8k` selects default SimpleAgent and requires no Pi Bundle preparation.

### Optional: Load a Pi Bundle

Supply a Pi Bundle to customize instructions, skills, extensions or settings. Apply this fragment while keeping services, environment and other fields:

```yaml
benchmark:
  name: gsm8k
  solver:
    name: simpleagent
    config:
      bundle:
        path: ${PI_BUNDLE_PATH}
```

Point to a prepared Pi Bundle, rather than an arbitrary source directory. `bundle.settings` supplies serializable Pi settings applied to a staged copy, leaving the original bundle intact.

A Pi Bundle must declare `extensionPolicy: run-v1` in `bundle.yaml`. Each attempt uses a separate Pi process. Before loading extensions, Evaluator writes the six capability settings to `PI_BUNDLE_RUN_POLICY`. Read that policy during activation before registering tools, connecting MCP, loading skills, or starting a child. Pass the same policy to children.

### Tool Command Timeouts

Tool commands have separate timeouts. Increasing the task budget does not make shell commands unlimited. To adjust them:

```yaml
benchmark:
  name: gsm8k
  solver:
    config:
      toolPolicy:
        shellTimeoutSeconds: 180
        shellMaxTimeoutSeconds: 600
```

Provide both fields; the maximum must be at least the default. This fragment retains default `simpleagent`. Actual tool call timeouts cannot exceed the maximum.

## Codex

The service’s `reasoningEffort` maps to Codex’s native `model_reasoning_effort`.

Codex still runs through `exec`. The evaluator provides a separate `web_fetch` tool through its local MCP server, so a solver can fetch a page with search disabled. Disabling fetch also removes Codex's combined native search and page-opening tool. The supplementary search tool then returns source URLs. Set `webSearch: enabled`, `webFetch: enabled`, and `mcp: disabled` together to expose the native combined tool only. The model endpoint determines whether that tool can return page bodies. With MCP disabled, enabling fetch requires explicitly enabling search as well. Enabling search while explicitly disabling fetch also fails before startup. With `tools: none`, the evaluator removes both supplementary web tools and leaves independently declared MCP servers subject to the `mcp` setting.

`codex` runs Codex CLI in the task working directory on the local machine or in Docker. Evaluator installs CLI version `0.167.0` during environment preparation and authenticates with the selected model service. Save the following experiment YAML and set `CODEX_MODEL`, `CODEX_ENDPOINT`, and `CODEX_API_KEY` before running it.

```yaml
services:
  codex:
    model: ${CODEX_MODEL}
    base_url: ${CODEX_ENDPOINT}
    api: openai-responses
    api_key: ${CODEX_API_KEY}
benchmark:
  name: gsm8k
  solver:
    name: codex
    service: codex
environment: local
run:
  maxTasks: 1
output:
  directory: ./results/codex
```

- Set `base_url` to the API base, for example `https://api.openai.com/v1`. Codex sends requests to `/responses` under that base. `contextWindow` sets the automatic compaction threshold. The solver rejects the `maxTokens` and `retry` service fields.
- Codex uses `danger-full-access` and `approval_policy="never"` in local and Docker runs.
- For images and PDF attachments in `pages` mode, set `inputModalities: [text, image]` on the service. Codex passes both as images. Each attempt saves Codex events, the Evaluator trajectory, and stderr under `agent/`. See [image and PDF evaluations](multimodal.md).

## Claude Code

An explicit service `reasoningEffort` sets the main agent’s effort through the native `--effort` flag. The CLI resolves the setting against the model’s supported levels and selects the effort for subagents and auxiliary requests.

When task networking permits fetching, Claude Code enables native WebFetch for the main agent and subagents. The launcher sets `skipWebFetchPreflight` for those attempts to skip Anthropic’s domain safety lookup. Task networks `none` and `model-api`, `webFetch: disabled`, and `tools: none` all remove WebFetch.

Evaluator installs Claude Code `2.1.322` for local and Docker tasks. Save this experiment YAML and set `CLAUDE_MODEL`, `CLAUDE_ENDPOINT`, and `CLAUDE_API_KEY` before running it.

```yaml
services:
  claude:
    model: ${CLAUDE_MODEL}
    base_url: ${CLAUDE_ENDPOINT}
    api: anthropic-messages
    api_key: ${CLAUDE_API_KEY}
benchmark:
  name: gsm8k
  solver:
    name: claudecode
    service: claude
environment: local
run:
  maxTasks: 1
output:
  directory: ./results/claudecode
```

- Set `base_url` to the API base. Claude Code sends requests to `/v1/messages` under that base and authenticates via `x-api-key`. Use `https://api.anthropic.com` for Anthropic or `https://api.deepseek.com/anthropic` for DeepSeek's compatible API.
- Claude disables its internal sandbox. The Docker task uses `bypassPermissions` and retains its configured user, mounts, and network. A local Linux run as root uses `dontAsk`. Explicit tool exclusions apply in both modes. Bash runs with the permissions of the host or container process. On Windows, install Git for Windows and set `CLAUDE_CODE_GIT_BASH_PATH` to its `bash.exe` if Claude Code cannot find it.
- On Linux, the runtime sends model requests through an attempt-local relay and clears its temporary credentials from Bash's environment.
- For images and PDF pages, declare `image` in the service's `inputModalities`. For native PDFs, declare `pdf` and use a Messages endpoint that accepts document content blocks. See [image and PDF evaluations](multimodal.md).
- `maxTokens` sets the CLI output budget and the Messages API `max_tokens`. Set `contextWindow` between 100,000 and 1,000,000 tokens according to the model service's capacity. At 1,000,000, Evaluator selects Claude Code's `[1m]` mode, and the CLI strips the suffix from the model ID it sends to the service. The solver rejects `retry`. Each attempt saves events, the trajectory, and stderr under `agent/`.

## ZCode

ZCode supplies search on the custom model route through a supplementary MCP server. `webSearch: enabled` conflicts with `mcp: disabled`. The native `WebFetch` tool can still run with MCP disabled.

Evaluator builds ZCode CLI `0.17.1` from a pinned source archive during runtime preparation. The first run or `warmup` needs access to GitHub and the npm registry. Later runs reuse the build. Warmup requires no model credentials. See [network configuration](network.md) for mirror settings.

```yaml
services:
  zcode:
    model: ${ZCODE_MODEL}
    base_url: ${ZCODE_ENDPOINT}
    api: openai-completions
    api_key: ${ZCODE_API_KEY}
benchmark:
  name: gsm8k
  solver:
    name: zcode
    service: zcode
environment: local
run:
  maxTasks: 1
  preparation:
    environmentTimeoutSeconds: 1800
    roundTimeoutSeconds: 1800
output:
  directory: ./results/zcode
```

The preparation timeouts allow up to 30 minutes for the initial build and can be adjusted for your network.

Use the API base URL. Chat Completions and Responses usually use a URL ending in `/v1`. The solver also accepts `api: openai-responses` and `api: anthropic-messages`. Omit `retry`.

The service’s `reasoningEffort` sets `reasoningLevel` in ZCode’s native model selection. ZCode resolves the level against the model’s capabilities and chooses the effort for WebFetch, WebSearch, and background requests.

ZCode enables Bash in local and Docker runs. Use local mode for trusted tasks since Bash runs with the host process's permissions. Install Git Bash for Bash tools on Windows. Use Docker for tasks that need container isolation.

For images and PDF pages, declare `image` in the service's `inputModalities`. For native PDFs, declare `pdf` and use an endpoint that accepts PDF input. Each attempt saves redacted session events, the Evaluator trajectory, and stderr under `agent/`. See [image and PDF evaluations](multimodal.md).

## TRAE CLI

This TRAE version sends its native `model_reasoning_effort` setting over Chat Completions. To set the service’s `reasoningEffort` explicitly, use `api: openai-completions`. For Responses and Messages, omit the field.

TRAE's native WebFetch works independently of MCP. Native search needs working credentials. Setting `mcp: disabled` removes the evaluator's supplementary search service.

Evaluator downloads and caches the official `traecli` version `0.214.1` on x64 Windows, WSL, and Linux Docker. The first run or `warmup` needs access to the TRAE release CDN. Warmup requires no model key. Download proxies use the [network configuration](network.md).

Set `TRAE_MODEL`, `TRAE_ENDPOINT`, and `TRAE_API_KEY` before running this experiment.

```yaml
services:
  trae:
    model: ${TRAE_MODEL}
    base_url: ${TRAE_ENDPOINT}
    api: openai-responses
    api_key: ${TRAE_API_KEY}
benchmark:
  name: gsm8k
  solver:
    name: trae
    service: trae
environment: local
run:
  maxTasks: 1
  preparation:
    environmentTimeoutSeconds: 900
    roundTimeoutSeconds: 900
output:
  directory: ./results/trae
```

- The selected service's `api` controls the request path. TRAE appends `/chat/completions` for `openai-completions`, `/responses` for `openai-responses`, or `/messages` for `anthropic-messages` to `base_url`. Include any API prefix required by the service (for example, `/v1` for LiteLLM). Omit the service fields `maxTokens` and `retry`.
- WSL uses Bash and native Windows uses PowerShell. Both use `danger-full-access` with approval set to `never`.
- Set `inputModalities: [text, image]` for images and PDF `pages` attachments. Use pages mode for PDFs. Each attempt saves redacted session events, the Evaluator trajectory, and stderr under `agent/`. See [image and PDF evaluations](multimodal.md).

## CodeBuddy Code

An explicit service `reasoningEffort` sets the main agent’s effort through the native `--effort` flag. The CLI resolves the setting against the model’s supported levels and selects the effort for subagents and auxiliary requests.

Version 2.183.0 uses a pinned patch so `skills: disabled` disables project and plugin skills. The same plugin's MCP tools remain available when `mcp` is left at its default.

Evaluator installs and caches the standalone `@tencent-ai/codebuddy-code` version `2.183.0` on x64 Windows, WSL, and Linux Docker. The first `warmup` or run uses the configured npm registry. Warmup requires no model key. Set `CODEBUDDY_MODEL`, `CODEBUDDY_ENDPOINT`, and `CODEBUDDY_API_KEY` to run this example.

```yaml
services:
  codebuddy:
    model: ${CODEBUDDY_MODEL}
    base_url: ${CODEBUDDY_ENDPOINT}
    api: openai-completions
    api_key: ${CODEBUDDY_API_KEY}
    contextWindow: 200000  # Set to the selected service's context capacity.
benchmark:
  name: gsm8k
  solver:
    name: codebuddy
    service: codebuddy
    config:
      maxTurns: 2000
environment: local
run:
  maxTasks: 1
  preparation:
    environmentTimeoutSeconds: 900
    roundTimeoutSeconds: 900
output:
  directory: ./results/codebuddy
```

- Set `base_url` to the API base, such as `https://api.openai.com/v1`. You can also select `api: openai-responses`. `services.<name>.contextWindow` sets the model's native `maxInputTokens`, which CodeBuddy uses to calculate when to compact. `maxTokens` sets the model output limit. Omit `retry`.
- `solver.config.maxTurns` accepts a positive integer and maps to CodeBuddy's native `--max-turns`, limiting agentic turns per solve. When omitted, Evaluator leaves the CLI default unchanged. The turn limit and `run.solveTimeoutSeconds` apply independently; whichever is reached first ends the solve.
- Native Windows exposes PowerShell. WSL and Docker expose Bash. Local commands run with the host process's permissions, so use local mode for trusted tasks. Docker commands run in the task container.
- A workspace `.codebuddy/models.json` can override the selected endpoint. The solver reports an error before starting CodeBuddy when the file is present. For images and PDF `pages` attachments, declare `inputModalities: [text, image]`. Declare `pdf` to send original PDF files. Each attempt saves redacted events, trajectory, and stderr under `agent/`. See [image and PDF evaluations](multimodal.md).

## Qwen Code, Kimi Code CLI, MiniMax Code and OpenCode

Evaluator verifies and applies version-specific patches to CodeBuddy 2.183.0, Kimi 2.7.0, and MiniMax 0.7.8 during installation. CodeBuddy can disable project and plugin skills. Kimi can disable skills and project MCP, and MiniMax can disable project MCP and enforce its main-agent turn limit before dispatch. Solver provenance records `capabilityPatchSha256`. The installation contains `capability-patch-receipt.json` with the upstream and patched SHA-256 of each file.

Select `qwencode`, `kimicode`, `minimaxcode`, or `opencode` in `benchmark.solver.name`. Evaluator installs the pinned official CLIs in an isolated runtime and does not reuse host login state.

| Solver | Package | Version | `solver.config.maxTurns` |
| --- | --- | --- | --- |
| `qwencode` | `@qwen-code/qwen-code` | `0.28.0` | Native `--max-session-turns` / `model.maxSessionTurns`, plus a model-request ceiling because ACP can ignore the startup limit |
| `kimicode` | `@moonshot-ai/kimi-code` | `2.7.0` | Native `loop_control.max_steps_per_turn` |
| `minimaxcode` | `@minimax-ai/code` | `0.7.8` | Native `exec --max-steps` |
| `opencode` | `opencode-ai` | `1.19.6` | Native `agent.build.steps`, plus a model-request ceiling: the native setting only prompts the model to wrap up |

```yaml
services:
  default:
    model: ${MODEL_NAME}
    base_url: ${MODEL_ENDPOINT}
    api_key: ${MODEL_API_KEY}
    api: openai-completions
    reasoningEffort: low
    maxTokens: 65536
    # Declare image only when the selected model supports it.
    inputModalities: [text, image]
benchmark:
  name: mmlu_pro
  config:
    solveNetwork: model-api
  solver:
    name: qwencode # kimicode, minimaxcode, or opencode
    config:
      tools: none
      mcp: disabled
      webSearch: disabled
      webFetch: disabled
      maxTurns: 2000
environment: docker
run:
  solveTimeoutSeconds: 600
```

`maxTokens` sets the per-response output cap, `maxTurns` sets the native step limit, and `run.solveTimeoutSeconds` sets the task deadline. At limits of 1 and 2, Qwen, Kimi, MiniMax, and OpenCode issued 1 and 2 main-agent requests respectively. Omitted solver limits use the service settings and CLI defaults. MiniMax custom models default to 16,384 output tokens. Kimi omits its native output cap on Chat requests, so Evaluator applies an explicit `maxTokens` at the relay. Unknown custom models in Kimi and MiniMax default to a 200,000-token window. Set `contextWindow` for the actual service capacity.

All four select Chat Completions, Responses, or Messages from the selected service's `api`. An explicit service `reasoningEffort` selects a native session effort in Qwen Code, Kimi Code and OpenCode. MiniMax Code receives it through its native `--effort` flag. The CLI decides how the selected effort is encoded and whether secondary requests inherit it. Qwen Code's native selector starts at `low`. Real model credentials remain in the relay process; child CLIs receive a temporary local token. Qwen, Kimi, and OpenCode receive initial images over native ACP; MiniMax uses native `exec --file`. OpenCode transmits original PDFs over all three APIs. Qwen supports original PDFs on Chat Completions and Messages, and requires pages on Responses. Kimi drops binary ACP resources. MiniMax sends a file reference without the PDF bytes. Use pages mode for these two CLIs. Task skill directories and MCP servers are passed to the selected CLI when enabled.

When built-in tools are disabled, CLI model requests retain only registered MCP tool declarations. Evaluator also skips its automatic search fallback. Search tools provided by a task’s MCP servers follow the MCP setting and the task’s network policy.

OpenCode's native `websearch` uses Exa and can run with MCP disabled. For Qwen, Kimi and MiniMax, disabling MCP removes the supplementary search server. Whether native search can return sources depends on the model route and credentials. Check the actual tool result in the attempt.

MiniMax installation verifies its native SQLite module; if its prebuilt binary cannot be downloaded, the native installer may require Python, make and a C++ compiler. Node 24 is required; OpenCode installs the official platform binary. Use [network configuration](network.md) for registry and Docker sources. If a registry mirror has not synchronized MiniMax `0.7.8`, set `sources.npm.registry` to `https://registry.npmjs.org`. Run `warmup` before `run`; four [MMLU-Pro examples](../../playbook/mmlu-pro/) are provided.

Artifacts retain native JSONL/ACP events, final text and usage. ACP `usage_update` is context occupancy, not cumulative usage. Evaluator uses native final usage when available and otherwise complete model-response usage; unreported usage remains missing.

## AgentBundle

Use the `harness.name` in the Bundle manifest to find its additional conditions.

| Harness | Conditions |
| --- | --- |
| DSH | The six switches target the pinned 0.2.2-rc.1 runtime. Explicit search or fetch requires the selected profile and model service to expose `web_search` or `web_fetch`. The search plugin can fall back to supplementary search. |
| Pi | With `webFetch: enabled`, Pi prefers the Evaluator’s direct HTTP `web_fetch` tool, which works with `mcp: disabled`. It replaces common fetch-only tool names and tools named in `pi.webFetchTools`. Leaving `webFetch` at `default` keeps the Bundle's tools. `pi.webSearchTools` names search tools, and assigning a tool to opposing policies is a configuration error. The same rules apply to aliases in `simpleagent.bundle`. |
| JiuwenSwarm | Fetch defaults to the Bundle configuration. Explicit fetch can activate the native fetch tool. With `mcp: disabled`, supplementary search is removed. Explicit search then requires a native search tool visible to the main session. A tool name in the config alone is insufficient. |
| DeepAgents | The graph returned by `build_agent_for_run` controls built-ins, fetch, delegation, MCP and skills. The maintained example provides fetch. When explicitly enabled, Evaluator also provides a supplementary fetch tool to the graph. The evaluator's search and fetch tools can still run with MCP disabled. |

JiuwenSwarm disables its inner sandbox and approval prompts. The main agent and the three default children (`statusline-setup`, `explore_agent`, and `plan_agent`) can load task and Bundle skills through their own native `skill_tool`. The optional `code_agent` and `browser_agent` also get their own readers when enabled. Setting `skills: disabled` removes skill discovery and the reader from these sessions. File tools retain their configured access. By default, the Bundle selects the available web tools. Set `webFetch: enabled` to enable the native `fetch_webpage` tool or `webFetch: disabled` to remove it from the model's tool list while keeping other tools available. Hermes uses a local terminal with approvals off. DeepAgents graphs and remote Dify workflows control their own execution backends. Adapters reject restrictions they cannot enforce.

Follow [source installation](installation.md#install-from-source) to prepare Evaluator. pnpm installs the AgentBundle SDK automatically, without a sibling source repository. `AGENT_BUNDLE_PATH` below points to a prepared **agent bundle directory**, supplied separately rather than the SDK installation path. See the [AgentBundle project](https://github.com/ARSI-LAB/agentbundle) for concepts, CLI usage and examples, and its [bundle authoring guide](https://github.com/ARSI-LAB/agentbundle/blob/master/docs/bundle-formats.md) for harness-specific layouts, manifests and validation.

```yaml
services:
  default:
    model: ${MODEL_NAME}
    base_url: ${MODEL_ENDPOINT}
    api_key: ${MODEL_API_KEY}
benchmark:
  name: gsm8k
  solver:
    name: agentbundle
    config:
      path: ${AGENT_BUNDLE_PATH}
environment: local
run:
  maxTasks: 2
  timeoutSeconds: 900
output:
  directory: ./results/gsm8k-agentbundle
```

Prefer an absolute `AGENT_BUNDLE_PATH`. Evaluator reads the declared harness and checks content identity before selecting an adapter; directory names are not used to guess. Local harnesses also check their pinned versions against the declared ranges; see below for remote Dify version limits. Start a new run after bundle changes.

| Harness declaration | Behavior |
| --- | --- |
| `dsh` | Prepare and run through DSH; see [DSH output](usage.md#dsh-tool-output) |
| `deepagents` **Beta** | Set `graphs.agent` in `langgraph.json` to `./agent.py:build_agent_for_run`. The evaluator passes the run policy, task MCP servers, skill directories and middleware to the factory before it builds the main graph and its children. Preparation rejects the old `:agent` reference. |
| `hermes` **Beta** | Hermes adapter |
| `jiuwenswarm` **Beta** | Jiuwenswarm adapter |
| `pi` **Beta** | pi with release artifact and settings digest validation |
| `dify` **Beta** | Install a remote application with the SDK, then execute its Workflow; see below |

Some harnesses require preinstalled local runtimes or dependency installation during Docker preparation. Local directories do not automatically become container/remote paths. Check bundle and harness deployment requirements before choosing a [Playbook](../../playbook/README.md) environment.

Specify existing installations with Solver settings such as `dshhome`, `dshprofile`, `hermeshome`, or `jiuwenswarmhome`. `jiuwenswarmTimeoutSeconds` applies only to that harness. Additional pi settings use `benchmark.solver.config.pi.settings`, unsupported by other harnesses.

For Docker, DSH uses the pinned default (0.2.2-rc.1) when it satisfies the Bundle’s `harness.version`. Otherwise the Solver selects the highest compatible release from the configured npm registry. Use an explicit prerelease comparator to allow a release candidate. Local environments check the installed DSH version against the same range.

For bundles that support an output cap, Solver `maxTokens` overrides the service field. This page covers Evaluator configuration and execution; use the linked AgentBundle documentation for bundle creation, formats and installation.

For DSH, `services.<name>.contextWindow` sets the selected model's native context capacity for compaction. On the built-in DeepSeek API-key route, an explicit context size supplies a local catalog entry for the selected model. Leave room for the output cap and the profile's compaction headroom (65,536 tokens by default). DSH's ordinary task loop has no native `maxTurns` setting. Use `run.solveTimeoutSeconds` to set a task deadline.

## Docker Preparation and Networking

The solver selects agent behavior; the task environment selects an existing image or a Dockerfile build. Choosing `simpleagent` or `agentbundle` does not directly select an image download method. `warmup` makes no model calls, but prepares task images, Evaluator's shared Node runtime and installation dependencies required by the selected harness. Available caches are reused.

A single warmup may include both Dockerfile `FROM` pulls and explicit acquisition of existing images such as Node. The former uses Docker daemon/BuildKit networking; the latter uses the network file's `docker.mirrors` and `docker.pull`. Even with `docker.pull.method: docker`, Evaluator rewrites the image reference before asking Docker to download it. See [warmup downloads](deployment/network.md#image-and-dependency-downloads-during-warmup) for configuration boundaries across image acquisition, build-time dependency installation and runtime installation.

## Dify

Dify is an AgentBundle harness. Prepare a bundle declaring `harness.name: dify` and use this text-task configuration:

```yaml
services:
  default:
    model: dify-internal-binding
    base_url: http://127.0.0.1:9/v1
    api_key: ${MODEL_API_KEY}
benchmark:
  name: gsm8k
  solver:
    name: agentbundle
    config:
      path: ${DIFY_BUNDLE_PATH}
      dify:
        baseUrl: ${DIFY_BASE_URL}
        registryPath: ${DIFY_REGISTRY_PATH}  # optional
environment: local
run:
  maxTasks: 2
  timeoutSeconds: 900
output:
  directory: ./results/gsm8k-dify
```

`path` selects the Dify bundle. `dify.baseUrl` is the service address, such as `https://dify.example`, without `/v1`, `/workflows/run`, credentials, query parameters, or fragments. Installation and execution both use this address, overriding the SDK's `DIFY_BASE`. The Workflow accepts text input `task` and returns text `report` or `answer`; other output objects are saved as JSON text.

Configure Console credentials on the machine running the Evaluator process: `DIFY_ADMIN_API_KEY`, `DIFY_EMAIL` plus `DIFY_PASSWORD`, or previously saved SDK credentials. Missing credentials fail without an interactive login. The SDK installs and publishes the application and returns its app ID and Service API key. For Ray, preconfigure Console credentials on installation nodes; local environment variables are not automatically distributed.

services retains required framework metadata. In this example `MODEL_API_KEY` only satisfies service binding and no request goes to the placeholder address; model binding belongs to the Dify application. Service or Solver `maxTokens` does not change Workflow model parameters.

`dify.registryPath` selects the installation record file, relative to the YAML directory. By default it uses `dify/<service-address-digest>/installations.json` below the SDK's default registry directory. Concurrent attempts sharing a file on one machine use a file lock and create one application. Remote nodes have separate records; installation is not deduplicated across nodes. An explicit registry containing the same bundle for another service is rejected; choose another file. Registry files contain Service API keys and must not be committed. Run artifacts only contain credential-free installation evidence. Applications remain installed in persistent mode after evaluation.

Provenance records the bundle digest, Runner digest/version, and declared platform version range. The actual remote Dify version and external changes to the installed Workflow are not verified. The old `solver.name: dify`, `bundlePath`, `apiKeyEnv`, and `appId` settings are removed. Migrate to this bundle configuration and start a new run; existing results remain usable for offline reporting.

**The Dify harness does not sync generated files back to task environments.** Office and repository-editing tasks need SimpleAgent or another AgentBundle harness that writes through EnvironmentSession. The [Office Dify YAML](../../playbook/workbuddy/workbuddy-office-dify.yaml) only demonstrates configuration.

## AgentX Service Performance

No AgentBundle preparation is needed. `benchmark.name: agentx` selects a dedicated trace-request solver. The API must support streaming, `ignore_eos`, full context, and required output lengths.

- `replay`: explicitly set `traceCount` and complete a finite trace set, suitable for adaptation acceptance.
- `standard`: fixed `standard` measurement windows and load rules.

vLLM `/metrics` and Ascend sampling endpoints are optional; without them only model API performance is measured. `replay` is not a formally comparable score; standard must pass upstream and local validity checks. See [AgentX](benchmarks/agentx.md) for parameters, Python requirements, and NPU collection.

[User guide](README.md) · [Daily operations](usage.md) · [Configuration reference](config.md)
