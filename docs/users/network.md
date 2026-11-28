# Network downloads

> English | [中文](network.zh-CN.md)

`--network` selects a network YAML for proxies, download sources, and image acquisition. The experiment YAML selects the benchmark, model, tasks, and execution environment:

```bash
arsi-evaluator run experiment.yaml --network network.yaml
```

Both file paths resolve from the current working directory. Register the CLI using the [installation guide](installation.md#register-the-global-cli) first.

## 1. Choose a network file

| Goal | File |
| --- | --- |
| Download Terminal-Bench task images from ModelScope | [archives.yaml](../../playbook/network/archives.yaml); see [instructions](image-downloads.md#download-task-images-from-modelscope) |
| Use download mirrors and DockerProxy | [mirrors.yaml](../../playbook/network/mirrors.yaml); see [editing instructions](reference/network.md#edit-mirrorsyaml) |
| Use official sources | [official.yaml](../../playbook/network/official.yaml) |
| Set your own proxy or download URLs | Create `network.yaml`; see [fields and proxies](reference/network.md) |

Select one file per command. Omitted fields use built-in defaults. Supported environment variables override YAML; use `inspect` below to see effective settings.

## 2. Inspect, then run

For example, download task images from ModelScope from the repository root. Replace `experiment.yaml` with your Terminal-Bench 4.0 experiment file:

```bash
# Show effective settings without downloading
arsi-evaluator inspect experiment.yaml --network playbook/network/archives.yaml
# Start evaluation
arsi-evaluator run experiment.yaml --network playbook/network/archives.yaml
```

`--network` selects a file for that invocation only; pass it again in subsequent commands. Without it, Evaluator uses the environment variable or the default file in your user directory. See [set a default network file](reference/network.md#set-a-default-network-file).

This file changes Terminal-Bench task image acquisition only; the selected tasks and platform must have published archives. To check connectivity or prepare images first, use `doctor` or `warmup` with the same experiment file and `--network`. `run` also prepares images and dependencies automatically.

## Further reading

| Topic | Guide |
| --- | --- |
| Default files, precedence, proxies, package sources, environment variables | [Fields and proxies](reference/network.md) |
| ModelScope, combined mirrors, acquisition methods, caching, image IDs | [Image downloads](image-downloads.md) |
| doctor results, failure causes, real download verification | [Network diagnosis](faq/network.md) |
| Docker daemon, source installation, toolbox, Ray node networking | [Deployment networking](deployment/network.md) |

## Web tool network policy

Use the Solver's `webSearch` and `webFetch` switches to control web tools. With unrestricted web access, Solvers with native tools use them first. Supplementary tools call public Exa MCP when a native call reports a detectable failure. Exa requests do not use the model API key. Pi and SimpleAgent use direct HTTP for Evaluator-provided fetch, including on unrestricted task networks. For harnesses with native fetch, `mcp: disabled` also suppresses Evaluator's supplementary fetch.

`none` and `model-api` environments disable supplementary web tools. With a domain allowlist, supplementary fetch uses direct HTTP and checks each redirect, and supplementary search is disabled.
