import { afterEach, expect, test, vi } from "vitest";
import { createServer } from "node:http";
import { text } from "node:stream/consumers";
import { startModelRelay } from "../../src/runtimes/shared/assets/model-relay.mjs";
import { fetchWeb, searchWeb } from "../../src/infrastructure/network/web-search.mjs";
import { nativeWebFallback, taskServers } from "../../src/runtimes/shared/assets/task-resources.mjs";
import { fetchWebPage } from "../../src/infrastructure/network/web-fetch.mjs";

const signal = new AbortController().signal;
const source = { title: "Source", url: "https://docs.example.org/page" };
afterEach(() => vi.unstubAllGlobals());

test.each([
  [{ webSearch: "disabled", webFetch: "enabled" }, ["web_fetch"], "web_search"],
  [{ webSearch: "enabled", webFetch: "disabled" }, ["web_search"], "web_fetch"],
])("the MCP rejects calls to the missing tool as well as omitting it from discovery", async (toolPolicy, expected, missing) => {
  const fetchPage = vi.fn();
  const resources = await taskServers({ toolPolicy }, false, toolPolicy.webFetch === "enabled" ? fetchPage : undefined);
  const call = async (method, params) => (await fetch(resources.servers[0].url, { method: "POST",
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) })).json();
  try {
    const listing = await call("tools/list", {});
    expect(listing.result.tools.map(tool => tool.name)).toEqual(expected);
    expect((await call("tools/call", { name: missing, arguments: {} })).error.code).toBe(-32601);
    expect(fetchPage).not.toHaveBeenCalled();
  } finally {
    resources.close();
  }
});

test("Codex fetch rejects private URLs and out-of-scope domains before connecting", async () => {
  for (const url of ["file:///a", "https://u:p@example.com", "http://127.0.0.1", "http://[::1]", "http://localhost"]) {
    await expect(fetchWebPage(url, undefined, signal)).rejects.toThrow(/public HTTP/u);
  }
  await expect(fetchWebPage("https://example.org", ["*.example.org"], signal)).rejects.toThrow(/allowlist/u);
});

const exaReply = () => Response.json({ result: { content: [{ type: "text", text: "Title: Source\nURL: " + source.url }] } });

test("direct supplementary search uses public Exa without model credentials", async () => {
  const fetch = vi.fn(exaReply);
  vi.stubGlobal("fetch", fetch);
  expect(await searchWeb("query", signal)).toMatchObject({ backend: "exa", results: [source] });
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(fetch.mock.calls[0][0]).toBe("https://mcp.exa.ai/mcp?tools=web_search_exa");
  expect(fetch.mock.calls[0][1].headers).not.toHaveProperty("authorization");
});

test("reads the matching Exa result from a streaming MCP response", async () => {
  const fetch = vi.fn(async (_url, options) => {
    const request = JSON.parse(options.body);
    expect(request.params).toEqual({ name: "web_search_exa", arguments: { query: "query", objective: "query", numResults: 5 } });
    const event = JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { content: [{ type: "text", text: "Title: Source\nURL: " + source.url }] } });
    return new Response("data: {\"method\":\"notifications/progress\"}\n\ndata: " + event + "\n\n", {
      headers: { "content-type": "text/event-stream" },
    });
  });
  vi.stubGlobal("fetch", fetch);
  expect(await searchWeb("query", signal)).toMatchObject({ backend: "exa", results: [source] });
  expect(fetch).toHaveBeenCalledTimes(1);
});

test("reports Exa HTTP failure without returning its response body", async () => {
  const fetch = vi.fn(async () => Response.json({ error: "private-value" }, { status: 503 }));
  vi.stubGlobal("fetch", fetch);
  await expect(searchWeb("query", signal)).rejects.toThrow(/^Exa returned HTTP 503$/u);
  expect(fetch).toHaveBeenCalledTimes(1);
});

test("supplementary fetch calls Exa directly for a public URL, with no external fallback for blocked domains", async () => {
  const fetch = vi.fn(async (url, options) => {
    expect(url).toBe("https://mcp.exa.ai/mcp?tools=web_fetch_exa");
    expect(options.headers).not.toHaveProperty("authorization");
    expect(JSON.parse(options.body).params).toEqual({ name: "web_fetch_exa", arguments: { urls: ["https://example.org/"] } });
    return Response.json({ result: { content: [{ type: "text", text: "Fetched page text" }] } });
  });
  vi.stubGlobal("fetch", fetch);
  await expect(fetchWeb("https://example.org", ["other.example.org"], signal)).rejects.toThrow(/allowlist/u);
  await expect(fetchWeb("http://127.0.0.1/", undefined, signal)).rejects.toThrow(/public HTTP/u);
  expect(fetch).not.toHaveBeenCalled();
  expect(await fetchWeb("https://example.org", undefined, signal)).toMatchObject({ backend: "exa", body: "Fetched page text" });
  expect(fetch).toHaveBeenCalledTimes(1);
});

test("project and task MCP names are both reserved for supplementary search", async () => {
  const task = { name: "evaluator-search-fallback", transport: "http", url: "http://localhost/task" };
  const resources = await taskServers({ mcpServers: [task] }, false, undefined, async () => ["evaluator-search"]);
  try {
    expect(resources.servers.map(server => server.name)).toEqual([task.name, "evaluator-search-fallback-fallback"]);
    expect(resources.servers[0]).toEqual(task);
  } finally { resources.close(); }
});

test("restricted attempts never start the supplementary MCP search server", async () => {
  const server = { name: "task", url: "http://localhost/task", transport: "http" };
  for (const toolPolicy of [{ mcp: "disabled" }, { tools: "none", mcp: "disabled" }]) {
    expect(await taskServers({ mcpServers: [server], toolPolicy })).toEqual({ servers: [] });
  }
  expect(await taskServers({ mcpServers: [server], toolPolicy: { tools: "none" } })).toEqual({ servers: [server] });
  expect(await taskServers({ mcpServers: [server], toolPolicy: { webSearch: "disabled" } })).toEqual({ servers: [server] });
});

test("native search runs first and its empty result receives one supplementary result across retries", async () => {
  const complete = nativeWebFallback("http://localhost/fixture", "evaluator-search");
  const fetch = vi.fn(async () => Response.json({ result: { content: [{ text: JSON.stringify({ backend: "exa", results: [source] }) }] } }));
  vi.stubGlobal("fetch", fetch);
  const request = { tools: ["websearch", "evaluator-search_web_search", "read"].map(name => ({ function: { name } })),
    messages: [{ role: "assistant", tool_calls: [{ id: "call-1", function: { name: "websearch", arguments: '{"query":"example"}' } }] },
      { role: "tool", tool_call_id: "call-1", content: "Error: missing native credentials" }] };
  for (let retry = 0; retry < 2; retry++) {
    const payload = structuredClone(request);
    await complete(payload, signal);
    expect(payload.tools.map(tool => tool.function.name)).toEqual(["websearch", "read"]);
    expect(payload.messages[1].content).toContain(source.url);
  }
  expect(fetch).toHaveBeenCalledTimes(1);
  const success = structuredClone(request);
  success.messages[1].content = "Title: Source\nURL: " + source.url;
  await complete(success, signal);
  expect(success.messages[1].content).not.toContain("Supplementary");
  expect(fetch).toHaveBeenCalledTimes(1);
});

test.each([
  { input: [{ type: "function_call", call_id: "a", name: "web_search", arguments: '{"query":"official docs"}' },
    { type: "function_call_output", call_id: "a", output: "No search results" }] },
  { messages: [{ role: "assistant", content: [{ type: "tool_use", id: "a", name: "WebSearch", input: { query: "official docs" } }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "a", is_error: true, content: [{ type: "text", text: "HTTP 403" }] }] }] },
])("supplements paired tool results across API protocols", async request => {
  const fetch = vi.fn(async () => Response.json({ result: { content: [{ text: JSON.stringify({ backend: "exa", results: [source] }) }] } }));
  vi.stubGlobal("fetch", fetch);
  await nativeWebFallback("http://localhost/fixture", "evaluator-search")(request, signal);
  expect(JSON.stringify(request)).toContain(source.url);
  expect(fetch).toHaveBeenCalledTimes(1);
});

test.each([false, true])("Responses continuation falls back using the model-emitted call (stream=%s)", async stream => {
  const queries = [];
  const outputs = [];
  const server = createServer(async (req, res) => {
    const body = JSON.parse(await text(req));
    if (req.url === "/search") {
      queries.push(body.params.arguments.query);
      res.end(JSON.stringify({ result: { content: [{ text: JSON.stringify({ backend: "exa", results: [source] }) }] } }));
      return;
    }
    if (body.previous_response_id) outputs.push({ model: body.model, output: body.input[0].output });
    const item = { type: "function_call", call_id: "same-id", name: "web_search", arguments: JSON.stringify({ query: body.input }) };
    const result = { object: "response", id: "resp-" + (body.previous_response_id ?? body.input), output: body.previous_response_id ? [] : [item] };
    if (stream) {
      res.writeHead(200, { "content-type": "text/event-stream" });
      for (const output of result.output) res.write("data: " + JSON.stringify({ type: "response.output_item.done", item: output }) + "\n\n");
      res.end("data: " + JSON.stringify({ type: "response.completed", response: { ...result, output: [] } }) + "\n\n");
    } else {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(result));
    }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const base = "http://127.0.0.1:" + server.address().port;
  const relay = await startModelRelay({ api: "openai-responses", baseUrl: base, apiKey: "fixture", token: "test",
    completeWebTools: nativeWebFallback(base + "/search", "evaluator-search") });
  try {
    const post = async payload => {
      const reply = await fetch(relay.endpoint + "/responses", { method: "POST", headers: { authorization: "Bearer test" },
        body: JSON.stringify({ stream, ...payload }) });
      expect(reply.status).toBe(200);
      await reply.text();
    };
    for (const input of ["first", "second"]) await post({ input, model: "route-" + input });
    for (const previous_response_id of ["resp-second", "resp-first", "unrelated", "resp-first"]) {
      await post({ previous_response_id, input: [{ type: "function_call_output", call_id: "same-id", output: "Error: unavailable" }] });
    }
    await post({ model: "explicit-route", previous_response_id: "resp-first",
      input: [{ type: "function_call_output", call_id: "same-id", output: "Error: unavailable" }] });
    expect(queries).toEqual(["second", "first"]);
    expect(outputs.map(item => item.model)).toEqual(["route-second", "route-first", undefined, "route-first", "explicit-route"]);
    expect(outputs.map(item => item.output.includes(source.url))).toEqual([true, true, false, true, true]);
  } finally {
    relay.close();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});

test("per-query domain restrictions never reach an unrestricted fallback", async () => {
  const fetch = vi.fn();
  vi.stubGlobal("fetch", fetch);
  const payload = { messages: [{ role: "assistant", tool_calls: [{ id: "a", function: { name: "WebSearch",
    arguments: JSON.stringify({ query: "docs", allowed_domains: ["docs.example.org"] }) } }] },
    { role: "tool", tool_call_id: "a", content: "No results" }] };
  await nativeWebFallback("http://localhost/fixture", "evaluator-search")(payload, signal);
  expect(fetch).not.toHaveBeenCalled();
});

test("native fetch wins, and a failed call gets only the corresponding supplemental result", async () => {
  const complete = nativeWebFallback("http://localhost/fixture", "evaluator-search", undefined, "native", true, false);
  const fetch = vi.fn(async (_url, options) => {
    expect(JSON.parse(options.body).params).toEqual({ name: "web_fetch", arguments: { url: source.url } });
    return Response.json({ result: { content: [{ text: JSON.stringify({ backend: "exa", body: "fixture body" }) }] } });
  });
  vi.stubGlobal("fetch", fetch);
  const request = {
    tools: ["WebFetch", "evaluator-search_web_fetch"].map(name => ({ name })),
    messages: [{ role: "assistant", content: [
      { type: "tool_use", name: "WebFetch", id: "success", input: { url: source.url } },
      { type: "tool_use", name: "WebFetch", id: "failure", input: { url: source.url } },
    ] }, { role: "user", content: [
      { type: "tool_result", tool_use_id: "success", content: "native body" },
      { type: "tool_result", tool_use_id: "failure", content: "HTTP 403 Forbidden" },
    ] }],
  };
  await complete(request, signal);
  expect(request.tools).toEqual([{ name: "WebFetch" }]);
  expect(request.messages[1].content[0].content).toBe("native body");
  expect(request.messages[1].content[1].content).toContain("fixture body");
  expect(fetch).toHaveBeenCalledTimes(1);
});

test.each([true, false])("Qwen deferred WebFetch respects fetch policy and pairs results by outer call ID (enabled=%s)", async enabled => {
  const fetch = vi.fn(async () => Response.json({ result: { content: [{ text: "supplementary page" }] } }));
  vi.stubGlobal("fetch", fetch);
  const complete = nativeWebFallback("http://localhost/fixture", "evaluator-search", undefined, "native", enabled);
  const toolCall = (id, name, args) => ({ id, function: { name: "tool_call", arguments: JSON.stringify({ name, arguments: args }) } });
  const calls = [
    toolCall("failed", "web_fetch", { url: source.url, prompt: "Extract the heading." }),
    toolCall("ok", "web_fetch", { url: "https://example.org/other" }),
    toolCall("unrelated", "read_file", { url: source.url }),
  ];
  const results = [
    { role: "tool", tool_call_id: "ok", content: "native page" },
    { role: "tool", tool_call_id: "unrelated", content: "Error: file unavailable" },
    { role: "tool", tool_call_id: "failed", content: "HTTP 403 Forbidden" },
  ];
  await complete({ messages: [{ role: "assistant", tool_calls: calls }, ...results] }, signal);
  expect(results.map(result => result.content)).toEqual(["native page", "Error: file unavailable",
    enabled ? "HTTP 403 Forbidden\nSupplementary web fetch: supplementary page" : "HTTP 403 Forbidden"]);
  expect(fetch).toHaveBeenCalledTimes(enabled ? 1 : 0);
  if (enabled) expect(JSON.parse(fetch.mock.calls[0][1].body).params).toEqual({ name: "web_fetch", arguments: { url: source.url } });
});
