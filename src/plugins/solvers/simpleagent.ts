import { parseAgentOptions, type AgentLimits } from "./agent-limits.js";
import { loadAttachments } from "../../runtimes/multimodal/input.js";
import type { ErrorCode } from "../../core/errors/registry.js";
import { join, posix } from "node:path";
import { readFile } from "node:fs/promises";

import type { ModelConfig, RuntimeAuth } from "../../core/contracts/config.js";
import type {
  EnvironmentSession,
  RuntimeInstallation,
  RuntimeRequirement,
} from "../../core/contracts/environment.js";
import type { SolveResult } from "../../core/contracts/result.js";
import type { AttemptContext, PreparedSolver, Solver } from "../../core/contracts/solver.js";
import type { PublicTask } from "../../core/contracts/task.js";
import { createPiRuntimeInstallation } from "../../runtimes/pi/package-runtime.js";
import { disposePiBundle, stagePiBundle, type PiBundleOptions, type StagedPiBundle } from "../../runtimes/pi/bundle.js";
import { piFetchOptions, projectRunnerInput } from "../../runtimes/pi/protocol.js";
import { consumePiRunner, PiRunnerError } from "../../runtimes/pi/process.js";
import { parseShellToolPolicy, type ShellToolPolicy } from "../../runtimes/pi/tool-policy.js";
import { expectNonEmptyString, expectRecord, rejectUnknown } from "../../core/validation/input.js";
import { sessionToolPolicy, parseWebToolNames, toolPolicyProvenance, type SolverToolPolicy, type WebToolNames } from "../../core/validation/solver-tool-policy.js";

export class SimpleAgentError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(`${code}: ${message}`, options);
    this.name = "SimpleAgentError";
  }
}

export type SimpleAgentConfig = SolverToolPolicy & AgentLimits & { bundle?: PiBundleOptions & WebToolNames; toolPolicy?: ShellToolPolicy };

/**
 * Parse the simpleagent solver config. `bundle` is optional; without it the
 * solver runs the plain Pi harness. `bundle.settings` must survive a JSON
 * round-trip because it is written verbatim into the staged copy.
 */
export function parseSimpleAgentConfig(value: unknown): SimpleAgentConfig {
  const config = expectRecord(value, "simpleagent");
  const policy = parseAgentOptions(config, "simpleagent", ["bundle", "toolPolicy"]);
  const options = config.toolPolicy === undefined ? policy : {
    ...policy, toolPolicy: parseShellToolPolicy(config.toolPolicy, "simpleagent.toolPolicy"),
  };
  if (config.bundle === undefined) return options;
  const bundle = expectRecord(config.bundle, "simpleagent.bundle");
  rejectUnknown(bundle, ["path", "settings", "webSearchTools", "webFetchTools"], "simpleagent.bundle");
  const parsed: PiBundleOptions & WebToolNames = {
    path: expectNonEmptyString(bundle.path, "simpleagent.bundle.path"),
    ...parseWebToolNames(bundle, "simpleagent.bundle", policy),
  };
  if (bundle.settings !== undefined) {
    const settings = expectRecord(bundle.settings, "simpleagent.bundle.settings");
    try {
      parsed.settings = JSON.parse(JSON.stringify(settings)) as Record<string, unknown>;
    } catch (error) {
      throw new TypeError(`simpleagent.bundle.settings is not JSON-serializable: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { bundle: parsed, ...options };
}

function local(session: EnvironmentSession): boolean {
  return (
    typeof session.metadata === "object" &&
    session.metadata !== null &&
    !Array.isArray(session.metadata) &&
    session.metadata.kind === "local"
  );
}

/**
 * Isolated environments expose the model API at a mapped loopback endpoint;
 * the original configured endpoint stays authoritative in run records.
 */
function mappedModel(session: EnvironmentSession, model: ModelConfig): ModelConfig {
  const mapping = session.modelEndpoint;
  if (!mapping || model.endpoint !== mapping.originEndpoint) return model;
  return { ...model, endpoint: mapping.baseUrl };
}

export class SimpleAgentSolver implements Solver {
  readonly inputModalities = ["text", "image"] as const;
  private staged: Promise<StagedPiBundle> | undefined;

  constructor(
    private readonly model: ModelConfig,
    private readonly auth: RuntimeAuth,
    private readonly bundle?: PiBundleOptions,
    private readonly toolPolicy?: ShellToolPolicy,
    private readonly policy: SolverToolPolicy & WebToolNames = {},
  ) {
    if (Object.keys(policy).length > 0) {
      this.provenance = async signal => {
        signal.throwIfAborted();
        const entry = import.meta.resolve("@earendil-works/pi-coding-agent");
        const { version } = JSON.parse(await readFile(new URL("../package.json", entry), { encoding: "utf8", signal }));
        return { piSdkVersion: expectNonEmptyString(version, "Pi SDK version"), ...toolPolicyProvenance(policy, "pi-sdk") };
      };
    }
  }

  readonly provenance?: NonNullable<Solver["provenance"]>;

  dispose(): Promise<void> { return disposePiBundle(this.staged); }

  requirements(): RuntimeRequirement[] {
    return [
      { name: "node", version: "24.x", platform: "any" },
      { name: "shell", version: "any", platform: "any" },
    ];
  }

  runtimeInstallation(signal: AbortSignal): Promise<RuntimeInstallation> {
    return this.stage(signal).then(staged => createPiRuntimeInstallation(signal, staged));
  }

  /** Stage once per command; the Registry releases the copy after all attempts. */
  private stage(signal: AbortSignal): Promise<StagedPiBundle | undefined> {
    if (this.bundle === undefined) return Promise.resolve(undefined);
    return this.staged ??= stagePiBundle(this.bundle, signal);
  }

  async prepare(session: EnvironmentSession, context: AttemptContext): Promise<PreparedSolver> {
    const runner = this.runner(session, context.signal);
    return {
      solve: (input, solveContext) => this.execute(input, session, runner, solveContext),
    };
  }

  async solve(input: PublicTask, session: EnvironmentSession, context: AttemptContext): Promise<SolveResult> {
    return await this.execute(input, session, this.runner(session, context.signal), context);
  }

  private runner(session: EnvironmentSession, signal: AbortSignal): string {
    signal.throwIfAborted();
    const runtime = session.runtime;
    if (
      !runtime ||
      typeof runtime.root !== "string" ||
      runtime.root === "" ||
      typeof runtime.identity !== "string" ||
      runtime.identity === ""
    ) {
      throw new SimpleAgentError("ENV_RUNTIME_INSTALL_FAILED", "simpleagent requires an environment-prepared runtime");
    }
    return local(session)
      ? join(runtime.root, "dist", "runtimes", "pi", "runner.js")
      : posix.join(runtime.root, "dist", "runtimes", "pi", "runner.js");
  }

  /** Extension entry paths inside the target environment, or undefined without a bundle. */
  private async extensions(session: EnvironmentSession, signal: AbortSignal): Promise<string[] | undefined> {
    const staged = await this.stage(signal);
    if (staged === undefined) return undefined;
    const runtime = session.runtime;
    if (!runtime || typeof runtime.root !== "string" || runtime.root === "") {
      throw new SimpleAgentError("ENV_RUNTIME_INSTALL_FAILED", "simpleagent requires an environment-prepared runtime");
    }
    const joinTarget = local(session) ? join : posix.join;
    return staged.entries.map(entry => joinTarget(runtime.root, "bundle", entry));
  }

  private async execute(
    input: PublicTask,
    session: EnvironmentSession,
    runner: string,
    context: AttemptContext,
  ): Promise<SolveResult> {
    if (this.bundle === undefined && this.policy.subagent === "disabled") {
      context.warning?.({
        code: "CONFIG_INVALID",
        message: "simpleagent (Pi without Bundle): subagent: disabled has no built-in capability to turn off. The policy still applies to workspace extensions.",
      });
    }
    const extensions = await this.extensions(session, context.signal);
    const toolAccess = sessionToolPolicy("simpleagent", this.policy, session);
    const runnerInput = projectRunnerInput({
      ...(input.attachments?.length ? { media: await loadAttachments(input, session, context) } : {}),
      key: context.key,
      input,
      model: mappedModel(session, this.model),
      auth: this.auth,
      workdir: session.workdir,
      outputDir: session.agentOutputDir,
      ...(this.toolPolicy === undefined ? {} : { toolPolicy: this.toolPolicy }),
      toolAccess,
      ...piFetchOptions(toolAccess, session.solveNetwork),
      ...(extensions === undefined ? {} : { extensions }),
    });
    const handle = await session.start(
      {
        executable: local(session) ? process.execPath : "node",
        args: [runner],
        cwd: session.workdir,
        env: {},
        input: Buffer.from(`${JSON.stringify(runnerInput)}\n`, "utf8"),
      },
      context.signal,
    );
    try {
      return await consumePiRunner(handle, this.auth.value, join(context.paths.agent, "stderr.log"), context.signal, context.warning, context.activity);
    } catch (error) {
      if (error instanceof PiRunnerError) throw new SimpleAgentError(error.code, error.message.replace(`${error.code}: `, ""), { cause: error });
      throw error;
    }
  }
}
