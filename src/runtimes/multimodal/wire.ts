import { expectNonEmptyString, expectRecord, rejectUnknown } from "../../core/validation/input.js";

export type EncodedAttachment = { name: string; mediaType: "image/png" | "image/jpeg" | "image/webp" | "application/pdf"; data: string };

export function parseEncodedAttachments(value: unknown): EncodedAttachment[] {
  if (!Array.isArray(value) || value.length > 32) throw new TypeError("media must contain at most 32 attachments");
  let bytes = 0;
  return value.map(raw => {
    const item = expectRecord(raw, "media");
    rejectUnknown(item, ["name", "mediaType", "data"], "media");
    const name = expectNonEmptyString(item.name, "media.name");
    const mediaType = item.mediaType;
    if (mediaType !== "image/png" && mediaType !== "image/jpeg" && mediaType !== "image/webp" && mediaType !== "application/pdf") throw new TypeError("Unsupported media type");
    const data = expectNonEmptyString(item.data, "media.data");
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(data)) throw new TypeError("media.data must be base64");
    bytes += Buffer.byteLength(data, "base64");
    if (bytes > 50 * 1024 * 1024) throw new TypeError("media exceeds 50 MiB");
    return { name, mediaType, data };
  });
}
