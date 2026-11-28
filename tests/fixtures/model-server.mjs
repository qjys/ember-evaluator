import { appendFile } from "node:fs/promises";
import { createServer } from "node:http";

const statePath = process.argv[2];
const numericAnswer = process.argv[3] === "numeric";
const overflowSeen = new Set();
if (!statePath) throw new Error("usage: model-server.mjs <state-path>");

function sse(response, chunks, delay = 0) {
  response.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  setTimeout(() => {
    for (const chunk of chunks) response.write(`data: ${JSON.stringify(chunk)}\n\n`);
    response.end("data: [DONE]\n\n");
  }, delay);
}

const server = createServer(async (request, response) => {
  if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
    response.writeHead(404).end();
    return;
  }
  const parts = [];
  for await (const part of request) parts.push(part);
  const body = JSON.parse(Buffer.concat(parts).toString("utf8"));
  const authorization = request.headers.authorization ?? null;
  await appendFile(statePath, `${JSON.stringify({ authorization, body })}\n`, "utf8");

  const userText = body.messages
    .filter(message => message.role === "user")
    .map(message => typeof message.content === "string" ? message.content : JSON.stringify(message.content))
    .join("\n");
  const task = userText.includes("beta") ? "beta" : "alpha";
  if (body.messages.some(message => message.role === "system" && String(message.content).includes("context summarization assistant"))) {
    const chunk = { id: "summary", object: "chat.completion.chunk", created: 1, model: body.model };
    sse(response, [
      { ...chunk, choices: [{ index: 0, delta: { role: "assistant", content: "## Goal\nComplete context-overflow test.\n## Progress\nNo files changed.\n" }, finish_reason: null }] },
      { ...chunk, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
      { ...chunk, choices: [], usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } },
    ]);
    return;
  }
  if (userText.includes("context-overflow") && !overflowSeen.has(authorization)) {
    overflowSeen.add(authorization);
    response.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ error: { message: "Your input exceeds the context window of this model", type: "invalid_request_error" } }));
    return;
  }
  if (userText.includes("token-limit-") && !(userText.includes("token-limit-tool") && body.messages.some(message => message.role === "tool"))) {
    const thinking = userText.includes("token-limit-thinking");
    const tokens = body.max_tokens ?? body.max_completion_tokens ?? 256;
    const chunk = { id: "limit", object: "chat.completion.chunk", created: 1, model: body.model };
    sse(response, [
      { ...chunk, choices: [{ index: 0, delta: { role: "assistant", ...(thinking ? { reasoning_content: "Still working" }
        : userText.includes("token-limit-tool") ? { tool_calls: [{ index: 0, id: "truncated-call", type: "function", function: { name: "bash", arguments: '{"command":"touch truncated-marker.txt"' } }] }
        : { content: "Partial answer" }) }, finish_reason: null }] },
      { ...chunk, choices: [{ index: 0, delta: {}, finish_reason: "length" }] },
      { ...chunk, choices: [], usage: { prompt_tokens: 10, completion_tokens: tokens, total_tokens: tokens + 10, completion_tokens_details: { reasoning_tokens: thinking ? tokens : 0 } } },
    ]);
    return;
  }
  const noUsage = userText.includes("no-usage");
  const hasToolResult = body.messages.some(message => message.role === "tool");
  const shell = body.tools?.some(tool => tool.function?.name === "powershell") ? "powershell"
    : body.tools?.some(tool => tool.function?.name === "pwsh") ? "pwsh" : "bash";
  const shellTool = body.tools?.find(tool => tool.function?.name === shell);
  const markerCommand = shell === "powershell" || shell === "pwsh"
    ? `[System.IO.File]::WriteAllText((Join-Path (Get-Location) 'marker.txt'), '${task}')`
    : `printf '${task}' > marker.txt`;
  const markerArguments = { command: markerCommand };
  if (shellTool?.function?.parameters?.required?.includes("description")) markerArguments.description = `write ${task} marker`;
  if (!hasToolResult) {
    const taskMcp = userText.includes("call the task MCP");
    const fetchUrl = userText.match(/call web_fetch (https?:\/\/\S+)/u)?.[1];
    const name = fetchUrl ? "web_fetch" : taskMcp ? "mcp__task__echo" : shell;
    const args = fetchUrl ? { url: fetchUrl } : taskMcp ? { value: "task-mcp-called" } : markerArguments;
    const chunks = [
      {
        id: `tool-${task}`,
        object: "chat.completion.chunk",
        created: 1,
        model: body.model,
        choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: `call-${task}`, type: "function", function: { name, arguments: JSON.stringify(args) } }] }, finish_reason: null }],
      },
      {
        id: `tool-${task}`,
        object: "chat.completion.chunk",
        created: 1,
        model: body.model,
        choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
      },
      !noUsage && {
        id: `tool-${task}`,
        object: "chat.completion.chunk",
        created: 1,
        model: body.model,
        choices: [],
        usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 },
      },
    ].filter(Boolean);
    sse(response, chunks);
    return;
  }

  const chunks = [
    {
      id: `final-${task}`,
      object: "chat.completion.chunk",
      created: 2,
      model: body.model,
      choices: [{ index: 0, delta: { role: "assistant", content: `Answer: ${numericAnswer ? "42" : task}` }, finish_reason: null }],
    },
    {
      id: `final-${task}`,
      object: "chat.completion.chunk",
      created: 2,
      model: body.model,
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    },
    !noUsage && {
      id: `final-${task}`,
      object: "chat.completion.chunk",
      created: 2,
      model: body.model,
      choices: [],
      usage: { prompt_tokens: 13, completion_tokens: 5, total_tokens: 18 },
    },
  ].filter(Boolean);
  sse(response, chunks, userText.includes("cancel") ? 10_000 : 300);
});

server.listen(0, "127.0.0.1", () => {
  const address = server.address();
  process.stdout.write(`${JSON.stringify({ port: address.port })}\n`);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
