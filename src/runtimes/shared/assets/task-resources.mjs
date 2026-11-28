import { appendFile, cp, mkdir, readdir, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { fetchWeb, startSearchMcp } from "../../../infrastructure/network/web-search.mjs";

async function hasSkill(directory) {
  try { return (await stat(join(directory, "SKILL.md"))).isFile(); }
  catch (error) { if (error.code === "ENOENT") return false; throw error; }
}

// Task paths are inside the solve environment. Each CLI receives its own
// attempt-local skill tree; installing a task never mutates the source bundle.
export async function stageSkills(directories, destination) {
  for (const directory of directories ?? []) {
    const candidates = await hasSkill(directory) ? [directory] : (await readdir(directory, { withFileTypes: true }))
      .filter(entry => entry.isDirectory()).map(entry => join(directory, entry.name));
    for (const candidate of candidates) {
      if (!await hasSkill(candidate)) continue;
      await mkdir(destination, { recursive: true });
      await cp(candidate, join(destination, basename(candidate)), { recursive: true, force: false, errorOnExist: true });
    }
  }
}

export async function taskServers(input, nativeSearchUsesExa = false, fetchPage, configuredNames) {
  const policy = input.toolPolicy ?? {};
  if (policy.mcp === "disabled") return { servers: [] };
  const servers = [...(input.mcpServers ?? [])];
  const network = input.fetchNetwork;
  if (policy.webFetch === "disabled" || network === "none" || network === "model-api") fetchPage = undefined;
  else if (!fetchPage && network !== undefined) fetchPage = (url, signal) => fetchWeb(url, network?.allowedHosts, signal);
  if (policy.tools === "none" || policy.webSearch === "disabled" && !fetchPage) return { servers };
  const reserved = new Set([...servers.map(server => server.name), ...(configuredNames ? await configuredNames() : [])]);
  let name = "evaluator-search";
  while (reserved.has(name)) name += "-fallback";
  const record = input.outputDir ? async event => {
    await mkdir(input.outputDir, { recursive: true });
    const fetch = event.operation === "fetch";
    await appendFile(join(input.outputDir, fetch ? "web-fetch.jsonl" : "web-search.jsonl"),
      JSON.stringify({ tool: name + (fetch ? "/web_fetch" : "/web_search"), ...event }) + "\n", { mode: 0o600 });
  } : undefined;
  const search = await startSearchMcp(policy, record, fetchPage);
  servers.push({ name, transport: "http", url: search.url });
  return { servers, close: search.close, completeWebTools:
    nativeWebFallback(search.url, name, record, nativeSearchUsesExa ? "exa" : "native", Boolean(fetchPage), policy.webSearch !== "disabled") };
}

// A few CLIs expose web tools as model functions but have no post-tool hook.
// Complete the actual tool result on the next model turn, also for child agents.
// Keep the original result in the native transcript and reuse results on retries.
export function nativeWebFallback(url, serverName, record, nativeBackend = "native", fetchEnabled = false, searchEnabled = true) {
  const nativeOperation = name => searchEnabled && /^(?:web_?search|search_web)$/iu.test(name) ? "web_search"
    : fetchEnabled && /^(?:web_?fetch|fetchurl)$/iu.test(name) ? "web_fetch" : undefined;
  const supplementary = (name, operation) => name === "mcp__" + serverName + "__" + operation || name === serverName + "_" + operation;
  const completed = new Map();
  const recorded = new Set();
  const pendingResponses = new Map();
  return async (payload, signal) => {
    const nameOf = tool => tool?.function?.name ?? tool?.name;
    if (!payload.previous_response_id && Array.isArray(payload.tools)) {
      const native = new Set(payload.tools.map(tool => nativeOperation(nameOf(tool))).filter(Boolean));
      if (native.size) payload.tools = payload.tools.filter(tool => ![...native].some(operation => supplementary(nameOf(tool), operation)));
    }
    const previous = pendingResponses.get(payload.previous_response_id);
    // Some gateways require the original model alias to route an output-only continuation.
    if (payload.model === undefined && previous?.model !== undefined) payload.model = previous.model;
    const calls = new Map(previous?.calls);
    const remember = (id, name, args) => {
      if (!id) return;
      calls.delete(id);
      // Qwen dispatches a deferred web_fetch through tool_call and replies with the outer ID.
      const deferredFetch = fetchEnabled && name === "tool_call";
      const operation = deferredFetch ? "web_fetch" : nativeOperation(name);
      if (!operation) return;
      if (typeof args === "string") {
        try { args = JSON.parse(args); } catch { return; }
      }
      if (deferredFetch) {
        if (args?.name !== "web_fetch") return;
        name = args.name;
        args = args.arguments;
      }
      const value = operation === "web_fetch" ? args?.url : args?.query ?? args?.search_query;
      if (typeof value !== "string" || !value.trim()) return;
      if (Object.keys(args).some(key => /domain|site|filter/iu.test(key) && args[key]?.length)) return;
      calls.set(id, { name, value, operation });
    };
    const complete = async (block, field, id, failed) => {
      const call = calls.get(id);
      if (!call) return;
      const { name, value, operation } = call;
      const isFetch = operation === "web_fetch";
      const content = block[field];
      const original = Array.isArray(content) ? content.map(part => part?.text ?? JSON.stringify(part)).join("\n")
        : typeof content === "string" ? content : JSON.stringify(content ?? "");
      // Only use addresses present in the native tool output. An error can
      // itself contain a help URL, so HTTP/tool errors still need a fallback.
      const nativeError = failed || /^(?:error|failed|HTTP\s+[45]\d{2}\b|\{\s*"(?:error|isError)")|tool_(?:auth|request_failed)|unauthorized|no (?:search )?results/iu.test(original.trimStart());
      const urls = nativeError ? [] : [...original.matchAll(/(?:\bURL:\s*|"(?:url|link)"\s*:\s*"|\]\()(https?:\/\/[^\s<>"\\)]+)/giu)]
        .map(match => URL.parse(match[1])).filter(link => link && !link.username && !link.password);
      const usable = isFetch ? !nativeError && original.trim().length > 0 : urls.length > 0;
      const key = JSON.stringify([id, operation, value]);
      if (record && !recorded.has(key)) {
        recorded.add(key);
        await record({ tool: name, origin: "native", backend: isFetch ? "native" : nativeBackend,
          ...(isFetch ? { operation: "fetch" } : {}),
          ...(usable ? (isFetch ? {} : { sources: [...new Set(urls.map(link => link.href))].map(url => ({ url })) })
            : { failure: nativeError ? "native tool returned an error" : "native tool returned no content" }) });
      }
      if (usable) return;
      let pending = completed.get(key);
      if (!pending) {
        pending = (async () => {
          const response = await fetch(url, { method: "POST", signal, redirect: "error",
            headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1,
              method: "tools/call", params: { name: operation, arguments: isFetch ? { url: value } : { query: value } } }) });
          if (!response.ok) throw Error("Supplementary web tool returned HTTP " + response.status);
          const reply = await response.json();
          const content = reply.result?.content?.[0]?.text;
          if (typeof content !== "string") throw Error("Supplementary web tool returned no result");
          if (reply.result.isError) return "Supplementary web tool failed: " + content;
          if (isFetch) return content;
          const found = JSON.parse(content);
          return JSON.stringify({ backend: found.backend, sources: found.results });
        })();
        completed.set(key, pending);
      }
      try {
        const extra = "\nSupplementary web " + (isFetch ? "fetch: " : "search: ") + await pending;
        if (typeof block[field] === "string") block[field] += extra;
        else if (Array.isArray(block[field])) block[field].push({ type: field === "output" ? "input_text" : "text", text: extra });
      } catch (error) {
        completed.delete(key);
        signal.throwIfAborted();
        throw error;
      }
    };
    for (const message of Array.isArray(payload.messages) ? payload.messages : []) {
      if (message.role === "assistant") {
        for (const call of message.tool_calls ?? []) remember(call.id, call.function?.name, call.function?.arguments);
        for (const block of Array.isArray(message.content) ? message.content : []) {
          if (block.type === "tool_use") remember(block.id, block.name, block.input);
        }
      } else if (message.role === "tool") await complete(message, "content", message.tool_call_id, false);
      else if (message.role === "user" && Array.isArray(message.content)) {
        for (const block of message.content) {
          if (block.type === "tool_result") await complete(block, "content", block.tool_use_id, block.is_error);
        }
      }
    }
    for (const item of Array.isArray(payload.input) ? payload.input : []) {
      if (item.type === "function_call") remember(item.call_id, item.name, item.arguments);
      else if (item.type === "function_call_output") {
        await complete(item, "output", item.call_id, false);
        calls.delete(item.call_id);
      }
    }
    // Responses clients can send only an output on the next HTTP request.
    // Associate model-emitted calls with their response so parallel agents stay independent.
    return event => {
      if (event.type === "response.output_item.done" && event.item?.type === "function_call") {
        remember(event.item.call_id, event.item.name, event.item.arguments);
      }
      const result = event.response ?? event;
      if (!result.id || !(event.type === "response.completed" || event.object === "response")) return;
      for (const item of result.output ?? []) {
        if (item.type === "function_call") remember(item.call_id, item.name, item.arguments);
      }
      if (calls.size) pendingResponses.set(result.id, { model: payload.model, calls: new Map(calls) });
    };
  };
}

export function nativeMcpConfig(servers) {
  return { mcpServers: Object.fromEntries(servers.map(({ name, transport, url }) => [name, { type: transport, url }])) };
}
