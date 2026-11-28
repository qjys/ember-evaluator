import { parseAgentOptions, type AgentLimits } from "./agent-limits.js";
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { join, posix } from "node:path";
import type { EnvironmentSession, RuntimeRequirement } from "../../core/contracts/environment.js";
import type { ServiceBinding } from "../../core/contracts/plugin.js";
import type { SolveResult } from "../../core/contracts/result.js";
import type { AttemptContext, Solver, SolverProvenance } from "../../core/contracts/solver.js";
import type { PublicTask } from "../../core/contracts/task.js";
import { EvaluatorError } from "../../core/errors/evaluator-error.js";
import { expectRecord } from "../../core/validation/input.js";
import { normalizeAllowedHosts } from "../../core/policies/network-policy.js";
import { sessionToolPolicy, toolPolicyProvenance, unsupportedToolPolicy, type SolverToolPolicy } from "../../core/validation/solver-tool-policy.js";
import { consumeCodex } from "../../runtimes/codex/protocol.js";
import { CODEX_ENTRY, CODEX_VERSION, codexRuntimeInstallation } from "../../runtimes/codex/runtime.js";
import { loadAttachments, requireInputModalities } from "../../runtimes/multimodal/input.js";

type CodexConfig = SolverToolPolicy & AgentLimits & { shellTool?: "disabled" };

export function parseCodexConfig(value: unknown): CodexConfig {
  const { shellTool, ...config } = expectRecord(value, "codex config");
  const policy = parseAgentOptions(config, "codex");
  if (shellTool !== undefined && shellTool !== "default" && shellTool !== "disabled") {
    throw new TypeError("codex config.shellTool must be default or disabled");
  }
  if (policy.mcp === "disabled" && policy.webFetch === "enabled" && policy.webSearch !== "enabled") {
    unsupportedToolPolicy("codex", "webFetch: enabled with mcp: disabled requires webSearch: enabled for the native combined tool. Independent fetching requires the evaluator MCP.");
  }
  if (policy.mcp === "disabled" && policy.webFetch === "disabled" && policy.webSearch === "enabled") {
    unsupportedToolPolicy("codex", "webSearch: enabled, webFetch: disabled and mcp: disabled cannot be combined because disabling fetch removes the native combined search/open tool and search-only mode requires the evaluator MCP.");
  }
  return { ...policy, ...(shellTool === "disabled" ? { shellTool: "disabled" } : {}) };
}

function responsesEndpoint(endpoint: string | null): string {
  const url = endpoint === null ? null : URL.parse(endpoint);
  if (!url || !["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new TypeError("codex requires an HTTP(S) base_url without credentials, query or fragment");
  }
  return url.href.replace(/\/+$/u, "");
}

export class CodexSolver implements Solver {
  readonly inputModalities = ["text", "image"] as const;
  private readonly endpoint: string;

  constructor(private readonly binding: ServiceBinding, private readonly policy: CodexConfig = {}) {
    if (binding.model.api !== "openai-responses") {
      throw new TypeError("codex requires api: openai-responses on its selected service");
    }
    this.endpoint = responsesEndpoint(binding.model.endpoint);
    if (binding.model.maxTokens !== undefined || binding.model.retry !== undefined) {
      throw new TypeError("codex does not support services.*.maxTokens or services.*.retry");
    }
  }

  requirements(): RuntimeRequirement[] {
    return [{ name: "node", version: "24.x", platform: "any" }, { name: "shell", version: "any", platform: "any" }];
  }

  runtimeInstallation = codexRuntimeInstallation;

  async provenance(signal: AbortSignal): Promise<SolverProvenance> {
    signal.throwIfAborted();
    return { ...toolPolicyProvenance(this.policy, "codex-native"),
      ...(this.policy.shellTool === undefined ? {} : { shellTool: this.policy.shellTool }), codexVersion: CODEX_VERSION };
  }

  async solve(input: PublicTask, session: EnvironmentSession, context: AttemptContext): Promise<SolveResult> {
    const policy = sessionToolPolicy("codex", this.policy, session);
    const { signal } = context;
    signal.throwIfAborted();
    const { model, auth } = this.binding;
    if (!auth.value.trim() || /[\r\n\0]/u.test(auth.value)) {
      throw new EvaluatorError("MODEL_AUTH_FAILED", "codex requires a non-empty, single-line API key on its selected service");
    }
    if (input.attachments?.some(attachment => attachment.kind === "pdf" && attachment.mode === "native")) {
      throw new EvaluatorError("BENCHMARK_UNSUPPORTED", "codex requires PDF attachments in pages mode");
    }
    requireInputModalities(input, model.inputModalities ?? ["text"]);
    const runtime = session.runtime;
    if (runtime?.stateRoot === undefined) {
      throw new EvaluatorError("ENV_RUNTIME_INSTALL_FAILED", "codex requires an environment-prepared runtime with writable state");
    }
    const mapping = session.modelEndpoint;
    const endpoint = mapping?.originEndpoint === model.endpoint ? responsesEndpoint(mapping.baseUrl) : this.endpoint;
    const local = runtime.persistent;
    const path = local ? join : posix.join;
    const home = path(runtime.stateRoot, `attempt-${randomUUID()}`);
    const settings = [
      'approval_policy="never"',
      ...(policy.tools === "none" || policy.subagent === "disabled" ? ["features.multi_agent=false", "features.multi_agent_v2=false"] : []),
      "allow_login_shell=false",
      ...(policy.tools === "none" || policy.webSearch === "disabled" || policy.webFetch === "disabled" ? ['web_search="disabled"'] : policy.webSearch === "enabled" ? ['web_search="live"'] : []),
      "analytics.enabled=false",

      `projects={ ${JSON.stringify(session.workdir)}={ trust_level="${policy.mcp === "disabled" ? "untrusted" : "trusted"}" } }`,
      'shell_environment_policy.inherit="core"',
      "shell_environment_policy.ignore_default_excludes=false",
      'shell_environment_policy.filters.EVALUATOR_CODEX_API_KEY="exclude"',
      'model_provider="arsi-evaluator"',
      'model_providers.arsi-evaluator.name="ARSI-Evaluator"',
      `model_providers.arsi-evaluator.base_url=${JSON.stringify(endpoint)}`,
      'model_providers.arsi-evaluator.env_key="EVALUATOR_CODEX_API_KEY"',
      'model_providers.arsi-evaluator.wire_api="responses"',
      ...(model.reasoningEffort === undefined ? [] : [`model_reasoning_effort=${JSON.stringify(model.reasoningEffort)}`]),
      ...(model.contextWindow === undefined ? [] : [`model_context_window=${model.contextWindow}`, `model_auto_compact_token_limit=${model.contextWindow}`]),
    ];
    const media = await loadAttachments(input, session, context);
    try {
      const handle = await session.start({
        executable: local ? process.execPath : "node",
        args: [path(runtime.root, "launch.mjs"), home, path(runtime.root, CODEX_ENTRY),
          "exec", "--json", "--ephemeral", ...(policy.mcp === "disabled" ? ["--ignore-user-config"] : []), "--skip-git-repo-check",
          "--color", "never", "--sandbox", "danger-full-access", "--model", model.name,
          ...(policy.tools === "none" || policy.shellTool === "disabled" ? ["--disable", "shell_tool"] : []),
          ...settings.flatMap(setting => ["-c", setting]), "-"],
        cwd: session.workdir,
        env: {},
        inheritEnv: false,
        input: Buffer.from(JSON.stringify({ toolPolicy: policy, fetchNetwork: typeof session.solveNetwork === "object"
          ? { allowedHosts: normalizeAllowedHosts(session.solveNetwork.allowedHosts) } : session.solveNetwork ?? "bridge",
          outputDir: session.agentOutputDir, skillsDirectories: input.skillsDirectories, mcpServers: input.mcpServers,
          apiKey: auth.value, prompt: input.prompt, media, api: model.api, baseUrl: endpoint, model: model.name }), "utf8"),
      }, signal);
      return await consumeCodex(handle, context, auth.value);
    } finally {
      if (local) await rm(home, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }).catch(() => {
        context.warning?.({ code: "CLEANUP_FAILED", message: "Could not remove the temporary Codex state directory" });
      });
    }
  }
}
