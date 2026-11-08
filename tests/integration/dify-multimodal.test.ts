import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { parse, stringify } from "yaml";
import { afterEach, expect, test, vi } from "vitest";
import { assertDifyFileWorkflow } from "../../src/runtimes/dify/multimodal.js";
import { assertDifyModelCapabilities } from "../../src/runtimes/dify/model-capabilities.js";
import { fixturePNG } from "../fixtures/multimodal.js";
import { fixturePDF } from "../fixtures/officeqa.js";

const roots: string[] = [];
async function directory() { const root = await mkdtemp(join(tmpdir(), "dify-media-")); roots.push(root); return root; }
afterEach(async () => { vi.unstubAllEnvs(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

test("PDF files must reach the target LLM directly, not through extracted text or an orphan node", async () => {
  const root = await directory();
  await writeFile(join(root, "bundle.yaml"), "entry: workflow.yaml\n");
  const workflow = parse(await readFile(resolve("playbook/multimodal/dify/workflow.yaml"), "utf8"));
  const llm = workflow.workflow.graph.nodes[1].data;
  llm.vision.enabled = false;
  llm.prompt_template[0].text += "\n{{#start.files#}}";
  const check = async () => {
    await writeFile(join(root, "workflow.yaml"), stringify(workflow));
    return assertDifyFileWorkflow(root, "files", "gpt-4.1");
  };
  expect(await check()).toEqual([{ nodeId: "solve", provider: "langgenius/openai/openai", name: "gpt-4.1" }]);
  llm.prompt_template[0].text = "{{#extract.text#}}";
  await expect(check()).rejects.toThrow(/bind/);
  llm.prompt_template[0].text = "{{#start.files#}}";
  workflow.workflow.graph.edges = [];
  await expect(check()).rejects.toThrow(/path to the output/);
});

test("Dify checks the deployed Provider document capability with Console cookie and CSRF auth", async () => {
  let features = ["vision", "document"];
  const server = createServer(async (request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.url === "/console/api/login") {
      const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
      expect(JSON.parse(Buffer.concat(chunks).toString()).password).toBe(Buffer.from("test-password").toString("base64"));
      response.setHeader("set-cookie", ["access_token=fixture-session; HttpOnly", "csrf_token=fixture-csrf"]);
      response.end('{}'); return;
    }
    expect(request.headers.cookie).toContain("access_token=fixture-session");
    expect(request.headers["x-csrf-token"]).toBe("fixture-csrf");
    response.end(JSON.stringify({ data: [{ model: "vision", provider: { provider: "target" }, features }] }));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); if (!address || typeof address === "string") throw new Error("missing port");
  vi.stubEnv("DIFY_ADMIN_API_KEY", ""); vi.stubEnv("DIFY_EMAIL", "test@example.com"); vi.stubEnv("DIFY_PASSWORD", "test-password");
  const check = () => assertDifyModelCapabilities(`http://127.0.0.1:${address.port}`,
    [{ nodeId: "solve", provider: "target", name: "vision" }], ["image", "pdf"], AbortSignal.timeout(5_000));
  try {
    expect(await check()).toMatchObject({ features: ["vision", "document"] });
    features = ["vision"];
    await expect(check()).rejects.toMatchObject({ code: "BENCHMARK_UNSUPPORTED" });
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

test("Dify uploads unchanged PDFs, binds document and image IDs in order, and rejects disallowed documents before upload", async () => {
  const root = await directory();
  const requests: { url: string; body: Buffer }[] = [];
  let types = ["document", "image"];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = Buffer.concat(chunks); requests.push({ url: request.url!, body });
    response.setHeader("content-type", "application/json");
    if (request.url === "/v1/parameters") response.end(JSON.stringify({ user_input_form: [{ "file-list": {
      variable: "files", allowed_file_types: types, allowed_file_upload_methods: ["local_file"], max_length: 3,
    } }] }));
    else if (request.url === "/v1/files/upload") response.end(JSON.stringify({ id: body.includes(fixturePDF()) ? "pdf-id" : "image-id" }));
    else {
      response.setHeader("content-type", "text/event-stream");
      response.end('data: {"event":"workflow_started","data":{"id":"r"}}\n\ndata: {"event":"workflow_finished","data":{"status":"succeeded","outputs":{"answer":"ok"}}}\n\n');
    }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); if (!address || typeof address === "string") throw new Error("missing port");
  const execute = async () => {
    const child = spawn(process.execPath, [resolve("src/runtimes/dify/assets/runner.mjs")], { windowsHide: true });
    let stdout = ""; child.stdout.on("data", chunk => { stdout += String(chunk); }); child.stderr.resume();
    child.stdin.end(JSON.stringify({ schemaVersion: 1, baseUrl: `http://127.0.0.1:${address.port}`, apiKey: "test-key",
      appId: "app", task: "look", attempt: { runId: "r", taskId: "t", attemptId: "a" }, outputDir: root, filesInput: "files",
      media: [{ name: "paper.pdf", mediaType: "application/pdf", data: fixturePDF().toString("base64") },
        { name: "image.png", mediaType: "image/png", data: fixturePNG().toString("base64") }] }));
    const code = await new Promise<number | null>((resolve, reject) => { child.on("error", reject); child.on("close", resolve); });
    return { code, stdout };
  };
  try {
    expect((await execute()).code).toBe(0);
    const uploads = requests.filter(request => request.url.endsWith("upload"));
    expect(uploads).toHaveLength(2);
    expect(uploads[0]!.body.includes(fixturePDF())).toBe(true);
    expect(uploads[0]!.body.toString()).toContain("Content-Type: application/pdf");
    const workflow = JSON.parse(requests.find(request => request.url.endsWith("run"))!.body.toString());
    expect(workflow.user).toBe("ember-evaluator");
    expect(workflow.inputs.files).toEqual([
      { type: "document", transfer_method: "local_file", upload_file_id: "pdf-id" },
      { type: "image", transfer_method: "local_file", upload_file_id: "image-id" },
    ]);
    types = ["image"];
    const invalid = await execute();
    expect(invalid).toMatchObject({ code: 1 }); expect(invalid.stdout).toContain("does not accept document");
    expect(requests.filter(request => request.url.endsWith("upload"))).toHaveLength(2);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
