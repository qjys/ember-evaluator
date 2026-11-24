import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { text } from "node:stream/consumers";
import { fileURLToPath } from "node:url";
import { TrajectoryWriter } from "../../core/artifacts/trajectory.js";
import type { EnvironmentSession } from "../../core/contracts/environment.js";
import type { SolveResult } from "../../core/contracts/result.js";
import type { ServiceBinding } from "../../core/contracts/plugin.js";
import type { AttemptContext, Solver } from "../../core/contracts/solver.js";
import type { JsonValue, PublicTask } from "../../core/contracts/task.js";
import { redactDiagnostic } from "../../core/errors/diagnostics.js";
import { assertJsonValue, expectNonEmptyString, expectPositiveInteger, expectRecord, rejectUnknown } from "../../core/validation/input.js";

const runner = fileURLToPath(new URL("../../runtimes/sglang-gr/assets/measure.py", import.meta.url));

export function parseSglangGrConfig(value: unknown) {
  const v = expectRecord(value, "sglang-gr");
  rejectUnknown(v, ["pythonExecutable", "requestTimeoutSeconds", "tokenizerPath", "lengthToleranceTokens", "exportTimeoutSeconds"], "sglang-gr");
  if (v.lengthToleranceTokens !== undefined && v.tokenizerPath === undefined) throw new TypeError("lengthToleranceTokens requires tokenizerPath");
  return { pythonExecutable: expectNonEmptyString(v.pythonExecutable ?? "python3", "pythonExecutable"),
    exportTimeoutSeconds: expectPositiveInteger(v.exportTimeoutSeconds ?? 1800, "exportTimeoutSeconds"),
    requestTimeoutSeconds: expectPositiveInteger(v.requestTimeoutSeconds ?? 600, "requestTimeoutSeconds"),
    lengthToleranceTokens: v.lengthToleranceTokens === undefined || v.lengthToleranceTokens === 0 ? 0 : expectPositiveInteger(v.lengthToleranceTokens, "lengthToleranceTokens"),
    tokenizerPath: v.tokenizerPath === undefined ? null : expectNonEmptyString(v.tokenizerPath, "tokenizerPath") };
}

export class SglangGrSolver implements Solver {
  constructor(private readonly config: ReturnType<typeof parseSglangGrConfig>, private readonly service: ServiceBinding,
    private readonly services: Record<string, ServiceBinding>) {}
  requirements() { return []; }
  async provenance(signal: AbortSignal) {
    const hash = createHash("sha256");
    for (const file of ["measure.py", "profile_capture.py", "profile_export.py"])
      hash.update(await readFile(new URL("../../runtimes/sglang-gr/assets/" + file, import.meta.url), { signal }));
    return { clientSha256: hash.digest("hex") };
  }

  async solve(input: PublicTask, session: EnvironmentSession, context: AttemptContext): Promise<SolveResult> {
    const payload = input.payload;
    if (!payload || typeof payload !== "object" || Array.isArray(payload) || !payload.workload) throw new TypeError("Missing GR workload");
    const service = typeof payload.service === "string" ? this.services[payload.service] : this.service;
    if (!service) throw new Error("Missing GR collection service or credentials");
    const { signal } = context;
    const trajectory = new TrajectoryWriter(join(context.paths.agent, "trajectory.jsonl"), context.key);
    try {
      await trajectory.append("start", { solver: "sglang-gr" });
      const request = { ...payload, endpoint: service.model.endpoint, apiKey: service.auth.value, exportTimeoutSeconds: this.config.exportTimeoutSeconds,
        timeout: this.config.requestTimeoutSeconds, output: session.agentOutputDir, tokenizerPath: this.config.tokenizerPath,
        lengthToleranceTokens: this.config.lengthToleranceTokens };
      const handle = await session.start({ executable: this.config.pythonExecutable, args: [runner], cwd: session.workdir,
        env: { PYTHONUTF8: "1", PYTHONDONTWRITEBYTECODE: "1" }, input: Buffer.from(JSON.stringify(request)) }, signal);
      try {
        const [exit, stdout, stderr] = await Promise.all([handle.done, text(handle.stdout), text(handle.stderr)]);
        signal.throwIfAborted();
        if (exit.code !== 0 || exit.signal !== null) throw new Error("SGLang-GR measurement failed: " + redactDiagnostic(stderr.trim().slice(-1000), [service.auth.value]));
        const result = expectRecord(JSON.parse(stdout), "SGLang-GR terminal evidence");
        if (payload.collection === "profiling") {
          const profile = result.profile;
          assertJsonValue(profile, "GR profiling evidence");
          await trajectory.append("end", { collection: "profiling" }, true);
          return { observations: { workload: payload.workload, profile }, finalText: "Captured single-request GR trace",
            usage: { inputTokens: null, outputTokens: null, totalTokens: null } };
        }
        const jsonl = await readFile(join(session.agentOutputDir, "session.jsonl"), { encoding: "utf8", signal });
        const samples: JsonValue[] = jsonl.trim().split("\n").filter(Boolean).map(line => {
          const row: unknown = JSON.parse(line);
          assertJsonValue(row, "GR sample");
          return row;
        });
        const counters = result.counters;
        assertJsonValue(counters, "GR counters");
        const inputTokens = result.inputTokens;
        assertJsonValue(inputTokens, "GR input tokens");
        const wallSeconds = result.wallSeconds;
        if (typeof wallSeconds !== "number" || !Number.isFinite(wallSeconds) || wallSeconds < 0) throw new TypeError("Invalid GR measurement window");
        const observations = { version: 2, wallSeconds, workload: payload.workload, samples, counters, inputTokens,
          promptPoolSize: expectPositiveInteger(result.promptPoolSize, "promptPoolSize"), resetOk: result.resetOk === true };
        await trajectory.append("end", { samples: samples.length, resetOk: observations.resetOk }, true);
        return { observations, finalText: `SGLang-GR recorded ${samples.length} warmup and measured requests`,
          usage: { inputTokens: null, outputTokens: null, totalTokens: null } };
      } catch (error) {
        await handle.stop(500);
        throw error;
      }
    } finally { await trajectory.close(); }
  }
}
