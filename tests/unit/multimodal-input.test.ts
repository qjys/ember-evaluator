import { fixturePNG } from "../fixtures/multimodal.js";
import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { afterEach, expect, test } from "vitest";
import type { EnvironmentSession } from "../../src/core/contracts/environment.js";
import type { AttemptContext } from "../../src/core/contracts/solver.js";
import type { TaskAttachment } from "../../src/core/contracts/task.js";
import { parseInputModalities, parseTaskAttachments } from "../../src/core/validation/multimodal.js";
import { loadAttachments, requireInputModalities } from "../../src/runtimes/multimodal/input.js";
import { parseRunnerInput, projectRunnerInput } from "../../src/runtimes/pi/protocol.js";
import { parseModel } from "../../src/config/effective.js";
import { fixturePDF } from "../fixtures/officeqa.js";

const roots: string[] = [];
const png = fixturePNG();
const digest = createHash("sha256").update(png).digest("hex");
const attachment: TaskAttachment = { kind: "image", path: "figure.png", sha256: digest, mediaType: "image/png" };
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

test("attachment paths, PDF rendering policy and model modalities are validated", () => {
  for (const path of ["../answer.png", "/tests/answer.png", "C:/answer.png", "a/../answer.png", "a\\image.png"]) {
    expect(() => parseTaskAttachments([{ ...attachment, path }])).toThrow(/relative/);
  }
  expect(() => parseTaskAttachments([{ kind: "pdf", path: "doc.pdf", sha256: digest }])).toThrow();
  expect(() => parseTaskAttachments([{ kind: "pdf", path: "doc.pdf", sha256: digest, mode: "pages", pages: [1, 1], dpi: 144, rendererVersion: "22.02.0" }])).toThrow(/duplicates/);
  expect(() => parseInputModalities(["image", "image"])).toThrow(/duplicates/);
  expect(() => parseInputModalities(["video"])).toThrow();
  expect(() => requireInputModalities({ id: "task", prompt: "Look", attachments: [attachment] }, ["text"])).toThrow(/does not support image/);
});

test("model and public attachments survive the Pi protocol without private payload fields", () => {
  const model = parseModel({ name: "vision", endpoint: "http://localhost/v1", api: "openai-completions", inputModalities: ["text", "image"] });
  const projected = projectRunnerInput({ key: { runId: "run", taskId: "task", attemptId: "1" },
    input: { id: "task", prompt: "Look", attachments: [attachment], answer: "private" }, model,
    auth: { value: "fixture", reference: null }, workdir: "/workspace", outputDir: "/logs/agent" });
  expect(parseRunnerInput(projected)).toEqual(projected);
  expect(projected.input).not.toHaveProperty("answer");
  expect(projected.model.inputModalities).toEqual(["text", "image"]);
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "evaluator-media-")); roots.push(root);
  const paths = { root, agent: join(root, "agent"), verifier: join(root, "verifier"), artifacts: join(root, "artifacts") };
  await Promise.all(Object.values(paths).map(path => mkdir(path, { recursive: true })));
  await writeFile(join(root, attachment.path), png);
  const context: AttemptContext = { key: { runId: "run", taskId: "task", attemptId: "1" }, paths, signal: AbortSignal.timeout(10_000) };
  const session: EnvironmentSession = { id: "local", workdir: root, agentOutputDir: paths.agent, verifierOutputDir: paths.verifier,
    metadata: { kind: "local" }, download: (source, target) => copyFile(join(root, source), target), upload: (source, target) => copyFile(source, target),
    start: async () => { throw new Error("unused"); }, exportState: async () => { throw new Error("unused"); },
    restoreState: async () => {}, dispose: async () => {} };
  return { root, context, session };
}

test("reads bytes from the execution environment and checks the locked digest", async () => {
  const { root, session, context } = await fixture();
  const input = { id: "task", prompt: "Look", attachments: [attachment] };
  const media = await loadAttachments(input, session, context);
  expect(media).toEqual([{ name: "figure.png", mediaType: "image/png", data: png.toString("base64") }]);
  expect(await readFile(join(context.paths.agent, "input-media", digest))).toEqual(png);
  await writeFile(join(root, attachment.path), "changed");
  await expect(loadAttachments(input, session, context)).rejects.toThrow(/digest mismatch/);
});

test("rejects MIME mismatch and propagates cancellation", async () => {
  const { session, context } = await fixture();
  await expect(loadAttachments({ id: "task", prompt: "Look", attachments: [{ ...attachment, mediaType: "image/jpeg" }] }, session, context)).rejects.toThrow(/invalid image\/jpeg/);
  const signal = AbortSignal.abort(new Error("cancelled"));
  await expect(loadAttachments({ id: "task", prompt: "Look", attachments: [attachment] }, session, { ...context, signal })).rejects.toThrow(/cancelled/);
});

const popplerVersion = /version (\d+\.\d+\.\d+)/.exec(spawnSync("pdftoppm", ["-v"], { encoding: "utf8" }).stderr ?? "")?.[1];
test.skipIf(!popplerVersion)("renders a real PDF with a pinned renderer and rejects nonexistent pages", async () => {
  const { root, session, context } = await fixture();
  const pdf = fixturePDF(); await writeFile(join(root, "document.pdf"), pdf);
  const attachment: TaskAttachment = { kind: "pdf", path: "document.pdf", sha256: createHash("sha256").update(pdf).digest("hex"),
    mode: "pages", pages: [1], dpi: 72, rendererVersion: popplerVersion! };
  const input = { id: "pdf", prompt: "Look", attachments: [attachment] };
  const media = await loadAttachments(input, session, context);
  expect(media).toEqual([expect.objectContaining({ name: "document.pdf#page=1", mediaType: "image/png" })]);
  expect(await loadAttachments(input, session, context)).toEqual(media);
  await expect(loadAttachments({ ...input, attachments: [{ ...attachment, pages: [2] }] }, session, context)).rejects.toThrow(/PDF rendering failed/);
  await expect(loadAttachments({ ...input, attachments: [{ ...attachment, rendererVersion: "0.0.0" }] }, session, context)).rejects.toThrow(/PDF rendering failed/);
});

test("native PDF preserves original bytes and a remote environment owns attachment paths", async () => {
  const { session, context } = await fixture();
  const pdf = fixturePDF();
  const attachment: TaskAttachment = { kind: "pdf", path: "public/document.pdf", sha256: createHash("sha256").update(pdf).digest("hex"), mode: "native" };
  const sources: string[] = [];
  const remote = { ...session, workdir: "/workspace", metadata: { kind: "docker" },
    download: async (source: string, target: string) => { sources.push(source); await writeFile(target, pdf); } };
  expect(await loadAttachments({ id: "pdf", prompt: "Look", attachments: [attachment] }, remote, context)).toEqual([
    { name: "public/document.pdf", mediaType: "application/pdf", data: pdf.toString("base64") },
  ]);
  expect(sources).toEqual(["public/document.pdf"]);
});
