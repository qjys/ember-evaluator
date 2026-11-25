import { Command as Commander, CommanderError, Option } from "commander";
import { resolve } from "node:path";
import { pluginCommandArguments } from "../application/plugins/cli-extensions.js";
import type { CliExtensions } from "../application/plugins/cli-extensions.js";
import type { PluginActivation } from "../core/contracts/plugin-extension.js";
export type Command = (
  | { kind: "benchmark-list"; json: boolean; patchPath?: string }
  | { kind: "benchmark-info"; name: string; patchPath?: string }
  | { kind: "cleanup-images"; file?: string; all: boolean; execute: boolean; patchPath?: string }
  | { kind: "retry"; run: string; taskIds: string[]; requestId?: string; reason?: string }
  | { kind: "help"; text: string; exitCode?: number }
  | { kind: "init"; name: string; output: string; patchPath?: string }
  | { kind: "doctor"; file: string; overrides: CliOverrides; patchPath?: string }
  | { kind: "inspect"; file: string; overrides: CliOverrides; patchPath?: string }
  | { kind: "compare-recommendation"; base: string; fast: string }
  | { kind: "report"; directory: string }
  | { kind: "plugin"; plugin: PluginCliCommand; argv: string[] }
  | { kind: "run"; file: string; overrides: CliOverrides; resume?: string | null; taskIdsFile?: string; patchPath?: string }
  | { kind: "warmup"; file: string; overrides: CliOverrides; taskIdsFile?: string; patchPath?: string }
  | { kind: "dry-run"; file: string; overrides: CliOverrides; taskIdsFile?: string; patchPath?: string }
) & { networkConfigPath?: string };


import type { CliOverrides } from "../core/contracts/config.js";
import type { PluginCliCommand } from "../core/contracts/plugin-extension.js";

interface Options extends Omit<CliOverrides, "plugins"> {
  patch?: string; taskIdsFile?: string; resume?: boolean | string; dryRun?: boolean;
  all?: boolean; yes?: boolean; benchmark?: string; output?: string; json?: boolean;
  run?: string; taskId?: string[]; requestId?: string; reason?: string;
  network?: string;
}

export class CommandUsageError extends TypeError {
  constructor(message: string, readonly helpText: string) { super(message); }
}

export function parseCommand(argv: string[], extensions: CliExtensions = { commands: [], options: [] }): Command {
  const plugins = extensions.commands;
  const pluginExamples = plugins.map(command => `  arsi-evaluator ${command.name} <command> ...`).join("\n");
  const activations = new Map<string, PluginActivation>();
  let result: Command | undefined;
  let help = "";
  const program = new Commander("arsi-evaluator")
    .description("Run benchmark experiments, inspect configuration, and rebuild saved reports.")
    .exitOverride().configureOutput({ writeOut: text => { help += text; }, writeErr: text => { help += text; } });
  program.addHelpText("after", `\nExamples:\n  arsi-evaluator run experiment.yaml\n  arsi-evaluator run --help\n  arsi-evaluator report <run-dir>\n${pluginExamples ? pluginExamples + "\n" : ""}\nUse <command> --help for parameter details.`);
  const patch = (cmd: Commander) => cmd.option("--patch <path>", "Load an explicit plugin patch; path is relative to the current directory");
  const network = (cmd: Commander) => cmd.option("--network <yaml>", "Use this network YAML for source endpoints, proxies, and download settings");
  const networkOptions = (opts: Options) => opts.network === undefined ? {} : { networkConfigPath: resolve(opts.network) };
  const model = (cmd: Commander) => cmd
    .option("--model <name>", "Override the solver model name")
    .option("--endpoint <url>", "Override the model API base URL")
    .addOption(new Option("--api-key <key>", "Provide the model API key (prefer --api-key-env to avoid shell history)").conflicts("apiKeyEnv"))
    .option("--api-key-env <name>", "Read the model API key from this environment variable");
  const progress = (cmd: Commander) => cmd.addOption(new Option("--progress <mode>", "Progress display: auto detects a terminal, tty forces live display, plain prints logs").choices(["auto", "tty", "plain"]).default("auto"));
  const common = (opts: Options) => {
    const overrides: CliOverrides = {};
    for (const key of ["model", "endpoint", "apiKey", "apiKeyEnv"] as const) {
      const value = opts[key];
      if (value !== undefined) overrides[key] = value;
    }
    if (activations.size) overrides.plugins = [...activations.values()];
    return { overrides, ...networkOptions(opts), ...(opts.patch === undefined ? {} : { patchPath: resolve(opts.patch) }) };
  };
  for (const name of ["run", "warmup", "doctor", "inspect"] as const) {
    const cmd = network(patch(program.command(name).description(name === "run" ? "Execute an experiment and save results" : name === "warmup" ? "Prepare task images and runtimes without solving tasks" : name === "inspect" ? "Show resolved experiment and network settings without download probes" : "Check experiment configuration, runtime prerequisites, and network connectivity")
      .argument("<yaml>", "Experiment YAML file")));
    if (name === "run") model(cmd);
    if (name === "run" || name === "warmup") {
      progress(cmd).option("--task-ids-file <json>", "Select tasks from a JSON object containing a taskIds array; overrides sampling");
    }
    if (name === "run") cmd.option("--dry-run", "Resolve the dataset and list selected task IDs without solving tasks")
      .addOption(new Option("--resume [run-id]", "Resume a saved run; omit the ID to select automatically").conflicts("dryRun"));
    cmd.addHelpText("after", `\nExample:\n  arsi-evaluator ${name} experiment.yaml`);
    cmd.action((file: string, opts: Options) => {
      result = { kind: name === "run" && opts.dryRun ? "dry-run" : name, file, ...common(opts),
        ...(opts.taskIdsFile === undefined ? {} : { taskIdsFile: opts.taskIdsFile }),
        ...(opts.resume === undefined ? {} : { resume: opts.resume === true ? null : String(opts.resume) }) };
    });
  }
  const benchmark = program.command("benchmark").description("Discover benchmarks, supported versions, and scenarios");
  patch(benchmark.command("list").description("List benchmark versions, defaults, and scenarios as a table"))
    .option("--json", "Output structured benchmark metadata as JSON")
    .action((opts: Options) => { result = { kind: "benchmark-list", json: opts.json ?? false, ...(opts.patch ? { patchPath: resolve(opts.patch) } : {}) }; });
  patch(benchmark.command("info").description("Show benchmark details and resolved settings for each version").argument("<name>", "Registered benchmark name"))
    .action((name: string, opts: Options) => { result = { kind: "benchmark-info", name, ...(opts.patch ? { patchPath: resolve(opts.patch) } : {}) }; });
  patch(program.command("init").description("Create an experiment YAML from benchmark defaults")
    .requiredOption("--benchmark <name>", "Registered benchmark to initialize")
    .requiredOption("--output <yaml>", "Destination YAML file (existing files are not overwritten)"))
    .action((opts: Options) => { result = { kind: "init", name: String(opts.benchmark), output: resolve(String(opts.output)), ...(opts.patch ? { patchPath: resolve(opts.patch) } : {}) }; });
  program.command("compare-recommendation").description("Compare formal SID candidates and scores from saved base and fast runs as JSON")
    .argument("<base-run-dir>").argument("<fast-run-dir>")
    .action((base: string, fast: string) => { result = { kind: "compare-recommendation", base, fast }; });
  program.command("report").description("Rebuild metrics and report.md from saved results without a model API key")
    .argument("<run-dir>", "Directory containing a saved run")
    .action((directory: string) => { result = { kind: "report", directory }; });
  network(progress(program.command("retry").description("Retry network failures within an existing run")))
    .requiredOption("--run <id-or-directory>", "Saved run ID or run directory")
    .option("--task-id <id>", "Restrict retries to this task; may be repeated", (value: string, previous: string[]) => [...previous, value], [])
    .option("--request-id <id>", "Idempotency identifier for this retry request")
    .option("--reason <text>", "Reason recorded with the retry request")
    .action((opts: Options) => { result = { kind: "retry", run: String(opts.run), taskIds: opts.taskId ?? [], ...networkOptions(opts), ...(opts.requestId === undefined ? {} : { requestId: opts.requestId }), ...(opts.reason === undefined ? {} : { reason: opts.reason }) }; });
  patch(program.command("cleanup").description("Manage evaluator resources").command("images").description("Preview evaluator image references; remove them only with --yes")
    .argument("[yaml]", "Experiment YAML defining the image scope")
    .option("--all", "Include all evaluator image references; required when YAML is omitted")
    .option("--yes", "Execute removal; without this flag only preview affected references"))
    .action((file: string | undefined, opts: Options) => {
      if (!file && !opts.all) throw new TypeError("Image cleanup requires YAML or --all");
      if (!file && opts.patch) throw new TypeError("--patch requires YAML");
      result = { kind: "cleanup-images", all: opts.all ?? false, execute: opts.yes ?? false, ...(file ? { file } : {}), ...(opts.patch ? { patchPath: resolve(opts.patch) } : {}) };
    });
  const names = new Set(program.commands.map(command => command.name()));
  names.add("help");
  for (const plugin of plugins) {
    if (!/^[a-z][a-z0-9-]*$/u.test(plugin.name) || names.has(plugin.name)) throw new TypeError(`Duplicate or reserved CLI command: ${plugin.name}`);
    names.add(plugin.name);
    program.command(plugin.name).description(plugin.description);
  }
  for (const { id, command, option: contribution } of extensions.options) {
    const target = program.commands.find(item => item.name() === command);
    if (!target || command !== "run") throw new TypeError(`Unsupported CLI extension target: ${command}`);
    const option = new Option(contribution.flags, contribution.description);
    if (!option.long || option.long === "--help" || option.short === "-h" || target.options.some(existing =>
      (option.long && [existing.long, existing.short].includes(option.long)) ||
      (option.short && [existing.long, existing.short].includes(option.short)) || existing.attributeName() === option.attributeName()))
      throw new TypeError(`Duplicate or reserved CLI option: ${contribution.flags}`);
    target.addOption(option);
    target.on(`option:${option.name()}`, value => contribution.configure(value, {
      enable(config) {
        activations.set(id, { id, config: { ...activations.get(id)?.config, ...config } });
      },
    }));
  }
  const matched = plugins.find(command => command.name === argv[0]);
  if (matched) return { kind: "plugin", plugin: matched, argv: pluginCommandArguments(argv.slice(1)) };
  // Preserve rejection of duplicate scalar options, which Commander otherwise overwrites.
  const configure = (cmd: Commander) => {
    cmd.exitOverride().allowExcessArguments(false).showHelpAfterError();
    for (const option of cmd.options) {
      let seen = false;
      cmd.on(`option:${option.name()}`, () => {
        if (seen && option.long !== "--task-id") throw new TypeError(`Repeated ${option.long} option`);
        seen = true;
      });
    }
    for (const child of cmd.commands) configure(child);
  };
  configure(program);
  if (!argv.length) return { kind: "help", text: program.helpInformation() };
  try { program.parse(argv, { from: "user" }); }
  catch (error) {
    if (error instanceof CommanderError && ["commander.helpDisplayed", "commander.help"].includes(error.code)) return { kind: "help", text: help, ...(error.exitCode === 0 ? {} : { exitCode: 2 }) };
    if (error instanceof CommanderError) throw new CommandUsageError(error.message, help || program.helpInformation());
    throw error;
  }
  if (!result) throw new TypeError("Choose a subcommand; use --help for available commands");
  return result;
}
