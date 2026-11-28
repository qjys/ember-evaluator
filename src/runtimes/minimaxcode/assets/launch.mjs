import { nativeMcpConfig } from "./runtimes/shared/assets/task-resources.mjs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { launchCodeCli, jsonlRun } from "./runtimes/shared/assets/native-code-launch.mjs";

await launchCodeCli({
  entry: "node_modules/@minimax-ai/code/cli.js",
  stageImages: true,
  async configure({ home, endpoint, env, api, model, token, maxTokens, contextWindow, reasoningEffort, maxTurns, supportsImages, prompt, files, toolPolicy, servers }) {
    env.EVALUATOR_DISABLE_MCP = toolPolicy.mcp === "disabled" ? "1" : "0";
    if (maxTurns !== undefined) env.MINIMAX_EVALUATOR_MAX_TURNS = String(maxTurns);
    env.MINIMAX_DATA_DIR = join(home, "minimax");
    await mkdir(env.MINIMAX_DATA_DIR, { recursive: true });
    if (servers.length) await writeFile(join(env.MINIMAX_DATA_DIR, "mcp.json"), JSON.stringify(nativeMcpConfig(servers)), { mode: 0o600 });
    const none = toolPolicy.tools === "none";
    if (none) {
      // The CLI also injects an on-demand catalog into user-role messages.
      // Its catalog and system hints have independent switches.
      env.MAVIS_MCP_TOOL_SEARCH_ENABLED = "false";
      env.MAVIS_MCP_TOOL_SEARCH_CATALOG = "false";
      env.MAVIS_MCP_TOOL_SEARCH_SYSTEM_HINT = "false";
      env.MAVIS_MCP_TOOL_SEARCH_DIRECT_CALL = "true";
    }
    const config = {
      custom_provider: { evaluator: { kind: "custom", enabled: true, name: "Evaluator", api,
        options: { apiKey: token, baseURL: api === "anthropic-messages" ? endpoint.replace(/\/v1$/u, "") : endpoint, authMode: "api-key" }, models: { [model]: {
          id: model, name: model, attachment: supportsImages, tool_call: true,
          capabilities: { support_image: supportsImages },
          modalities: { input: supportsImages ? ["text", "image"] : ["text"], output: ["text"] },
          limit: { context: contextWindow ?? 200000, output: maxTokens ?? 16384 },
          ...(reasoningEffort === undefined ? {} : { reasoning: true, thinking: {
            effortOptions: ["default", reasoningEffort], defaultEffort: "default" } }),
      } } } }, defaultModel: `custom_provider:evaluator/${model}`, defaultLightModel: `custom_provider:evaluator/${model}`,
      agents: { default: {
        ...(toolPolicy.skills === "disabled" ? { skills: [] } : {}),
        ...(toolPolicy.mcp === "disabled" ? { mcpServers: [] } : {}),
        ...(none ? { tools: [], builtinTools: [] } : {}),
        ...(toolPolicy.webFetch === "disabled" ? { disallowedTools: ["web_fetch"] } : {}),
        ...(none ? { features: { mavis: false, delegation: false, webSearch: false } }
          : { features: {
              ...(toolPolicy.webSearch === "disabled" ? { webSearch: false } : {}),
              ...(toolPolicy.subagent === "disabled" ? { delegation: false } : {}),
            } }),
      } },
      ...(none ? { beta: { mcodeTools: false, ptc: false, browserUseTooling: false } } : {}),
      ...(toolPolicy.skills === "disabled" ? { skills: { external: { enabled: false } } } : {}),
      telemetry: { enabled: false, metrics: false, diagnostics: false },
      sessionTitle: { enabled: false }, promptSuggestion: { enabled: false },
    };
    const configPath = join(home, "runtime.json");
    // JSON is also valid YAML; the native --config loader accepts this file.
    await writeFile(configPath, JSON.stringify(config), { mode: 0o600 });
    return { skillsDir: join(env.MINIMAX_DATA_DIR, "skills"), args: ["exec", "--config", configPath, "--model", `custom_provider:evaluator/${model}`, "--permission", "full",
      "--input", "-", "--input-format", "json", "--output-format", "stream-json",
      ...(none ? ["--append-system-prompt", "In this run WebSearch, WebFetch, shell, file access and tool discovery are disabled. Skip any request conditional on the availability of one of those built-ins. The declared MCP functions are directly callable. Never call an MCP function to probe for other tools. For a requested MCP operation, use its returned content as the result. When the remaining actions require disabled tools, return the final answer immediately."] : []),
      ...(reasoningEffort === undefined ? [] : ["--effort", reasoningEffort]),
      ...(maxTurns === undefined ? [] : ["--max-steps", String(maxTurns)]),
      ...files.flatMap(file => ["--file", file])], input: JSON.stringify({ prompt }) };
  },
  async run(state) {
    let result;
    return jsonlRun(state, event => { if (event.type === "exec.completed") result = event.result; }, () => {
      if (!result || result.status !== "succeeded" || typeof result.output !== "string") {
        throw Error(result?.error?.message ?? `MiniMax Code result: ${result?.status ?? "missing"}`);
      }
      return { finalText: result.output, usage: result.usage };
    });
  },
});
