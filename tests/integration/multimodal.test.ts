import { fixturePNG } from "../fixtures/multimodal.js";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { run } from "../../src/runtimes/pi/runner.js";
import { projectRunnerInput } from "../../src/runtimes/pi/protocol.js";
import type { JsonValue } from "../../src/core/contracts/task.js";

const png = fixturePNG();
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

test.each([true, false])("Pi preserves image order and checks tool images against model capability: %s", async vision => {
  const root = await mkdtemp(join(tmpdir(), "evaluator-vision-")); roots.push(root);
  const outputDir = join(root, "logs"); await mkdir(outputDir);
  await writeFile(join(root, "screenshot.png"), png);
  const requests: { model: string; messages: { role: string; content: JsonValue }[] }[] = [];
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
    requests.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    const delta = requests.length === 1
      ? { role: "assistant", tool_calls: [{ index: 0, id: "read_image", type: "function", function: { name: "read", arguments: JSON.stringify({ path: "screenshot.png" }) } }] }
      : { role: "assistant", content: "Image received" };
    const base = { id: "vision", object: "chat.completion.chunk", created: 1, model: "fixture-vision" };
    res.writeHead(200, { "content-type": "text/event-stream" });
    for (const event of [
      { ...base, choices: [{ index: 0, delta, finish_reason: null }] },
      { ...base, choices: [{ index: 0, delta: {}, finish_reason: requests.length === 1 ? "tool_calls" : "stop" }] },
      { ...base, choices: [], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } },
    ]) res.write(`data: ${JSON.stringify(event)}\n\n`);
    res.end("data: [DONE]\n\n");
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); if (!address || typeof address === "string") throw new Error("missing server port");
  try {
    const running = run(projectRunnerInput({ key: { runId: "r", taskId: "t", attemptId: "a" },
      input: { id: "t", prompt: "View the attachments and read screenshot.png." },
      media: vision ? [{ name: "first.png", mediaType: "image/png", data: png.toString("base64") },
        { name: "second.png", mediaType: "image/png", data: fixturePNG(true).toString("base64") }] : [],
      model: { name: "fixture-vision", endpoint: `http://127.0.0.1:${address.port}/v1`, provider: null,
        api: "openai-completions", inputModalities: vision ? ["text", "image"] : ["text"], retry: { maxAttempts: 1 } },
      auth: { value: "fixture", reference: null }, workdir: root, outputDir }));
    if (!vision) {
      await expect(running).rejects.toMatchObject({ code: "BENCHMARK_UNSUPPORTED" });
      expect(requests).toHaveLength(1);
      return;
    }
    expect((await running).finalText).toBe("Image received");
    expect(requests).toHaveLength(2);
    expect(requests.every(request => request.model === "fixture-vision")).toBe(true);
    const images = (value: unknown): number => {
      if (Array.isArray(value)) return value.reduce((sum, item) => sum + images(item), 0);
      if (value && typeof value === "object") return (Reflect.get(value, "type") === "image_url" ? 1 : 0) + Object.values(value).reduce<number>((sum, item) => sum + images(item), 0);
      return 0;
    };
    expect(images(requests[0])).toBe(2);
    const firstRequest = JSON.stringify(requests[0]);
    expect(firstRequest.indexOf(png.toString("base64"))).toBeLessThan(firstRequest.indexOf(fixturePNG(true).toString("base64")));
    expect(images(requests[1])).toBe(3);
    for (const name of ["session.jsonl", "trajectory.jsonl"]) {
      const evidence = await readFile(join(outputDir, name), "utf8");
      expect(evidence).not.toContain(png.toString("base64"));
      expect(evidence).toContain("artifact:media/");
    }
    expect(await readFile(join(outputDir, "media", createHash("sha256").update(png).digest("hex")))).toEqual(png);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
}, 30_000);
