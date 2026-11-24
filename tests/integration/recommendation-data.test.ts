import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { text } from "node:stream/consumers";
import { stringify } from "yaml";
import { expect, test } from "vitest";
import { runCli } from "../../src/cli/main.js";
import { northStarLengths, parseRecommendationConfig } from "../../src/plugins/benchmarks/recommendation/config.js";

test("generated mode keeps the north-star workload and rejects conflicting data sources", () => {
  const config = { dataMode: "generated", prefix1File: "a", prefix2File: "b" };
  const point = parseRecommendationConfig(config);
  expect(point.inputs.map(input => input.length)).toEqual(northStarLengths);
  expect(point).toMatchObject({ requests: 8, warmup: 2, generator: { seed: 42, samplesPerLength: 4 } });
  for (const override of [{ inputs: [] }, { promptDir: "." }, { generator: { lengths: [128] } },
    { generator: { samplesPerLength: 7 } }, { scenario: "custom", generator: { lengths: [128, 128] } },
    { dataMode: "files", promptDir: ".", generator: {} }])
    expect(() => parseRecommendationConfig({ ...config, ...override })).toThrow();
});

test("generated data can be replayed byte for byte and is verified before service access", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gr-data-"));
  const requests: string[] = [], events: string[] = [];
  const server = createServer(async (req, res) => {
    events.push(req.url ?? "");
    if (req.url === "/v1/gr/beam_search") {
      requests.push(JSON.parse(await text(req)).prompt);
      res.end(JSON.stringify({ choices: [{ output_ids: [151669, 159861, 168053], score: 1 }] }));
    } else res.end("{}");
  });
  const oldPath = process.env.PYTHONPATH;
  try {
    const tokenizer = process.env.GR_TEST_TOKENIZER ?? join(dir, "tokenizer");
    if (!process.env.GR_TEST_TOKENIZER) {
      await mkdir(tokenizer);
      await writeFile(join(tokenizer, "vocab.json"), JSON.stringify({ "<s_a_0>": 151669, "<s_b_0>": 159861,
        "<s_c_0>": 168053, "<s_c_1>": 168054 }));
      process.env.PYTHONPATH = fileURLToPath(new URL("../fixtures/recommendation/tokenizer-stub/", import.meta.url));
    }
    await writeFile(join(dir, "a"), '{"0":[0]}');
    await writeFile(join(dir, "b"), '{"0,0":[0,1]}');
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("fixture server has no port");
    const root = join(dir, "results");
    const yaml = join(dir, "test.yaml");
    const python = process.env.GR_TEST_PYTHON ?? execFileSync(process.platform === "win32" ? "python" : "python3",
      ["-c", "import sys; print(sys.executable)"], { encoding: "utf8" }).trim();
    const save = async (source: Record<string, unknown>) => writeFile(yaml, stringify({
      services: { default: { model: "test", base_url: "http://127.0.0.1:" + address.port } },
      benchmark: { name: "recommendation", scenario: "custom", solver: { config: { tokenizerPath: tokenizer, lengthToleranceTokens: 3,
        pythonExecutable: python } },
        config: { prefix1File: "a", prefix2File: "b", warmup: 1, requests: 5, ...source } }, output: { directory: root } }));
    const generator = { seed: 42, lengths: [128, 256], samplesPerLength: 3 };
    const generate = (settings = generator) => save({ dataMode: "generated", generator: settings });
    const output: string[] = [], errors: string[] = [];
    const cli = (...args: string[]) => runCli(["run", yaml, "--api-key", "EMPTY", ...args],
      { out: s => output.push(s), error: s => errors.push(s) });
    await generate({ ...generator, lengths: [1] });
    expect(await cli("--dry-run")).toBe(2);
    expect(errors.join("\n")).toContain("L=1");
    await generate();
    expect(await cli("--dry-run"), errors.join("\n")).toBe(0);
    expect(events).toEqual([]);
    const [id] = await readdir(join(root, "datasets"));
    const dataset = join(root, "datasets", id!);
    const raw = await readFile(join(dataset, "dataset.json"));
    expect(id).toEqual(createHash("sha256").update(raw).digest("hex"));
    const manifest = JSON.parse(raw.toString("utf8"));
    expect(manifest).toMatchObject({ seed: 42, generatorVersion: 1, samplesPerLength: 3, tokenizer: { sha256: expect.stringMatching(/^[0-9a-f]{64}$/u) } });
    const inputs: { length: number; file: string }[] = [], expectedRequests: string[] = [];
    for (const p of manifest.points) {
      const file = join(dataset, p.file);
      inputs.push({ length: p.length, file });
      const data = await readFile(file);
      expect(createHash("sha256").update(data).digest("hex")).toBe(p.sha256);
      expect(p.tokenLengths).toHaveLength(3);
      expect(p.tokenLengths.every((n: number) => Math.abs(n - p.length) <= 3)).toBe(true);
      const [a, b, c] = JSON.parse(data.toString("utf8"));
      expect(a).toContain("<|sid_begin|><s_a_0><s_b_0><s_c_");
      expectedRequests.push(a, a, b, c, a, b);
    }
    expect(await cli(), errors.join("\n")).toBe(0);
    const generated = output.at(-1)!;
    expect(requests).toEqual(expectedRequests);
    expect(await readdir(join(root, "datasets"))).toEqual([id]);
    expect(await readFile(join(generated, "report.md"), "utf8")).toContain("../datasets/" + id + "/dataset.json");
    const metrics = async (run: string) => JSON.parse(await readFile(join(run, "metrics.json"), "utf8")).metrics["recommendation-performance"];
    const m = await metrics(generated);
    expect(m).toMatchObject({ dataMode: "generated", generatedManifestSha256: id });
    await save({ dataMode: "files", inputs });
    requests.length = 0;
    expect(await cli(), errors.join("\n")).toBe(0);
    expect(requests).toEqual(expectedRequests);
    expect(await metrics(output.at(-1)!)).toMatchObject({ dataMode: "files", sourceRevision: m.sourceRevision });
    await generate({ ...generator, seed: 43 });
    expect(await cli("--dry-run")).toBe(0);
    expect(await readdir(join(root, "datasets"))).toHaveLength(2);
    await generate();
    await writeFile(inputs[0]!.file, "[]");
    expect(await cli("--dry-run")).toBe(2);
    expect(errors.join("\n")).toContain("digest");
    await save({ inputs });
    expect(await cli("--dry-run")).toBe(2);
    expect(requests).toEqual(expectedRequests);
  } finally {
    if (oldPath === undefined) delete process.env.PYTHONPATH;
    else process.env.PYTHONPATH = oldPath;
    if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  }
}, 180_000);
