import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { launchCodeCli, acpRun } from "./runtimes/shared/assets/native-code-launch.mjs";

await launchCodeCli({
  entry: "node_modules/@moonshot-ai/kimi-code/dist/main.mjs",
  async configure({ home, endpoint, env, api, model, token, maxTokens, contextWindow, reasoningEffort, maxTurns, supportsImages, toolPolicy }) {
    env.EVALUATOR_DISABLE_MCP = toolPolicy.mcp === "disabled" ? "1" : "0";
    env.EVALUATOR_DISABLE_SKILLS = toolPolicy.skills === "disabled" ? "1" : "0";
    env.KIMI_CODE_HOME = join(home, "kimi");
    // Kimi only reads project MCP configuration from a trusted workspace.
    env.KIMI_CODE_TRUST_WORKSPACE = "true";
    env.EVALUATOR_MODEL_TOKEN = token;
    await mkdir(env.KIMI_CODE_HOME, { recursive: true });
    const type = { "openai-completions": "openai", "openai-responses": "openai_responses", "anthropic-messages": "anthropic" }[api];
    const disabled = [];
    if (toolPolicy.webSearch === "disabled") disabled.push("WebSearch");
    if (toolPolicy.webFetch === "disabled") disabled.push("FetchURL");
    if (toolPolicy.subagent === "disabled") disabled.push("Agent", "AgentSwarm", "Task", "CreateSubagent", "AgentTask");
    if (toolPolicy.skills === "disabled") disabled.push("Skill");
    const tools = `disabled = ${JSON.stringify(disabled)}`;
    const config = [
      'default_model = "evaluator"', 'default_permission_mode = "auto"', 'telemetry = false',
      '[providers.evaluator]', `type = ${JSON.stringify(type)}`, `base_url = ${JSON.stringify(api === "anthropic-messages" ? endpoint.replace(/\/v1$/u, "") : endpoint)}`,
      'api_key_env = "EVALUATOR_MODEL_TOKEN"', '[models.evaluator]', 'provider = "evaluator"',
      `model = ${JSON.stringify(model)}`, `max_context_size = ${contextWindow ?? 200000}`,
      ...(maxTokens === undefined ? [] : [`max_output_size = ${maxTokens}`]),
      `capabilities = ${JSON.stringify(["tool_use", ...(supportsImages ? ["image_in"] : []), ...(reasoningEffort === undefined ? [] : ["thinking"])])}`,
      ...(reasoningEffort === undefined ? [] : [`support_efforts = ${JSON.stringify([reasoningEffort])}`]),
      '[tools]', tools, ...(maxTurns === undefined ? [] : ['[loop_control]', `max_steps_per_turn = ${maxTurns}`]),
    ].join("\n") + "\n";
    await writeFile(join(env.KIMI_CODE_HOME, "config.toml"), config, { mode: 0o600 });
    return { args: ["acp"], modeId: "yolo", effortConfigId: "thinking" };
  },
  run: acpRun,
});
