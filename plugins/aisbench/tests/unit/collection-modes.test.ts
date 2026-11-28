import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { classifyError } from "arsi-evaluator";
import { expect, test } from "vitest";
import { nativeBatchSize, parseNativeConfig } from "../../native-config.js";
import { NativePerformanceMetrics } from "../../native-results.js";
import { aisbenchSnapshot } from "../fixtures/results.js";

test("forwards ordered raw arguments including repeated and valueless flags", () => {
  const nativeArgs = ["--models", "backend", "--datasets", "dataset", "--extra-label", "first", "--stream", "--extra-label", "second"];
  const native = parseNativeConfig({ nativeArgs, concurrency: [8], measurementMode: "performance" });
  const fixture = fileURLToPath(new URL("../fixtures/native-argv.py", import.meta.url));
  const tokens: string[] = JSON.parse(execFileSync(process.platform === "win32" ? "python" : "python3", ["-B", fixture], { input: JSON.stringify(native), encoding: "utf8" }));
  expect(tokens.slice(tokens.indexOf("--models"), tokens.indexOf("--mode"))).toEqual(nativeArgs);
  expect(tokens.at(-1)).toBe("--batch-size=8");
  expect(nativeBatchSize(["--batch-size", "1", "--batch-size=8", "--models", "vision"])).toBe(8);
  expect(nativeBatchSize(["--batch-size", "1", "8"])).toBeUndefined();
  expect(() => parseNativeConfig({ nativeArgs: ["--api-key=private"] })).toThrow("managed option");
});

test("a diagnostic stop failure keeps verified formal measurements for offline reports", async () => {
  const snapshot = aisbenchSnapshot();
  const record = snapshot.records[0]!;
  const digest = "a".repeat(64);
  snapshot.run.source = { source: "aisbench:native", revision: "2", files: [], metadata: { bundleDigest: digest } };
  const group = { model: "vision", dataset: "textvqa", concurrency: 8, status: "measured" };
  const formal = { ...record.solve!, observations: { schemaVersion: 1, kind: "aisbench-native", bundleDigest: digest, taskId: record.key.taskId, phase: "performance", groups: [group] } };
  const common = { startedAt: record.startedAt, finishedAt: record.finishedAt, evidencePath: "c8" };
  record.steps = [
    { ...common, name: "performance", solve: formal, verdict: { passed: null, details: null }, errors: [] },
    { ...common, name: "profiling", solve: null, verdict: null, errors: [classifyError(new Error("stop_profile unconfirmed"), { phase: "solve" })] },
  ];
  record.solve = null;
  record.executionStatus = "failed";
  const metrics = await new NativePerformanceMetrics().compute(snapshot);
  expect(metrics.points[0]).toMatchObject({ status: "partial", groups: [group], collections: [{ profiling: { status: "failed", error: "stop_profile unconfirmed" } }] });
});
