import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { text } from "node:stream/consumers";
import { stringify } from "yaml";
import { expect, test } from "vitest";
import { runCli } from "../../src/cli/main.js";

test.each(["both", "host-only", "performance", "profiling", "zero-hit", "request-error"])(
  "routes collection %s and rebuilds linked metrics offline", async mode => {
    const dir = await mkdtemp(join(tmpdir(), "gr-collections-"));
    const events: string[] = [];
    let tracing = false, destination = "";
    const servers = ["performance", "profiling"].map(role => createServer(async (req, res) => {
      events.push(role + req.url);
      if (req.headers.authorization !== "Bearer " + role + "-key") {
        res.statusCode = 401;
        return res.end("{}");
      }
      if (req.url === "/start_profile") {
        const body = JSON.parse(await text(req));
        expect(body).toMatchObject({ activities: ["CPU", "NPU"], profile_by_stage: false, with_stack: false, record_shapes: true });
        destination = join(body.output_dir, "rank0", "ASCEND_PROFILER_OUTPUT");
        tracing = true;
        return res.end("started");
      }
      if (req.url === "/stop_profile") {
        tracing = false;
        await mkdir(destination, { recursive: true });
        if (mode === "host-only") {
          await writeFile(join(destination, "operator_details.csv"), "Name,Host Total Duration(us),Device Total Duration(us)\nview,25,0\n");
          await writeFile(join(destination, "trace_view.json"), "[]");
        } else {
          await writeFile(join(destination, "op_statistic.csv"), "OP Type,Count,Total Time(us)\nmm,2,100\n");
          await writeFile(join(destination, "kernel_details.csv"), "Name,Duration(us),Wait Time(us)\nk,10,5\n");
        }
        return res.end("stopped");
      }
      if (req.url === "/v1/gr/beam_search") {
        if (tracing && mode === "request-error") {
          res.statusCode = 500;
          return res.end("{}");
        }
        return res.end(JSON.stringify({ choices: [{ output_ids: [151669, 159861, 168053], score: 0.5 }] }));
      }
      return res.end(JSON.stringify({ shared_prefix_forward: mode === "zero-hit" ? 0 : 1, decode_forward: 2 }));
    }));
    try {
      const services: Record<string, unknown> = {};
      for (const [i, role] of ["performance", "profiling"].entries()) {
        const server = servers[i]!;
        await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
        const addr = server.address();
        if (!addr || typeof addr === "string") throw new Error("No fixture port");
        if ((mode === "performance" || mode === "profiling") && role !== mode) continue;
        services[role] = { model: "fixture", base_url: "http://127.0.0.1:" + addr.port, api_key: "${GR_TEST_" + role + "}" };
        process.env["GR_TEST_" + role] = role + "-key";
      }
      for (const [file, data] of Object.entries({ "p1.json": {"0":[0]}, "p2.json": {"0,0":[0]}, "prompts.json": ["one","two"] }))
        await writeFile(join(dir, file), JSON.stringify(data));
      const standard = mode === "both";
      const lengths = standard ? [128, 512, 1024, 5120, 10240] : [128, 512];
      if (standard) for (const length of lengths)
        await writeFile(join(dir, `prompts_${length}_batch_4.json`), JSON.stringify(["a", "b", "c", "d"]));
      const yaml = join(dir, "experiment.yaml");
      await writeFile(yaml, stringify({ services, benchmark: { name: "recommendation", scenario: standard ? "north-star" : "custom",
        ...(Object.keys(services).length === 2 ? { collections: [{ type: "profiling", service: "profiling", ...(standard ? {} : { lengths: [128] }) },
          { type: "performance", service: "performance" }] } : {}),
        config: { tag: "fast", ...(standard ? { promptDir: "." } : {
          inputs: lengths.map(length => ({ length, file: "prompts.json" })), requests: 1, warmup: 0 }),
          prefix1File: "p1.json", prefix2File: "p2.json" },
        solver: { config: { exportTimeoutSeconds: 12, pythonExecutable: execFileSync(process.platform === "win32" ? "python" : "python3",
          ["-c", "import sys;print(sys.executable)"], { encoding: "utf8" }).trim() } } }, output: { directory: join(dir, "out") } }));
      const out: string[] = [], errors: string[] = [];
      const io = { out: (v: string) => out.push(v), error: (v: string) => errors.push(v) };
      expect(await runCli(["run", yaml, "--dry-run"], io), errors.join("\n")).toBe(0);
      expect(events).toEqual([]);
      const failed = ["zero-hit", "host-only", "request-error"].includes(mode);
      expect(await runCli(["run", yaml], io), errors.join("\n")).toBe(failed ? 1 : 0);
      expect(tracing).toBe(false);
      const run = out.at(-1)!;
      const parent = JSON.parse(await readFile(join(run, "metrics.json"), "utf8"));
      expect(parent.collections.sort()).toEqual(Object.keys(services).sort());
      if ("performance" in services) {
        expect(parent.metrics["recommendation-performance"].points).toHaveLength(lengths.length);
        expect(parent.metrics["recommendation-performance"].points.every((p: { valid: boolean }) => p.valid)).toBe(true);
        expect(events).not.toContain("performance/start_profile");
      }
      if ("profiling" in services) {
        if (standard) expect(parent.metrics["recommendation-profiling"].points).toHaveLength(5);
        const profile = parent.metrics["recommendation-profiling"].points[0];
        expect(profile.valid).toBe(!failed);
        if (mode === "zero-hit") expect(events.some(e => e.startsWith("profiling"))).toBe(false);
        else {
          expect(events.lastIndexOf("performance/debug/gr_counters")).toBeLessThan(events.indexOf("profiling/health"));
          expect(events.slice(events.indexOf("profiling/start_profile"), events.indexOf("profiling/stop_profile") + 1)
            .filter(e => e === "profiling/v1/gr/beam_search")).toHaveLength(1);
        }
        if (!failed) expect(profile.profile.exports[0]).toMatchObject({ kernelCount: 1, kernelWaitUs: 5, operatorDeviceUs: 100 });
        if (mode === "host-only") expect(profile.profile.exports[0]).toMatchObject({ deviceEvidence: false, operatorHostUs: 25 });
      }
      for (const s of servers) await new Promise<void>(resolve => s.close(() => resolve()));
      const files = ["report.md", "metrics.json", ...Object.keys(services).flatMap(k => [k+"/report.md", k+"/metrics.json"])];
      const before = await Promise.all(files.map(f => readFile(join(run, f), "utf8")));
      expect(await runCli(["report", run], io)).toBe(0);
      expect(await Promise.all(files.map(f => readFile(join(run, f), "utf8")))).toEqual(before);
      expect(before.join("")).not.toContain("-key");
      if (standard) {
        const count = events.length;
        expect(await runCli(["run", yaml, "--resume"], io), errors.join("\n")).toBe(0);
        expect(events).toHaveLength(count);
        expect(await readFile(join(run, "reports", "resume-1", "profiling", "report.md"), "utf8")).toContain("NPU 算子采集");
      }
    } finally {
      for (const s of servers) if (s.listening) await new Promise<void>(resolve => s.close(() => resolve()));
      delete process.env.GR_TEST_profiling;
      delete process.env.GR_TEST_performance;
      await rm(dir, { recursive: true, force: true });
    }
  }, 120_000);
