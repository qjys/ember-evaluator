import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { JsonValue } from "../../core/contracts/task.js";

/** Evidence-only copies. Never replace media in the active model conversation. */
export function externalizeMedia(value: JsonValue, outputDir: string): JsonValue {
  const save = (data: string, mediaType: string): string => {
    const bytes = Buffer.from(data, "base64");
    const digest = createHash("sha256").update(bytes).digest("hex");
    mkdirSync(join(outputDir, "media"), { recursive: true });
    const path = join(outputDir, "media", digest);
    try { writeFileSync(path, bytes, { flag: "wx", mode: 0o600 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    return `artifact:media/${digest} (${mediaType})`;
  };
  if (typeof value === "string") {
    const match = /^data:((?:image\/[^;,]+)|application\/pdf);base64,([A-Za-z0-9+/=\r\n]+)$/.exec(value);
    return match ? save(match[2]!, match[1]!) : value;
  }
  if (Array.isArray(value)) return value.map(item => externalizeMedia(item, outputDir));
  if (value !== null && typeof value === "object") {
    if (value.type === "image" && typeof value.data === "string" && typeof value.mimeType === "string") {
      const { data, ...rest } = value;
      return { ...rest, artifact: save(data, value.mimeType) };
    }
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, externalizeMedia(item, outputDir)]));
  }
  return value;
}
