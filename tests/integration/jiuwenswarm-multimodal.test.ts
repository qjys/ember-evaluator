import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test } from "vitest";
import { mergeJiuwenswarmModelConfig } from "../../src/runtimes/jiuwenswarm/prepare.js";
import { fixturePNG } from "../fixtures/multimodal.js";

const python = process.env.EVALUATOR_JIUWENSWARM_TEST_PYTHON;

test.skipIf(!python)("pinned JiuwenSwarm sends the initial image and native read_file images to the same model", async () => {
  const root = await mkdtemp(join(tmpdir(), "jiuwen-images-"));
  const requests: Record<string, unknown>[] = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    requests.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    const read = requests.length === 1;
    const base = { id: "jiuwen-vision", object: "chat.completion.chunk", created: 1, model: "vision" };
    const delta = read ? { role: "assistant", tool_calls: [{ index: 0, id: "read-picture", type: "function",
      function: { name: "read_file", arguments: JSON.stringify({ file_path: join(root, "later.png") }) } }] } :
      { role: "assistant", content: "image checked" };
    response.writeHead(200, { "content-type": "text/event-stream" });
    for (const event of [
      { ...base, choices: [{ index: 0, delta, finish_reason: null }] },
      { ...base, choices: [{ index: 0, delta: {}, finish_reason: read ? "tool_calls" : "stop" }] },
      { ...base, choices: [], usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 } },
    ]) response.write(`data: ${JSON.stringify(event)}\n\n`);
    response.end("data: [DONE]\n\n");
  });
  try {
    await mkdir(join(root, "config"));
    await writeFile(join(root, "config/config.yaml"), mergeJiuwenswarmModelConfig(
      "preferred_language: en\nrsi:\n  enabled: false\nsymphony:\n  enabled: false\n", true));
    await writeFile(join(root, "later.png"), fixturePNG(true));
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("missing server port");
    const image = { name: "initial.png", mediaType: "image/png", data: fixturePNG().toString("base64") };
    const child = spawn(python!, [resolve("src/runtimes/jiuwenswarm/assets/multimodal-runner.py"),
      "Inspect the attached image and later.png.", "--output", "json", "--cwd", root, "--timeout", "30"], {
      cwd: root, windowsHide: true,
      env: { ...process.env, HOME: root, USERPROFILE: root, JIUWENSWARM_DATA_DIR: root,
        PYTHONIOENCODING: "utf-8", API_BASE: `http://127.0.0.1:${address.port}/v1`, API_KEY: "fixture",
        MODEL_NAME: "vision", MODEL_PROVIDER: "OpenAI", ENDPOINT_PROFILE: "openai" },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", chunk => { stdout += String(chunk); });
    child.stderr.on("data", chunk => { stderr += String(chunk); });
    child.stdin.on("error", () => {});
    child.stdin.end(JSON.stringify([image]));
    const timer = setTimeout(() => child.kill(), 40_000);
    try {
      const code = await new Promise<number | null>((resolve, reject) => {
        child.once("error", reject);
        child.once("close", resolve);
      });
      expect(code, stdout + stderr).toBe(0);
    } finally { clearTimeout(timer); }
    expect(requests).toHaveLength(2);
    expect(requests.map(request => request.model)).toEqual(["vision", "vision"]);
    expect(JSON.stringify(requests[0])).toContain(`data:image/png;base64,${image.data}`);
    const imageUrls = JSON.stringify(requests[1]).match(/data:image\/[^"\s]+/g) ?? [];
    expect(new Set(imageUrls).size, JSON.stringify(requests[1])).toBeGreaterThanOrEqual(2);
    expect(stdout).toContain("image checked");
    expect((await readdir(root)).filter(name => name.startsWith(".evaluator-images-"))).toEqual([]);
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
}, 60_000);
