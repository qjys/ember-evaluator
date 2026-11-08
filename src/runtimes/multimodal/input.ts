import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { copyFile, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { resizeImage } from "@earendil-works/pi-coding-agent";
import type { EnvironmentSession } from "../../core/contracts/environment.js";
import type { AttemptContext } from "../../core/contracts/solver.js";
import type { InputModality, PublicTask } from "../../core/contracts/task.js";
import { EvaluatorError } from "../../core/errors/evaluator-error.js";
import { attachmentModalities, parseTaskAttachments } from "../../core/validation/multimodal.js";
import { acquireRuntimeLock } from "../../infrastructure/runtime-installation/lock.js";

import type { EncodedAttachment } from "./wire.js";
const execute = promisify(execFile);
const MAX_BYTES = 50 * 1024 * 1024;

export function requireInputModalities(input: PublicTask, supported: readonly InputModality[]): void {
  const missing = attachmentModalities(parseTaskAttachments(input.attachments ?? [])).filter(kind => !supported.includes(kind));
  if (missing.length) throw new EvaluatorError("BENCHMARK_UNSUPPORTED", `Task ${input.id}: this model/Harness combination does not support ${missing.join(", ")}`);
}

function mediaType(bytes: Buffer): EncodedAttachment["mediaType"] | undefined {
  if (bytes.length > 32 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) && bytes.toString("ascii", bytes.length - 8, bytes.length - 4) === "IEND") return "image/png";
  if (bytes.length > 4 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255 && bytes.at(-2) === 255 && bytes.at(-1) === 217) return "image/jpeg";
  if (bytes.length > 12 && bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP" && bytes.readUInt32LE(4) + 8 === bytes.length) return "image/webp";
  if (bytes.toString("ascii", 0, 5) === "%PDF-" && /%%EOF\s*$/.test(bytes.subarray(-1024).toString("ascii"))) return "application/pdf";
  return undefined;
}

/** Reads from the execution environment, including remote worker/container paths. */
export async function loadAttachments(input: PublicTask, session: EnvironmentSession, context: AttemptContext): Promise<EncodedAttachment[]> {
  context.signal.throwIfAborted();
  const attachments = parseTaskAttachments(input.attachments ?? []);
  if (!attachments.length) return [];
  const root = join(context.paths.agent, "input-media");
  await mkdir(root, { recursive: true });
  const encoded: EncodedAttachment[] = [];
  let total = 0;
  let sourceBytes = 0;
  const add = async (file: string, name: string, expected: EncodedAttachment["mediaType"]) => {
    context.signal.throwIfAborted();
    const info = await stat(file);
    if (!info.isFile() || info.size === 0 || info.size > MAX_BYTES || total + info.size > MAX_BYTES || encoded.length >= 32) {
      throw new EvaluatorError("TASK_DATA_INVALID", `Task ${input.id}: attachment ${name} exceeds the 32-image / 50 MiB input limit`);
    }
    const bytes = await readFile(file, { signal: context.signal });
    if (mediaType(bytes) !== expected) throw new EvaluatorError("TASK_DATA_INVALID", `Task ${input.id}: attachment ${name} has invalid ${expected} content`);
    if (expected !== "application/pdf" && await resizeImage(bytes, expected) === null) {
      throw new EvaluatorError("TASK_DATA_INVALID", `Task ${input.id}: attachment ${name} cannot be decoded as an image`);
    }
    context.signal.throwIfAborted();
    total += bytes.length;
    encoded.push({ name, mediaType: expected, data: bytes.toString("base64") });
  };
  for (const attachment of attachments) {
    const file = join(root, attachment.sha256);
    // Each environment resolves this public relative path against its own workspace.
    await session.download(attachment.path, file, context.signal);
    const info = await stat(file);
    sourceBytes += info.size;
    if (!info.isFile() || info.size === 0 || info.size > MAX_BYTES || sourceBytes > MAX_BYTES) throw new EvaluatorError("TASK_DATA_INVALID", `Task ${input.id}: invalid attachment size for ${attachment.path}`);
    const bytes = await readFile(file, { signal: context.signal });
    if (createHash("sha256").update(bytes).digest("hex") !== attachment.sha256) {
      throw new EvaluatorError("TASK_DATA_INVALID", `Task ${input.id}: digest mismatch for ${attachment.path}`);
    }
    if (attachment.kind === "image") await add(file, attachment.path, attachment.mediaType);
    else if (attachment.mode === "native") await add(file, attachment.path, "application/pdf");
    else {
      if (mediaType(bytes) !== "application/pdf") throw new EvaluatorError("TASK_DATA_INVALID", `Task ${input.id}: invalid PDF ${attachment.path}`);
      try {
        const version = await execute("pdftoppm", ["-v"], { signal: context.signal });
        if (!new RegExp(`\\bversion ${attachment.rendererVersion.replaceAll(".", "\\.")}(?:\\s|$)`).test(version.stderr + version.stdout)) {
          throw new Error(`pdftoppm must be version ${attachment.rendererVersion}`);
        }
        for (const page of attachment.pages) {
          const name = `${attachment.sha256}-${attachment.rendererVersion}-${attachment.dpi}-${page}`;
          const prefix = join(tmpdir(), "ember-evaluator-pdf-pages-v1", name);
          const target = `${prefix}.png`;
          const release = await acquireRuntimeLock(`${prefix}.lock`, context.signal);
          try {
            const cached = await readFile(`${target}.sha256`, "utf8").catch(() => "");
            const existing = cached ? await readFile(target).catch(() => Buffer.alloc(0)) : Buffer.alloc(0);
            if (!cached || createHash("sha256").update(existing).digest("hex") !== cached) {
              // A page beyond the document must fail, never render its last page instead.
              const info = await execute("pdfinfo", ["-f", String(page), "-l", String(page), file], { signal: context.signal, maxBuffer: 1024 * 1024 });
              const pages = Number(/^Pages:\s+(\d+)/m.exec(info.stdout)?.[1]);
              if (!Number.isInteger(pages) || page > pages) throw new Error(`PDF has ${pages} pages; requested ${page}`);
              const size = /^Page(?:\s+\d+)?\s+size:\s+([\d.]+) x ([\d.]+) pts/m.exec(info.stdout);
              if (!size || Number(size[1]) * Number(size[2]) * (attachment.dpi / 72) ** 2 > 40_000_000) throw new Error("PDF page exceeds the 40 megapixel rendering limit");
              await execute("pdftoppm", ["-f", String(page), "-l", String(page), "-r", String(attachment.dpi), "-singlefile", "-png", file, prefix],
                { signal: context.signal, maxBuffer: 1024 * 1024 });
              if ((await stat(target)).size > MAX_BYTES) throw new Error("Rendered page exceeds 50 MiB");
              await writeFile(`${target}.sha256`, createHash("sha256").update(await readFile(target, { signal: context.signal })).digest("hex"));
            }
            const artifact = join(root, `${name}.png`);
            await copyFile(target, artifact);
            await add(artifact, `${attachment.path}#page=${page}`, "image/png");
          } catch (error) {
            await rm(target, { force: true });
            throw error;
          } finally {
            await release();
          }
        }
      } catch (cause) {
        context.signal.throwIfAborted();
        throw new EvaluatorError("TASK_DATA_INVALID", `Task ${input.id}: PDF rendering failed for ${attachment.path}`, {}, { cause });
      }
    }
  }
  const identity = createHash("sha256").update(JSON.stringify(attachments)).digest("hex");
  await writeFile(join(root, `${identity}.json`), JSON.stringify({ taskId: input.id, attachments,
    inputs: encoded.map(({ name, mediaType, data }) => ({ name, mediaType, sha256: createHash("sha256").update(Buffer.from(data, "base64")).digest("hex") })) }) + "\n");
  return encoded;
}
