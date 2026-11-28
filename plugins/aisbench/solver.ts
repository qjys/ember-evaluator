import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile, appendFile, rename } from "node:fs/promises";
import { join, posix } from "node:path";
import { setTimeout } from "node:timers/promises";
import { bindService, bindSolverService, fingerprintConfig, redactDiagnostic } from "arsi-evaluator";
import type { Solver, AttemptContext, EnvironmentSession, PublicTask, SolveResult, PluginFactoryContext } from "arsi-evaluator";
import { expectNonEmptyString, expectPositiveInteger, expectRecord } from "./validation.js";
import { AisbenchRemoteClient, aisbenchBaseUrl } from "./ssh/client.js";
import { parseCsv } from "./ssh/csv.js";
import { parseWorkload, type AisbenchSshConfig } from "./config.js";
import { bundleDigest } from "./ssh/bundle.js";
import { parseAisbenchSummary } from "./evidence.js";

import { nativeFiles } from "./native-benchmark.js";
import { parseNativeConfig } from "./native-config.js";
import { readNativeGroups, readServiceCollections } from "./native-results.js";

export class AisbenchSshSolver implements Solver {
  private readonly generated = new Map<string, string>();
  private readonly temporaryInputs = new Map<string, { client: AisbenchRemoteClient; fingerprint: string }>();
  constructor(private readonly config: AisbenchSshConfig, private readonly runtime: PluginFactoryContext) {}
  async dispose(): Promise<void> {
    for (const [job, { client, fingerprint }] of this.temporaryInputs) {
      await client.call("release-generated-input", job, fingerprint, {}, AbortSignal.timeout(30000));
      this.temporaryInputs.delete(job);
    }
    this.generated.clear();
  }
  requirements() { return []; }
  async provenance() { return { bundleDigest: await bundleDigest(), aisbenchVersion: this.config.remote.aisbenchVersion }; }
  async solve(input: PublicTask, _session: EnvironmentSession, context: AttemptContext): Promise<SolveResult> {
    await mkdir(context.paths.agent, { recursive: true });
    const trajectory = join(context.paths.agent, "trajectory.jsonl");
    const event = (seq: number, type: "start" | "end", data: Record<string, string>) =>
      JSON.stringify({ schemaVersion: 1, key: context.key, seq, at: new Date().toISOString(), type, data }) + "\n";
    await writeFile(trajectory, event(1, "start", { solver: "aisbench-ssh" }), { mode: 0o600 });
    const result = await this.measure(input, context);
    await appendFile(trajectory, event(2, "end", { status: "completed", finalText: result.finalText }));
    return result;
  }

  private async measure(input: PublicTask, context: AttemptContext): Promise<SolveResult> {
    const payload = input.payload;
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new TypeError("Invalid AISBench payload");
    const digest = await bundleDigest();
    if (!["aisbench", "aisbench-native"].includes(String(payload.kind)) || payload.schemaVersion !== 1 || payload.bundleDigest !== digest) throw new TypeError("Invalid AISBench task bundle");
    const native = payload.kind === "aisbench-native" ? parseNativeConfig(payload.native) : undefined;
    const workload = native ? undefined : parseWorkload(payload.workload);
    const uploads = native ? await nativeFiles(native, this.runtime, context.signal) : [];
    if (native && fingerprintConfig(uploads.map(({ path, sha256 }) => ({ path, sha256, origin: "experiment" }))) !== fingerprintConfig(payload.files ?? null))
      throw new TypeError("Native AISBench configuration files changed after task preparation");
    const action = native?.multimodalAction;
    const dataOnly = action === "prepare" || action === "validate";
    const service = dataOnly ? undefined : bindSolverService(this.runtime);
    const apiKey = service?.auth.value ?? "";
    const profileService = native?.profiling?.service ? bindService(this.runtime, native.profiling.service) : undefined;
    const profileApiKey = profileService?.auth.value ?? "";
    const secrets = [apiKey, profileApiKey].filter(Boolean);
    const client = new AisbenchRemoteClient(this.config, digest);
    const identity = createHash("sha256").update(JSON.stringify([context.key.runId, context.key.taskId])).digest("hex");
    const jobDir = posix.join(this.config.remote.workRoot, "jobs", identity);
    const workingDirectory = this.config.remote.workingDirectory ?? this.config.remote.aisbenchWorkPath;
    const sharedCount = payload.sharedGenerationCount === undefined ? undefined : expectPositiveInteger(payload.sharedGenerationCount, "sharedGenerationCount");
    let command = native;
    const sharedManifest = this.generated.get(context.key.runId);
    if (native?.multimodalGeneration && sharedCount) {
      const { multimodalGeneration, ...rest } = native;
      command = sharedManifest ? { ...rest, multimodalManifest: sharedManifest } : { ...rest, multimodalGeneration: {
        ...multimodalGeneration, outputDirectory: multimodalGeneration.outputDirectory ?? posix.join(jobDir, "generated-input"),
      } };
    }
    const config = { ...(profileService ? { profileEndpoint: aisbenchBaseUrl(expectNonEmptyString(profileService.model.endpoint, "profiling endpoint")), profileApiKey } : {}),
      ...(command ? { native: command, uploads, ...(sharedCount && !sharedManifest ? { generationCount: sharedCount } : {}),
      ...(workingDirectory ? { workingDirectory } : {}) } : { workload: workload ?? null }),
      ...(service ? { serviceEndpoint: service.model.endpoint, model: service.model.name, apiKey,
        endpoint: aisbenchBaseUrl(expectNonEmptyString(service.model.endpoint, "aisbench service endpoint")) } : {}),
      ...(this.config.tokenizerPath ? { tokenizerPath: this.config.tokenizerPath } : {}),
      pythonExecutable: this.config.remote.pythonExecutable, ...(this.config.remote.aisbenchWorkPath ? { aisbenchWorkPath: this.config.remote.aisbenchWorkPath } : {}),
      aisbenchVersion: this.config.remote.aisbenchVersion, podInfo: this.config.podInfo };
    // Stable across credentials rotation and attempt retries; remote private config is never persisted locally.
    const fingerprint = fingerprintConfig({ ...config, apiKey: "", ...(profileService ? { profileApiKey: "" } : {}), bundleDigest: digest });
    const point = context.paths.measurementPoint;
    const root = point ? join(context.paths.root, "performance", ...(native ? [] : ["outputs"])) : join(context.paths.artifacts, "aisbench");
    await mkdir(root, { recursive: true });
    await writeFile(join(context.paths.agent, "remote-job.json"), JSON.stringify({ jobDir, fingerprint, bundleDigest: digest }) + "\n");
    const session = join(context.paths.agent, "session.jsonl");
    const sessionLine = (operation: string, fields: Record<string, string | number | null> = {}) =>
      JSON.stringify({ at: new Date().toISOString(), operation, ...fields }) + "\n";
    await writeFile(session, sessionLine("deploy", { fingerprint }), { mode: 0o600 });
    let previousStatus: string | undefined;
    const readStatus = async (offset: number, signal: AbortSignal) => {
      const status = await client.status(jobDir, fingerprint, offset, signal);
      const entry = { state: status.state, phase: redactDiagnostic(status.phase, secrets), exitCode: status.exitCode };
      const serialized = JSON.stringify(entry);
      if (serialized !== previousStatus) {
        await appendFile(session, sessionLine("status", entry));
        previousStatus = serialized;
      }
      return status;
    };
    let started = false, terminal = false, collected = false;
    const log = async (text: string) => {
      const safe = redactDiagnostic(text, secrets);
      if (safe) { await appendFile(join(context.paths.agent, "remote.log"), safe); context.activity?.({ lines: safe.split(/\r?\n/u).filter(Boolean).slice(-20) }); }
    };
    try {
      context.activity?.({ message: "AISBench: deploying remote runner" });
      await client.deploy(context.signal);
      if (sharedCount && !sharedManifest && !native?.multimodalGeneration?.outputDirectory)
        this.temporaryInputs.set(jobDir, { client, fingerprint });
      let status = await readStatus(0, context.signal);
      if (["missing", "failed", "cancelled"].includes(status.state)) {
        started = true; // start response can be lost; cancellation must still find the job.
        await client.call("start", jobDir, fingerprint, { config, restartToken: context.key.attemptId }, context.signal);
        await appendFile(session, sessionLine("start"));
      } else started = true;
      let offset = 0;
      for (;;) {
        status = await readStatus(offset, context.signal);
        await log(status.log); offset = status.offset;
        context.activity?.({ message: `AISBench: ${status.phase} (${status.state})`, activity: Boolean(status.log) });
        if (status.state !== "running") break;
        await setTimeout(this.config.remote.pollIntervalSeconds * 1000, undefined, { signal: context.signal });
      }
      terminal = ["completed", "failed", "cancelled"].includes(status.state);
      if (!terminal) throw new Error("Remote measurement state is unconfirmed");
      await client.download(jobDir, fingerprint, root, context.signal); collected = true;
      if (status.state !== "completed" || status.exitCode !== 0) throw new Error(`AISBench remote measurement ${status.state} (exit ${status.exitCode}); see collected artifacts`);
      if (native) {
        let datasetOperation;
        let expectedRequests;
        if (native.multimodalGeneration || native.multimodalManifest) {
          const plan = expectRecord(JSON.parse(await readFile(join(root, "native-plan.json"), "utf8")), "AISBench native plan");
          const summary = expectRecord(plan.multimodalGeneration, "multimodal manifest summary");
          const count = expectPositiveInteger(summary.requests, "manifest requests");
          if (sharedCount && !sharedManifest) this.generated.set(context.key.runId,
            expectNonEmptyString(summary.manifestPath, "shared generated manifest"));
          if (dataOnly) {
            if (plan.multimodalAction !== action) throw new Error("Unexpected multimodal operation in remote evidence");
            datasetOperation = { action, manifestPath: expectNonEmptyString(summary.manifestPath, "manifestPath"),
              manifestSha256: expectNonEmptyString(summary.manifestSha256, "manifestSha256"), requests: count };
          } else if (!native.pressureSeconds && !native.options?.pressure) expectedRequests = native.dataCount ?? count;
        }
        const groups = dataOnly ? [] : await readNativeGroups(root, native.concurrency, expectedRequests);
        if (native.concurrency && groups.some(group => group.concurrency !== null && !native.concurrency?.includes(group.concurrency)))
          throw new Error("Native AISBench reported a concurrency outside the selected measurement point");
        const collections = native.engineMetrics || native.profiling
          ? await readServiceCollections(root, native) : undefined;
        const observations = { kind: "aisbench-native", schemaVersion: 1, taskId: input.id, taskDigest: fingerprintConfig(payload),
          bundleDigest: digest, aisbenchVersion: this.config.remote.aisbenchVersion, groups,
          ...(collections ? { collections } : {}), ...(datasetOperation ? { datasetOperation } : {}) };
        await writeFile(join(context.paths.agent, "native-summary.json"), JSON.stringify(observations, null, 2) + "\n");
        return { finalText: datasetOperation ? `AISBench multimodal ${action} completed: ${datasetOperation.manifestPath}`
          : `AISBench exited successfully; ${groups.length} native performance groups found`,
          usage: { inputTokens: null, outputTokens: null, totalTokens: null }, observations };
      }
      if (!workload) throw new TypeError("Missing AISBench workload");
      const rows = parseCsv(await readFile(join(root, "aisbench_result.csv"), "utf8"));
      const observations = parseAisbenchSummary({ schemaVersion: 1, kind: "aisbench", workload, bundleDigest: digest, aisbenchVersion: this.config.remote.aisbenchVersion, rows });
      await writeFile(join(context.paths.agent, "aisbench-summary.json"), JSON.stringify(observations, null, 2) + "\n");
      return { finalText: `AISBench completed ${workload.dataCount} requests at concurrency ${workload.concurrency}`, usage: { inputTokens: null, outputTokens: null, totalTokens: null }, observations };
    } catch (error) {
      if (started && !terminal) {
        try {
          await client.call("cancel", jobDir, fingerprint, {}, AbortSignal.timeout(30000));
          const stopped = await client.status(jobDir, fingerprint, 0, AbortSignal.timeout(30000));
          if (!["completed", "failed", "cancelled"].includes(stopped.state)) throw new Error("Cancellation not terminal");
        } catch {
          await writeFile(join(root, "cleanup-unconfirmed.json"), JSON.stringify({ jobDir, fingerprint }));
          await log("\nRemote cancellation unconfirmed; inspect remote-job.json before restarting.\n");
        }
      }
      if (started && !collected) {
        try { await client.download(jobDir, fingerprint, root, AbortSignal.timeout(30000)); }
        catch { await log("\nRemote artifact collection incomplete; remote job retained for recovery.\n"); }
      }
      throw error;
    } finally {
      if (point && native?.profiling) {
        await rename(join(root, "profiling"), join(context.paths.root, "profiling")).catch(error => {
          if (error.code !== "ENOENT") throw error;
        });
      }
    }
  }
}
