import type { InputModality, PreparedTask, SourceLock, TaskAttachment } from "../contracts/task.js";
import { EvaluatorError } from "../errors/evaluator-error.js";
import { expectNonEmptyString, expectPositiveInteger, expectRecord, rejectUnknown } from "./input.js";

export function parseInputModalities(value: unknown): InputModality[] {
  if (!Array.isArray(value) || value.length === 0 || value.some(item => !["text", "image", "pdf"].includes(item))) {
    throw new TypeError("inputModalities must contain text, image, or pdf");
  }
  if (new Set(value).size !== value.length) throw new TypeError("inputModalities contains duplicates");
  return value as InputModality[];
}

export function parseTaskAttachments(value: unknown): TaskAttachment[] {
  if (!Array.isArray(value) || value.length > 32) throw new TypeError("attachments must be an array of at most 32 files");
  return value.map((raw, index) => {
    const label = `attachments[${index}]`;
    const item = expectRecord(raw, label);
    rejectUnknown(item, ["kind", "path", "sha256", "mediaType", "mode", "pages", "dpi", "rendererVersion"], label);
    const path = expectNonEmptyString(item.path, `${label}.path`);
    if (path.startsWith("/") || /[\\:\0]/u.test(path) || path.split("/").some(part => part === ".." || part === "." || part === "")) {
      throw new TypeError(`${label}.path must be relative to the public workspace`);
    }
    const sha256 = expectNonEmptyString(item.sha256, `${label}.sha256`);
    if (!/^[a-f0-9]{64}$/.test(sha256)) throw new TypeError(`${label}.sha256 must be a SHA-256 digest`);
    if (item.kind === "image") {
      rejectUnknown(item, ["kind", "path", "sha256", "mediaType"], label);
      const mediaType = item.mediaType;
      if (mediaType !== "image/png" && mediaType !== "image/jpeg" && mediaType !== "image/webp") throw new TypeError(`${label}.mediaType is unsupported`);
      return { kind: "image", path, sha256, mediaType };
    }
    if (item.kind !== "pdf") throw new TypeError(`${label}.kind must be image or pdf`);
    if (item.mode === "native") {
      rejectUnknown(item, ["kind", "path", "sha256", "mode"], label);
      return { kind: "pdf", path, sha256, mode: "native" };
    }
    rejectUnknown(item, ["kind", "path", "sha256", "mode", "pages", "dpi", "rendererVersion"], label);
    if (item.mode !== "pages" || !Array.isArray(item.pages) || item.pages.length === 0 || item.pages.length > 32) {
      throw new TypeError(`${label} requires native mode or pages mode with 1–32 page numbers`);
    }
    const pages = item.pages.map(page => expectPositiveInteger(page, `${label}.pages`));
    if (new Set(pages).size !== pages.length) throw new TypeError(`${label}.pages contains duplicates`);
    const dpi = expectPositiveInteger(item.dpi, `${label}.dpi`);
    if (dpi > 300) throw new TypeError(`${label}.dpi must be at most 300`);
    const rendererVersion = expectNonEmptyString(item.rendererVersion, `${label}.rendererVersion`);
    if (!/^\d+\.\d+\.\d+$/.test(rendererVersion)) throw new TypeError(`${label}.rendererVersion must pin a Poppler version`);
    return { kind: "pdf", path, sha256, mode: "pages", pages, dpi, rendererVersion };
  });
}

export function attachmentModalities(attachments: readonly TaskAttachment[]): InputModality[] {
  return [...new Set(attachments.map(item => item.kind === "pdf" && item.mode === "native" ? "pdf" as const : "image" as const))];
}

export function assertLockedAttachments(task: PreparedTask, source: SourceLock): void {
  const locked = new Set(source.files.map(file => file.sha256));
  for (const current of [task, ...(task.steps?.map(step => step.task) ?? [])]) {
    let attachments: TaskAttachment[];
    try { attachments = parseTaskAttachments(current.input.attachments ?? []); }
    catch (cause) { throw new EvaluatorError("TASK_DATA_INVALID", `Task ${current.input.id}: invalid attachments`, {}, { cause }); }
    for (const attachment of attachments) {
      if (!locked.has(attachment.sha256)) throw new EvaluatorError("TASK_DATA_INVALID", `Task ${current.input.id}: attachment ${attachment.path} is not part of SourceLock`);
    }
  }
}
