import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { parseTaskAttachments } from "ember-evaluator";

export const inject = ["evaluator"];
export function apply(ctx) {
  ctx.evaluator.register("benchmark", "multimodal-example", value => {
    if (!value || typeof value !== "object" || Array.isArray(value) ||
        Object.keys(value).some(key => !["mode", "rendererVersion"].includes(key)) ||
        !["image", "native", "pages"].includes(value.mode)) throw new TypeError("mode must be image, native, or pages");
    if (value.mode === "pages" && !/^\d+\.\d+\.\d+$/.test(value.rendererVersion ?? "")) throw new TypeError("pages requires rendererVersion");
    return value;
  }, config => {
    const path = config.mode === "image" ? "figure.png" : "document.pdf";
    const source = fileURLToPath(new URL(`./${path}`, import.meta.url));
    return {
      validateSourceOnCompletedResume: true,
      async resolveSource(previous, signal) {
        const sha256 = createHash("sha256").update(await readFile(source, { signal })).digest("hex");
        const lock = { source: "multimodal-example", revision: "1", files: [{ path, sha256, origin: "packaged example" }], metadata: {} };
        if (previous && JSON.stringify(previous) !== JSON.stringify(lock)) throw new Error("SOURCE_CHANGED: example attachment changed");
        return lock;
      },
      async *enumerate() { yield { id: "colours", recordKey: "colours" }; },
      async prepare(ref, lock) {
        const attachments = parseTaskAttachments([{ path, sha256: lock.files[0].sha256,
          ...(config.mode === "image" ? { kind: "image", mediaType: "image/png" } :
            config.mode === "native" ? { kind: "pdf", mode: "native" } :
              { kind: "pdf", mode: "pages", pages: [1], dpi: 144, rendererVersion: config.rendererVersion }) }]);
        return {
          input: { id: ref.id, prompt: "Inspect the attached figure. Name the left and right colours in English. Reply with exactly two lowercase words, left first.", attachments },
          verification: { answer: "red blue" },
          solveEnv: { workdir: ".", image: null, initialFiles: [{ source, target: path }], runtime: [] },
          verifyEnv: null, transfer: null,
        };
      },
      async verify(task, result) {
        const passed = result.finalText.trim().toLowerCase() === task.verification.answer;
        return { passed, score: passed ? 1 : 0, details: {} };
      },
    };
  });
}
