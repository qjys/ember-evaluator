import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { saveReport } from "../../src/application/report/index.js";
import { runEngine } from "../../src/application/run-engine.js";
import { safeTaskKey } from "../../src/core/artifacts/artifacts.js";
import { DefinedBenchmark } from "../../src/plugins/benchmarks/agent-harness/definitions/defined-benchmark.js";
import { gsm8kDefinition } from "../../src/plugins/benchmarks/agent-harness/definitions/gsm8k.js";
import { LocalEnvironment } from "../../src/plugins/environments/local/environment.js";
import { harness, source } from "../fixtures/engine/fakes.js";

test("a single GSM8K answer and its score use the task layout", async () => {
  const root = await mkdtemp(join(tmpdir(), "gsm8k-layout-"));
  const fixture = harness(root), { components, config } = fixture;
  try {
    components.environment = new LocalEnvironment(root);
    components.solver.requirements = () => [];
    components.benchmark = new DefinedBenchmark(gsm8kDefinition, {
      async resolve() { return source; },
      async *rows() { yield { question: "What is six times seven?", answer: "#### 42" }; },
    }, { dockerExecutable: "docker" });
    const solve = components.solver.solve.bind(components.solver);
    components.solver.solve = async (...args) => ({ ...await solve(...args), finalText: "#### 42" });
    config.experiment.run.maxTasks = 1;
    const snapshot = await runEngine({ components, config, signal: new AbortController().signal });
    expect(snapshot.run.resultLayout).toBeUndefined();
    const record = snapshot.records[0]!;
    expect(record.errors).toEqual([]);
    expect(record.verdict?.passed).toBe(true);
    await saveReport(components.store, [], components.reporter);
    const run = join(config.experiment.output.directory, snapshot.run.runId);
    expect(await readdir(run)).toContain("metrics.json");
    expect(await readdir(run)).not.toContain("metrics");
    const attempt = join(run, "tasks", safeTaskKey(record.key.taskId), "attempts", record.key.attemptId);
    expect(JSON.parse(await readFile(join(attempt, "result.json"), "utf8")).verdict.passed).toBe(true);
  } finally {
    await fixture.dispose();
    await rm(root, { recursive: true, force: true });
  }
});
