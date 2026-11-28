import { pickSolverToolPolicy, PI_WEB_FETCH_TOOL_NAMES } from "../../core/validation/solver-tool-policy.js";
import { searchWeb } from "../../infrastructure/network/web-search.mjs";
import { fetchWebPage } from "../../infrastructure/network/web-fetch.mjs";
import { requireInputModalities } from "../multimodal/input.js";
import { externalizeMedia } from "../multimodal/evidence.js";
import type { ErrorCode } from "../../core/errors/registry.js";
import {
  createAgentSession,
  createBashToolDefinition,
  createLocalBashOperations,
  createPowerShellToolDefinition,
  DefaultResourceLoader,
  defineTool,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type AgentSessionEvent,
  type SessionStats,
  type ResourceLoader,
} from "@earendil-works/pi-coding-agent";
import { InMemoryCredentialStore, type Api, type AssistantMessage } from "@earendil-works/pi-ai";
import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { JsonValue } from "../../core/contracts/task.js";
import type { SolveResult } from "../../core/contracts/result.js";
import { parseRunnerInput, type RunnerInput, type RunnerOutput } from "./protocol.js";
import { TrajectoryWriter } from "../../core/artifacts/trajectory.js";
import { findBash } from "../../infrastructure/shell/bash.js";
import { findPowerShell, shellToolName } from "../../infrastructure/shell/shell.js";
import { powerShellOperations } from "../../infrastructure/shell/powershell.js";
import { DEFAULT_SHELL_TOOL_POLICY, enforceShellTimeout, type ShellToolPolicy } from "./tool-policy.js";
import { loadModelDefaults, outputLimitFor } from "./model-defaults.js";
import { taskMcpExtension } from "./mcp.js";
import { classifyError } from "../../core/errors/classify.js";
import { streamWithProviderOutput } from "../../infrastructure/models/openai-output.js";
import { LIVE_LINES, safeLiveText, toolActivity, toolOutputLines } from "../../core/progress/live-progress.js";
import { installEnvProxy } from "../../infrastructure/network/env-proxy.js";

installEnvProxy();

const SYSTEM_PROMPT =
  "You are an autonomous coding agent. Complete the user's task in the current working directory. Use the available tools when needed, then give a concise final answer.";
const INPUT_LIMIT = 75 * 1024 * 1024;
const [WEB_FETCH] = PI_WEB_FETCH_TOOL_NAMES;

class RunnerFailure extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "RunnerFailure";
  }
}

type TrajectorySink = Pick<TrajectoryWriter, "append" | "flush" | "close">;

export type RunnerOptions = {
  createTrajectoryWriter?: (path: string, key: RunnerInput["key"]) => TrajectorySink;
};

async function persistTrajectory<T>(message: string, operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    throw new RunnerFailure("STORE_WRITE_FAILED", message, { cause: error });
  }
}

function json(value: unknown, seen = new WeakSet<object>()): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : String(value);
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "undefined" || typeof value === "function" || typeof value === "symbol") return null;
  if (value instanceof Error) return { name: value.name, message: value.message, stack: value.stack ?? null };
  if (Array.isArray(value)) return value.map(item => json(item, seen));
  if (typeof value === "object") {
    if (seen.has(value)) return "[circular]";
    seen.add(value);
    const output: Record<string, JsonValue> = {};
    for (const [key, item] of Object.entries(value)) output[key] = json(item, seen);
    seen.delete(value);
    return output;
  }
  return String(value);
}

function redact(value: JsonValue, secret: string): JsonValue {
  if (secret === "") return value;
  if (typeof value === "string") return value.replaceAll(secret, "[redacted]");
  if (Array.isArray(value)) return value.map(item => redact(item, secret));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key.replaceAll(secret, "[redacted]"), redact(item, secret)]),
    );
  }
  return value;
}

async function resourceLoaderFor(input: RunnerInput, settingsManager: SettingsManager, systemPrompt: string): Promise<ResourceLoader> {
  const noSkills = input.toolAccess?.skills === "disabled";
  const skillPaths = new Set(noSkills ? [] : input.input.skillsDirectories);
  if (!noSkills) {
    for (const folder of [".pi", ".agents"]) {
      const path = join(input.workdir, folder, "skills");
      const directory = await stat(path).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
      });
      if (directory?.isDirectory()) skillPaths.add(path);
    }
  }
  const factories = [...(input.toolAccess?.mcp !== "disabled" && input.input.mcpServers?.length ? [taskMcpExtension(input.input.mcpServers, join(input.outputDir, "mcp.log"))] : [])];
  if (input.piConfigDir !== undefined) {
    const settings = await installedPiSettings(input.piConfigDir);
    const extensions = stringPaths(settings.extensions, "installed Pi settings.extensions");
    const instructions = join(input.piConfigDir, "AGENTS.md");
    const instructionText = await readFile(instructions, "utf8");
    const loader = new DefaultResourceLoader({
      cwd: input.workdir,
      agentDir: input.piConfigDir,
      settingsManager,
      additionalExtensionPaths: extensions,
      additionalSkillPaths: noSkills ? [] : [join(input.piConfigDir, "skills"), ...skillPaths],
      extensionFactories: factories,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      systemPrompt,
      agentsFilesOverride: () => ({ agentsFiles: [{ path: instructions, content: instructionText }] }),
    });
    await loader.reload();
    const loaded = loader.getExtensions();
    if (loaded.errors.length > 0) {
      throw new RunnerFailure("ENV_RUNTIME_INSTALL_FAILED",
        `extension load failed: ${loaded.errors.map(error => `${error.path}: ${error.error}`).join("; ")}`);
    }
    if (loaded.extensions.length === 0) throw new RunnerFailure("ENV_RUNTIME_INSTALL_FAILED", "no extension was loaded");
    if (noSkills) loader.getSkills = () => ({ skills: [], diagnostics: [] });
    return loader;
  }
  const extensionPaths = input.extensions ?? [];
  // An empty temporary agent directory keeps the host's personal pi
  // configuration out of the evaluation.
  const agentDir = await mkdtemp(join(tmpdir(), "evaluator-pi-agent-"));
  const loader = new DefaultResourceLoader({
    cwd: input.workdir,
    agentDir,
    settingsManager,
    additionalExtensionPaths: extensionPaths,
    additionalSkillPaths: [...skillPaths],
    extensionFactories: factories,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    systemPrompt,
  });
  await loader.reload();
  const loaded = loader.getExtensions();
  if (loaded.errors.length > 0) {
    throw new RunnerFailure("ENV_RUNTIME_INSTALL_FAILED",
      `extension load failed: ${loaded.errors.map(error => `${error.path}: ${error.error}`).join("; ")}`);
  }
  if (loaded.extensions.length === 0 && extensionPaths.length > 0) throw new RunnerFailure("ENV_RUNTIME_INSTALL_FAILED", "no extension was loaded");
  if (noSkills) loader.getSkills = () => ({ skills: [], diagnostics: [] });
  return loader;
}

async function installedPiSettings(agentDir: string): Promise<Record<string, unknown>> {
  let value: unknown;
  try {
    value = JSON.parse(await readFile(join(agentDir, "settings.json"), "utf8")) as unknown;
  } catch (error) {
    throw new RunnerFailure("CONFIG_INVALID", "installed Pi settings.json is missing or invalid", { cause: error });
  }
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new RunnerFailure("CONFIG_INVALID", "installed Pi settings.json must be an object");
  return value as Record<string, unknown>;
}

function stringPaths(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.some(item => typeof item !== "string" || item === ""))
    throw new RunnerFailure("CONFIG_INVALID", `${label} must be a non-empty string array`);
  return value as string[];
}

async function inputFromStdin(): Promise<RunnerInput> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const part of process.stdin) {
    const chunk = Buffer.from(part as Uint8Array);
    bytes += chunk.byteLength;
    if (bytes > INPUT_LIMIT) throw new RunnerFailure("SOLVER_PROTOCOL_INVALID", "runner input exceeds 75 MiB");
    chunks.push(chunk);
  }
  const source = Buffer.concat(chunks).toString("utf8").trim();
  if (source === "") throw new RunnerFailure("SOLVER_PROTOCOL_INVALID", "runner stdin is empty");
  try {
    return parseRunnerInput(JSON.parse(source));
  } catch (error) {
    throw new RunnerFailure("SOLVER_PROTOCOL_INVALID", error instanceof Error ? error.message : String(error), { cause: error });
  }
}

// Preserve the existing fallback for custom models without catalog metadata.
const DEFAULT_CONTEXT_WINDOW = 128_000 + 16_384;

export async function modelFor(input: RunnerInput, runtime: ModelRuntime) {
  const defaults = await loadModelDefaults();
  const matches = runtime.getModels().filter(model => model.id === input.model.name);
  const registered = input.model.provider === null ? (matches.length === 1 ? matches[0] : undefined) : runtime.getModel(input.model.provider, input.model.name);
  const maxTokens = outputLimitFor(defaults, input.model.name, input.model.provider, input.model.maxTokens, registered?.maxTokens);
  let providerId: string;
  if (input.model.endpoint !== null) {
    if (input.model.api === null)
      throw new RunnerFailure("CONFIG_INVALID", "an explicit endpoint requires an API protocol");
    providerId = "arsi-evaluator-runtime";
    const { api, reasoningEffort } = input.model;
    const compatible = registered?.api === api ? registered : undefined;
    const useProviderBudget = api === "openai-completions" && input.model.maxTokens === undefined;
    // The SDK needs wire capabilities for custom aliases; the session supplies
    // the effort on each call, including independent choices by extensions.
    const customCompat = api === "openai-completions" ? { thinkingFormat: "openai" as const, supportsReasoningEffort: true } :
      api === "anthropic-messages" ? { forceAdaptiveThinking: true } : undefined;
    const compat = reasoningEffort === undefined ? undefined : compatible ? compatible.compat : customCompat;
    const thinkingLevelMap = compatible ? compatible.thinkingLevelMap :
      reasoningEffort === "xhigh" || reasoningEffort === "max" ? { [reasoningEffort]: reasoningEffort } : undefined;
    runtime.registerProvider(providerId, {
      name: "ARSI-Evaluator runtime provider",
      baseUrl: input.model.endpoint,
      api: input.model.api as Api,
      ...(useProviderBudget ? { streamSimple: streamWithProviderOutput } : {}),
      models: [
        {
          id: input.model.name,
          name: input.model.name,
          api: input.model.api as Api,
          reasoning: input.model.reasoningEffort !== undefined,
          ...(compat === undefined ? {} : { compat }),
          ...(reasoningEffort !== undefined && thinkingLevelMap !== undefined ? { thinkingLevelMap } : {}),
          input: (input.model.inputModalities ?? registered?.input ?? ["text"]).filter((kind): kind is "text" | "image" => kind !== "pdf"),
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: input.model.contextWindow ?? registered?.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
          maxTokens,
        },
      ],
    });
  } else {
    if (input.model.provider === null)
      throw new RunnerFailure("CONFIG_INVALID", "a provider is required when endpoint is absent");
    providerId = input.model.provider;
  }
  await runtime.setRuntimeApiKey(providerId, input.auth.value);
  const model = runtime.getModel(providerId, input.model.name);
  if (!model) throw new RunnerFailure("MODEL_REQUEST_INVALID", `model ${providerId}/${input.model.name} is not available`);
  return {
    ...model, maxTokens,
    ...(input.model.inputModalities === undefined ? {} : { input: input.model.inputModalities.filter((kind): kind is "text" | "image" => kind !== "pdf") }),
    ...(input.model.contextWindow === undefined ? {} : { contextWindow: input.model.contextWindow }),
  };
}

function assistantMessages(messages: unknown[]): AssistantMessage[] {
  return messages.filter(
    (message): message is AssistantMessage =>
      typeof message === "object" && message !== null && "role" in message && message.role === "assistant",
  );
}

function sessionUsage(stats: SessionStats): SolveResult["usage"] {
  const { input, output, cacheRead, cacheWrite, total } = stats.tokens;
  return total > 0
    ? { inputTokens: input + cacheRead + cacheWrite, outputTokens: output, totalTokens: total }
    : { inputTokens: null, outputTokens: null, totalTokens: null };
}

function solveResult(messages: unknown[], finalMessage: AssistantMessage | undefined,
  stats: SessionStats): SolveResult {
  const assistants = assistantMessages(messages);
  // The SDK may remove a thinking-only truncated reply from its active context.
  // Keep the observed terminal response so truncation retains its real cause.
  if (finalMessage && assistants.at(-1)?.timestamp !== finalMessage.timestamp) assistants.push(finalMessage);
  const last = assistants.at(-1);
  if (!last) throw new RunnerFailure("SOLVER_PROTOCOL_INVALID", "pi session produced no assistant message");
  if (last.stopReason === "error" || last.stopReason === "aborted") {
    throw new RunnerFailure(
      last.stopReason === "aborted" ? "RUN_CANCELLED" : "INTERNAL_ERROR",
      last.errorMessage ?? `agent stopped with ${last.stopReason}`,
    );
  }
  const finalText = last.content
    .filter(block => block.type === "text")
    .map(block => block.text)
    .join("")
    .trim();
  if (finalText === "" && last.stopReason !== "length")
    throw new RunnerFailure("SOLVER_PROTOCOL_INVALID", "pi session produced no final text");
  return {
    finalText,
    // session.messages contains only the active context after compaction.
    // SDK stats include the complete persisted history and summarization calls.
    usage: sessionUsage(stats),
  };
}

function output(message: RunnerOutput): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

/**
 * Custom shell tool replacing the builtin by name. The operations layer
 * enforces the policy timeout on every command; the underlying execution
 * kills the whole process tree on expiry and reports the timeout to the
 * model as an ordinary tool result so the agent can recover.
 */
function shellToolDefinition(
  shell: ReturnType<typeof shellToolName>,
  workdir: string,
  shellPath: string,
  policy: ShellToolPolicy,
) {
  return shell === "bash"
    ? defineTool(
        createBashToolDefinition(workdir, {
          operations: enforceShellTimeout(createLocalBashOperations({ shellPath }), policy),
        }),
      )
    : defineTool(
        createPowerShellToolDefinition(workdir, {
          operations: enforceShellTimeout(powerShellOperations(shellPath), policy),
        }),
      );
}

export async function run(input: RunnerInput, options: RunnerOptions = {}): Promise<SolveResult> {
  const shell = shellToolName();
  const access = input.toolAccess ?? {};
  const noTools = access.tools === "none";
  const shellPath = noTools ? undefined : shell === "bash" ? await findBash() : await findPowerShell();
  const tools = noTools ? [] : [shell, "read", "write", "edit"];
  const useSearch = !noTools && access.webSearch !== "disabled" && !access.webSearchTools?.length;
  if (useSearch) tools.push("web_search");
  const fetchNames = [...new Set([...PI_WEB_FETCH_TOOL_NAMES, ...(access.webFetchTools ?? [])])];
  const useFetch = !noTools && access.webFetch === "enabled" && input.supplementaryFetch !== undefined;
  if (useFetch) tools.push(WEB_FETCH);
  // The SDK gives customTools priority over extension tools with the same name.
  const searchNames = access.webSearchTools ?? ["web_search"];
  const excluded = useFetch
    ? fetchNames.filter(name => name !== WEB_FETCH && (access.webSearch === "disabled" || !searchNames.includes(name)))
    : [];
  for (const [key, names, builtin] of [
    ["webSearch", searchNames, "web_search"],
    ["webFetch", fetchNames, WEB_FETCH],
  ] as const) {
    if (noTools) {
      // Pi registers declared MCP tools in the mcp__ namespace.
      excluded.push(builtin, ...names.filter(name => !name.startsWith("mcp__") || access.mcp === "disabled" || access[key] === "disabled"));
    } else if (access[key] === "disabled") excluded.push(...names);
  }
  const requiredSearch = access.webSearch === "enabled" && !useSearch ? access.webSearchTools ?? ["web_search"] : [];
  const systemPrompt = noTools ? SYSTEM_PROMPT : `${SYSTEM_PROMPT} The command tool is ${shell}; use ${shell === "powershell" ? "PowerShell" : "Bash"} syntax for commands.`;
  await mkdir(input.outputDir, { recursive: true });
  const trajectory = (options.createTrajectoryWriter ?? ((path, key) => new TrajectoryWriter(path, key)))(
    join(input.outputDir, "trajectory.jsonl"),
    input.key,
  );
  const sessionPath = join(input.outputDir, "session.jsonl");
  await writeFile(sessionPath, "", { encoding: "utf8", flag: "wx", mode: 0o600 });
  const sessionManager = SessionManager.open(sessionPath, input.outputDir, input.workdir);
  // With compaction and extensions disabled, all model/tool content enters the
  // native session through this public SDK method. Redact a copy before the SDK
  // caches or appends it, retaining its native IDs, parent chain and durability.
  // Do not mutate live agent messages (tool arguments still need to execute).
  const appendMessage = sessionManager.appendMessage.bind(sessionManager);
  sessionManager.appendMessage = message =>
    appendMessage(
      redact(JSON.parse(JSON.stringify(message)) as JsonValue, input.auth.value) as unknown as Parameters<
        SessionManager["appendMessage"]
      >[0],
    );
  // Model-call retry budget (default 7 attempts = 1 try + 6 retries). pi-ai classifies
  // retryable provider errors (408/409/429/5xx, network) and applies backoff with
  // Retry-After support; exhausted retries surface as a normal stopReason=error.
  const maxAttempts = input.model.retry?.maxAttempts ?? 7;
  const runtimeSettings = {
      // Long-horizon solves outgrow small context windows; compaction
      // summarizes older history once the context passes the configured
      // context window instead of failing on provider truncation.
      // reserveTokens/keepRecentTokens keep the SDK defaults (16k/20k).
      compaction: { enabled: true },
      // Transient provider failures (stream drops, connection errors, 429/5xx)
      // are retried with backoff inside the agent turn; an exhausted budget still
      // surfaces the original error. Long web/code solves regularly outlive
      // fragile upstream connections, so the default budget is deliberately generous.
      retry: { enabled: maxAttempts > 1, maxRetries: maxAttempts - 1, baseDelayMs: 5_000 },
      defaultTools: tools,
      ...(shell === "bash" && shellPath !== undefined ? { shellPath } : {}),
  };
  let settingsManager: SettingsManager;
  if (input.piConfigDir === undefined) {
    settingsManager = SettingsManager.inMemory(runtimeSettings, { projectTrusted: true });
  } else {
    const installedSettings = await installedPiSettings(input.piConfigDir);
    const protectedResources = {
      extensions: installedSettings.extensions,
      skills: installedSettings.skills,
      ...(installedSettings.packages === undefined ? {} : { packages: installedSettings.packages }),
    };
    await writeFile(
      join(input.piConfigDir, "settings.json"),
      `${JSON.stringify({ ...installedSettings, ...(input.piSettings ?? {}), ...protectedResources }, null, 2)}\n`,
      { encoding: "utf8", mode: 0o600 },
    );
    settingsManager = SettingsManager.create(input.workdir, input.piConfigDir, { projectTrusted: true });
    const defaults = settingsManager.getDefaultTools();
    const bundleTools = defaults?.map(name => name === "bash" ? shell : name);
    settingsManager.applyOverrides({ ...runtimeSettings,
      ...(bundleTools && !noTools ? { defaultTools: [...new Set([...bundleTools, ...(useSearch ? ["web_search"] : []), ...(useFetch ? [WEB_FETCH] : [])])] } : {}) });
  }
  const runtime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsPath: null,
    allowModelNetwork: false,
    refreshOnCreate: false,
  });
  const model = await modelFor(input, runtime);
  requireInputModalities(input.input, model.input);
  if (input.media?.some(item => item.mediaType === "application/pdf")) throw new RunnerFailure("BENCHMARK_UNSUPPORTED", "Pi does not support native PDF input");
  if (input.media?.length && settingsManager.getSettings().images?.blockImages) throw new RunnerFailure("CONFIG_INVALID", "Pi images.blockImages prevents this task from receiving its images");
  if (input.media?.length && !model.input.includes("image")) throw new RunnerFailure("BENCHMARK_UNSUPPORTED", "Pi target model does not support image input");
  const expectedMedia = (input.input.attachments ?? []).flatMap(item => item.kind === "pdf" && item.mode === "pages"
    ? item.pages.map(page => `${item.path}#page=${page}`) : [item.path]);
  if (expectedMedia.length && JSON.stringify(expectedMedia) !== JSON.stringify(input.media?.map(item => item.name))) {
    throw new RunnerFailure("SOLVER_PROTOCOL_INVALID", "Prepared media does not match the task attachment order");
  }
  const resourceLoader = await resourceLoaderFor(input, settingsManager, systemPrompt);
  // `tools` deliberately stays out of createAgentSession: the SDK treats that
  // option as an allow-list, which would filter bundle extension tools out of
  // the registry entirely. The settings' defaultTools carry the same baseline
  // set, and the constructor activates every extension-registered tool on top.
  const { session } = await createAgentSession({
    cwd: input.workdir,
    modelRuntime: runtime,
    model,
    ...(input.model.reasoningEffort === undefined ? {} : { thinkingLevel: input.model.reasoningEffort }),
    ...(noTools ? { noTools: "builtin" } : {}),
    ...(excluded.length ? { excludeTools: excluded } : {}),
    ...(shellPath === undefined ? {} : {
      customTools: [
        shellToolDefinition(shell, input.workdir, shellPath, input.toolPolicy ?? DEFAULT_SHELL_TOOL_POLICY),
        ...(useSearch ? [defineTool({
          name: "web_search", label: "Web search", description: "Search public web sources for a query.",
          parameters: { type: "object" as const, properties: { query: { type: "string" as const } }, required: ["query"], additionalProperties: false },
          async execute(_id, params: { query: string }, signal) {
            const found = await searchWeb(params.query, signal ?? new AbortController().signal);
            return { content: [{ type: "text" as const, text: JSON.stringify(found) }], details: { backend: found.backend } };
          },
        })] : []),
        ...(useFetch ? [defineTool({
          name: WEB_FETCH, label: "Web fetch", description: "Read the body of a public web page by URL.",
          parameters: { type: "object", properties: { url: { type: "string" } }, required: ["url"], additionalProperties: false },
          async execute(_id, params, signal) {
            const page = await fetchWebPage(params.url, input.supplementaryFetch?.allowedHosts, signal ?? new AbortController().signal);
            const backend = "http-fetch";
            return { content: [{ type: "text", text: JSON.stringify({ backend, ...page }) }], details: { backend } };
          },
        })] : []),
      ],
    }),
    resourceLoader,
    sessionManager,
    settingsManager,
  });
  // Headless modes call bindExtensions after creating a session; without it the
  // SDK never emits session_start or resources_discover, so bundle extensions
  // could not observe the session or contribute skills.
  await session.bindExtensions({
    mode: "print",
    onError: error => {
      process.stderr.write(`extension error (${error.extensionPath}): ${String(error.error)}\n`);
    },
  });
  // MCP finishes registration in before_agent_start, after bindExtensions returns.
  let webToolFailure: RunnerFailure | undefined;
  if (requiredSearch.length || access.webFetch === "enabled") {
    const stream = session.agent.streamFunction;
    session.agent.streamFunction = (model, context, options) => {
      const names = new Set(session.getActiveToolNames());
      const missing = requiredSearch.filter(name => !names.has(name)).map(name => `webSearch: enabled requires tool ${name}`);
      if (access.webFetch === "enabled" && !fetchNames.some(name => names.has(name))) {
        missing.push(`webFetch: enabled requires an active tool from ${fetchNames.join(", ")}`);
      }
      if (missing.length) {
        const harness = input.extensions || input.piConfigDir ? "Pi Bundle" : "simpleagent (Pi without Bundle)";
        webToolFailure = new RunnerFailure("CONFIG_INVALID", `${harness}: ${missing.join("; ")}.${access.mcp === "disabled" ? " With mcp: disabled, MCP-provided tools are unavailable." : ""}`);
        throw webToolFailure;
      }
      return stream(model, context, options);
    };
  }
  let writeFailure: unknown;
  let modalityFailure: RunnerFailure | undefined;
  const write = (type: string, data: JsonValue, durable = false) => {
    void trajectory.append(type, externalizeMedia(redact(data, input.auth.value), input.outputDir), durable).catch(error => {
      writeFailure ??= error;
      void session.abort().catch(() => {});
    });
  };
  const usageSnapshot = () => {
    const stats = session.getSessionStats();
    return { ...sessionUsage(stats), cost: stats.tokens.total > 0 ? stats.cost : null };
  };
  let finalMessage: AssistantMessage | undefined;
  let lastActivityEmission = -Infinity;
  const activity = (message: string, lines: string[] = [], frequent = false) => {
    const now = performance.now();
    if (frequent && now - lastActivityEmission < 200) return;
    lastActivityEmission = now;
    output({ schemaVersion: 1, type: "activity", activity: { message: safeLiveText(message, [input.auth.value]),
      lines: lines.slice(-LIVE_LINES).map(line => safeLiveText(line, [input.auth.value])) } });
  };
  const event = (value: AgentSessionEvent) => {
    if (value.type === "tool_execution_end" && Array.isArray(value.result?.content) && value.result.content.some((block: unknown) =>
      typeof block === "object" && block !== null && "type" in block && block.type === "image") &&
        (!model.input.includes("image") || settingsManager.getSettings().images?.blockImages)) {
      modalityFailure = new RunnerFailure("BENCHMARK_UNSUPPORTED", `Tool ${value.toolName} returned an image that the configured model/settings cannot receive`);
      void session.abort().catch(() => {});
    }
    if (value.type === "message_start" && value.message.role === "assistant") activity("Requesting model response");
    else if (value.type === "message_update") activity("Receiving model response", [], true);
    else if (value.type === "tool_execution_start") activity(`Running tool ${value.toolName}`, [toolActivity(value.toolName, value.args)]);
    else if (value.type === "tool_execution_update") activity(`Running tool ${value.toolName}`, toolOutputLines(value.partialResult), true);
    else if (value.type === "tool_execution_end") activity(`Tool ${value.toolName} ${value.isError ? "returned an error" : "completed"}`, toolOutputLines(value.result));
    else if (value.type === "auto_retry_start") activity(`Retrying model request ${value.attempt}/${value.maxAttempts}; waiting ${value.delayMs}ms`);
    else if (value.type === "auto_retry_end") activity(value.success ? "Model request retry completed" : "Model request retry failed");
    else if (value.type === "compaction_start") activity("Compacting context");
    else if (value.type === "compaction_end") activity("Context compaction finished");
    if (value.type === "message_start") write("message_start", { role: value.message.role });
    else if (value.type === "message_end") {
      if (value.message.role === "assistant") finalMessage = value.message;
      write("message", json(value.message), true);
      if (value.message.role === "assistant" && value.message.stopReason === "length") {
        const maxTokens = input.model.endpoint !== null && input.model.api === "openai-completions" && input.model.maxTokens === undefined
          ? undefined : model.maxTokens;
        const warning = { code: "SOLVER_OUTPUT_LIMIT" as const,
          message: `Model output was truncated (stopReason=length; model.maxTokens=${maxTokens ?? "provider-default"}; outputTokens=${value.message.usage.output}; reasoningTokens=${value.message.usage.reasoning ?? "unknown"}); continuing evaluation with the actual output.` };
        output({ schemaVersion: 1, type: "warning", ...warning });
        write("warning", warning, true);
      }
    }
    else if (value.type === "tool_execution_start")
      write("tool_start", json({ id: value.toolCallId, name: value.toolName, args: value.args }));
    else if (value.type === "tool_execution_end")
      write(
        "tool_result",
        json({ id: value.toolCallId, name: value.toolName, result: value.result, isError: value.isError }),
        true,
      );
    else if (value.type === "agent_end") write("agent_end", { willRetry: value.willRetry });
    // Non-message usage (including compaction) must survive a later timeout.
    else if (value.type === "compaction_end" && value.result !== undefined)
      write("usage", json(usageSnapshot()), true);
    else if (value.type === "entry_appended" && value.entry.type !== "message" && "usage" in value.entry)
      write("usage", json(usageSnapshot()), true);
  };
  const unsubscribe = session.subscribe(event);
  const abort = () => {
    void session.abort().catch(() => {});
  };
  for (const signal of ["SIGINT", "SIGTERM", "SIGBREAK"] as NodeJS.Signals[]) process.on(signal, abort);
  let primaryFailure = false;
  try {
    await persistTrajectory("failed to initialize trajectory", () =>
      trajectory.append(
        "start",
        redact(json({ input: input.input, systemPrompt, model: input.model, tools,
          capabilities: { modelInput: model.input, images: settingsManager.getSettings().images ?? {} } }), input.auth.value),
        true,
      ),
    );
    await session.prompt(input.input.prompt, { expandPromptTemplates: false, source: "rpc",
      ...(input.media?.length ? { images: input.media.map(item => ({ type: "image" as const, data: item.data, mimeType: item.mediaType })) } : {}) });
    if (webToolFailure) throw webToolFailure;
    if (modalityFailure) throw modalityFailure;
    await persistTrajectory("failed to flush trajectory", () => trajectory.flush());
    if (writeFailure !== undefined)
      throw new RunnerFailure("STORE_WRITE_FAILED", "failed to write trajectory", { cause: writeFailure });
    const result = solveResult(session.messages, finalMessage, session.getSessionStats());
    if (input.auth.value) result.finalText = result.finalText.replaceAll(input.auth.value, "[redacted]");
    await persistTrajectory("failed to write trajectory usage", () =>
      trajectory.append("usage", json(usageSnapshot()), true),
    );
    await persistTrajectory("failed to complete trajectory", () =>
      trajectory.append(
        "end",
        redact(json({ status: "completed", finalText: result.finalText }), input.auth.value),
        true,
      ),
    );
    return result;
  } catch (error) {
    primaryFailure = true;
    const failure = webToolFailure ?? modalityFailure ?? (
      writeFailure === undefined
        ? error
        : new RunnerFailure("STORE_WRITE_FAILED", "failed to write trajectory", { cause: writeFailure }));
    try {
      await trajectory.append("usage", json(usageSnapshot()), true);
      await trajectory.append("error", redact(json(failure), input.auth.value), true);
    } catch {}
    throw failure;
  } finally {
    for (const signal of ["SIGINT", "SIGTERM", "SIGBREAK"] as NodeJS.Signals[]) process.off(signal, abort);
    unsubscribe();
    await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
    session.dispose();
    try {
      await trajectory.close();
      // Compaction reads the native session during execution; compact evidence only
      // after disposal, so the model always receives the original image bytes.
      const lines = (await readFile(sessionPath, "utf8")).split("\n").filter(Boolean);
      await writeFile(sessionPath, lines.map(line => JSON.stringify(externalizeMedia(JSON.parse(line) as JsonValue, input.outputDir))).join("\n") + "\n");
    } catch (error) {
      if (!primaryFailure)
        throw new RunnerFailure("STORE_WRITE_FAILED", "failed to close trajectory", { cause: error });
    }
  }
}

export async function startPiRunner(): Promise<void> {
  let auth = "";
  try {
    const input = await inputFromStdin();
    // A runner process owns one attempt. Native Pi also propagates this policy to child processes.
    process.env.PI_BUNDLE_RUN_POLICY = JSON.stringify(pickSolverToolPolicy(input.toolAccess ?? {}));
    auth = input.auth.value;
    const result = await run(input);
    output({ schemaVersion: 1, type: "result", result });
  } catch (error) {
    const failure =
      error instanceof RunnerFailure
        ? error
        : new RunnerFailure("INTERNAL_ERROR", error instanceof Error ? error.message : String(error), { cause: error });
    const safe = auth === "" ? failure.message : failure.message.replaceAll(auth, "[redacted]");
    const diagnostic = classifyError(failure, { phase: "solve", component: "model", secrets: [auth] });
    process.stderr.write(`${diagnostic.code}: ${safe}\n`);
    output({ schemaVersion: 1, type: "error", code: diagnostic.code, message: safe, details: diagnostic.details });
    process.exitCode = 1;
  }
}

if (import.meta.main) await startPiRunner();
