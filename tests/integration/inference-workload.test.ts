import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { stringify } from "yaml";
import { loadConfig } from "../../src/application/config.js";
import { inspectExperiment } from "../../src/application/inspection.js";

const target = { hardware: "npu", services: { default: { model: "vision", base_url: "http://localhost:9000/v1", api_key: "${WORKLOAD_TEST_KEY}" } },
  aisbench: { tokenizerPath: "/models/vl", remote: { ssh: { host: "load" }, pythonExecutable: "/env/bin/python", aisbenchVersion: "3.1.0" } },
  data: { mmmuParquetDir: "/datasets/MMMU" }, profiling: { traceDirectory: "/traces" }, serviceNode: "serving" };

test("one target expands structured and native workloads, preserves legacy selectors and detects conflicting fields", async () => {
  const dir = await mkdtemp(join(tmpdir(), "inference-workload-"));
  try {
    const file = join(dir, "experiment.yaml");
    await writeFile(join(dir, "targets.yaml"), stringify({ targets: { blue: target } }));
    async function load(benchmark: object) {
      await writeFile(file, stringify({ target: "blue", benchmark }));
      return (await loadConfig(file, {}, { ...process.env, WORKLOAD_TEST_KEY: "fixture-reference" })).experiment;
    }
    const request = { name: "aisbench", concurrency: [1, 8], collect: "all" };
    const named = await load({ ...request, workload: { type: "dataset", dataset: "textvqa_gen_base64", requests: 8 } });
    expect(named.benchmark).toMatchObject({ name: "aisbench-native", evaluationScenario: "inference-engine",
      config: { datasets: "textvqa_gen_base64", dataCount: 8, concurrency: [1, 8], measurementMode: "all", profiling: { serviceNode: "serving" } } });
    const old = await load({ name: "aisbench", scenario: "native", config: { datasets: "textvqa_gen_base64", backend: "vllm_api_stream_chat", dataCount: 8, concurrency: [1, 8] } });
    expect(old.benchmark.config).not.toHaveProperty("measurementMode");
    const generated = await load({ ...request, workload: { type: "synthetic-multimodal", images: "single_1080p", textTokens: 32, requests: 8 } });
    expect(generated.benchmark.config.multimodalGeneration).toEqual({ mmmuParquetDir: "/datasets/MMMU", textTokens: 32, imageScenario: "single_1080p" });
    const synthetic = await load({ ...request, workload: { type: "synthetic-text", inputTokens: 64, outputTokens: 8, requests: 16 } });
    expect(synthetic.benchmark.config).toMatchObject({ syntheticText: true, syntheticWorkload: { inputLength: 64, outputLength: 8 }, dataCount: 16 });
    const data = await load({ name: "aisbench", workload: { type: "synthetic-multimodal", action: "prepare", textTokens: 64, requests: 8 } });
    expect(data.benchmark).toMatchObject({ evaluationScenario: "task", config: { multimodalAction: "prepare" } });
    const legacyReplay = await load({ name: "agentx", scenario: "replay", config: { traceCount: 8, concurrency: [1,8] } });
    expect(legacyReplay.benchmark.config).toMatchObject({ mode: "replay", traceCount: 8, concurrency: [1,8] });
    const replay = await load({ name: "agentx", workload: { type: "replay", traces: 8 }, concurrency: [1,8] });
    expect(replay.benchmark.config).toMatchObject({ measurementMode: "performance", mode: "replay", traceCount: 8 });
    const args = ["--models", "vllm_api_stream_chat", "--datasets", "textvqa_gen_base64", "--debug", "--debug"];
    expect((await load({ name: "aisbench", workload: { type: "native", args } })).benchmark.config).toMatchObject({ nativeArgs: args, nativeConcurrency: true });
    expect((await inspectExperiment({ file, overrides: {} })).document.invocation).toMatchObject({ arguments: args, concurrency: "configured" });
    const fileConfig = await load({ name: "aisbench", workload: { type: "native", file: "./benchmark.py", args: ["--debug"] } });
    expect(fileConfig.benchmark.config).toMatchObject({ configFile: "./benchmark.py", nativeArgs: ["--debug"], nativeConcurrency: true });
    await expect(load({ name: "agentx", workload: { type: "replay", traces: 8 }, config: { mode: "standard" } })).rejects.toThrow("benchmark.config.mode");
    await expect(load({ ...request, workload: { type: "native", file: "./myconfig.py" } })).rejects.toThrow("service binding");
  } finally { await rm(dir, { recursive: true, force: true }); }
});
