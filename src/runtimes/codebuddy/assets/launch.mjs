import { nativeMcpConfig, stageSkills, taskServers } from "./runtimes/shared/assets/task-resources.mjs";
import { spawn } from "node:child_process";
import { readFileSync, writeSync } from "node:fs";
import { lstat, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { startModelRelay } from "./runtimes/shared/assets/model-relay.mjs";

const [home, entry] = process.argv.slice(2);
const input = JSON.parse(readFileSync(0, "utf8"));
const { apiKey, api, baseUrl, model, maxTokens, contextWindow, reasoningEffort, maxTurns, supportsImages, prompt, token, media, toolPolicy = {} } = input;

// The model loader in CodeBuddy 2.183.0 reads this file independently of --setting-sources.
const projectModels = await lstat(join(process.cwd(), ".codebuddy", "models.json")).catch(error => {
  if (error.code === "ENOENT") return undefined;
  throw error;
});
if (projectModels) {
  writeSync(1, JSON.stringify({ type: "evaluator.config_error", message: "CodeBuddy cannot run with a workspace .codebuddy/models.json because it can override the selected model service" }) + "\n");
  process.exit(1);
}

await mkdir(home, { mode: 0o700 });
let resources;
let relay;
try {
  resources = await taskServers(input);
  if (toolPolicy.skills !== "disabled") await stageSkills(input.skillsDirectories, join(home, "skills"));
  relay = await startModelRelay({
    completeWebTools: resources.completeWebTools, api, baseUrl, apiKey, token,
    disableWebFetch: toolPolicy.webFetch === "disabled", disableHostedSearch: toolPolicy.webSearch === "disabled", disableMcp: toolPolicy.mcp === "disabled",
    disableBuiltinTools: toolPolicy.tools === "none",
  });
  await writeFile(join(home, "models.json"), JSON.stringify({
    models: [{
      id: model, name: model, vendor: "openai", api, apiKey: token,
      url: api === "openai-completions" ? relay.endpoint + "/chat/completions" : relay.endpoint,
        supportsToolCall: true,
        // CodeBuddy only serializes native per-agent effort for reasoning-capable models.
        ...(reasoningEffort === undefined ? {} : { supportsReasoning: true }),
        // The Chat adapter uses this flag for both image and document blocks.
        supportsImages: supportsImages || media.some(item => item.mediaType === "application/pdf"),
      ...(contextWindow === undefined ? {} : { maxInputTokens: contextWindow }),
      ...(maxTokens === undefined ? {} : { maxOutputTokens: maxTokens }),
    }],
    availableModels: [model],
  }), { mode: 0o600 });

  const windows = process.platform === "win32";
  const none = toolPolicy.tools === "none";
  const denied = toolPolicy.subagent === "disabled" ? ["Agent", "Task", "Workflow"] : [];
  if (toolPolicy.skills === "disabled") denied.push("Skill");
  if (toolPolicy.webSearch === "disabled") denied.push("WebSearch");
  if (toolPolicy.webFetch === "disabled") denied.push("WebFetch");
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^(?:CODEBUDDY_|WORKBUDDY_|CLAUDE_|ANTHROPIC_|OTEL_)/iu.test(name)));
  const noProxy = [env.NO_PROXY ?? env.no_proxy, "127.0.0.1"].filter(Boolean).join(",");
  const child = spawn(process.execPath, [entry,
    "--print", "--verbose", "--output-format", "stream-json", "--input-format", "stream-json", "--model", model,
    "--setting-sources", "user,project,local",
    ...(toolPolicy.mcp === "disabled" ? ["--strict-mcp-config"] : []),
    ...(resources.servers.length ? ["--mcp-config", JSON.stringify(nativeMcpConfig(resources.servers))] : []), "--no-session-persistence",
    ...(reasoningEffort === undefined ? [] : ["--effort", reasoningEffort]),
    ...(maxTurns === undefined ? [] : ["--max-turns", String(maxTurns)]),
    "--permission-mode", "bypassPermissions", "--subagent-permission-mode", "bypassPermissions",
    ...(none ? ["--tools", ""] : []),
    ...(denied.length ? ["--disallowedTools", ...denied] : []),
  ], {
    env: {
      ...env, ...(none ? { CODEBUDDY_DEFER_TOOL_LOADING: "false" } : {}), ...(input.container ? { CODEBUDDY_IS_SANDBOX: "1" } : {}), HOME: home, USERPROFILE: home, CODEBUDDY_CONFIG_DIR: home,
      ...(windows ? { TEMP: home, TMP: home, CODEBUDDY_SKIP_GIT_BASH_CHECK: "1" } : {}),
      EVALUATOR_DISABLE_SKILLS: toolPolicy.skills === "disabled" ? "1" : "0",
      CODEBUDDY_CODE_SHELL: windows ? "powershell" : "bash", DISABLE_AUTOUPDATER: "1", DISABLE_TELEMETRY: "1",
      CODEBUDDY_CODE_DISABLE_SESSION_TITLE_REFRESH: "1",
      CODEBUDDY_DISABLE_AUTO_MEMORY: "1", CODEBUDDY_DISABLE_BUILTIN_MODELS: "1",
      NO_PROXY: noProxy, no_proxy: noProxy,
    },
    stdio: ["pipe", "inherit", "inherit"], windowsHide: true,
  });
  const exited = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", code => resolve(code ?? 1));
    child.stdin.on("error", error => {
      if (error.code !== "EPIPE") reject(error);
    });
  });
  const terminate = () => child.kill("SIGTERM");
  process.once("SIGTERM", terminate);
  try {
    const content = [{ type: "text", text: prompt }, ...media.map(({ mediaType, data }) => ({
      type: mediaType === "application/pdf" ? "document" : "image",
      source: { type: "base64", media_type: mediaType, data },
    }))];
    child.stdin.end(JSON.stringify({ type: "user", message: { role: "user", content } }) + "\n", "utf8");
    process.exitCode = await exited;
  } finally {
    process.removeListener("SIGTERM", terminate);
  }
} finally {
  resources?.close?.();
  relay?.close();
  await rm(home, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
}
