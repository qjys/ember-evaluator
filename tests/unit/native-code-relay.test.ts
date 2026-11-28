import { createServer } from "node:http";
import { expect, test } from "vitest";

const moduleUrl = new URL("../../src/runtimes/shared/assets/model-relay.mjs", import.meta.url);
const { startModelRelay } = await import(moduleUrl.href);
const { nativeMessages } = await import(new URL("../../src/runtimes/shared/assets/native-code-launch.mjs", import.meta.url).href);

test("native output preserves split UTF-8 and rejects corrupt or truncated records", async () => {
  async function* chunks(...values: Uint8Array[]) { yield* values; }
  const line = Buffer.from('{"type":"text","text":"鲸🐳"}\n');
  const parsed = [];
  for await (const event of nativeMessages(chunks(...[...line].map(byte => Uint8Array.of(byte))))) parsed.push(event);
  expect(parsed).toEqual([{ type: "text", text: "鲸🐳" }]);
  const read = async (bytes: Uint8Array) => { for await (const _event of nativeMessages(chunks(bytes))) { /* Drain controlled output. */ } };
  await expect(read(Buffer.from('{"type":"text"}'))).rejects.toThrow(/incomplete/u);
  await expect(read(Buffer.from('{not json}\n'))).rejects.toThrow(/invalid JSONL/u);
  await expect(read(Buffer.from([0xff, 0x0a]))).rejects.toThrow();
});

test.each(["openai-completions", "openai-responses", "anthropic-messages"])("native CLI relay applies %s limits while preserving native reasoning and protecting its key", async api => {
  const requests: Record<string, unknown>[] = [];
  const server = createServer(async (request, response) => {
    let text = "";
    for await (const chunk of request) text += chunk;
    requests.push(JSON.parse(text));
    expect(request.headers.authorization ?? request.headers["x-api-key"]).toMatch(/upstream-secret/u);
    response.writeHead(200, { "content-type": "text/event-stream" });
    const usage = api === "anthropic-messages" ? { input_tokens: 10, output_tokens: 2, cache_read_input_tokens: 3 }
      : api === "openai-completions" ? { prompt_tokens: 13, completion_tokens: 2 } : { input_tokens: 13, output_tokens: 2 };
    response.end(`data: ${JSON.stringify({ usage })}\n\ndata: [DONE]\n\n`);
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw Error("No fixture port");
  const relay = await startModelRelay({ api, baseUrl: `http://127.0.0.1:${address.port}/v1`, apiKey: "upstream-secret", token: "relay-token", maxTokens: 70000, disableBuiltinTools: true, captureUsage: true });
  try {
    const route = api === "openai-completions" ? "/chat/completions" : api === "openai-responses" ? "/responses" : "/messages";
    const nativeReasoning = api === "openai-responses"
      ? [{ reasoning: { effort: "max", summary: "auto" } }, {}]
      : api === "anthropic-messages"
        ? [{ output_config: { effort: "max" } }, { thinking: { type: "disabled" }, output_config: { effort: "low" } }]
        : [{ reasoning_effort: "max" }, { reasoning_effort: "low", enable_thinking: false }];
    for (const reasoning of nativeReasoning) {
      const response = await fetch(relay.endpoint + route, { method: "POST", headers: { authorization: "Bearer relay-token", "content-type": "application/json" },
        body: JSON.stringify({ model: "fixture", tools: [{ type: "function", name: "Bash" }], tool_choice: "required", web_search_options: {}, extra_body: { web_search_options: {} }, max_tokens: 8, ...reasoning }) });
      expect(response.status).toBe(200);
      expect(await response.text()).not.toContain("upstream-secret");
    }
    const limit = api === "openai-responses" ? { max_output_tokens: 70000 } : { max_tokens: 70000 };
    expect(requests).toEqual(nativeReasoning.map(reasoning => ({ model: "fixture", extra_body: {}, ...limit, ...reasoning })));
    expect(relay.usage()).toEqual({ inputTokens: 26, outputTokens: 4, totalTokens: 30 });
    expect((await fetch(relay.endpoint + route, { method: "POST", body: "{}" })).status).toBe(401);
  } finally { relay.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

test.each(["openai-completions", "openai-responses", "anthropic-messages"])("MCP-only requests preserve the declared tool and reject an undeclared call on %s", async api => {
  const name = "mcp__fixture__lookup";
  const chat = api === "openai-completions";
  const responses = api === "openai-responses";
  const definition = chat ? { type: "function", function: { name } }
    : responses ? { type: "namespace", name: "mcp__fixture", tools: [{ type: "function", name: "lookup" }] }
    : { name, input_schema: { type: "object" }, defer_loading: true };
  const received: unknown[][] = [];
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    received.push(JSON.parse(Buffer.concat(chunks).toString()).tools);
    const valid = received.length === 1;
    if (chat) {
      response.writeHead(200, { "content-type": "text/event-stream" });
      for (const fragment of ["mcp__fixture__", valid ? "lookup" : "unknown"]) {
        const delta = { tool_calls: [{ index: 0, function: { name: fragment } }] };
        response.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta }] })}\n\n`);
      }
      response.end("data: [DONE]\n\n");
    } else {
      const result = responses ? { output: [{ type: "function_call", namespace: "mcp__fixture", name: valid ? "lookup" : "unknown" }] }
        : { content: [{ type: "tool_use", name: valid ? name : "mcp__fixture__unknown" }] };
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(result));
    }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw Error("No fixture port");
  const relay = await startModelRelay({ api, baseUrl: `http://127.0.0.1:${address.port}/v1`, apiKey: "secret", token: "token", disableBuiltinTools: true });
  try {
    const route = chat ? "/chat/completions" : responses ? "/responses" : "/messages";
    const call = () => fetch(relay.endpoint + route, { method: "POST", headers: { authorization: "Bearer token" },
      body: JSON.stringify({ tools: [definition, { type: "function", name: "Bash" }, { type: "function", name: "WebSearch" },
        { type: "function", name: "WebFetch" }, { type: "web_search_preview" }, { type: "web_fetch_20250910", name: "web_fetch" }] }) })
      .then(response => response.text());
    expect(await call()).toContain("lookup");
    expect(await call().catch(() => "")).not.toContain("unknown");
    const expected = chat || responses ? definition : { name, input_schema: { type: "object" } };
    expect(received).toEqual([[expected], [expected]]);
  } finally { relay.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

test.each([false, true])("no-tools relay blocks unexpected tool output before native execution (SSE=%s)", async stream => {
  const server = createServer(async (request, response) => {
    for await (const _chunk of request) { /* Drain the controlled request. */ }
    const payload = { choices: [{ delta: { tool_calls: [{ id: "call", type: "function", function: { name: "Bash", arguments: "{}" } }] }, message: { tool_calls: [{}] } }] };
    response.writeHead(200, { "content-type": stream ? "text/event-stream" : "application/json" });
    response.end(stream ? `data: ${JSON.stringify(payload)}\n\ndata: [DONE]\n\n` : JSON.stringify(payload));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw Error("No fixture port");
  const relay = await startModelRelay({ api: "openai-completions", baseUrl: `http://127.0.0.1:${address.port}/v1`, apiKey: "secret", token: "token", disableBuiltinTools: true });
  try {
    // The tool-bearing record must never reach the CLI, even if the provider
    // violates the empty tool declaration. A broken stream is an invalid attempt.
    const output = await fetch(relay.endpoint + "/chat/completions", { method: "POST", headers: { authorization: "Bearer token" }, body: "{}" })
      .then(response => response.text()).catch(() => "stream rejected");
    expect(output).not.toContain("tool_calls");
    expect(output).not.toContain('"Bash"');
  } finally { relay.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

test("the ACP request ceiling excludes HTTP failures and rejects requests before another model step", async () => {
  let calls = 0;
  const server = createServer(async (request, response) => {
    for await (const _chunk of request) { /* Drain the controlled request. */ }
    calls++;
    response.writeHead(calls === 1 ? 503 : 200, { "content-type": "application/json" }).end("{}");
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw Error("No fixture port");
  const relay = await startModelRelay({ api: "openai-completions", baseUrl: `http://127.0.0.1:${address.port}/v1`, apiKey: "secret", token: "token", maxModelCalls: 1 });
  const request = () => fetch(relay.endpoint + "/chat/completions", { method: "POST", headers: { authorization: "Bearer token" }, body: "{}" });
  try {
    const failed = await request(); expect(failed.status).toBe(503); await failed.text();
    const success = await request(); expect(success.status).toBe(200); await success.text();
    const rejected = await request(); expect(rejected.status).toBe(400);
    expect(await rejected.text()).toContain("MAX_TURNS_EXCEEDED");
    expect(calls).toBe(2);
  } finally { relay.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
