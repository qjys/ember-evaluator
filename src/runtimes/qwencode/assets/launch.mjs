import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { launchCodeCli, acpRun } from "./runtimes/shared/assets/native-code-launch.mjs";

await launchCodeCli({
  entry: "node_modules/@qwen-code/qwen-code/cli-entry.js",
  enforceMaxTurns: true,
  async configure({ home, endpoint, env, api, model, token, supportsImages, supportsPdf, maxTokens, contextWindow, reasoningEffort, maxTurns, toolPolicy, servers }) {
    const protocol = api === "anthropic-messages" ? "anthropic" : "openai";
    const generationConfig = { modalities: { image: supportsImages, ...(supportsPdf ? { pdf: true } : {}) },
      ...(contextWindow === undefined ? {} : { contextWindowSize: contextWindow }),
      ...(maxTokens === undefined ? {} : { samplingParams: { max_tokens: maxTokens } }) };
    const profile = { "openai-completions": "openai-effort", "openai-responses": "openai-reasoning",
      "anthropic-messages": "anthropic-adaptive" }[api];
    const config = { security: { auth: { selectedType: protocol } }, model: { name: model, generationConfig,
      ...(maxTurns === undefined ? {} : { maxSessionTurns: maxTurns }) },
      modelProviders: { [protocol]: [{ id: model, baseUrl: api === "anthropic-messages" ? endpoint.replace(/\/v1$/u, "") : endpoint, envKey: "EVALUATOR_MODEL_TOKEN",
        ...(api === "openai-responses" ? { wireApi: "responses" } : {}),
        ...(reasoningEffort === undefined ? {} : {
          // A custom route needs a capability declaration before the native session selector is available.
          // Keep this model default independent of the current session's effort.
          capabilities: { reasoning: { profile, efforts: ["low", "medium", "high", "xhigh", "max"], defaultEffort: "high" } },
        }), generationConfig }] },
      ...(toolPolicy.mcp === "disabled" ? { mcp: { allowed: [] } } : {}),
      ...(toolPolicy.skills === "disabled" ? { skills: { disabledLevels: ["project", "user", "extension", "bundled"] } } : {}),
      tools: { sandbox: false, ...(toolPolicy.tools === "none" ? { toolSearch: { enabled: false } } : {}),
        ...(toolPolicy.tools === "none" || toolPolicy.webSearch === "disabled" ? { webSearch: { enabled: false } } : {}) },
      telemetry: { enabled: false }, privacy: { usageStatisticsEnabled: false } };
    env.QWEN_HOME = join(home, "qwen");
    env.EVALUATOR_MODEL_TOKEN = token;
    env.OPENAI_API_KEY = token;
    env.OPENAI_BASE_URL = endpoint;
    env.ANTHROPIC_API_KEY = token;
    env.ANTHROPIC_BASE_URL = endpoint.replace(/\/v1$/u, "");
    env.QWEN_CODE_MODELS_DEV_REFRESH = "off";
    await mkdir(env.QWEN_HOME, { recursive: true });
    await writeFile(join(env.QWEN_HOME, "settings.json"), JSON.stringify(config), { mode: 0o600 });
    const deny = [];
    if (toolPolicy.tools === "none") deny.push(
      "exec", "edit", "write_file", "read_file", "zoom_image", "grep_search", "glob", "run_shell_command", "todo_write",
      "save_memory", "manage_memory", "search_memory", "agent", "skill", "exit_plan_mode", "enter_plan_mode", "web_fetch", "web_search",
      "image_gen", "list_directory", "lsp", "ask_user_question", "cron_create", "cron_list", "cron_delete", "autofix_pr", "loop_wakeup",
      "create_sub_session", "list_agents", "task_stop", "task_create", "task_update", "task_list", "team_create", "team_delete",
      "team_plan_approval", "request_shutdown", "send_message", "structured_output", "monitor", "notebook_edit", "tool_call", "tool_search",
      "read_mcp_resource", "advisor", "enter_worktree", "exit_worktree", "workflow", "artifact", "record_artifact", "record_source",
      "report_findings", "get_goal", "update_goal", "propose_goal", "display_image", "omni_downsample_image", "omni_downscale_video",
      "omni_downsample_audio", "omni_extract_keyframes", "omni_extract_audio", "omni_clip_video", "omni_convert_image", "omni_transcribe_audio",
      "omni_clip_image", "omni_clip_audio", "omni_caption_image", "omni_caption_audio", "omni_ocr_image", "omni_understand_video_segments", "omni_recall_media_memory",
    );
    else {
      if (toolPolicy.subagent === "disabled") deny.push("agent", "create_sub_session", "team_create", "advisor");
      if (toolPolicy.webSearch === "disabled") deny.push("web_search");
      if (toolPolicy.webFetch === "disabled") deny.push("web_fetch");
    }
    return { skillsDir: join(env.QWEN_HOME, "skills"), effortConfigId: "reasoning_effort", async beforePrompt(send, sessionId) {
      if (toolPolicy.tools !== "none" || toolPolicy.mcp === "disabled") return;
      // Qwen returns session/new before it has finished registering MCP tools.
      for (;;) {
        const { mcp } = await send("qwen/status/session/resources", { sessionId }, false);
        if (!mcp.initialized) throw Error("Qwen could not read the session MCP discovery status");
        if (mcp.discoveryState === "completed" || !mcp.servers.some(server => !server.disabled)) {
          const missing = (servers ?? []).filter(server => !mcp.servers.some(entry => entry.name === server.name && entry.mcpStatus === "connected"));
          if (missing.length) throw Error("Qwen could not connect to MCP: " + missing.map(server => server.name).join(", "));
          return;
        }
        await delay(100);
      }
    }, args: ["--auth-type", protocol, "--model", model, "--approval-mode", "yolo",
      "--acp",
      ...(maxTurns === undefined ? [] : ["--max-session-turns", String(maxTurns)]),
      ...(deny.length ? ["--exclude-tools", ...deny] : [])] };
  },
  run: acpRun,
});
