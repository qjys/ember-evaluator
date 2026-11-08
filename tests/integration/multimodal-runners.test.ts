import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, test } from "vitest";
import { fixturePNG } from "../fixtures/multimodal.js";
import { fixturePDF } from "../fixtures/officeqa.js";
import { assertDifyFileWorkflow } from "../../src/runtimes/dify/multimodal.js";
import { dshModelPatch, dshPermissionPatch, dshSdkPatch } from "../../src/runtimes/dsh/model.js";

const roots: string[] = [];
async function directory() { const root = await mkdtemp(join(tmpdir(), "multimodal-runner-")); roots.push(root); return root; }
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const image = { name: "figure.png", mediaType: "image/png", data: fixturePNG().toString("base64") };
const key = { runId: "r", taskId: "t", attemptId: "a" };
async function program(executable: string, args: string[], input: unknown, cwd: string) {
  const child = spawn(executable, args, { cwd, env: { ...process.env, EVALUATOR_MEDIA_OUTPUT: cwd }, windowsHide: true });
  const output: Buffer[] = []; const errors: Buffer[] = [];
  child.stdout.on("data", chunk => output.push(Buffer.from(chunk))); child.stderr.on("data", chunk => errors.push(Buffer.from(chunk)));
  child.stdin.on("error", () => {}); child.stdin.end(JSON.stringify(input));
  const timer = setTimeout(() => child.kill(), 20_000);
  try {
    const code = await new Promise<number | null>((resolve, reject) => { child.on("error", reject); child.on("close", resolve); });
    return { code, stdout: Buffer.concat(output).toString("utf8"), stderr: Buffer.concat(errors).toString("utf8") };
  } finally { clearTimeout(timer); }
}

test("Dify checks vision binding and rejects an unrelated target model", async () => {
  await expect(assertDifyFileWorkflow(resolve("playbook/multimodal/dify"), "files", "gpt-4.1")).resolves.toEqual([
    { nodeId: "solve", provider: "langgenius/openai/openai", name: "gpt-4.1" },
  ]);
  await expect(assertDifyFileWorkflow(resolve("playbook/multimodal/dify"), "absent", "gpt-4.1")).rejects.toThrow(/bind/);
  await expect(assertDifyFileWorkflow(resolve("playbook/multimodal/dify"), "files", "other-model")).rejects.toThrow(/differs/);
});

test("Dify uploads image bytes with the workflow user, binds IDs in order, and reuses receipts", async () => {
  const root = await directory(); const requests: { url: string; body: Buffer }[] = [];
  let variable = "images";
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = []; for await (const part of request) chunks.push(Buffer.from(part));
    const body = Buffer.concat(chunks); requests.push({ url: request.url!, body });
    response.setHeader("content-type", "application/json");
    if (request.url === "/v1/parameters") response.end(JSON.stringify({ user_input_form: [{ "file-list": { variable, allowed_file_types: ["image"], allowed_file_upload_methods: ["local_file"], max_length: 32 } }] }));
    else if (request.url === "/v1/files/upload") response.end(JSON.stringify({ id: "image-id" }));
    else {
      response.setHeader("content-type", "text/event-stream");
      response.end('data: {"event":"workflow_started","data":{"id":"run"}}\n\ndata: {"event":"workflow_finished","data":{"status":"succeeded","outputs":{"answer":"ok"}}}\n\n');
    }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); if (!address || typeof address === "string") throw new Error("missing port");
  try {
    const input = { schemaVersion: 1, baseUrl: `http://127.0.0.1:${address.port}`, apiKey: "fixture", appId: "app",
      task: "look", attempt: key, outputDir: root, filesInput: "images", media: [image, { ...image, name: "second.png" }] };
    const execute = () => program(process.execPath, [resolve("src/runtimes/dify/assets/runner.mjs")], input, root);
    expect(await execute()).toMatchObject({ code: 0 });
    const upload = requests.find(request => request.url.endsWith("upload"))!;
    expect(upload.body.includes(fixturePNG())).toBe(true);
    expect(upload.body.toString()).toContain('name="user"\r\n\r\nember-evaluator');
    const workflow = JSON.parse(requests.find(request => request.url.endsWith("run"))!.body.toString());
    expect(workflow.user).toBe("ember-evaluator");
    expect(workflow.inputs.images).toEqual(Array(2).fill({ type: "image", transfer_method: "local_file", upload_file_id: "image-id" }));
    expect(await execute()).toMatchObject({ code: 0 });
    expect(requests.filter(request => request.url.endsWith("upload"))).toHaveLength(1);
    variable = "absent";
    const invalid = await execute(); expect(invalid.code).toBe(1); expect(invalid.stdout).toContain("CONFIG_INVALID");
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
}, 30_000);

test("DSH structured SDK entry retains image content, usage, evidence and close", async () => {
  const root = await directory();
  const client = join(root, "node_modules/@deepseek-ai/dsh-sdk-client");
  const llm = join(root, "node_modules/@deepseek-ai/dsh-llm");
  await Promise.all([mkdir(client, { recursive: true }), mkdir(llm, { recursive: true })]);
  await writeFile(join(client, "package.json"), JSON.stringify({ name: "@deepseek-ai/dsh-sdk-client", type: "module", main: "index.js" }));
  await writeFile(join(llm, "package.json"), JSON.stringify({ name: "@deepseek-ai/dsh-llm", type: "module", exports: { "./assistant-stream": "./index.js" } }));
  await writeFile(join(llm, "index.js"), "export const lastAssistantStreamChunk = () => undefined;");
  await writeFile(join(client, "index.js"), `import {writeFileSync} from 'node:fs';
    export class DeepSeekHarness {
      constructor(options) { this.options=options; }
      async run(content, hooks) {
        writeFileSync('captured.json', JSON.stringify({options:this.options,content}));
        hooks.onNotification({method:'session.event',params:{event:{type:'image',data:content[1].data,mimeType:content[1].mimeType}}});
        return {sessionId:'session',finishReason:'completed',finalResponse:'ok',events:[{type:'assistant/message',data:{usage:{inputTokens:7,outputTokens:3,totalTokens:10}}}]};
      }
      async close() {writeFileSync('closed','yes');}
    }`);
  const result = await program(process.execPath, [resolve("src/runtimes/dsh/assets/multimodal-runner.mjs")], {
    moduleBase: join(root, "package.json"), dsh: "fixture", home: root, profile: "candidate", patches: ["model", "permissions"],
    workdir: root, outputDir: root, model: "vision", provider: "target", key, prompt: "look", media: [image],
  }, root);
  expect(result.code).toBe(0);
  expect(JSON.parse((await readFile(join(root, "captured.json"), "utf8")))).toMatchObject({ content: [{ type: "text", text: "look" }, { type: "image", data: image.data }] });
  expect(result.stdout).toContain('"totalTokens":10');
  expect(await readFile(join(root, "closed"), "utf8")).toBe("yes");
  const trajectory = await readFile(join(root, "trajectory.jsonl"), "utf8");
  expect(trajectory).not.toContain(image.data); expect(trajectory).toContain('"artifact":"media/');
});

test("DeepAgents constructs image and native PDF message blocks without putting media in traces", async () => {
  const root = await directory();
  await writeFile(join(root, "agent.py"), `import json
from types import SimpleNamespace
def invoke(state):
    open('captured.json','w').write(json.dumps(state))
    return {'messages':[SimpleNamespace(type='ai',content='ok',tool_calls=[],usage_metadata={'input_tokens':2,'output_tokens':1})]}
def build_agent(middleware):
    return SimpleNamespace(invoke=invoke)
`);
  const pdf = { name: "document.pdf", mediaType: "application/pdf", data: fixturePDF().toString("base64") };
  const result = await program(process.env.PYTHON_BIN ?? (process.platform === "win32" ? "python" : "python3"),
    [resolve("src/runtimes/deepagents/assets/runner.py"), "--bundle-dir", root], { prompt: "look", media: [image, pdf] }, root);
  expect(result.code, result.stdout + result.stderr).toBe(0);
  const content = JSON.parse(await readFile(join(root, "captured.json"), "utf8")).messages[0][1];
  expect(content).toEqual([{ type: "text", text: "look" }, { type: "image_url", image_url: { url: `data:image/png;base64,${image.data}` } },
    { type: "file", file: { filename: "document.pdf", file_data: `data:application/pdf;base64,${pdf.data}` } }]);
  expect(result.stdout).not.toContain(image.data);
});

test.each([true, false])("Hermes preserves native input and checks the image route (%s)", async allowed => {
  const root = await directory();
  await mkdir(join(root, "hermes_cli"));
  await writeFile(join(root, "run_agent.py"), `class AIAgent:
    def _model_supports_vision(self): return True
    def _provider_supports_vision_tool_messages(self): return ${allowed ? "True" : "False"}
    def run_conversation(self, message): return message
`);
  await writeFile(join(root, "hermes_cli/main.py"), `import json
def main():
    from run_agent import AIAgent
    agent = AIAgent()
    print(json.dumps([agent.run_conversation('look'), agent.run_conversation('next')]))
`);
  const bootstrap = join(root, "bootstrap.py");
  await writeFile(bootstrap, `import importlib.util,sys
spec=importlib.util.spec_from_file_location('runner',sys.argv.pop(1))
runner=importlib.util.module_from_spec(spec)
spec.loader.exec_module(runner)
runner.install_output_capture=lambda: None
runner.main()
`);
  const result = await program(process.env.PYTHON_BIN ?? (process.platform === "win32" ? "python" : "python3"),
    ["-c", `import os,runpy,sys;os.environ['EVALUATOR_HERMES_MEDIA']='1';sys.argv=sys.argv[1:];runpy.run_path(sys.argv[0],run_name='__main__')`, bootstrap,
      resolve("src/runtimes/hermes/assets/runner.py"), root], [image], root);
  if (!allowed) { expect(result.code).not.toBe(0); expect(result.stderr).toContain("cannot preserve image tool results"); }
  else {
    expect(result.code, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual([[{ type: "text", text: "look" }, { type: "image_url", image_url: { url: `data:image/png;base64,${image.data}` } }], "next"]);
  }
});

test.skipIf(!process.env.EVALUATOR_DEEPAGENTS_TEST_PYTHON)("pinned DeepAgents sends files and tool images to the actual ChatOpenAI transport", async () => {
  const root = await directory(); const requests: { model: string; messages: unknown[] }[] = [];
  await writeFile(join(root, "figure.png"), fixturePNG());
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = []; for await (const part of request) chunks.push(Buffer.from(part));
    requests.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    const tool = requests.length === 1;
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ id: "vision", object: "chat.completion", created: 1, model: "vision",
      choices: [{ index: 0, finish_reason: tool ? "tool_calls" : "stop", message: tool ? { role: "assistant", content: "",
        tool_calls: [{ id: "view", type: "function", function: { name: "view_image", arguments: '{"path":"figure.png"}' } }] } : { role: "assistant", content: "ok" } }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); if (!address || typeof address === "string") throw new Error("missing port");
  try {
    await writeFile(join(root, "agent.py"), `from deepagents import create_deep_agent
from langchain_openai import ChatOpenAI
def build_agent(middleware):
    return create_deep_agent(model=ChatOpenAI(model='vision',api_key='fixture',base_url='http://127.0.0.1:${address.port}/v1'),middleware=list(middleware))
`);
    const result = await program(process.env.EVALUATOR_DEEPAGENTS_TEST_PYTHON!, [resolve("src/runtimes/deepagents/assets/runner.py"), "--bundle-dir", root],
      { prompt: "Look", imageTools: true, media: [image, { name: "document.pdf", mediaType: "application/pdf", data: fixturePDF().toString("base64") }] }, root);
    expect(result.code, result.stdout + result.stderr).toBe(0);
    expect(requests).toHaveLength(2);
    expect(requests.every(request => request.model === "vision")).toBe(true);
    expect(JSON.stringify(requests[0])).toContain("file_data");
    expect(JSON.stringify(requests[1]).split("image_url").length - 1).toBeGreaterThanOrEqual(2);
    expect(result.stdout).not.toContain(image.data);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
}, 30_000);

test.skipIf(!process.env.EVALUATOR_DSH_TEST_RUNTIME)("pinned DSH preserves images through the installed headless profile and SDK overlay", async () => {
  const root = await directory(); const runtime = process.env.EVALUATOR_DSH_TEST_RUNTIME!;
  const dsh = join(runtime, "node_modules/@deepseek-ai/dsh/lib/bin.js");
  await writeFile(join(root, "figure.png"), fixturePNG());
  const requests: unknown[] = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = []; for await (const part of request) chunks.push(Buffer.from(part));
    requests.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    response.writeHead(200, { "content-type": "text/event-stream" });
    const base = { id: "dsh-vision", object: "chat.completion.chunk", created: 1, model: "vision" };
    const read = requests.length === 1;
    const delta = read ? { role: "assistant", tool_calls: [{ index: 0, id: "image", type: "function",
      function: { name: "read_image", arguments: JSON.stringify({ file_path: "figure.png" }) } }] } : { role: "assistant", content: "ok" };
    for (const event of [{ ...base, choices: [{ index: 0, delta, finish_reason: null }] },
      { ...base, choices: [{ index: 0, delta: {}, finish_reason: read ? "tool_calls" : "stop" }] },
      { ...base, choices: [], usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 } }]) response.write(`data: ${JSON.stringify(event)}\n\n`);
    response.end("data: [DONE]\n\n");
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); if (!address || typeof address === "string") throw new Error("missing port");
  try {
    // DSH can clone its packaged headless profile before reporting missing input.
    const init = spawn(process.execPath, [dsh, "--profile", "evaluator", "--from-default-profile", "headless"],
      { cwd: root, env: { ...process.env, DSH_HOME: root }, stdio: "pipe", windowsHide: true });
    init.stdin.end(); init.stdout.resume(); init.stderr.resume();
    const timer = setTimeout(() => init.kill(), 15_000);
    await new Promise<void>(resolve => init.once("close", () => resolve())); clearTimeout(timer);
    const patches = [join(root, "model.yaml"), join(root, "permissions.yaml"), join(root, "sdk.yaml")];
    await writeFile(patches[0]!, dshModelPatch({ name: "vision", provider: null, endpoint: `http://127.0.0.1:${address.port}/v1`, api: "openai-completions", inputModalities: ["text", "image"] }));
    await writeFile(patches[1]!, dshPermissionPatch("danger-full-access"));
    await writeFile(patches[2]!, dshSdkPatch("evaluator", root, "danger-full-access"));
    const result = await program(process.execPath, [resolve("src/runtimes/dsh/assets/multimodal-runner.mjs")], {
      moduleBase: join(runtime, "package.json"), dsh, home: root, profile: "evaluator", patches,
      workdir: root, outputDir: join(root, "logs"), model: "vision", provider: "ember-evaluator", key, prompt: "look", media: [image],
    }, root);
    expect(result.code, result.stdout + result.stderr).toBe(0);
    expect(requests).toHaveLength(2);
    expect(JSON.stringify(requests[0])).toContain("image_url");
    expect(JSON.stringify(requests[1]).split("image_url").length - 1).toBeGreaterThanOrEqual(2);
    expect(result.stdout).toContain('"totalTokens":26');
    const trajectory = await readFile(join(root, "logs/trajectory.jsonl"), "utf8");
    expect(trajectory).toContain('"artifact":"media/');
    expect(trajectory).not.toContain(image.data);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
}, 60_000);
