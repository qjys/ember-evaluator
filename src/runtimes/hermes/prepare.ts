import { expectRecord } from "../../core/validation/input.js";
import { resolveModelInput } from "../multimodal/model.js";
import { loadAttachments, requireInputModalities } from "../multimodal/input.js";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { delimiter, dirname, join, posix } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import type { ModelConfig } from "../../core/contracts/config.js";

import type { EnvironmentSession } from "../../core/contracts/environment.js";
import type { AttemptContext, PreparedSolver } from "../../core/contracts/solver.js";

import { canonicalJson } from "../../core/results/run-manifest.js";
import { AgentBundleError, cliJson, cliOutput, parseInstalledBundle, parseVerifiedBundle, type VerifiedBundle } from "../agentbundle/cli.js";

import { HERMES_VERSION, hermesRuntimeInstallation } from "./runtime.js";
import { HERMES_AUTH_ENV, hermesModelSettings } from "./model.js";
import { consumeHermes } from "./protocol.js";

import { acquireRuntimeLock } from "../../infrastructure/runtime-installation/lock.js";
import { runtimeProcessEnvironment } from "../../infrastructure/process/local.js";

import { type BundlePreparation, sameCandidate, hasCode, customHomeDirectory, writeHomeConfig, claimPersistentState, preparedAttempt } from "../agentbundle/preparation-state.js";
/** Merge the solver's model_aliases into the install-written Hermes config.yaml
 *  without clobbering model.default/model.provider owned by the bundle install. */
function mergeHermesModelConfig(existing: string, model: ModelConfig, root: string, node: string, search: boolean): string {
  let doc: Record<string, unknown> = {};
  if (existing.trim() !== "") {
    const parsed = parseYaml(existing);
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) doc = parsed as Record<string, unknown>;
  }
  doc.terminal = { ...expectRecord(doc.terminal ?? {}, "Hermes terminal"), backend: "local" };
  doc.approvals = { ...expectRecord(doc.approvals ?? {}, "Hermes approvals"), mode: "off" };
  if (search) {
    const servers = expectRecord(doc.mcp_servers ?? {}, "Hermes mcp_servers");
    let name = "evaluator-search";
    while (Object.hasOwn(servers, name) && (servers[name] as { args?: unknown[] } | null)?.args?.[0] !== root) name += "-fallback";
    doc.mcp_servers = { ...servers, [name]: { command: node,
      args: [root, "--serve", JSON.stringify({ fetch: true })] } };
  }
  const additions = parseYaml(hermesModelSettings(model)) as Record<string, unknown>;
  if (model.inputModalities?.includes("image")) {
    const agent = doc.agent && typeof doc.agent === "object" && !Array.isArray(doc.agent) ? doc.agent as Record<string, unknown> : {};
    if (agent.image_input_mode === "text") throw new AgentBundleError("CONFIG_INVALID", "Hermes agent.image_input_mode=text conflicts with image input");
    const currentModel = doc.model && typeof doc.model === "object" && !Array.isArray(doc.model) ? doc.model as Record<string, unknown> : {};
    return stringifyYaml({ ...doc, ...additions, model: { ...currentModel, supports_vision: true }, agent: { ...agent, image_input_mode: "native" } });
  }
  return stringifyYaml({ ...doc, ...additions });
}

export async function prepareHermes(
  preparation: BundlePreparation,
  session: EnvironmentSession,
  context: AttemptContext,
  candidate: VerifiedBundle,
): Promise<PreparedSolver> {
  preparation = { ...preparation, model: await resolveModelInput(preparation.model) };
  const runtime = session.runtime!;
  // Hermes is provisioned into the runtime root at build time (see
  // hermesRuntimeInstallation), so it runs under any environment, not just
  // the managed local runtime.
  const stateRoot = runtime.stateRoot;
  if (stateRoot === undefined)
    throw new AgentBundleError(
      "ENV_RUNTIME_INSTALL_FAILED",
      "agentbundle requires an environment-prepared state directory",
    );
  const local = runtime.persistent;
  const path = local ? join : posix.join;
  const node = local ? process.execPath : "node";
  const version = preparation.harnessVersion ?? HERMES_VERSION;
  const identity = createHash("sha256")
    .update(
      canonicalJson({ kind: "hermes", candidate, runtime: runtime.identity, settings: hermesModelSettings(preparation.model), inputModalities: preparation.model.inputModalities ?? ["text"] }),
    )
    .digest("hex");
  const configuredHome = local ? preparation.options.hermeshome : undefined;
  const customHome = configuredHome !== undefined;
  let state =
    configuredHome !== undefined ? await customHomeDirectory(configuredHome) : path(stateRoot, identity.slice(0, 24));
  const cli = path(runtime.root, "agentbundle", "run.mjs");
  // R10: the pm-runtime (ruamel-bearing deps) is provisioned under the runtime-root HOME (see
  // hermesRuntimeInstallation provisionEnv HOME={root}). agent-bundle install borrows it via
  // nativeHome(env.HERMES_HOME)/installs, so run.mjs's env points at the provision home while the
  // --home route keeps the plugin registry + config isolated (borrow links <state>/installs -> <provision>/installs).
  const provisionHome = path(runtime.root, ".hermes");
  const systemEnv = local
    ? runtimeProcessEnvironment()
    : { PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin" };
  const hostPath = Object.entries(systemEnv).find(([key]) => key.toUpperCase() === "PATH")?.[1] ?? "";
  const env = {
    ...systemEnv,
    // agent-bundle install enables plugins by spawning `hermes` from PATH, so the
    // provisioned launcher dir (materialized by setup-hermes.sh --runtime-only into
    // hermes-agent/.hermes/bin — v0.21.6 has no venv/bin/hermes) must precede it.
    PATH: `${path(runtime.root, "hermes-agent", ".hermes", "bin")}${local ? delimiter : ":"}${hostPath}`,
    // v0.21.6 plugin deps are installed by `hermes plugins enable` via PM `uv sync --frozen` against
    // the checkout's uv.lock (URLs pinned to files.pythonhosted.org). PIP_INDEX_URL is a no-op for
    // that path (R8): mirroring needs a uv.lock re-lock at provision time (see runtime.ts R8 note).
    HOME: state,
    USERPROFILE: state,
    HERMES_HOME: state,
    AGENT_BUNDLE_REGISTRY: path(state, "registry.json"),
  };
  const start = session.start.bind(session);
  const command = (args: string[]) => ({
    executable: node,
    args: [cli, "--json", ...args, "--harness-version", version],
    cwd: runtime.root,
    env: { ...(preparation.network?.environment("runtime", env, runtime.persistent ? "host" : "container") ?? env), HERMES_HOME: provisionHome },
    inheritEnv: false,
    input: null,
  });
  const release = local
    ? await acquireRuntimeLock(
        customHome ? join(state, ".evaluator.lock") : join(stateRoot, `${identity}.lock`),
        context.signal,
      )
    : async () => {};
  try {
    if (local) state = await claimPersistentState(customHome ? dirname(state) : stateRoot, state, identity);
    env.HOME = state;
    env.USERPROFILE = state;
    env.HERMES_HOME = state;
    env.AGENT_BUNDLE_REGISTRY = path(state, "registry.json");
    const bundle = local ? preparation.path : path(state, "bundle");
    if (!local) await session.upload(preparation.path, bundle, context.signal);
    const verified = parseVerifiedBundle(
      await cliJson(start, command(["verify", bundle, "--expect-digest", candidate.digest]), context.signal),
    );
    sameCandidate(candidate, verified);
    const installed = parseInstalledBundle(
      await cliJson(start, command(["install", bundle, "--home", state]), context.signal),
    );
    sameCandidate(candidate, installed);
    if (installed.home !== state)
      throw new AgentBundleError("SOLVER_PROTOCOL_INVALID", "CLI installed outside the requested home");
    context.signal.throwIfAborted();
    // Merge the solver's model_aliases into the install-written config.yaml
    // without clobbering model.default/model.provider owned by the preparation.
    const target = path(state, "config.yaml");
    const existing = local ? await readFile(target, { encoding: "utf8", signal: context.signal }).catch(error => {
      if (!hasCode(error, "ENOENT")) throw error;
      return "";
    }) : await cliOutput(start, { executable: "cat", args: [target], cwd: state, env, inheritEnv: false, input: null }, context.signal);
    const merged = mergeHermesModelConfig(existing, preparation.model,
      path(runtime.root, "runtimes", "shared", "assets", "search-stdio.mjs"), node,
      preparation.options.tools !== "none" && preparation.options.webSearch !== "disabled" && preparation.options.mcp !== "disabled");
    const configYaml = join(context.paths.agent, "hermes-config.yaml");
    await mkdir(context.paths.agent, { recursive: true });
    await writeFile(configYaml, merged, { mode: 0o600 });
    if (customHome) {
      await writeHomeConfig(target, merged);
    } else {
      await session.upload(configYaml, target, context.signal);
    }
    context.signal.throwIfAborted();
    await writeFile(
      join(context.paths.agent, "installation.json"),
      JSON.stringify({ ...installed, runtimeIdentity: runtime.identity, preparationIdentity: identity }),
      { mode: 0o600 },
    );
    const usageFile = join(context.paths.agent, "usage.json");
    const runtimeUsageFile = local ? usageFile : path(session.agentOutputDir, "usage.json");
    let taskConfigWritten = false;
    return preparedAttempt(
      async () => {
        try {
          if (local && taskConfigWritten) await writeHomeConfig(target, merged);
        } finally { await release(); }
      },
      async (input, signal) => {
        requireInputModalities(input, (preparation.model.inputModalities ?? ["text"]).filter(kind => kind !== "pdf"));
        if (input.attachments?.length && preparation.model.api !== "openai-completions") throw new AgentBundleError("BENCHMARK_UNSUPPORTED", "Hermes image input requires the validated openai-completions route");
        if (input.mcpServers?.length || input.skillsDirectories?.length) {
          const doc = expectRecord(parseYaml(merged), "Hermes config");
          const servers = expectRecord(doc.mcp_servers ?? {}, "Hermes mcp_servers");
          for (const server of input.mcpServers ?? []) {
            if (Object.hasOwn(servers, server.name)) throw new AgentBundleError("CONFIG_INVALID", "Duplicate Hermes MCP server " + server.name);
            servers[server.name] = { url: server.url, transport: server.transport === "http" ? "streamable-http" : "sse" };
          }
          const skills = expectRecord(doc.skills ?? {}, "Hermes skills");
          const dirs = skills.external_dirs ?? [];
          if (!Array.isArray(dirs)) throw new AgentBundleError("CONFIG_INVALID", "Hermes skills.external_dirs must be an array");
          const taskConfig = stringifyYaml({ ...doc, mcp_servers: servers,
            skills: { ...skills, external_dirs: [...new Set([...dirs, ...(input.skillsDirectories ?? [])])] } });
          taskConfigWritten = true;
          if (local) await writeHomeConfig(target, taskConfig);
          else {
            const file = join(context.paths.agent, "hermes-task.yaml");
            await writeFile(file, taskConfig, { mode: 0o600 });
            await session.upload(file, target, signal);
          }
        }
        const media = await loadAttachments(input, session, { ...context, signal });
        signal.throwIfAborted();
        return start(
          {
            executable: "bash",
            args: [path(runtime.root, "hermes-agent", "scripts", "run-in-hermes-env"), "python",
              path(runtime.root, "hermes", "runner.py"), path(runtime.root, "hermes-agent"),
              "-z", input.prompt, "--usage-file", runtimeUsageFile, "--in", session.workdir, "-m", preparation.model.name,
              ...(preparation.model.reasoningEffort === undefined ? [] : ["--reasoning", preparation.model.reasoningEffort])],
            cwd: session.workdir,
            env: {
              ...env,
              HERMES_HOME: state,
              HERMES_YOLO_MODE: "1",
              OFFICE_AGENT_WORKDIR: path(state, "work", "office-agent"),
              [HERMES_AUTH_ENV]: preparation.auth.value,
              ...(media.length ? { EVALUATOR_HERMES_MEDIA: "1" } : {}),
            },
            inheritEnv: false,
            input: media.length ? Buffer.from(JSON.stringify(media)) : null,
          },
          signal,
        );
      },
      (handle, solveContext, signal, input) =>
        consumeHermes(handle, { ...solveContext, signal }, preparation.auth.value, usageFile, undefined, {
          prompt: input.prompt,
          model: preparation.model.name,
          inputModalities: preparation.model.inputModalities ?? ["text"],
          imageInputMode: preparation.model.inputModalities?.includes("image") ? "native" : "text",
        }, local ? undefined : () => session.download(runtimeUsageFile, usageFile, signal)),
      ["text", "image"],
    );
  } catch (error) {
    await release();
    throw error;
  }
}
