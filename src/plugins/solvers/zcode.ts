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
import { sessionToolPolicy, toolPolicyProvenance, unsupportedToolPolicy, type SolverToolPolicy } from "../../core/validation/solver-tool-policy.js";
import { loadAttachments, requireInputModalities } from "../../runtimes/multimodal/input.js";
import { consumeZCode } from "../../runtimes/zcode/protocol.js";
import { readZCodeSourceLock, ZCODE_ENTRY, zcodeRuntimeInstallation } from "../../runtimes/zcode/runtime.js";

export function parseZCodeConfig(value: unknown): SolverToolPolicy & AgentLimits {
  const policy = parseAgentOptions(value, "zcode");
  if (policy.webSearch === "enabled" && policy.mcp === "disabled") {
    unsupportedToolPolicy("zcode", "webSearch: enabled cannot be combined with mcp: disabled because the custom model route has no native WebSearch and supplementary search requires MCP.");
  }
  return policy;
}

function apiBase(endpoint: string | null): string {
  const url = endpoint === null ? null : URL.parse(endpoint);
  if (!url || !["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash ||
      /\/(?:chat\/completions|responses|messages(?:\/count_tokens)?)\/*$/u.test(url.pathname)) {
    throw new TypeError("zcode requires an HTTP(S) base_url without credentials, query, fragment or API method path");
  }
  return url.href.replace(/\/+$/u, "");
}

export class ZCodeSolver implements Solver {
  readonly inputModalities = ["text", "image", "pdf"] as const;
  private readonly endpoint: string;

  constructor(private readonly binding: ServiceBinding, private readonly policy: SolverToolPolicy = {}) {
    const { model } = binding;
    if (model.api === null || !["openai-completions", "openai-responses", "anthropic-messages"].includes(model.api)) {
      throw new TypeError("zcode requires api: openai-completions, openai-responses or anthropic-messages");
    }
    if (model.retry !== undefined) {
      throw new TypeError("zcode does not support services.*.retry");
    }
    this.endpoint = apiBase(model.endpoint);
  }

  requirements(): RuntimeRequirement[] {
    return [{ name: "node", version: "24.x", platform: "any" }, { name: "shell", version: "any", platform: "any" }];
  }

  runtimeInstallation = zcodeRuntimeInstallation;

  async provenance(signal: AbortSignal): Promise<SolverProvenance> {
    const { cliVersion, commit } = await readZCodeSourceLock(signal);
    return { ...toolPolicyProvenance(this.policy, "zcode-native"), zcodeVersion: cliVersion, zcodeCommit: commit };
  }

  async solve(input: PublicTask, session: EnvironmentSession, context: AttemptContext): Promise<SolveResult> {
    const { signal } = context;
    signal.throwIfAborted();
    const { model, auth } = this.binding;
    if (!auth.value.trim() || /[\r\n\0]/u.test(auth.value)) {
      throw new EvaluatorError("MODEL_AUTH_FAILED", "zcode requires a non-empty, single-line API key on its selected service");
    }
    const runtime = session.runtime;
    if (runtime?.stateRoot === undefined) {
      throw new EvaluatorError("ENV_RUNTIME_INSTALL_FAILED", "zcode requires an environment-prepared runtime with writable state");
    }
    const mapping = session.modelEndpoint;
    const baseUrl = mapping?.originEndpoint === model.endpoint ? apiBase(mapping.baseUrl) : this.endpoint;
    const local = runtime.persistent;
    const path = local ? join : posix.join;
    const home = path(runtime.stateRoot, `attempt-${randomUUID()}`);
    const token = randomUUID();
    requireInputModalities(input, model.inputModalities ?? ["text"]);
    const media = await loadAttachments(input, session, context);
    try {
      const handle = await session.start({
        executable: local ? process.execPath : "node",
        args: [path(runtime.root, "launch.mjs"), home, path(runtime.root, ZCODE_ENTRY)],
        cwd: session.workdir,
        env: { NODE_USE_ENV_PROXY: "1" },
        inheritEnv: false,
        input: Buffer.from(JSON.stringify({
          outputDir: session.agentOutputDir, skillsDirectories: input.skillsDirectories, mcpServers: input.mcpServers,
          fetchNetwork: typeof session.solveNetwork === "object"
            ? { allowedHosts: normalizeAllowedHosts(session.solveNetwork.allowedHosts) } : session.solveNetwork ?? "bridge",
          apiKey: auth.value, api: model.api, baseUrl, model: model.name, inputModalities: model.inputModalities, maxTokens: model.maxTokens, contextWindow: model.contextWindow, reasoningEffort: model.reasoningEffort,
          prompt: input.prompt, token, media, toolPolicy: sessionToolPolicy("zcode", this.policy, session),
        }), "utf8"),
      }, signal);
      return await consumeZCode(handle, context, [auth.value, token]);
    } finally {
      if (local) await rm(home, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }).catch(() => {
        context.warning?.({ code: "CLEANUP_FAILED", message: "Could not remove the temporary ZCode state directory" });
      });
    }
  }
}
