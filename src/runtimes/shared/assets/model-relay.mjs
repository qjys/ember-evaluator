import { createServer } from "node:http";
import { buffer, text } from "node:stream/consumers";
import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";

const routes = {
  "openai-completions": ["/chat/completions"],
  "openai-responses": ["/responses"],
  "anthropic-messages": ["/messages", "/messages/count_tokens"],
};
const requestHeaders = ["accept", "anthropic-beta", "anthropic-version", "content-type", "user-agent"];
const responseHeaders = ["content-type", "retry-after", "request-id"];
function restrictBuiltinTools(payload, isMcpTool) {
  const allowed = new Set();
  const tools = (payload.tools ?? []).filter(tool => {
    const name = tool.function?.name ?? tool.name;
    if (typeof name !== "string" || !isMcpTool(name)) return false;
    if (tool.type === "namespace") {
      tool.tools = (tool.tools ?? []).filter(member => member.type === "function" && typeof member.name === "string");
      if (!tool.tools.length) return false;
      for (const member of tool.tools) allowed.add(name + "." + member.name);
    } else {
      if (tool.type !== undefined && tool.type !== "function" && tool.type !== "custom") return false;
      allowed.add(name);
      // MCP tools must be directly callable even when the CLI normally defers
      // them behind a built-in tool discovery function.
      delete tool.defer_loading;
    }
    return true;
  });
  if (tools.length) payload.tools = tools;
  else {
    delete payload.tools;
    delete payload.parallel_tool_calls;
  }
  delete payload.tool_choice;
  delete payload.functions;
  delete payload.function_call;
  return allowed;
}

// Chat Completions can split function names across SSE chunks. Hold tool events
// until the entire name has been checked against this request's declarations.
function toolResponseGuard(allowed) {
  const fragments = new Map();
  let seen = false;
  function check(name) {
    seen = true;
    if (!allowed.has(name)) throw Error("Model returned a tool that was not offered");
  }
  function inspectItem(item) {
    if (!item) return;
    if (item.type === "function_call" || item.type === "tool_use") {
      check(item.namespace ? item.namespace + "." + item.name : item.name);
    } else if (item.type === "server_tool_use" || item.type?.endsWith("_call")) {
      check(undefined);
    }
  }
  return {
    inspect(event) {
      for (const choice of event.choices ?? []) {
        if (choice.delta?.function_call || choice.message?.function_call) check(undefined);
        for (const call of choice.message?.tool_calls ?? []) check(call.function?.name);
        for (const call of choice.delta?.tool_calls ?? []) {
          seen = true;
          const key = (choice.index ?? 0) + ":" + (call.index ?? 0);
          fragments.set(key, (fragments.get(key) ?? "") + (call.function?.name ?? ""));
        }
      }
      inspectItem(event.content_block);
      inspectItem(event.item);
      for (const item of event.output ?? event.response?.output ?? event.content ?? []) inspectItem(item);
      return seen;
    },
    finish() { for (const name of fragments.values()) check(name); },
  };
}

export async function startModelRelay({ api, baseUrl, apiKey, token, maxTokens, disableBuiltinTools = false, disableMcp = false, isMcpTool = name => name.startsWith("mcp__"), disableHostedSearch = false, disableWebFetch = false, completeWebTools, captureUsage = false, maxModelCalls }) {
  const anthropic = api === "anthropic-messages";
  const base = anthropic && !baseUrl.endsWith("/v1") ? baseUrl + "/v1" : baseUrl;
  const totals = { inputTokens: 0, outputTokens: 0, reported: false };
  let messagesAuthHeader = "x-api-key";
  let modelCalls = 0;
  const server = createServer(async (request, response) => {
    const authorized = request.headers.authorization === "Bearer " + token
      || (anthropic && request.headers["x-api-key"] === token);
    if (!authorized) return response.writeHead(401).end();
    const url = URL.parse(request.url, "http://localhost");
    const route = routes[api]?.find(path => url?.pathname === "/v1" + path);
    if (request.method !== "POST" || !route) return response.writeHead(404).end();
    const controller = new AbortController();
    response.once("close", () => controller.abort());
    try {
      const counted = route !== "/messages/count_tokens" && maxModelCalls !== undefined;
      if (counted && modelCalls >= maxModelCalls) {
        response.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ error: {
          type: "invalid_request_error", code: "MAX_TURNS_EXCEEDED", message: `The configured maxTurns limit (${maxModelCalls}) was reached` } }));
        return;
      }
      const headers = new Headers();
      for (const name of requestHeaders) {
        const value = request.headers[name];
        if (typeof value === "string") headers.set(name, value);
      }
      let body = request;
      let guard;
      let observeSearchResponse;
      if (disableBuiltinTools || disableHostedSearch || disableWebFetch || completeWebTools ||
          (maxTokens !== undefined && route !== "/messages/count_tokens")) {
        const payload = JSON.parse(await text(request));
        if (maxTokens !== undefined && route !== "/messages/count_tokens") {
          const key = api === "openai-responses" ? "max_output_tokens" : api === "openai-completions" && payload.max_completion_tokens !== undefined ? "max_completion_tokens" : "max_tokens";
          delete payload.max_tokens;
          delete payload.max_completion_tokens;
          delete payload.max_output_tokens;
          payload[key] = maxTokens;
        }
        if (disableBuiltinTools || disableHostedSearch) {
          // Suppress standard hosted search when the task disallows it. Deployment routes
          // must honor the request tool declarations rather than injecting automatic web access.
          delete payload.web_search_options;
          if (payload.extra_body) delete payload.extra_body.web_search_options;
        }
        if (disableBuiltinTools) {
          guard = toolResponseGuard(restrictBuiltinTools(payload, name => !disableMcp && isMcpTool(name)));
        } else if (disableHostedSearch || disableWebFetch) {
          const blocked = tool => {
            const name = tool?.function?.name ?? tool?.name;
            return (disableHostedSearch && (/^web_search(?:$|_)/u.test(tool?.type) || /^(?:web_?search|search_web)$/iu.test(name)))
              || (disableWebFetch && (/^web_fetch(?:$|_)/u.test(tool?.type) || /^(?:web_?fetch|fetchurl)$/iu.test(name)));
          };
          if (Array.isArray(payload.tools)) payload.tools = payload.tools.filter(tool => !blocked(tool));
          if (Array.isArray(payload.functions)) payload.functions = payload.functions.filter(tool => !blocked(tool));
          if (blocked(payload.tool_choice)) delete payload.tool_choice;
          if (blocked(payload.function_call)) delete payload.function_call;
        }
        if (completeWebTools && !disableBuiltinTools && route !== "/messages/count_tokens") {
          const observe = await completeWebTools(payload, controller.signal);
          if (api === "openai-responses") observeSearchResponse = observe;
        }
        body = JSON.stringify(payload);
      } else if (anthropic) {
        // A rejected Messages request can be replayed with the other auth header.
        body = await buffer(request);
      }
      if (counted) modelCalls++;
      let upstream;
      try {
        let authHeader = anthropic ? messagesAuthHeader : "authorization";
        const send = () => {
          headers.set(authHeader, authHeader === "authorization" ? "Bearer " + apiKey : apiKey);
          return fetch(base + route + url.search, {
            method: "POST", headers, body, duplex: "half", redirect: "error", signal: controller.signal,
          });
        };
        upstream = await send();
        if (anthropic && upstream.status === 401) {
          await upstream.body?.cancel();
          headers.delete(authHeader);
          authHeader = authHeader === "x-api-key" ? "authorization" : "x-api-key";
          upstream = await send();
        }
        if (anthropic && upstream.ok) messagesAuthHeader = authHeader;
      } catch (error) {
        if (counted) modelCalls--;
        throw error;
      }
      if (!upstream.ok) {
        if (counted) modelCalls--;
        observeSearchResponse = undefined;
      }
      for (const name of responseHeaders) {
        const value = upstream.headers.get(name);
        if (value !== null) response.setHeader(name, value);
      }
      response.writeHead(upstream.status);
      if (upstream.body && (guard || captureUsage || observeSearchResponse) && upstream.headers.get("content-type")?.includes("text/event-stream")) {
        let pending = "";
        const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
        let usage;
        let held;
        const commitUsage = () => {
          if (!captureUsage || !usage) return;
          const input = usage.prompt_tokens ?? usage.input_tokens;
          const output = usage.completion_tokens ?? usage.output_tokens;
          if (Number.isSafeInteger(input) && Number.isSafeInteger(output)) {
            totals.reported = true;
            totals.inputTokens += input + (anthropic ? (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0) : 0);
            totals.outputTokens += output;
          }
        };
        const inspect = frame => {
          const data = frame.split(/\r?\n/u).filter(line => line.startsWith("data:")).map(line => line.slice(5)).join("\n").trim();
          if (!data || data === "[DONE]") return;
          let event;
          try { event = JSON.parse(data); } catch (error) { if (guard) throw error; return; }
          observeSearchResponse?.(event);
          if (guard?.inspect(event)) held ??= [];
          const current = event.usage ?? event.message?.usage ?? event.response?.usage;
          if (current) usage = { ...usage, ...current };
        };
        const inspector = new Transform({
          transform(chunk, _encoding, callback) {
            try {
              pending += decoder.decode(chunk, { stream: true });
              let boundary;
              while ((boundary = /\r?\n\r?\n/u.exec(pending))) {
                const end = boundary.index + boundary[0].length;
                const frame = pending.slice(0, end);
                pending = pending.slice(end);
                inspect(frame);
                if (held) held.push(frame);
                else this.push(frame);
              }
              callback();
            } catch (error) { callback(error); }
          },
          flush(callback) {
            try { pending += decoder.decode(); inspect(pending); guard?.finish();
              if (held) for (const line of held) this.push(line);
              this.push(pending); commitUsage(); callback(); }
            catch (error) { callback(error); }
          },
        });
        await pipeline(upstream.body, inspector, response, { signal: controller.signal });
      }
      else if (upstream.body && (guard || observeSearchResponse) && upstream.headers.get("content-type")?.includes("application/json")) {
        const payload = await upstream.text();
        const event = JSON.parse(payload);
        observeSearchResponse?.(event);
        guard?.inspect(event);
        guard?.finish();
        response.end(payload);
      }
      else if (upstream.body) await pipeline(upstream.body, response, { signal: controller.signal });
      else response.end();
    } catch {
      if (response.destroyed) return;
      if (response.headersSent) response.destroy();
      else response.writeHead(502, { "content-type": "application/json" })
        .end(JSON.stringify({ error: { message: "Model relay could not reach its upstream" } }));
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return {
    endpoint: "http://127.0.0.1:" + server.address().port + "/v1",
    usage() { return totals.reported ? { inputTokens: totals.inputTokens, outputTokens: totals.outputTokens, totalTokens: totals.inputTokens + totals.outputTokens } : {}; },
    close() {
      server.close();
      server.closeAllConnections();
    },
  };
}
