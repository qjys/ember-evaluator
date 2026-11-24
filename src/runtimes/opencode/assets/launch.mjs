import { launchCodeCli, acpRun } from "./runtimes/shared/assets/native-code-launch.mjs";
import { spawnSync } from "node:child_process";

await launchCodeCli({
  entry: "node_modules/opencode-ai/bin/opencode.exe", native: true, enforceMaxTurns: true,
  async configure({ executable, servers, endpoint, env, api, model, token, maxTokens, contextWindow, reasoningEffort, maxTurns, supportsImages, supportsPdf, toolPolicy }) {
    const permission = toolPolicy.tools === "none" ? { "*": "deny" } : { "*": "allow",
      ...(toolPolicy.subagent === "disabled" ? { task: "deny" } : {}),
      ...(toolPolicy.skills === "disabled" ? { skill: "deny" } : {}),
      ...(toolPolicy.webSearch === "disabled" ? { websearch: "deny", search: "deny" } : {}),
      ...(toolPolicy.webFetch === "disabled" ? { webfetch: "deny", fetch: "deny" } : {}) };
    const npm = api === "anthropic-messages" ? "@ai-sdk/anthropic" : api === "openai-responses" ? "@ai-sdk/openai" : "@ai-sdk/openai-compatible";
    const variant = api === "anthropic-messages" ? { effort: reasoningEffort, thinking: { type: "adaptive" } }
      : { reasoningEffort };
    env.OPENCODE_CONFIG_CONTENT = JSON.stringify({ model: `evaluator/${model}`, small_model: `evaluator/${model}`,
      provider: { evaluator: { npm, options: { apiKey: token, baseURL: endpoint }, models: { [model]: {
        id: model, name: model, attachment: Boolean(supportsImages || supportsPdf), tool_call: true,
        ...(reasoningEffort === undefined ? {} : { variants: { [reasoningEffort]: variant } }),
        ...(maxTokens === undefined && contextWindow === undefined ? {} : { limit: { context: contextWindow ?? 200000, output: maxTokens ?? 32000 } }),
        modalities: { input: ["text", ...(supportsImages ? ["image"] : []), ...(supportsPdf ? ["pdf"] : [])], output: ["text"] },
      } } } },
      agent: { title: { disable: true }, build: { permission, ...(maxTurns === undefined ? {} : { steps: maxTurns }) } },
      permission, share: "disabled", autoupdate: false, snapshot: false,
    });
    if (toolPolicy.mcp === "disabled") env.OPENCODE_DISABLE_PROJECT_CONFIG = "1";
    env.OPENCODE_DISABLE_MODELS_FETCH = "1";
    env.OPENCODE_DISABLE_AUTOUPDATE = "1";
    env.OPENCODE_WEBSEARCH_PROVIDER = "exa";
    if (toolPolicy.tools !== "none" && toolPolicy.webSearch !== "disabled") env.OPENCODE_ENABLE_EXA = "1";
    const prefixes = [];
    if (toolPolicy.tools === "none" && toolPolicy.mcp !== "disabled") {
      // OpenCode uses <server>_<tool> for MCP. Use its merged configuration
      // to include project servers as well as those passed by ACP session/new.
      const config = spawnSync(executable, ["debug", "config"], { encoding: "utf8", env, windowsHide: true });
      if (config.status !== 0) throw Error("OpenCode could not resolve the configured MCP servers");
      const names = new Set([...Object.keys(JSON.parse(config.stdout).mcp ?? {}), ...servers.map(server => server.name)]);
      for (const name of names) {
        const prefix = name.replace(/[^a-zA-Z0-9_-]/gu, "_") + "_";
        prefixes.push(prefix);
        permission[prefix + "*"] = "allow";
      }
      // An MCP server named "apply" must not enable the built-in apply_patch.
      permission.apply_patch = "deny";
      const settings = JSON.parse(env.OPENCODE_CONFIG_CONTENT);
      settings.permission = settings.agent.build.permission = permission;
      env.OPENCODE_CONFIG_CONTENT = JSON.stringify(settings);
    }
    return { args: ["acp"], modeId: "build", nativeSearchUsesExa: true, effortConfigId: "effort",
      isMcpTool: name => name !== "apply_patch" && prefixes.some(prefix => name.startsWith(prefix)) };
  },
  run: acpRun,
});
