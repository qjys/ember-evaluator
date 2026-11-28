import { nativeMcpConfig, stageSkills, taskServers } from "./runtimes/shared/assets/task-resources.mjs";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { startModelRelay } from "./runtimes/shared/assets/model-relay.mjs";
import { stageAttachments } from "./stage-attachments.mjs";

const [home, entry] = process.argv.slice(2);
const input = JSON.parse(readFileSync(0, "utf8"));
const { apiKey, api, baseUrl, model, inputModalities, maxTokens, contextWindow, reasoningEffort, prompt, token, media = [], toolPolicy = {} } = input;
const settings = join(home, ".zcode", "cli");
await mkdir(home, { mode: 0o700 });
let relay;
let resources;
try {
  const none = toolPolicy.tools === "none";
  resources = await taskServers(input);
  if (toolPolicy.skills !== "disabled") await stageSkills(input.skillsDirectories, join(home, ".agents", "skills"));
  relay = await startModelRelay({
    completeWebTools: resources.completeWebTools, api, baseUrl, apiKey, token,
    disableWebFetch: toolPolicy.webFetch === "disabled", disableHostedSearch: toolPolicy.webSearch === "disabled", disableMcp: toolPolicy.mcp === "disabled", disableBuiltinTools: none,
  });
  await mkdir(settings, { recursive: true, mode: 0o700 });
  const providerFile = join(home, "provider_config.json");
  const providerId = "arsi-evaluator";
  const apiType = api === "openai-completions" ? "openai-chat-completions" : api;
  await writeFile(providerFile, JSON.stringify({
    schemaVersion: 1,
    config: {
      providerConfigRules: { providerRules: [{
        providerId, providerName: "ARSI-Evaluator",
        config: {
          group: "standard-personal", access: { type: "api-key", apiKey: token },
          api: { type: apiType, baseUrl: relay.endpoint }, personalModelIds: [model],
        },
      }] },
      modelConfigRules: {
        providerModelRules: inputModalities === undefined && maxTokens === undefined && contextWindow === undefined ? [] : [{
          providerId, modelId: model, config: {
            ...(maxTokens === undefined ? {} : { optionSpecs: { maxOutputTokens: { max: maxTokens } } }),
            properties: {
              ...(contextWindow === undefined ? {} : { contextWindow }),
              ...(inputModalities === undefined ? {} : { inputFormat: {
                supportsImage: inputModalities.includes("image"),
                supportsPdf: inputModalities.includes("pdf"),
              } }),
            },
          },
        }],
        manualProviderModelRules: [],
      },
      defaultModelSelection: { providerId, modelId: model,
        ...(reasoningEffort === undefined ? {} : { options: { reasoningLevel: reasoningEffort } }) },
    },
  }), { mode: 0o600 });
  await writeFile(join(settings, "config.json"), JSON.stringify({
    ...(resources.servers.length ? { mcp: { servers: nativeMcpConfig(resources.servers).mcpServers } } : {}),
    features: {
      ...(toolPolicy.mcp === "disabled" ? { mcp: false } : {}),
      ...(none || toolPolicy.subagent === "disabled" ? { subagent: false } : {}),
      ...(toolPolicy.skills === "disabled" ? { skill: false } : {}),
    },
    ...(toolPolicy.skills === "disabled" ? { skills: { enabled: false } } : {}),
  }), { mode: 0o600 });
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^(?:ZCODE_|OTEL_)/iu.test(name)));
  const noProxy = [env.NO_PROXY ?? env.no_proxy, "127.0.0.1"].filter(Boolean).join(",");
  // Registration-level exclusions for the locked CLI, including tools exposed when Bash is removed.
  const denied = toolPolicy.tools === "none" ? [
    "AskUserQuestion", "Bash", "PowerShell", "Edit", "EnterPlanMode", "ExitPlanMode", "Read", "TaskOutput",
    "TaskStop", "TodoRead", "TodoWrite", "WebFetch", "WebSearch", "Write", "Glob", "Grep", "MultiEdit",
    "NotebookEdit", "Agent", "Task", "Skill", "LSP", "ToolSearch", "ListSessions", "ReadSession",
    "CreateSession", "ForkSession", "SendToSession", "WaitSessions", "InterruptSession", "RenameSession", "ListModels",
  ] : [
    ...(toolPolicy.subagent === "disabled" ? ["Agent", "Task", "CreateSession", "ForkSession", "SendToSession"] : []),
    ...(toolPolicy.webSearch === "disabled" ? ["WebSearch"] : []),
    ...(toolPolicy.webFetch === "disabled" ? ["WebFetch"] : []),
  ];
  const attachmentPaths = await stageAttachments(home, media);
  const child = spawn(process.execPath, [
    join(import.meta.dirname, "cli.mjs"), entry,
    "--cwd", process.cwd(), "--mode", "yolo", "--output-format", "stream-json", "--no-color",
    ...(denied.length ? ["--disallowed-tools", denied.join(",")] : []),
  ], {
    env: {
      ...env, HOME: home, USERPROFILE: home, ZCODE_DATA_BASE_DIR: home,
      ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: providerFile, ZCODE_MODEL_TELEMETRY_ENABLED: "false",
      ZCODE_NO_PROXY: noProxy, NO_PROXY: noProxy, no_proxy: noProxy,
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
    child.stdin.end(JSON.stringify({ prompt, attachmentPaths }), "utf8");
    process.exitCode = await exited;
  } finally {
    process.removeListener("SIGTERM", terminate);
  }
} finally {
  resources?.close?.();
  relay?.close();
  await rm(home, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
}
