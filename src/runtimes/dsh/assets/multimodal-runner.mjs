import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { mkdir, writeFile } from "node:fs/promises";
import { mkdirSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";

const chunks = [];
let inputBytes = 0;
for await (const chunk of process.stdin) { inputBytes += chunk.length; if (inputBytes > 75 * 1024 * 1024) throw new Error("DSH input exceeds 75 MiB"); chunks.push(chunk); }
const input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
const emit = value => process.stdout.write(JSON.stringify({ schemaVersion: 1, ...value }) + "\n");
let harness;
let seq = 0;
const secret = process.env.EMBER_EVALUATOR_API_KEY ?? "";
const exportedImages = new Set();
const safe = value => {
  if (Array.isArray(value)) return value.map(safe);
  if (value && typeof value === "object") {
    const id = typeof value.attachmentId === "string" ? /^sha256:([a-f0-9]{64})$/.exec(value.attachmentId)?.[1] : undefined;
    if (id && typeof value.mediaType === "string" && value.mediaType.startsWith("image/")) {
      if (!exportedImages.has(id)) {
        // The pinned DSH attachment-local backend stores admitted and tool images here.
        // Export only references from this session, never the shared home's whole store.
        const bytes = readFileSync(join(input.home, "attachments", "v1", "objects", id.slice(0, 2), id));
        if (createHash("sha256").update(bytes).digest("hex") !== id) throw new Error("DSH image attachment digest mismatch");
        mkdirSync(join(input.outputDir, "media"), { recursive: true });
        writeFileSync(join(input.outputDir, "media", id), bytes);
        exportedImages.add(id);
      }
      return { ...value, artifact: "media/" + id };
    }
    if (value.type === "image" && typeof value.data === "string") {
      const bytes = Buffer.from(value.data, "base64");
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      mkdirSync(join(input.outputDir, "media"), { recursive: true });
      writeFileSync(join(input.outputDir, "media", sha256), bytes);
      const { data, ...rest } = value;
      return { ...rest, artifact: "media/" + sha256 };
    }
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, safe(item)]));
  }
  return typeof value === "string" && secret ? value.replaceAll(secret, "[redacted]") : value;
};
const record = (type, data) => {
  mkdirSync(input.outputDir, { recursive: true });
  appendFileSync(join(input.outputDir, "trajectory.jsonl"), JSON.stringify({ schemaVersion: 1, key: input.key, seq: ++seq, at: new Date().toISOString(), type, data: safe(data) }) + "\n");
};
record("start", { harness: "dsh", inputModalities: ["text", "image"], tools: "installed profile" });
try {
  const require = createRequire(input.moduleBase);
  const { DeepSeekHarness } = await import(pathToFileURL(require.resolve("@deepseek-ai/dsh-sdk-client")).href);
  const { lastAssistantStreamChunk } = await import(pathToFileURL(require.resolve("@deepseek-ai/dsh-llm/assistant-stream")).href);
  harness = new DeepSeekHarness({ dshBin: input.dsh, dshHome: input.home, profile: input.profile,
    patches: input.patches, cwd: input.workdir, processCwd: input.workdir,
    provider: input.provider, model: input.model, env: process.env });
  const stop = () => { void harness.close(); };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  let lastActivity = 0;
  const result = await harness.run([{ type: "text", text: input.prompt }, ...input.media.map(item => ({ type: "image", data: item.data, mimeType: item.mediaType }))], {
    onNotification: notification => {
      record("dsh-notification", notification);
      if (Date.now() - lastActivity > 200) { lastActivity = Date.now(); emit({ type: "activity", activity: { message: "DSH processing multimodal input" } }); }
    },
  });
  await mkdir(input.outputDir, { recursive: true });
  await writeFile(join(input.outputDir, "session.jsonl"), JSON.stringify(safe({ sessionId: result.sessionId, finishReason: result.finishReason })) + "\n");
  if (result.finishReason !== "completed" && result.finishReason !== "max-tokens") throw new Error("DSH turn ended with " + result.finishReason);
  const samples = result.events.filter(event => ["assistant/attempt", "assistant/message"].includes(event.type))
    .map(event => event.data.usage ?? lastAssistantStreamChunk(event.data.stream, "usage")?.usage);
  const sum = key => samples.length && samples.every(sample => typeof sample?.[key] === "number")
    ? samples.reduce((total, sample) => total + sample[key], 0) : null;
  const usage = { inputTokens: sum("inputTokens"), outputTokens: sum("outputTokens"), totalTokens: sum("totalTokens") };
  record("usage", usage);
  record("end", { status: "completed", finalText: result.finalResponse });
  if (result.finishReason === "max-tokens") emit({ type: "warning", code: "SOLVER_OUTPUT_LIMIT", message: "DSH model output was truncated" });
  emit({ type: "result", result: { finalText: result.finalResponse, usage } });
} catch (error) {
  const secret = process.env.EMBER_EVALUATOR_API_KEY ?? "";
  const message = String(error.message);
  record("error", { message });
  emit({ type: "error", code: error.code === "MODULE_NOT_FOUND" ? "BENCHMARK_UNSUPPORTED" : "SOLVER_PROTOCOL_INVALID",
    message: secret ? message.replaceAll(secret, "[redacted]") : message });
  process.exitCode = 1;
} finally {
  await harness?.close();
}
