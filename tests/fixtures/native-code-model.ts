import { createServer } from "node:http";

type Tool = { type: string; name?: string; function?: { name: string; parameters?: { properties?: Record<string, unknown> } }; input_schema?: { properties?: Record<string, unknown> } };
export type CapturedCodeRequest = { model: string; tools?: Tool[]; messages?: unknown[]; input?: unknown; max_tokens?: number; max_completion_tokens?: number; max_output_tokens?: number; reasoning_effort?: string; reasoning?: unknown; output_config?: unknown; thinking?: unknown; stream?: boolean };

export async function nativeCodeModel(mode: "answer" | "read" | "loop" | "discover-fetch" | "fetch" = "answer", hostname = "127.0.0.1", filePath = "input.txt") {
  const requests: CapturedCodeRequest[] = [];
  const server = createServer(async (request, response) => {
    if (mode === "fetch" && request.method === "GET" && request.url === "/fixture-page") {
      response.setHeader("content-type", "text/html");
      response.end("<html><body><h1>Local webfetch evidence</h1></body></html>");
      return;
    }
    let source = "";
    for await (const chunk of request) source += chunk;
    const body = JSON.parse(source) as CapturedCodeRequest;
    const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
    if (pathname.endsWith("/count_tokens")) { response.setHeader("content-type", "application/json"); response.end('{"input_tokens":123}'); return; }
    requests.push(body);
    const tools = body.tools ?? [];
    const read = tools.find(tool => /^(?:read|Read|read_file)$/u.test(tool.function?.name ?? tool.name ?? ""));
    const history = JSON.stringify(body.messages ?? body.input);
    let target = read;
    let call = (mode === "read" || mode === "loop") && read && (mode === "loop" || !history.includes("TOOL_EVIDENCE"));
    const properties = read?.function?.parameters?.properties ?? read?.input_schema?.properties ?? {};
    const path = ["file_path", "path", "filePath"].find(key => key in properties) ?? "path";
    let args = JSON.stringify({ [path]: filePath });
    let fetching = false;
    if (mode === "discover-fetch" || mode === "fetch") {
      const webFetch = tools.find(tool => /^(?:web_fetch|webfetch|FetchURL)$/u.test(tool.function?.name ?? tool.name ?? ""));
      const results = JSON.stringify((body.messages ?? []).filter(item => typeof item === "object" && item !== null && "role" in item && item.role === "tool"));
      const deferred = results.includes("web_fetch") ? tools.find(tool => (tool.function?.name ?? tool.name) === "tool_call") : undefined;
      if (mode === "fetch" && (webFetch || deferred) && !history.includes("call_fixture_fetch")) {
        const local = server.address();
        if (!local || typeof local === "string") throw Error("Missing mock server address");
        target = webFetch ?? deferred;
        call = true;
        fetching = true;
        const fetchArgs = { url: "http://127.0.0.1:" + local.port + "/fixture-page", prompt: "Extract the heading." };
        args = JSON.stringify(webFetch ? fetchArgs : { name: "web_fetch", arguments: fetchArgs });
      } else {
        target = tools.find(tool => (tool.function?.name ?? tool.name) === "tool_search");
        call = !webFetch && target !== undefined && !results.includes("web_fetch");
        args = JSON.stringify({ query: "select:web_fetch" });
      }
    }
    const name = target?.function?.name ?? target?.name;
    const callId = fetching ? "call_fixture_fetch" : `call_fixture_${requests.length}`;
    const answer = "The answer is 42.";
    response.writeHead(200, { "content-type": "text/event-stream" });
    const send = (event: object, type?: string) => response.write(`${type ? `event: ${type}\n` : ""}data: ${JSON.stringify(event)}\n\n`);
    if (pathname.endsWith("/messages")) {
      send({ type: "message_start", message: { id: "msg_fixture", type: "message", role: "assistant", model: body.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 123, output_tokens: 0 } } }, "message_start");
      send({ type: "content_block_start", index: 0, content_block: call ? { type: "tool_use", id: callId, name, input: {} } : { type: "text", text: "" } }, "content_block_start");
      send({ type: "content_block_delta", index: 0, delta: call ? { type: "input_json_delta", partial_json: args } : { type: "text_delta", text: answer } }, "content_block_delta");
      send({ type: "content_block_stop", index: 0 }, "content_block_stop");
      send({ type: "message_delta", delta: { stop_reason: call ? "tool_use" : "end_turn", stop_sequence: null }, usage: { output_tokens: 7 } }, "message_delta");
      send({ type: "message_stop" }, "message_stop");
    } else if (pathname.endsWith("/responses")) {
      const item = call ? { id: "fc_fixture", type: "function_call", name, call_id: callId, status: "completed", arguments: args }
        : { id: "msg_fixture", type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: answer, annotations: [] }] };
      const base = { id: "resp_fixture", object: "response", created_at: 1, model: body.model, status: "in_progress", output: [] };
      send({ type: "response.created", response: base }, "response.created");
      send({ type: "response.output_item.added", output_index: 0, item }, "response.output_item.added");
      if (!call) send({ type: "response.output_text.delta", item_id: "msg_fixture", output_index: 0, content_index: 0, delta: answer }, "response.output_text.delta");
      send({ type: "response.output_item.done", output_index: 0, item }, "response.output_item.done");
      send({ type: "response.completed", response: { ...base, status: "completed", output: [item], usage: { input_tokens: 123, output_tokens: 7, total_tokens: 130 } } }, "response.completed");
    } else {
      const base = { id: "chatcmpl_fixture", object: "chat.completion.chunk", created: 1, model: body.model };
      send({ ...base, choices: [{ index: 0, delta: call ? { role: "assistant", tool_calls: [{ index: 0, id: callId, type: "function", function: { name, arguments: args } }] } : { role: "assistant", content: answer }, finish_reason: null }] });
      send({ ...base, choices: [{ index: 0, delta: {}, finish_reason: call ? "tool_calls" : "stop" }] });
      send({ ...base, choices: [], usage: { prompt_tokens: 123, completion_tokens: 7, total_tokens: 130 } });
      response.write("data: [DONE]\n\n");
    }
    response.end();
  });
  await new Promise<void>(resolve => server.listen(0, hostname, resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw Error("Missing mock server address");
  return { requests, endpoint: `http://127.0.0.1:${address.port}/v1`,
    close: () => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }) };
}
