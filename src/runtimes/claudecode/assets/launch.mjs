import { nativeMcpConfig, stageSkills } from "./runtimes/shared/assets/task-resources.mjs";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { startModelRelay } from "./runtimes/shared/assets/model-relay.mjs";

const [home, entry, ...args] = process.argv.slice(2);
const input = JSON.parse(readFileSync(0, "utf8"));
const { apiKey, prompt, baseUrl, model, maxTokens, contextWindow, reasoningEffort, media = [] } = input;
// The pinned CLI assumes 200K for unrecognized models without this suffix.
// It strips the suffix before sending the model ID to the provider.
const cliModel = contextWindow === 1_000_000 && !/\[1m\]$/iu.test(model) ? `${model}[1m]` : model;
args.push("--model", cliModel);
await mkdir(home, { mode: 0o700 });
let relay;
try {
  const policy = input.toolPolicy ?? {};
  if (policy.mcp !== "disabled" && input.mcpServers?.length) {
    args.push("--mcp-config", JSON.stringify(nativeMcpConfig(input.mcpServers)));
  }
  const root = process.platform === "linux" && process.getuid() === 0;
  const dockerRoot = root && input.docker === true;
  const permissionMode = root && !dockerRoot ? "dontAsk" : "bypassPermissions";
  args.push("--permission-mode", permissionMode);
  const settings = { sandbox: { enabled: false },
    ...(permissionMode === "dontAsk" ? { permissions: { allow: ["*"] } } : {}) };
  // Fetch uses the task's network policy without a separate call to Anthropic's domain service.
  if (policy.tools !== "none" && policy.webFetch !== "disabled") settings.skipWebFetchPreflight = true;
  if (policy.tools !== "none") {
    const allowed = [policy.webSearch !== "disabled" ? "WebSearch" : undefined, policy.webFetch !== "disabled" && policy.mcp !== "disabled" ? "WebFetch" : undefined].filter(Boolean);
    if (allowed.length) {
      const handler = { type: "command", command: process.execPath,
        args: [fileURLToPath(new URL("./search-hook.mjs", import.meta.url)), input.outputDir ?? "",
          JSON.stringify(input.fetchNetwork ?? "bridge")], timeout: 100 };
      const hooks = [{ matcher: allowed.join("|"), hooks: [handler] }];
      settings.hooks = { PostToolUse: hooks, PostToolUseFailure: hooks };
    }
  }
  args.push("--settings", JSON.stringify(settings));
  if (input.toolPolicy?.skills !== "disabled") {
    await stageSkills(input.skillsDirectories, join(home, ".claude", "skills"));
  }
  const shellPrefix = join(home, "shell");
  const needsShellPrefix = process.platform === "linux";
  const relayKey = randomUUID();
  // SUBPROCESS_ENV_SCRUB forces the pinned CLI back to its default approval
  // mode. Keep the real credential in this relay on every operating system.
  relay = await startModelRelay({ disableHostedSearch: input.toolPolicy?.webSearch === "disabled",
    disableWebFetch: policy.webFetch === "disabled", disableMcp: policy.mcp === "disabled", disableBuiltinTools: input.toolPolicy?.tools === "none", api: "anthropic-messages", baseUrl,
    apiKey, token: relayKey, maxTokens });
  if (needsShellPrefix) {
    // The CLI passes the entire Bash command as one argument to the prefix.
    await writeFile(shellPrefix, '#!/bin/sh\nunset ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN ANTHROPIC_BASE_URL\nexec /bin/bash -c "$1"\n',
      { mode: 0o700 });
  }
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) =>
    !/^(?:ANTHROPIC_|CLAUDE_|IS_SANDBOX$|DISABLE_(?:UPDATES|AUTOUPDATER|TELEMETRY|ERROR_REPORTING)$)/iu.test(name)));
  const noProxy = [env.NO_PROXY ?? env.no_proxy, "127.0.0.1"].filter(Boolean).join(",");
  if (media.length) args.push("--input-format", "stream-json");
  if (reasoningEffort !== undefined) args.push("--effort", reasoningEffort);
  const cli = spawn(entry, args, {
    env: {
      ...env, HOME: home, USERPROFILE: home, CLAUDE_CONFIG_DIR: join(home, ".claude"),
      ...(process.env.CLAUDE_CODE_GIT_BASH_PATH === undefined ? {} : { CLAUDE_CODE_GIT_BASH_PATH: process.env.CLAUDE_CODE_GIT_BASH_PATH }),
      ANTHROPIC_API_KEY: relayKey, ANTHROPIC_BASE_URL: new URL(relay.endpoint).origin, ANTHROPIC_MODEL: cliModel,
      ANTHROPIC_DEFAULT_OPUS_MODEL: cliModel, ANTHROPIC_DEFAULT_SONNET_MODEL: cliModel, ANTHROPIC_DEFAULT_HAIKU_MODEL: cliModel,
      CLAUDE_CODE_SUBAGENT_MODEL: cliModel, CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST: "1",
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      ...(reasoningEffort === undefined ? {} : {
        ANTHROPIC_CUSTOM_MODEL_OPTION: model,
        ANTHROPIC_CUSTOM_MODEL_OPTION_SUPPORTED_CAPABILITIES: "effort,xhigh_effort,max_effort,thinking,adaptive_thinking",
      }),
      ...(policy.tools === "none" ? { ENABLE_TOOL_SEARCH: "false" } : {}),
      NO_PROXY: noProxy, no_proxy: noProxy,
      ...(needsShellPrefix ? { CLAUDE_CODE_SHELL_PREFIX: shellPrefix } : {}),
      // The pinned CLI accepts bypassPermissions as UID 0 in an isolated container.
      ...(dockerRoot ? { IS_SANDBOX: "1" } : {}),
      DISABLE_UPDATES: "1", DISABLE_TELEMETRY: "1", DISABLE_ERROR_REPORTING: "1",
      ...(maxTokens === undefined ? {} : { CLAUDE_CODE_MAX_OUTPUT_TOKENS: String(maxTokens) }),
      ...(contextWindow === undefined ? {} : { CLAUDE_CODE_AUTO_COMPACT_WINDOW: String(contextWindow) }),
    },
    stdio: ["pipe", "inherit", "inherit"],
    windowsHide: true,
  });
  const exited = new Promise((resolve, reject) => {
    cli.once("error", reject);
    cli.once("close", code => resolve(code ?? 1));
    cli.stdin.on("error", error => {
      if (error.code !== "EPIPE") reject(error);
    });
  });
  const terminate = () => { cli.kill("SIGTERM"); };
  process.once("SIGTERM", terminate);
  try {
    const content = [{ type: "text", text: prompt }, ...media.map(({ name, mediaType, data }) => ({
      ...(mediaType === "application/pdf" ? { type: "document", title: name } : { type: "image" }),
      source: { type: "base64", media_type: mediaType, data },
    }))];
    cli.stdin.end(media.length ? JSON.stringify({
      type: "user", message: { role: "user", content }, parent_tool_use_id: null, session_id: "",
    }) + "\n" : prompt, "utf8");
    process.exitCode = await exited;
  } finally {
    process.removeListener("SIGTERM", terminate);
  }
} finally {
  relay?.close();
  await rm(home, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
}
