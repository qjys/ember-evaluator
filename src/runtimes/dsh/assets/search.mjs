import { fetchWeb, searchWeb } from "../../../infrastructure/network/web-search.mjs";

export const name = "evaluator-search";
export const inject = ["web"];

export function apply(ctx, policy) {
  const web = ctx.web;
  if (policy.search) installSearch(ctx, web);
  if (policy.fetch) installFetch(ctx, web, policy.allowedHosts);
}

function installSearch(ctx, web) {
  const originalSearch = web.search;
  const originalReady = web.searchReady;
  web.searchReady = async () => true;
  web.search = async function (request, signal = new AbortController().signal) {
    let reason;
    try {
      const native = await originalSearch.call(this, request, signal);
      if (native.sources.length) return native;
      reason = "no sources";
    } catch (error) {
      signal.throwIfAborted();
      reason = error.code ?? "search unavailable";
    }
    const found = await searchWeb(request.query, signal);
    const sources = found.results.slice(0, request.maxResults ?? found.results.length);
    return { sources, truncated: sources.length < found.results.length,
      content: ["Native search: " + reason, "Search backend: " + found.backend, found.content].filter(Boolean).join("\n") };
  };
  ctx.on("dispose", () => {
    web.search = originalSearch;
    web.searchReady = originalReady;
  });
}

function installFetch(ctx, web, allowedHosts) {
  const originalFetch = web.fetch;
  const originalReady = web.fetchReady;
  web.fetchReady = async () => true;
  web.fetch = async function (request, signal = new AbortController().signal) {
    let native;
    try {
      native = await originalFetch.call(this, request, signal);
      if (native?.body?.content?.trim() && native.statusCode >= 200 && native.statusCode < 300) return native;
    } catch {
      signal.throwIfAborted();
    }
    let found;
    try {
      found = await fetchWeb(request.url, allowedHosts, signal);
    } catch (error) {
      signal.throwIfAborted();
      if (native) return native;
      throw error;
    }
    const kind = found.contentType === "text/html" ? "html" : "text";
    return { url: found.url, statusCode: found.status ?? 200, truncated: found.truncated,
      body: { kind, content: found.body } };
  };
  ctx.on("dispose", () => {
    web.fetch = originalFetch;
    web.fetchReady = originalReady;
  });
}
