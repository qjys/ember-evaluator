import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, test } from "vitest";

const python = process.env.AISBENCH_TEST_PYTHON;
test.skipIf(!python)("remote supervisor preserves idempotency, failure, cancellation and redacted artifacts", async () => {
  const result = await promisify(execFile)(python ?? "python3", [
    fileURLToPath(new URL("../fixtures/check-remote.py", import.meta.url)),
    fileURLToPath(new URL("../../dist/runtime/remote.py", import.meta.url)),
  ], { timeout: 30000, encoding: "utf8" });
  expect(JSON.parse(result.stdout)).toMatchObject({ passed: true });
}, 35000);

const mmPython = process.env.AISBENCH_MM_TEST_PYTHON;
test.skipIf(!mmPython)("official generator produces the requested token and image content for both presets", async () => {
  const result = await promisify(execFile)(mmPython ?? "python3", [
    fileURLToPath(new URL("../fixtures/check-generated.py", import.meta.url)),
    fileURLToPath(new URL("../../dist/runtime", import.meta.url)),
  ], { timeout: 90000, encoding: "utf8" });
  expect(JSON.parse(result.stdout.trimEnd().split("\n").at(-1) ?? "")).toMatchObject({ passed: true });
}, 100000);
