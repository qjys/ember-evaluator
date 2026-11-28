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
import { normalizeAllowedHosts } from "../../core/policies/network-policy.js";
import { sessionToolPolicy, toolPolicyProvenance, type SolverToolPolicy } from "../../core/validation/solver-tool-policy.js";
import { consumeClaudeCode } from "../../runtimes/claudecode/protocol.js";
import { CLAUDE_CODE_ENTRY, CLAUDE_CODE_VERSION, claudeCodeRuntimeInstallation } from "../../runtimes/claudecode/runtime.js";
import { loadAttachments, requireInputModalities } from "../../runtimes/multimodal/input.js";
import { record } from "../../runtimes/shared/cli-jsonl.js";

export function parseClaudeCodeConfig(value: unknown): SolverToolPolicy & AgentLimits {
  return parseAgentOptions(value, "claudecode");
}

function messagesEndpoint(endpoint: string | null): string {
  const url = endpoint === null ? null : URL.parse(endpoint);
  if (!url || !["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new TypeError("claudecode requires an HTTP(S) base_url without credentials, query or fragment");
  }
  const base = url.href.replace(/\/+$/u, "");
  if (base.endsWith("/v1/messages")) throw new TypeError("claudecode base_url must omit /v1/messages");
  return base;
}

export class ClaudeCodeSolver implements Solver {
  readonly inputModalities = ["text", "image", "pdf"] as const;
  private readonly endpoint: string;

  constructor(private readonly binding: ServiceBinding, private readonly policy: SolverToolPolicy & Pick<AgentLimits, "maxTurns"> = {}) {
    const { model } = binding;
    if (model.api !== "anthropic-messages") throw new TypeError("claudecode requires api: anthropic-messages on its selected service");
    this.endpoint = messagesEndpoint(model.endpoint);
    if (model.retry !== undefined) throw new TypeError("claudecode does not support services.*.retry");
    if (model.contextWindow !== undefined && (model.contextWindow < 100_000 || model.contextWindow > 1_000_000)) {
      throw new TypeError("claudecode contextWindow must be between 100000 and 1000000 tokens");
    }
  }

  requirements(): RuntimeRequirement[] {
    return [{ name: "node", version: "24.x", platform: "any" }, { name: "shell", version: "any", platform: "any" }];
  }

  runtimeInstallation = claudeCodeRuntimeInstallation;

  async provenance(signal: AbortSignal): Promise<SolverProvenance> {
    signal.throwIfAborted();
    const { maxTurns, ...tools } = this.policy;
    return { ...toolPolicyProvenance(tools, "claudecode-native"), claudeCodeVersion: CLAUDE_CODE_VERSION,
      ...(maxTurns === undefined ? {} : { maxTurns: String(maxTurns) }) };
  }

  async solve(input: PublicTask, session: EnvironmentSession, context: AttemptContext): Promise<SolveResult> {
    const { maxTurns, ...policy } = sessionToolPolicy("claudecode", this.policy, session);
    const { signal } = context;
    signal.throwIfAborted();
    const { model, auth } = this.binding;
    if (!auth.value.trim() || /[\r\n\0]/u.test(auth.value)) {
      throw new EvaluatorError("MODEL_AUTH_FAILED", "claudecode requires a non-empty, single-line API key on its selected service");
    }
    requireInputModalities(input, model.inputModalities ?? ["text"]);
    const runtime = session.runtime;
    if (runtime?.stateRoot === undefined) {
      throw new EvaluatorError("ENV_RUNTIME_INSTALL_FAILED", "claudecode requires an environment-prepared runtime with writable state");
    }
    const mapping = session.modelEndpoint;
    const baseUrl = mapping?.originEndpoint === model.endpoint ? messagesEndpoint(mapping.baseUrl) : this.endpoint;
    const local = runtime.persistent;
    const path = local ? join : posix.join;
    const home = path(runtime.stateRoot, `attempt-${randomUUID()}`);
    const requiredWebTools = [
      ...(policy.webSearch === "enabled" ? ["WebSearch"] : []),
      ...(policy.webFetch === "enabled" ? ["WebFetch"] : []),
    ];
    const none = policy.tools === "none";
    const denied = [
      ...(policy.subagent === "disabled" ? ["Agent", "Task", "Workflow"] : []),
      ...(policy.webSearch === "disabled" ? ["WebSearch"] : []),
      ...(policy.webFetch === "disabled" ? ["WebFetch"] : []),
    ];
    const gitBash = local && process.platform === "win32" ? process.env.CLAUDE_CODE_GIT_BASH_PATH : undefined;
    const media = await loadAttachments(input, session, context);
    try {
      const handle = await session.start({
        executable: local ? process.execPath : "node",
        args: [path(runtime.root, "launch.mjs"), home, path(runtime.root, CLAUDE_CODE_ENTRY),
          "--print", "--verbose", "--output-format", "stream-json", "--no-session-persistence",
          ...(maxTurns === undefined ? [] : ["--max-turns", String(maxTurns)]),
          ...(none ? ["--tools", ""] : []),
          ...(policy.skills === "disabled" ? ["--disable-slash-commands"] : []),
          ...(policy.mcp === "disabled" ? ["--strict-mcp-config"] : []),
          ...(denied.length ? ["--disallowedTools", ...denied] : [])],
        cwd: session.workdir,
        env: gitBash === undefined ? {} : { CLAUDE_CODE_GIT_BASH_PATH: gitBash },
        inheritEnv: false,
        input: Buffer.from(JSON.stringify({ toolPolicy: policy, outputDir: session.agentOutputDir, skillsDirectories: input.skillsDirectories, mcpServers: input.mcpServers,
          fetchNetwork: typeof session.solveNetwork === "object"
            ? { allowedHosts: normalizeAllowedHosts(session.solveNetwork.allowedHosts) } : session.solveNetwork ?? "bridge",
          docker: record(session.metadata)?.kind === "docker",
          apiKey: auth.value, prompt: input.prompt, api: model.api, baseUrl, model: model.name,
          maxTokens: model.maxTokens, contextWindow: model.contextWindow, reasoningEffort: model.reasoningEffort, media }), "utf8"),
      }, signal);
      return await consumeClaudeCode(handle, context, auth.value, requiredWebTools);
    } finally {
      if (local) await rm(home, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }).catch(() => {
        context.warning?.({ code: "CLEANUP_FAILED", message: "Could not remove the temporary Claude Code state directory" });
      });
    }
  }
}
