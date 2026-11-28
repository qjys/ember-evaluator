import { expect, test } from "vitest";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parseWorkload } from "../../config.js";
import { parseAisbenchSummary } from "../../evidence.js";
import { AisbenchBenchmark } from "../../benchmark.js";

test("synthetic workload identifies its source and requires full measured token counts", async () => {
  const workload = parseWorkload({ dataset: "synthetic", inputLength: 4096, outputLength: 2048, dataCount: 1320, concurrency: 330, warmups: 8 });
  const benchmark = new AisbenchBenchmark({ workload });
  expect((await benchmark.resolveSource(null, new AbortController().signal)).source).toBe("aisbench:synthetic");
  const row = { total_req: "1320", failed_req: "0.0", total_input_tokens: "5406720", total_output_tokens: "2703360", qps: "2", output_throughput: "4096", "TTFT P90": "16", "TPOT SLO_P90": "68", "E2EL P90": "150000" };
  const summary = { schemaVersion: 1, kind: "aisbench", workload, bundleDigest: "b".repeat(64), aisbenchVersion: "test", rows: [row] };
  expect(parseAisbenchSummary(summary).workload).toEqual(workload);
  for (const change of [{ failed_req: "1" }, { total_output_tokens: "100" }, { "TPOT SLO_P90": "NaN" }])
    expect(() => parseAisbenchSummary({ ...summary, rows: [{ ...row, ...change }] })).toThrow();
  expect(() => parseWorkload({ dataset: "synthetic", warmups: -1 })).toThrow();
  expect(() => parseWorkload({ dataset: "synthetic", prefixCache: { enabled: true } })).toThrow();
  expect(() => parseWorkload({ warmups: 8 })).toThrow();
});

test("native synthetic configuration and CSV parsing without AISBench or a model", () => {
  const result = spawnSync(process.platform === "win32" ? "python" : "python3", ["-X", "utf8", "-B", fileURLToPath(new URL("../fixtures/check-synthetic.py", import.meta.url))], { encoding: "utf8" });
  expect(result.status, result.stdout + result.stderr).toBe(0);
});
