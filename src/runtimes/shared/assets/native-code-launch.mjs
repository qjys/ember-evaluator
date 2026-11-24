import { stageSkills, taskServers } from "./task-resources.mjs";
import { spawn, spawnSync } from "node:child_process";
import { readFileSync, writeSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { startModelRelay } from "./model-relay.mjs";

export const emit = event => writeSync(1, JSON.stringify(event) + "\n");

// Native output must survive arbitrary byte boundaries without replacing bad
// UTF-8 or silently accepting a truncated final record. No fixed byte cap.
export async function* nativeMessages(source) {
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  const fragments = [];
  for await (const chunk of source) {
    const lines = decoder.decode(chunk, { stream: true }).split("\n");
    const tail = lines.pop();
    for (const line of lines) {
      const complete = fragments.length ? [...fragments, line].join("") : line;
      fragments.length = 0;
      if (!complete.trim()) continue;
      let event;
      try { event = JSON.parse(complete); } catch { throw Error("Native CLI stdout contains invalid JSONL"); }
      if (event === null || typeof event !== "object" || Array.isArray(event)) throw Error("Native CLI stdout contains a non-object JSONL record");
      yield event;
    }
    if (tail) fragments.push(tail);
  }
  if (decoder.decode() || fragments.length) throw Error("Native CLI stdout ended with an incomplete JSONL record");
}

export async function launchCodeCli({ entry, native = false, enforceMaxTurns = false, stageImages = false, configure, run }) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
  const executable = native ? join(root, entry) : process.execPath;
  const prefix = native ? [] : [join(root, entry)];
  if (process.argv[2] === "--version") {
    const result = spawnSync(executable, [...prefix, "--version"], { encoding: "utf8", windowsHide: true });
    if (result.status !== 0 || !result.stdout.trim().split(/\s+/u).includes(process.argv[3])) {
      throw Error(`Unexpected CLI version: ${result.stdout || result.stderr}`);
    }
    process.exit(0);
  }
  const home = process.argv[2];
  const input = JSON.parse(readFileSync(0, "utf8"));
  await mkdir(home, { recursive: true, mode: 0o700 });
  let relay;
  let resources;
  let options;
  try {
    resources = await taskServers(input, entry.includes("opencode-ai"));
    relay = await startModelRelay({
      api: input.api, baseUrl: input.baseUrl, apiKey: input.apiKey, token: input.token, maxTokens: input.maxTokens,
      completeSearch: resources.completeSearch, disableBuiltinTools: input.toolPolicy.tools === "none", disableMcp: input.toolPolicy.mcp === "disabled",
      isMcpTool: name => options?.isMcpTool ? options.isMcpTool(name) : name.startsWith("mcp__"),
      disableHostedSearch: input.toolPolicy.webSearch === "disabled",
      disableWebFetch: input.toolPolicy.webFetch === "disabled", captureUsage: true,
      maxModelCalls: enforceMaxTurns ? input.maxTurns : undefined });
    const env = Object.fromEntries(Object.entries(process.env).filter(([name]) =>
      !/^(?:QWEN_|OPENAI_|ANTHROPIC_|KIMI_|MINIMAX_|MAVIS_|OPENCODE_|OTEL_|DASHSCOPE_|ENABLE_WEB_)/iu.test(name)));
    Object.assign(env, { HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: join(home, "config"),
      XDG_CACHE_HOME: join(home, "cache"), XDG_DATA_HOME: join(home, "data"),
      NO_PROXY: [env.NO_PROXY ?? env.no_proxy, "127.0.0.1"].filter(Boolean).join(",") });
    env.no_proxy = env.NO_PROXY;
    const files = [];
    for (const [index, media] of (stageImages ? input.media ?? [] : []).entries()) {
      const extension = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp" }[media.mediaType];
      if (!extension) throw Error(`Unsupported initial attachment type: ${media.mediaType}`);
      const target = join(home, `image-${index}.${extension}`);
      await writeFile(target, Buffer.from(media.data, "base64"), { mode: 0o600 });
      files.push(target);
    }
    options = await configure({ ...input, executable, servers: resources.servers, home, endpoint: relay.endpoint, env, files });
    if (input.toolPolicy.skills !== "disabled") {
      await stageSkills(input.skillsDirectories, options.skillsDir ?? join(home, ".agents", "skills"));
    }
    if (run === acpRun) {
      options.mcpServers = resources.servers;
    }
    const child = spawn(executable, [...prefix, ...options.args], {
      cwd: process.cwd(), env, stdio: ["pipe", "pipe", "inherit"], windowsHide: true,
    });
    const terminate = () => child.kill("SIGTERM");
    process.once("SIGTERM", terminate);
    const exited = new Promise((resolveExit, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => resolveExit({ code, signal }));
      child.stdin.on("error", error => { if (error.code !== "EPIPE") reject(error); });
    });
    try {
      const result = await run({ child, exited, options, input, home });
      emit({ type: "evaluator.result", ...result, usage: result.usage?.inputTokens === undefined ? relay.usage() : result.usage });
    } finally {
      child.stdin.destroy();
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
      await exited;
      process.removeListener("SIGTERM", terminate);
    }
  } catch (error) {
    // Do not print arbitrary native request/config objects, which can contain credentials.
    emit({ type: "evaluator.error", message: String(error.message ?? error) });
    process.exitCode = 1;
  } finally {
    resources?.close?.();
    relay?.close();
    await rm(home, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
}

export async function jsonlRun({ child, exited, options }, accept, finish) {
  child.stdin.end(options.input ?? "");
  for await (const event of nativeMessages(child.stdout)) {
    emit(event);
    accept(event);
  }
  const exit = await exited;
  const result = finish();
  if (exit.code !== 0 || exit.signal !== null) throw Error(`Native CLI exited with code ${exit.code}, signal ${exit.signal}`);
  return result;
}

/** Native ACP transports initial images as content, independently of model tools. */
export async function acpRun({ child, exited, input, options }) {
  let sequence = 0;
  let finalText = "";
  const pending = new Map();
  const send = (method, params, recordResponse = true) => new Promise((resolveRequest, reject) => {
    const id = ++sequence;
    pending.set(id, { resolve: resolveRequest, reject, recordResponse });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
  const failPending = error => { for (const p of pending.values()) p.reject(error); pending.clear(); };
  const reader = (async () => {
    try {
      for await (const message of nativeMessages(child.stdout)) {
        // Status queries can include project MCP configuration and credentials.
        if (message.method || pending.get(message.id)?.recordResponse !== false) emit({ type: "acp.message", message });
        if (message.method === "session/update") {
          const update = message.params?.update;
          if (update?.sessionUpdate === "tool_call") finalText = "";
          if (update?.sessionUpdate === "agent_message_chunk" && update.content?.type === "text") finalText += update.content.text;
        } else if (message.method && message.id !== undefined) {
          const option = message.params?.options?.find(item => item.kind === "allow_once" || item.kind === "allow_always");
          const result = { outcome: !option ? { outcome: "cancelled" }
            : { outcome: "selected", optionId: option.optionId } };
          child.stdin.write(JSON.stringify(message.method === "session/request_permission"
            ? { jsonrpc: "2.0", id: message.id, result }
            : { jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Client method not supported" } }) + "\n");
        } else if (message.id !== undefined) {
          const request = pending.get(message.id);
          pending.delete(message.id);
          if (message.error) request?.reject(Error(message.error.message));
          else request?.resolve(message.result);
        }
      }
      failPending(Error("Native ACP closed before replying"));
    } catch (error) {
      failPending(error);
      child.kill("SIGTERM");
      throw error;
    }
  })();
  reader.catch(() => {});
  try {
    const initialized = await send("initialize", { protocolVersion: 1, clientCapabilities: {} });
    const capabilities = initialized.agentCapabilities?.promptCapabilities;
    const attachments = (input.media ?? []).map(media => {
      if (media.mediaType === "application/pdf") {
        if (!capabilities?.embeddedContext) throw Error("Native ACP did not advertise embedded resource input for PDFs");
        return { type: "resource", resource: {
          uri: "file:///attachments/" + encodeURIComponent(media.name), mimeType: media.mediaType, blob: media.data,
        } };
      }
      if (!capabilities?.image) throw Error("Native ACP did not advertise image input");
      return { type: "image", mimeType: media.mediaType, data: media.data };
    });
    const transports = initialized.agentCapabilities?.mcpCapabilities ?? {};
    const mcpServers = [];
    for (const { name, transport, url } of options.mcpServers ?? []) {
      if (transports[transport]) mcpServers.push({ type: transport, name, url, headers: [] });
      else if (transport === "http" && !input.mcpServers?.some(server => server.name === name)) {
        // ACP requires stdio transport even when HTTP servers are optional.
        mcpServers.push({ name, command: process.execPath, args: [join(import.meta.dirname, "search-stdio.mjs"), url], env: [] });
      } else if ((input.mcpServers ?? []).some(server => server.name === name) || input.toolPolicy.webSearch === "enabled" && !options.nativeSearchUsesExa) {
        throw Error(`Native ACP does not support ${transport} MCP for ${name}`);
      }
    }
    const { sessionId } = await send("session/new", { cwd: process.cwd(), mcpServers });
    if (options.modeId) await send("session/set_mode", { sessionId, modeId: options.modeId });
    if (options.effortConfigId && input.reasoningEffort !== undefined) {
      await send("session/set_config_option", { sessionId, configId: options.effortConfigId, value: input.reasoningEffort });
    }
    await options.beforePrompt?.(send, sessionId);
    const result = await send("session/prompt", { sessionId, prompt: [
      { type: "text", text: input.prompt }, ...attachments,
    ] });
    if (result.stopReason !== "end_turn") throw Error(`Native ACP stopped: ${result.stopReason}`);
    if (!finalText.trim()) throw Error("Native ACP completed without a final answer");
    if (initialized.agentCapabilities?.sessionCapabilities?.close) await send("session/close", { sessionId });
    child.stdin.end();
    await reader;
    const exit = await exited;
    if (exit.code !== 0 || exit.signal !== null) throw Error(`Native ACP exited: ${exit.code}`);
    return { finalText, usage: result.usage ?? {} };
  } finally {
    child.stdin.end();
  }
}
