# Installation and Deployment

> English | [中文](./installation.zh-CN.md)

[Project home](../../README.md) · [User guide](README.md)

## Install from Source

Prepare Node.js **24.22.1 or later 24.x**, pnpm **11 or 12**, and Git.

If pnpm is missing, run `npm install --global pnpm`. Clone the repository and install the CLI:

```bash
git clone https://github.com/evolving-foundry/ember-evaluator.git
cd ember-evaluator
pnpm install --frozen-lockfile
pnpm add -g .
ember-evaluator --help
```

The help output confirms installation. pnpm fetches the AgentBundle SDK from its public GitHub repository and builds it automatically. Keep the Evaluator directory and its dependencies. [AgentBundle on GitHub](https://github.com/evolving-foundry/agentbundle)

Top-level `--help` lists command purposes. Use `ember-evaluator run --help` for run parameters, or `ember-evaluator cleanup images --help` for nested commands. Each command describes its arguments and options.

After updating the source, run `pnpm install --frozen-lockfile` again. When using WSL, install and run in the same WSL environment.

## Register the Global CLI

The `pnpm add -g .` command above registers the CLI. If the global directory is not configured or the command cannot be found, run:

```bash
pnpm setup
```

Reopen the terminal as instructed, return to the Evaluator repository, and retry `pnpm add -g .` and `ember-evaluator --help`.

## Install the Agent Skill

In the project where you use your coding agent, run the following and select that agent:

```bash
npx skills add evolving-foundry/ember-evaluator --skill ember-evaluator
```

To have a coding agent install both the CLI and the skill, give it this instruction:

```text
Install the Ember Evaluator CLI and its ember-evaluator skill from https://github.com/evolving-foundry/ember-evaluator.
Follow docs/users/installation.md to install the CLI and add the skill to the target project for this agent.
Run ember-evaluator --help and confirm that this agent can discover and read the skill. Stop after verifying installation.
```

## Run the CLI from TypeScript Sources

From the repository root, use `pnpm dev` to run CLI commands against the TypeScript sources. On a fresh checkout with dependencies installed, the first command that needs the plugin registry builds the runtime assets and plugin bundles automatically.

```bash
pnpm dev run playbook/gsm8k/gsm8k-quick-start.yaml --tracer
```

Set the model variables first as described in the [Tracer guide](tracer.md#view-an-evaluation).

## Run from Any Directory

Follow the [quick start](quick-start.md) to prepare your configuration and model variables, then run:

```bash
ember-evaluator doctor '/path/to/config.yaml'
ember-evaluator run '/path/to/config.yaml'
```

Relative paths in YAML are based on the configuration file's directory. Use an absolute path for `--patch`. Prepare Docker or other requirements using the relevant [scenario guide](README.md).

## Run in the Management Container (Linux Servers)

If the host already has Docker, use the management container to install and run Evaluator without installing Node.js or other dependencies on the host. See the [management container guide](deployment/container-toolbox.md).

## Local Runtime Cache and Windows Path Length

Runtime dependencies are cached automatically. If Windows reports `WinError 206`, set a shorter cache path and retry:

```powershell
$env:EVALUATOR_RUNTIME_CACHE_DIR = "D:\ae"
ember-evaluator run "D:\experiments\config.yaml"
```

For other installation or runtime issues, see the [FAQ](faq/README.md).
