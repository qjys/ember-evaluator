import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, beforeAll, expect, test } from "vitest";

const pluginRoot = fileURLToPath(new URL("../../", import.meta.url));
const scratch = join(pluginRoot, ".scratch");
let directory: string;
let entryFingerprint: string;
const execute = promisify(execFile);
async function build(): Promise<string> {
  await execute(process.execPath, ["scripts/build.mjs"], { cwd: directory });
  return createHash("sha256").update(await readFile(join(directory, "dist/index.js"))).digest("hex");
}
async function load(): Promise<void> {
  // Registration validates resources before touching the supplied evaluator.
  await execute(process.execPath, ["--input-type=module", "-e",
    'const plugin = await import("./dist/index.js"); await plugin.apply({evaluator:{registerProfile(){},register(){}}});'], { cwd: directory });
}
beforeAll(async () => {
  await mkdir(scratch, { recursive: true });
  directory = await mkdtemp(join(scratch, "resource-build-"));
  for (const name of ["index.ts", "config.ts", "validation.ts", "benchmark.ts", "solver.ts", "native-benchmark.ts", "native-config.ts", "native-results.ts", "measurement-files.ts", "evidence.ts", "metrics.ts", "reporter.ts", "resources.json", "package.json", "ssh", "scripts", "profiles", "runtime"]) {
    await cp(join(pluginRoot, name), join(directory, name), { recursive: true });
  }
  entryFingerprint = await build();
  await load();
}, 15000);
afterAll(async () => {
  if (directory) {
    expect(dirname(resolve(directory))).toBe(resolve(scratch));
    await rm(directory, { recursive: true, force: true });
  }
});

test.each(["profiles/aisbench.yaml", "runtime/remote.py", "runtime/upstream/data_picker.py"])(
  "rejects stale %s and changes entry fingerprint after rebuild", async asset => {
    const source = join(directory, asset), installed = join(directory, "dist", asset);
    const original = await readFile(source, "utf8");
    try {
      await writeFile(installed, original + "\n# changed asset\n");
      await expect(load()).rejects.toThrow(/AISBench resource changed/u);
      await writeFile(source, original + "\n# changed asset\n");
      expect(await build()).not.toBe(entryFingerprint);
      await load();
    } finally {
      await writeFile(source, original);
      expect(await build()).toBe(entryFingerprint);
    }
  }, 15000);

test("rejects an incomplete installation before registering components", async () => {
  const path = join(directory, "dist/runtime/upstream/NOTICE.md");
  await unlink(path);
  await expect(load()).rejects.toThrow(/AISBench resource missing/u);
  await build();
});
