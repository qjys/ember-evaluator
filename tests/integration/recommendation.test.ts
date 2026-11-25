import { createServer } from "node:http";
import { execFileSync } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { text } from "node:stream/consumers";
import { parse, stringify } from "yaml";
import { expect, test } from "vitest";
import { runCli } from "../../src/cli/main.js";
import { northStarLengths } from "../../src/plugins/benchmarks/recommendation/config.js";

test("five-length GR run uses single prompts, resets after warmup, and rebuilds the report offline", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gr-north-star-"));
  const events: string[] = [];
  const server = createServer(async (req, res) => {
    res.setHeader("Content-Type", "application/json");
    switch (req.url) {
      case "/health": events.push("health"); return res.end("ok");
      case "/v1/gr/catalog": {
        const body = JSON.parse(await text(req));
        events.push(body.prefix1_file === join(dir, "p1.json") && body.prefix2_file === join(dir, "p2.json") ? "catalog" : "wrong paths");
        return res.end("{}");
      }
      case "/debug/gr_counters?reset=true": events.push("reset"); return res.end("{}");
      case "/debug/gr_counters": events.push("snapshot"); return res.end(JSON.stringify({ groups_finished: 8, groups_admitted: 8,
        shared_prefix_forward: 5, decode_forward: 16, request_span_us: 8000 }));
      case "/v1/gr/beam_search": {
        const body = JSON.parse(await text(req));
        const valid = req.method === "POST" && body.n === 1 && body.beam_width === 128 && body.max_decode_steps === 3 &&
          body.constraint_backend === "catalog" && body.ignore_eos === true && body.catalog_path === null;
        events.push(valid ? body.prompt : "wrong workload");
        return res.end(JSON.stringify({ choices: [{ output_ids: [151669, 159861, 168053], score: -0.75 }] }));
      }
      default: res.statusCode = 404; return res.end("{}");
    }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const close = () => new Promise<void>((resolve, reject) => server.close(err => err ? reject(err) : resolve()));
  try {
    const addr = server.address();
    if (!addr || typeof addr === "string") throw new Error("Invalid fixture endpoint");
    const prompts = ["甲", "原样\\n", "截断<s_a_0>", "甲"];
    for (const length of northStarLengths) await writeFile(join(dir, `prompts_${length}_batch_4.json`), JSON.stringify(prompts));
    await writeFile(join(dir, "p1.json"), '{"0":[0]}');
    await writeFile(join(dir, "p2.json"), '{"0,0":[0]}');
    const config = join(dir, "experiment.yaml");
    await writeFile(config, stringify({ services: { default: { model: "fixture", base_url: `http://127.0.0.1:${addr.port}` } },
      benchmark: { name: "recommendation", scenario: "north-star", config: { tag: "fast", promptDir: ".", prefix1File: "p1.json", prefix2File: "p2.json" },
        solver: { name: "sglang-gr", config: { pythonExecutable: execFileSync(process.platform === "win32" ? "python" : "python3",
          ["-c", "import sys; print(sys.executable)"], { encoding: "utf8" }).trim() } } },
      output: { directory: join(dir, "results") } }));
    const out: string[] = [], errors: string[] = [];
    const io = { out: (line: string) => out.push(line), error: (line: string) => errors.push(line) };
    expect(await runCli(["run", config, "--api-key", "EMPTY", "--dry-run"], io), errors.join("\n")).toBe(0);
    expect(events).toEqual([]);
    const rc = await runCli(["run", config, "--api-key", "EMPTY"], io);
    expect(rc, errors.join("\n") + "\n" + out.join("\n")).toBe(0);
    expect(events).toEqual(northStarLengths.flatMap(() => ["health", "catalog", ...prompts.slice(0, 2), "reset", ...prompts, ...prompts, "snapshot"]));
    const run = out.at(-1)!;
    const baseYaml = join(dir, "base.yaml");
    const baseConfig = parse(await readFile(config, "utf8"));
    baseConfig.benchmark.config.tag = "base";
    await writeFile(baseYaml, stringify(baseConfig));
    expect(await runCli(["run", baseYaml, "--api-key", "EMPTY"], io), errors.join("\n")).toBe(0);
    const base = out.at(-1)!;
    await close();
    expect(await runCli(["compare-recommendation", base, run], io), errors.join("\n")).toBe(0);
    const comparison = JSON.parse(out.at(-1)!);
    expect(comparison.status).toBe("match");
    expect(comparison.points.map((p: { length: number }) => p.length)).toEqual(northStarLengths);
    expect(comparison.points[0]).toMatchObject({ verified: 8, sidMatches: 8, scoreMatches: 8, fastpath: { fastpathStatus: "hit" } });
    const metrics = JSON.parse(await readFile(join(run, "metrics.json"), "utf8")).metrics["recommendation-performance"];
    expect(metrics).toMatchObject({ complete: true, fast: "hit", l128: "unassessed", northStar: { budgetVersion: "gr-a2-2026-11-23" } });
    expect(metrics.points).toHaveLength(5);
    const sessions = (await readdir(run, { recursive: true })).filter(file => file.endsWith(join("agent", "session.jsonl")));
    expect(sessions).toHaveLength(5);
    for (const file of sessions) {
      const records = (await readFile(join(run, file), "utf8")).trim().split("\n").map(line => JSON.parse(line));
      expect(records.map(r => r.phase)).toEqual(["warmup", "warmup", ...Array(8).fill("measure")]);
      for (const r of records) {
        expect(r.ttftMs).toBe(r.e2eMs);
        expect(r.perTokenMs).toBe(r.e2eMs / 3);
        expect(r).toMatchObject({ choiceCount: 1, sidValid: true, scoresFinite: true, status: "ok", outputTokens: 3 });
      }
    }
    for (const point of metrics.points) {
      expect(point).toMatchObject({ successfulRequests: 8, prompts: 8, fastpathForward: 5,
        client: { success: 8, failed: 0, outputTokens: 24, meanOutputTokens: 3, sidValidRequests: 8, scoresFiniteRequests: 8 } });
      expect(point.client.qps).toBeGreaterThan(0);
      expect(point.client.e2eMs.p50).toBe(point.p50Ms);
      expect(point.client.tpotMs).toBe(point.client.e2eMs.mean / 3);
    }
    const before = await readFile(join(run, "report.md"), "utf8");
    for (const label of ["五档有效测量 齐全", "p99", "QPS", "TPOT", "cli%", "910B1 graph"]) expect(before).toContain(label);
    expect(await runCli(["report", run], io), errors.join("\n")).toBe(0);
    expect(await readFile(join(run, "report.md"), "utf8")).toBe(before);
    await writeFile(join(dir, "p1.json"), '{"0":[1]}');
    expect(await runCli(["run", config, "--api-key", "EMPTY", "--resume"], io)).not.toBe(0);
  } finally {
    if (server.listening) await close();
    await rm(dir, { recursive: true, force: true });
  }
}, 120_000);
