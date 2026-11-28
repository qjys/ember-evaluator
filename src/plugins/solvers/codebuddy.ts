import { parseAgentOptions, type AgentLimits } from "./agent-limits.js";
import { lockedCliPatch } from "../../runtimes/shared/locked-cli-patch.js";
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
import { consumeCodeBuddy } from "../../runtimes/codebuddy/protocol.js";
import { CODEBUDDY_ENTRY, CODEBUDDY_VERSION, codeBuddyRuntimeInstallation } from "../../runtimes/codebuddy/runtime.js";
import { loadAttachments, requireInputModalities } from "../../runtimes/multimodal/input.js";

export type CodeBuddyConfig = SolverToolPolicy & AgentLimits;

export function parseCodeBuddyConfig(value: unknown): CodeBuddyConfig {
  return parseAgentOptions(value, "codebuddy");
}

function apiBase(endpoint: string | null): string {
  const url = endpoint === null ? null : URL.parse(endpoint);
  if (!url || !["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash ||
      /\/(?:chat\/completions|responses)\/*$/u.test(url.pathname)) {
    throw new TypeError("codebuddy requires an HTTP(S) base_url without credentials, query, fragment or API method path");
  }
  return url.href.replace(/\/+$/u, "");
}

export class CodeBuddySolver implements Solver {
  readonly inputModalities = ["text", "image", "pdf"] as const;
  private readonly endpoint: string;

  constructor(private readonly binding: ServiceBinding, private readonly config: CodeBuddyConfig = {}) {
    const { model } = binding;
    if (model.api !== "openai-completions" && model.api !== "openai-responses") {
      throw new TypeError("codebuddy requires api: openai-completions or openai-responses on its selected service");
    }
    if (model.retry !== undefined) {
      throw new TypeError("codebuddy does not support services.*.retry");
    }
    this.endpoint = apiBase(model.endpoint);
  }

  requirements(): RuntimeRequirement[] {
    return [{ name: "node", version: "24.x", platform: "any" }, { name: "shell", version: "any", platform: "any" }];
  }

  runtimeInstallation = codeBuddyRuntimeInstallation;

  async provenance(signal: AbortSignal): Promise<SolverProvenance> {
    signal.throwIfAborted();
    const { maxTurns, ...policy } = this.config;
    return { ...toolPolicyProvenance(policy, "codebuddy-native"), codebuddyVersion: CODEBUDDY_VERSION,
      capabilityPatchSha256: (await lockedCliPatch("codebuddy")).digest,
      ...(maxTurns === undefined ? {} : { maxTurns: String(maxTurns) }) };
  }

  async solve(input: PublicTask, session: EnvironmentSession, context: AttemptContext): Promise<SolveResult> {
    const { signal } = context;
    signal.throwIfAborted();
    const { model, auth } = this.binding;
    const { maxTurns, ...toolPolicy } = sessionToolPolicy("codebuddy", this.config, session);
    if (!auth.value.trim() || /[\r\n\0]/u.test(auth.value)) {
      throw new EvaluatorError("MODEL_AUTH_FAILED", "codebuddy requires a non-empty, single-line API key on its selected service");
    }
    requireInputModalities(input, model.inputModalities ?? ["text"]);
    const runtime = session.runtime;
    if (runtime?.stateRoot === undefined) {
      throw new EvaluatorError("ENV_RUNTIME_INSTALL_FAILED", "codebuddy requires an environment-prepared runtime with writable state");
    }
    const mapping = session.modelEndpoint;
    const baseUrl = mapping?.originEndpoint === model.endpoint ? apiBase(mapping.baseUrl) : this.endpoint;
    const local = runtime.persistent;
    const path = local ? join : posix.join;
    const home = path(runtime.stateRoot, `attempt-${randomUUID()}`);
    const token = randomUUID();
    const media = await loadAttachments(input, session, context);
    try {
      const handle = await session.start({
        executable: local ? process.execPath : "node",
        args: [path(runtime.root, "launch.mjs"), home, path(runtime.root, CODEBUDDY_ENTRY)],
        cwd: session.workdir,
        env: { NODE_USE_ENV_PROXY: "1" },
        inheritEnv: false,
        input: Buffer.from(JSON.stringify({
          container: !local, outputDir: session.agentOutputDir, skillsDirectories: input.skillsDirectories, mcpServers: input.mcpServers,
          fetchNetwork: typeof session.solveNetwork === "object"
            ? { allowedHosts: normalizeAllowedHosts(session.solveNetwork.allowedHosts) } : session.solveNetwork ?? "bridge",
          apiKey: auth.value, api: model.api, baseUrl, model: model.name,
          maxTokens: model.maxTokens, contextWindow: model.contextWindow, reasoningEffort: model.reasoningEffort, maxTurns, toolPolicy,
          supportsImages: model.inputModalities?.includes("image") ?? false, prompt: input.prompt, token, media,
        }), "utf8"),
      }, signal);
      return await consumeCodeBuddy(handle, context, [auth.value, token]);
    } finally {
      if (local) await rm(home, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }).catch(() => {
        context.warning?.({ code: "CLEANUP_FAILED", message: "Could not remove the temporary CodeBuddy state directory" });
      });
    }
  }
}
