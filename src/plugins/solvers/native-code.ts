import { parseAgentOptions, type AgentLimits } from "./agent-limits.js";
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { join, posix } from "node:path";
import type { EnvironmentSession, RuntimeRequirement } from "../../core/contracts/environment.js";
import type { ServiceBinding } from "../../core/contracts/plugin.js";
import type { SolveResult } from "../../core/contracts/result.js";
import type { AttemptContext, Solver, SolverProvenance } from "../../core/contracts/solver.js";
import type { InputModality, PublicTask } from "../../core/contracts/task.js";
import { EvaluatorError } from "../../core/errors/evaluator-error.js";
import { sessionToolPolicy, toolPolicyProvenance, type SolverToolPolicy } from "../../core/validation/solver-tool-policy.js";
import { loadAttachments, requireInputModalities } from "../../runtimes/multimodal/input.js";
import { consumeNativeCode } from "../../runtimes/shared/native-code-protocol.js";
import { nativeCodeInstallation, nativeCodeVersions, type NativeCodeName } from "../../runtimes/shared/native-code-runtime.js";
import { lockedCliPatch } from "../../runtimes/shared/locked-cli-patch.js";

export type NativeCodeConfig = SolverToolPolicy & AgentLimits;

export function parseNativeCodeConfig(name: NativeCodeName, value: unknown): NativeCodeConfig {
  return parseAgentOptions(value, name);
}

function apiBase(endpoint: string | null): string {
  const url = endpoint === null ? null : URL.parse(endpoint);
  if (!url || !["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash ||
      /\/(?:chat\/completions|responses|messages)\/*$/u.test(url.pathname)) {
    throw new TypeError("Code CLI solvers require an HTTP(S) base_url without credentials, query, fragment or API method path");
  }
  return url.href.replace(/\/+$/u, "");
}

/** Four independent native CLIs share only Evaluator's process/attachment plumbing. */
export class NativeCodeSolver implements Solver {
  get inputModalities(): readonly InputModality[] {
    const pdf = this.name === "opencode" || (this.name === "qwencode" && this.binding.model.api !== "openai-responses");
    return pdf ? ["text", "image", "pdf"] : ["text", "image"];
  }
  private readonly endpoint: string;

  constructor(private readonly name: NativeCodeName, private readonly binding: ServiceBinding, private readonly config: NativeCodeConfig = {}) {
    const { model } = binding;
    if (!["openai-completions", "openai-responses", "anthropic-messages"].includes(model.api ?? "")) {
      throw new TypeError(`${name} requires api: openai-completions, openai-responses or anthropic-messages`);
    }
    if (model.retry !== undefined) throw new TypeError(`${name} does not support services.*.retry`);
    if (name === "qwencode" && model.reasoningEffort === "minimal") {
      throw new TypeError("Qwen Code does not offer reasoningEffort: minimal. Use low, medium, high, xhigh, or max.");
    }
    this.endpoint = apiBase(model.endpoint);
  }

  requirements(): RuntimeRequirement[] {
    return [{ name: "node", version: "24.x", platform: "any" }, { name: "shell", version: "any", platform: "any" }];
  }

  runtimeInstallation = (signal: AbortSignal) => nativeCodeInstallation(this.name, signal);

  async provenance(signal: AbortSignal): Promise<SolverProvenance> {
    signal.throwIfAborted();
    const { maxTurns, ...policy } = this.config;
    const patch = this.name === "kimicode" || this.name === "minimaxcode" ? await lockedCliPatch(this.name) : undefined;
    return { ...toolPolicyProvenance(policy, `${this.name}-native-model-relay`), harnessVersion: nativeCodeVersions[this.name],
      ...(patch ? { capabilityPatchSha256: patch.digest } : {}),
      harnessEntry: this.name === "minimaxcode" ? "exec" : "acp",
      ...(maxTurns === undefined ? {} : { maxTurns: String(maxTurns) }) };
  }

  async solve(input: PublicTask, session: EnvironmentSession, context: AttemptContext): Promise<SolveResult> {
    context.signal.throwIfAborted();
    const { model, auth } = this.binding;
    if (!auth.value.trim() || /[\r\n\0]/u.test(auth.value)) throw new EvaluatorError("MODEL_AUTH_FAILED", `${this.name} requires a non-empty, single-line API key`);
    if (!this.inputModalities.includes("pdf") && input.attachments?.some(attachment => attachment.kind === "pdf" && attachment.mode === "native")) {
      throw new EvaluatorError("BENCHMARK_UNSUPPORTED", `${this.name} with ${model.api} requires PDF attachments in pages mode`);
    }
    requireInputModalities(input, model.inputModalities ?? ["text"]);
    const runtime = session.runtime;
    if (runtime?.stateRoot === undefined) throw new EvaluatorError("ENV_RUNTIME_INSTALL_FAILED", `${this.name} requires an environment-prepared runtime with writable state`);
    const path = runtime.persistent ? join : posix.join;
    const home = path(runtime.stateRoot, `attempt-${randomUUID()}`);
    const token = randomUUID();
    const media = await loadAttachments(input, session, context);
    const mapping = session.modelEndpoint;
    const baseUrl = mapping?.originEndpoint === model.endpoint ? apiBase(mapping.baseUrl) : this.endpoint;
    try {
      const handle = await session.start({
        executable: runtime.persistent ? process.execPath : "node",
        args: [path(runtime.root, "launch.mjs"), home], cwd: session.workdir, inheritEnv: false,
        env: { NODE_USE_ENV_PROXY: "1" },
        input: Buffer.from(JSON.stringify({ apiKey: auth.value, api: model.api, baseUrl, model: model.name,
          maxTokens: model.maxTokens, contextWindow: model.contextWindow, reasoningEffort: model.reasoningEffort,
          toolPolicy: sessionToolPolicy(this.name, this.config, session), outputDir: session.agentOutputDir, skillsDirectories: input.skillsDirectories, mcpServers: input.mcpServers, maxTurns: this.config.maxTurns, prompt: input.prompt,
          supportsImages: model.inputModalities?.includes("image") ?? false,
          supportsPdf: this.inputModalities.includes("pdf") && (model.inputModalities?.includes("pdf") ?? false), token, media }), "utf8"),
      }, context.signal);
      return await consumeNativeCode(this.name, handle, context, [auth.value, token]);
    } finally {
      if (runtime.persistent) await rm(home, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }).catch(() => {
        context.warning?.({ code: "CLEANUP_FAILED", message: `Could not remove temporary ${this.name} state` });
      });
    }
  }
}
