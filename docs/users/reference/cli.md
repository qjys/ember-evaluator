# CLI Reference

> English | [中文](cli.zh-CN.md)

Each row shows the full command. Replace placeholders such as `<yaml>` with actual values. Square brackets mark optional arguments or values. `ember` is an alias for `ember-evaluator`.

## Get help

| Full command | What it does | Optional flags |
| --- | --- | --- |
| `ember-evaluator --help` | Show the commands available in this installation. `-h` is shorthand for `--help`. | — |
| `ember-evaluator <command> --help` | Show help for a command or subcommand, for example `ember-evaluator kernel profile --help`. | — |
| `ember-evaluator help [command]` | Show help for a top-level command. Running `ember-evaluator` or `ember-evaluator help` displays top-level help. | — |

## Choose a Benchmark and configure an experiment

| Full command | What it does | Optional flags |
| --- | --- | --- |
| `ember-evaluator benchmark list` | List registered benchmark versions, defaults, and scenarios. Use `--json` for structured output. | `--json`, `--patch <path>` |
| `ember-evaluator benchmark info <name>` | Show details and resolved settings for each version of the named benchmark. | `--patch <path>` |
| `ember-evaluator init --benchmark <name> --output <yaml>` | Generate an experiment YAML from benchmark defaults. Existing destination files are preserved. | `--patch <path>` |
| `ember-evaluator inspect <yaml>` | Print resolved experiment and network settings without downloading or probing network access. | `--patch <path>`, `--network <yaml>` |

## Prepare the environment and clean up images

| Full command | What it does | Optional flags |
| --- | --- | --- |
| `ember-evaluator doctor <yaml>` | Check experiment configuration, runtime prerequisites, and network connectivity. | `--patch <path>`, `--network <yaml>` |
| `ember-evaluator warmup <yaml>` | Prepare images and runtime dependencies for selected tasks. Solving and scoring take place during the evaluation. | `--patch <path>`, `--network <yaml>`, `--progress <mode>`, `--task-ids-file <json>` |
| `ember-evaluator cleanup images [yaml]` | Preview evaluator image references by default. Pass `--yes` to remove them. Omitting the experiment YAML requires `--all`, and using `--patch` requires the YAML. | `--all`, `--yes`, `--patch <path>` |

## Run evaluations, retry tasks, and rebuild reports

| Full command | What it does | Optional flags |
| --- | --- | --- |
| `ember-evaluator run <yaml>` | Run an evaluation and save the results. | `--patch <path>`, `--network <yaml>`, `--progress <mode>`, `--task-ids-file <json>`, `--model <name>`, `--endpoint <url>`, `--api-key <key>`, `--api-key-env <name>` |
| `ember-evaluator run <yaml> --dry-run` | Resolve the dataset and list the selected task IDs. The CLI may download the dataset as needed. | See the `run` row |
| `ember-evaluator run <yaml> --resume [run-id]` | Continue a saved run. Omit the ID to let the CLI select a resumable run. | See the `run` row |
| `ember-evaluator run <yaml> --tracer [url]` | Run an evaluation and mirror attempt evidence to Tracer. Pass a URL to use another Collector endpoint. | See the `run` row |
| `ember-evaluator retry --run <id-or-directory>` | Rerun eligible network failures within the original run. Repeat `--task-id` to narrow the selection, use `--request-id` to deduplicate submissions, and record the reason with `--reason`. | `--task-id <id>`, `--request-id <id>`, `--reason <text>`, `--network <yaml>`, `--progress <mode>` |
| `ember-evaluator report <run-dir>` | Rebuild metrics and `report.md` offline from saved results without a model API key. | — |

`--dry-run` and `--resume` are mutually exclusive. [Network retry eligibility](../network-retry.md#commands)

## Tracer

From the repository root, use the model settings from the [GSM8K quick start](../quick-start.md). The first command runs the evaluation and starts or reuses the local Collector as needed. Run the second command in a separate terminal to check Collector status.

```bash
ember-evaluator run playbook/gsm8k/gsm8k-quick-start.yaml --tracer
ember-evaluator tracer status
```

Use `ember-evaluator tracer serve` to start the Collector independently. Open `http://127.0.0.1:8787` to view the captured evidence. [Tracer configuration](../tracer.md#collector-configuration)

| Full command | What it does | Optional flags |
| --- | --- | --- |
| `ember-evaluator tracer serve` | Start the Collector or reuse a healthy instance. The startup timeout defaults to `30000` ms. | `--url <url>`, `--db <path>`, `--spool <path>`, `--port <n>`, `--timeout <ms>` |
| `ember-evaluator tracer status` | Print Collector status as JSON. Exit nonzero when the Collector is unhealthy. | `--url <url>`, `--db <path>`, `--spool <path>`, `--port <n>` |
| `ember-evaluator tracer logs` | Read the Collector log. It prints the last `200` lines by default. Use `--follow` or `-f` to follow new entries. | `--url <url>`, `--db <path>`, `--spool <path>`, `--log <path>`, `--lines <n>`, `--follow`, `-f` |
| `ember-evaluator tracer stop` | Stop the Collector process recorded in `tracer.pid`. | `--url <url>`, `--db <path>`, `--spool <path>`, `--port <n>` |

For Collector management, `--url` selects the endpoint, `--port` overrides its port, and `--db` and `--spool` select the database and spool directory. `--log` selects the log to read.

## Measure kernels

| Full command | What it does | Optional flags |
| --- | --- | --- |
| `ember-evaluator kernel precision --problem <path> --kernel <path> --out <json>` | Validate the candidate kernel against the reference on an NPU. Pass a quoted, space-separated list to `--seeds`. The default is `"0 1"`. | `--seeds <list>`, `--device <n>`, `--python <executable>` |
| `ember-evaluator kernel bench --problem <path> --kernel <path> --out <json>` | Measure candidate kernel runtime on an NPU. Use `kernel precision` for correctness checks. | `--device <n>`, `--python <executable>` |
| `ember-evaluator kernel profile --problem <path> --kernel <path> --out <json>` | Collect candidate kernel profiling data independently. The round index, replay seed, and warmup count default to `0`, `0`, and `25`, respectively. | `--round <n>`, `--seed <n>`, `--warmup <n>`, `--device <n>`, `--python <executable>` |

For `kernel` commands, `--problem` points to the problem and reference definition, `--kernel` to the candidate implementation, and `--out` to the result JSON. `--device` takes a logical NPU index and `--python` selects the Python executable. A device value of `0` uses the worker's environment, with device `0` as the fallback. [Kernel examples](../benchmarks/kernel-npu.md#independent-measurement-atoms)

## Options used by multiple commands

- `--patch <path>` loads an explicit plugin patch. The CLI resolves the patch path from the current working directory. Installed extensions and explicit patches can add commands or `run` flags. Plugin commands also accept `--patch` for discovery. [External plugin loading](../../development/add-external-plugin.en.md)
- `--network <yaml>` selects a network configuration for the invocation. `--progress <mode>` accepts `auto` (default), `tty`, or `plain`. [Network configuration](../network.md) · [Live execution previews](../usage.md#live-execution-previews)
- `--task-ids-file <json>` reads a JSON object containing a `taskIds` array. It replaces the configured task IDs and clears the offset, maximum task count, and sampling settings. With `--resume [run-id]`, leaving out the ID lets the CLI select a resumable run automatically. [Task selection](../usage.md#preview-and-save-actual-task-ids) · [Resume](../usage.md#resume-and-rebuild-reports)
- `run --model` and `run --endpoint` override the Solver model and API endpoint. Supply the key through `--api-key-env <name>` or `--api-key <key>`, which are mutually exclusive. The environment variable form keeps the key out of the command line. [Model services](../solvers.md)

See [exit codes](errors.md) for command failures.
