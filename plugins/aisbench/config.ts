import { posix } from "node:path";
import { expectNonEmptyString, expectPositiveInteger, expectRecord, rejectUnknown } from "./validation.js";

export type AisbenchWorkload = {
  inputLength: number; outputLength: number; dataCount: number; concurrency: number; requestRate: number; testType: "stream" | "text";
  dataset?: "synthetic"; warmups?: number;
  prefixCache: { enabled: boolean; prefixCount: number; prefixRatio: number; warmup: boolean; dp: number; seed: number };
};
function boolean(value: unknown, fallback: boolean, name: string): boolean {
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") throw new TypeError(`${name} must be boolean`);
  return value;
}
function number(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new TypeError(`${name} must be finite`);
  return value;
}
export function parseWorkload(value: unknown): AisbenchWorkload {
  const v = expectRecord(value, "aisbench.workload");
  rejectUnknown(v, ["inputLength", "outputLength", "dataCount", "concurrency", "requestRate", "testType", "prefixCache", "dataset", "warmups"], "workload");
  if (v.dataset !== undefined && v.dataset !== "synthetic") throw new TypeError("Unknown AISBench dataset");
  if (v.dataset === undefined && v.warmups !== undefined) throw new TypeError("warmups requires dataset=synthetic");
  const warmups = number(v.warmups ?? 0, "warmups");
  if (!Number.isSafeInteger(warmups) || warmups < 0) throw new TypeError("warmups must be a nonnegative integer");
  const c = expectRecord(v.prefixCache ?? {}, "prefixCache");
  rejectUnknown(c, ["enabled", "prefixCount", "prefixRatio", "warmup", "dp", "seed"], "prefixCache");
  const enabled = boolean(c.enabled, false, "enabled");
  const warmup = boolean(c.warmup, false, "warmup");
  const ratio = number(c.prefixRatio ?? (enabled ? 0.5 : 0), "prefixRatio");
  if (ratio < 0 || ratio > 1 || (enabled && ratio === 0) || (!enabled && (warmup || ratio !== 0))) throw new TypeError("Invalid prefixCache ratio or warmup");
  if (v.dataset === "synthetic" && (enabled || v.testType === "text")) throw new TypeError("Synthetic measurements require streaming and no generated shared prefixes");
  const seed = number(c.seed ?? 42, "seed");
  if (!Number.isSafeInteger(seed) || seed < 0) throw new TypeError("seed must be a nonnegative safe integer");
  const requestRate = number(v.requestRate ?? 0, "requestRate");
  if (requestRate < 0) throw new TypeError("requestRate must be nonnegative");
  if (v.testType !== undefined && v.testType !== "text" && v.testType !== "stream") throw new TypeError("testType must be text or stream");
  const inputLength = expectPositiveInteger(v.inputLength ?? 2048, "inputLength");
  if (enabled && (Math.floor(inputLength * ratio) < 1 || (ratio < 1 && inputLength - Math.floor(inputLength * ratio) < 4))) throw new TypeError("inputLength too short for prefix and suffix");
  return { ...(v.dataset === "synthetic" ? { dataset: "synthetic" as const, warmups } : {}), inputLength, outputLength: expectPositiveInteger(v.outputLength ?? 512, "outputLength"), dataCount: expectPositiveInteger(v.dataCount ?? 160, "dataCount"),
    concurrency: expectPositiveInteger(v.concurrency ?? 16, "concurrency"), requestRate, testType: v.testType === "text" ? "text" : "stream",
    prefixCache: { enabled, warmup, prefixRatio: ratio, seed, prefixCount: expectPositiveInteger(c.prefixCount ?? 1, "prefixCount"), dp: expectPositiveInteger(c.dp ?? 1, "dp") } };
}
export type SshConfig = { host: string; user?: string; port?: number; identityFile?: string };
export type AisbenchSshConfig = { remote: { ssh: SshConfig; pythonExecutable: string; aisbenchWorkPath?: string; workingDirectory?: string; aisbenchVersion: string; workRoot: string; pollIntervalSeconds: number }; tokenizerPath?: string; podInfo: string[] };
function absolute(value: unknown, name: string): string {
  const text = expectNonEmptyString(value, name);
  if (!posix.isAbsolute(text) || /[\r\n\0]/u.test(text) || text.split("/").includes("..")) throw new TypeError(`${name} must be an absolute remote POSIX path without traversal`);
  return text;
}
export function parseAisbenchSshConfig(value: unknown): AisbenchSshConfig {
  const v = expectRecord(value, "aisbench-ssh");
  rejectUnknown(v, ["remote", "tokenizerPath", "podInfo"], "aisbench-ssh");
  const r = expectRecord(v.remote, "remote");
  rejectUnknown(r, ["ssh", "pythonExecutable", "aisbenchWorkPath", "workingDirectory", "aisbenchVersion", "workRoot", "pollIntervalSeconds"], "remote");
  const s = expectRecord(r.ssh, "ssh");
  rejectUnknown(s, ["host", "port", "user", "identityFile"], "ssh");
  const host = expectNonEmptyString(s.host, "ssh.host"), user = s.user === undefined ? undefined : expectNonEmptyString(s.user, "ssh.user");
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/u.test(host) || (user !== undefined && !/^[a-zA-Z0-9_][a-zA-Z0-9_.-]*$/u.test(user))) throw new TypeError("Invalid SSH host/user");
  const port = expectPositiveInteger(s.port ?? 22, "ssh.port");
  if (port > 65535) throw new TypeError("Invalid SSH port");
  const pollIntervalSeconds = number(r.pollIntervalSeconds ?? 10, "pollIntervalSeconds");
  if (pollIntervalSeconds < 1 || pollIntervalSeconds > 300) throw new TypeError("pollIntervalSeconds must be 1..300");
  const podInfo = v.podInfo ?? [];
  if (!Array.isArray(podInfo) || podInfo.some(p => typeof p !== "string" || !/^[a-zA-Z0-9.[\]:_-]+:\d+$/u.test(p))) throw new TypeError("podInfo must contain host:port entries");
  const aisbenchVersion = expectNonEmptyString(r.aisbenchVersion, "aisbenchVersion");
  if (!/^[a-zA-Z0-9.+_-]+$/u.test(aisbenchVersion)) throw new TypeError("Invalid AISBench version");
  const workRoot = r.workRoot === undefined ? "auto" : absolute(r.workRoot, "workRoot");
  if (workRoot === "/") throw new TypeError("workRoot must not be root");
  return { remote: { ssh: { host, ...(user ? { user } : {}), ...(s.port !== undefined || user ? { port } : {}), ...(s.identityFile === undefined ? {} : { identityFile: expectNonEmptyString(s.identityFile, "identityFile") }) },
    pythonExecutable: absolute(r.pythonExecutable, "pythonExecutable"), ...(r.aisbenchWorkPath === undefined ? {} : { aisbenchWorkPath: absolute(r.aisbenchWorkPath, "aisbenchWorkPath") }),
    ...(r.workingDirectory === undefined ? {} : { workingDirectory: absolute(r.workingDirectory, "workingDirectory") }), workRoot, aisbenchVersion, pollIntervalSeconds },
    ...(v.tokenizerPath === undefined ? {} : { tokenizerPath: absolute(v.tokenizerPath, "tokenizerPath") }), podInfo: podInfo.map(p => expectNonEmptyString(p, "podInfo")) };
}

export type AisbenchConfig = { workload: AisbenchWorkload };

export function parseAisbenchConfig(value: unknown): AisbenchConfig {
  const v = expectRecord(value, "aisbench");
  rejectUnknown(v, ["workload"], "aisbench");
  return { workload: parseWorkload(v.workload ?? {}) };
}
