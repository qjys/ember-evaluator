import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { text } from "node:stream/consumers";
import { fetchWebPage, publicWebUrl } from "./web-fetch.mjs";

// Use only URLs returned by the backend's search result or citation fields.
function sources(entries) {
  const unique = new Map();
  for (const entry of entries) {
    const url = URL.parse(entry?.url);
    if (url && !url.username && !url.password && ["http:", "https:"].includes(url.protocol)) {
      unique.set(url.href, { url: url.href, title: typeof entry.title === "string" && entry.title ? entry.title : url.hostname });
    }
  }
  return [...unique.values()];
}

const EXA_URL = "https://mcp.exa.ai/mcp";
const EXA_REQUEST_TIMEOUT_MS = 30_000;
const FETCH_TEXT_LIMIT = 96 * 1024;

async function callExa(name, args, signal) {
  signal.throwIfAborted();
  const id = 1;
  const response = await fetch(EXA_URL + "?tools=" + name, {
    method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } }),
    signal: AbortSignal.any([signal, AbortSignal.timeout(EXA_REQUEST_TIMEOUT_MS)]), redirect: "error",
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw Error("Exa returned HTTP " + response.status);
  }
  let message;
  if (response.headers.get("content-type")?.includes("text/event-stream") && response.body) {
    let pending = "";
    for await (const chunk of response.body.pipeThrough(new TextDecoderStream())) {
      pending += chunk;
      const events = pending.split(/\r?\n\r?\n/u);
      pending = events.pop();
      for (const event of events) {
        const data = event.split(/\r?\n/u).filter(line => line.startsWith("data:")).map(line => line.slice(5).trimStart()).join("\n");
        if (!data) continue;
        const value = parseMcpJson(data);
        if (value.id === id) { message = value; break; }
      }
      if (message) break;
    }
  } else if (response.body) {
    message = parseMcpJson(await response.text());
  }
  if (!message?.result || message.error || message.result.isError) throw Error("Exa tool call failed");
  return (message.result.content ?? []).filter(block => block.type === "text" && typeof block.text === "string")
    .map(block => block.text).join("\n");
}

function parseMcpJson(value) {
  try { return JSON.parse(value); } catch { throw Error("Exa returned invalid JSON"); }
}

export async function searchWeb(query, signal) {
  if (typeof query !== "string" || !query.trim()) throw Error("web search requires a query");
  const content = await callExa("web_search_exa", { query, objective: query, numResults: 5 }, signal);
  const results = sources([...content.matchAll(/^Title: (.+)\r?\nURL: (https?:\/\/\S+)/gmu)]
    .map(match => ({ title: match[1], url: match[2] })));
  if (!results.length) throw Error("Exa returned no sources");
  return { backend: "exa", results, content };
}

export async function fetchWeb(rawUrl, allowedHosts, signal) {
  const url = publicWebUrl(rawUrl, allowedHosts).href;
  // A remote backend cannot enforce the task allowlist on redirects.
  if (allowedHosts) return { backend: "http-fetch", ...await fetchWebPage(url, allowedHosts, signal) };
  const body = await callExa("web_fetch_exa", { urls: [url] }, signal);
  if (!body.trim()) throw Error("Exa returned no page body");
  return { backend: "exa", url, body: body.slice(0, FETCH_TEXT_LIMIT), truncated: body.length > FETCH_TEXT_LIMIT };
}

// Stateless Streamable HTTP server inside the solve environment. The CLI sees
// a local capability URL. Supplementary requests do not carry model credentials.
export async function startSearchMcp(policy = {}, record, fetchPage) {
  const path = "/" + randomUUID();
  const lifetime = new AbortController();
  const tool = { name: "web_search", description: "Search public web sources. If your tool list has no native WebSearch, or native search returned no sources, call this tool directly. Its result includes source titles and URLs you can cite.",
    inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } };
  const tools = policy.webSearch === "disabled" ? [] : [tool];
  if (fetchPage) tools.push({ name: "web_fetch", description: "Read the actual body of a public HTTP or HTTPS webpage by URL when native WebFetch is unavailable or fails.",
    inputSchema: { type: "object", properties: { url: { type: "string" } }, required: ["url"] } });
  const server = createServer(async (req, res) => {
    if (req.url !== path) return res.writeHead(404).end();
    if (req.method !== "POST") return res.writeHead(405).end();
    const controller = new AbortController();
    res.once("close", () => controller.abort());
    let id = null;
    const send = data => res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id, ...data }));
    try {
      const message = JSON.parse(await text(req));
      id = message.id;
      if (id === undefined) return res.writeHead(202).end();
      let result;
      if (message.method === "initialize") result = { protocolVersion: message.params.protocolVersion,
        capabilities: { tools: {} }, serverInfo: { name: "evaluator-search", version: "1" } };
      else if (message.method === "tools/list") result = { tools };
      else if (message.method === "ping") result = {};
      else if (message.method === "tools/call" && tools.some(entry => entry.name === message.params.name)) {
        const isFetch = message.params.name === "web_fetch";
        try {
          const signal = AbortSignal.any([lifetime.signal, controller.signal]);
          const found = isFetch ? await fetchPage(message.params.arguments?.url, signal)
            : await searchWeb(message.params.arguments?.query, signal);
          await record?.(isFetch ? { operation: "fetch", backend: found.backend ?? "http-fetch", status: found.status, truncated: found.truncated }
            : { backend: found.backend, sources: found.results });
          result = { content: [{ type: "text", text: JSON.stringify(found) }] };
        } catch (error) {
          await record?.({ ...(isFetch ? { operation: "fetch" } : {}), failure: error.message });
          result = { isError: true, content: [{ type: "text", text: error.message }] };
        }
      } else return send({ error: { code: -32601, message: "Method not found" } });
      send({ result });
    } catch { if (!res.destroyed) send({ error: { code: -32600, message: "Invalid request" } }); }
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  return { url: "http://127.0.0.1:" + server.address().port + path, close() { lifetime.abort(); server.close(); server.closeAllConnections(); } };
}
