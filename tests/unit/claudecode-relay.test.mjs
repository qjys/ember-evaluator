import { createServer } from "node:http";
import { text } from "node:stream/consumers";
import { expect, test } from "vitest";
import { startModelRelay } from "../../src/runtimes/shared/assets/model-relay.mjs";

test("Claude Code relay scopes temporary credentials to Anthropic Messages requests", async () => {
  const received = [];
  const upstream = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk.toString("utf8");
    received.push({ path: request.url, key: request.headers["x-api-key"],
      authorization: request.headers.authorization, beta: request.headers["anthropic-beta"], body });
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write('event: message_start\ndata: {}\n\n');
    if (request.url.includes("beta=true")) {
      response.write('event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"thinking_delta","thinking":"fixture thought"}}\n\n');
    }
    response.end('event: message_stop\ndata: {}\n\n');
  });
  await new Promise(resolve => upstream.listen(0, "127.0.0.1", resolve));
  const key = "temporary-fixture-key";
  const relay = await startModelRelay({ api: "anthropic-messages",
    baseUrl: `http://127.0.0.1:${upstream.address().port}/anthropic/v1`, apiKey: "real-fixture-key", token: key, maxTokens: 8192 });
  try {
    const send = (route, key) => fetch(new URL(relay.endpoint).origin + route, { method: "POST",
      headers: { "x-api-key": key, authorization: "Bearer do-not-forward", "anthropic-beta": "test", "content-type": "application/json" },
      body: '{"model":"fixture"}' });
    expect(key).not.toBe("real-fixture-key");
    expect((await send("/v1/messages", "wrong")).status).toBe(401);
    expect((await send("/outside", key)).status).toBe(404);
    const result = await send("/v1/messages?beta=true", key);
    expect(result.status).toBe(200);
    expect(result.headers.get("content-type")).toBe("text/event-stream");
    const stream = await result.text();
    expect(stream).toContain('"thinking":"fixture thought"');
    expect(stream).toContain("event: message_stop");
    expect((await send("/v1/messages/count_tokens", key)).status).toBe(200);
    expect(received).toEqual([{ path: "/anthropic/v1/messages?beta=true", key: "real-fixture-key",
      authorization: undefined, beta: "test", body: '{"model":"fixture","max_tokens":8192}' },
    { path: "/anthropic/v1/messages/count_tokens", key: "real-fixture-key",
      authorization: undefined, beta: "test", body: '{"model":"fixture"}' }]);
  } finally {
    relay.close();
    upstream.closeAllConnections();
    await new Promise(resolve => upstream.close(resolve));
  }
});

test("Messages relay negotiates Bearer on 401 and preserves the streaming protocol", async () => {
  const received = [];
  const upstream = createServer(async (request, response) => {
    const { authorization, "x-api-key": key, "anthropic-beta": beta } = request.headers;
    received.push({ path: request.url, authorization, key, beta, body: await text(request) });
    if (authorization !== "Bearer upstream-fixture-key") {
      response.writeHead(401).end("Unauthorized");
      return;
    }
    if (request.url === "/compatible/v1/messages/count_tokens") {
      response.writeHead(403).end("Count tokens unavailable");
      return;
    }
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end(stream);
  });
  const stream = 'event: content_block_start\ndata: {"type":"content_block_start","content_block":{"type":"tool_use","name":"lookup"}}\n\n'
    + 'event: message_stop\ndata: {"type":"message_stop"}\n\n';
  await new Promise(resolve => upstream.listen(0, "127.0.0.1", resolve));
  const token = "relay-fixture-token";
  const relay = await startModelRelay({ api: "anthropic-messages", token, maxModelCalls: 2,
    baseUrl: `http://127.0.0.1:${upstream.address().port}/compatible`, apiKey: "upstream-fixture-key" });
  const send = (path, body) => fetch(relay.endpoint + path, { method: "POST",
    headers: { "x-api-key": token, "anthropic-beta": "test", "content-type": "application/json" }, body });
  const firstBody = '{ "model":"fixture", "stream":true, "tools":[{"name":"lookup"}] }';
  const secondBody = '{"model":"fixture","stream":true,"messages":[{"role":"user","content":[{"type":"tool_result","content":"结果"}]}]}';
  try {
    for (const body of [firstBody, secondBody]) {
      const response = await send("/messages?beta=true", body);
      expect(response.status).toBe(200);
      expect(await response.text()).toBe(stream);
    }
    const countTokens = await send("/messages/count_tokens", '{"model":"fixture"}');
    expect(countTokens.status).toBe(403);
    expect(await countTokens.text()).toBe("Count tokens unavailable");
    expect((await send("/messages", firstBody)).status).toBe(400);
    expect(received).toEqual([
      { path: "/compatible/v1/messages?beta=true", authorization: undefined, key: "upstream-fixture-key", beta: "test", body: firstBody },
      { path: "/compatible/v1/messages?beta=true", authorization: "Bearer upstream-fixture-key", key: undefined, beta: "test", body: firstBody },
      { path: "/compatible/v1/messages?beta=true", authorization: "Bearer upstream-fixture-key", key: undefined, beta: "test", body: secondBody },
      { path: "/compatible/v1/messages/count_tokens", authorization: "Bearer upstream-fixture-key", key: undefined, beta: "test", body: '{"model":"fixture"}' },
    ]);
  } finally {
    relay.close();
    upstream.closeAllConnections();
    await new Promise(resolve => upstream.close(resolve));
  }
});
