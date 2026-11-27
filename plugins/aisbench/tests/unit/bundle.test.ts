import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { bundleDigest, bundleFiles, verifyResources, upstreamRevision } from "../../ssh/bundle.js";

describe("owned runtime resources", () => {
  it("preserves upstream files and a reproducible LF-normalized runtime digest", async () => {
    const files = await bundleFiles();
    expect(Object.keys(files)).toEqual(["remote.py", "native.py", "service_collections.py", "profile_export.py", "synthetic.py", "upstream/aisbench_test.py", "upstream/cal_prefix_hit_rate.py", "upstream/data_picker.py", "upstream/default_api.py", "upstream/generate_dataset.py", "upstream/save_file.py", "upstream/GSM8K.jsonl", "upstream/LICENSE", "upstream/NOTICE.md"]);
    expect(upstreamRevision).toBe("ac06bd619726663ac8c7b0c84c9b3cdbb041b062");
    expect(files["remote.py"]).toBe((await readFile(new URL("../../runtime/remote.py", import.meta.url), "utf8")).replace(/\r\n/gu, "\n"));
    expect(await bundleDigest()).toBe(createHash("sha256").update(JSON.stringify(files)).digest("hex"));
    await expect(verifyResources()).resolves.toBeUndefined();
  });
});
