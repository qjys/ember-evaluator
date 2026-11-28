import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, open, rename, rm } from "node:fs/promises";
import { dirname, join, posix } from "node:path";
import { setTimeout } from "node:timers/promises";
import { expectNonEmptyString, expectRecord } from "../validation.js";
import type { AisbenchSshConfig, SshConfig } from "../config.js";
import { bundleFiles } from "./bundle.js";

export function shellQuote(value: string): string { return `'${value.replaceAll("'", "'\"'\"'")}'`; }
export function aisbenchBaseUrl(endpoint: string): string {
  const url = new URL(endpoint);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new TypeError("AISBench requires credential-free HTTP(S) endpoint");
  // AISBench appends v1/chat/completions itself, unlike evaluator's service base URL.
  url.pathname = url.pathname.replace(/\/+$/u, "").replace(/\/v1(?:\/chat\/completions)?$/u, "") + "/";
  return url.toString();
}
export function sshArguments(config: SshConfig): string[] {
  return ["-T", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes", "-o", "ConnectTimeout=15", "-o", "ServerAliveInterval=10", "-o", "ServerAliveCountMax=2",
    ...(config.port ? ["-p", String(config.port)] : []), ...(config.identityFile ? ["-i", config.identityFile] : []), config.user ? `${config.user}@${config.host}` : config.host];
}
export type SshTransport = (command: string, request: unknown, signal: AbortSignal) => Promise<unknown>;
export function openSsh(config: SshConfig): SshTransport {
  return async (command, request, signal) => await new Promise((resolve, reject) => {
    signal.throwIfAborted();
    const child = spawn("ssh", [...sshArguments(config), command], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    const chunks: Buffer[] = [];
    let bytes = 0, exceeded = false;
    const abort = () => child.kill();
    const timer = globalThis.setTimeout(() => child.kill(), 45000);
    timer.unref();
    signal.addEventListener("abort", abort, { once: true });
    child.stdout.on("data", (chunk: Buffer) => { bytes += chunk.length; if (bytes > 2 * 1024 * 1024) { exceeded = true; child.kill(); } else chunks.push(chunk); });
    child.stderr.resume();
    child.on("error", error => reject(new Error("Unable to start OpenSSH", { cause: error })));
    child.stdin.on("error", () => undefined);
    child.on("close", code => {
      globalThis.clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      if (signal.aborted) { reject(signal.reason); return; }
      if (exceeded || code !== 0) { reject(new Error(`SSH remote command failed (exit ${code}); check connectivity, known_hosts, Python and remote configuration`)); return; }
      try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); } catch { reject(new Error("Malformed SSH JSON response")); }
    });
    child.stdin.end(JSON.stringify(request));
  });
}

// Bootstrap carries code over stdin so neither local shell quoting nor argv exposes credentials.
const bootstrap = "import sys,json,pathlib,os; r=json.load(sys.stdin); p=pathlib.Path(r['directory']); p.mkdir(parents=True,exist_ok=True); os.chmod(p,0o700); [( (p/n).parent.mkdir(parents=True,exist_ok=True),(p/n).write_text(v,encoding='utf-8')) for n,v in r['files'].items()]; print(json.dumps({'schemaVersion':1,'ok':True}))";
export type RemoteState = { state: string; phase: string; heartbeat: unknown; exitCode: number | null; log: string; offset: number };
export class AisbenchRemoteClient {
  private readonly transport: SshTransport;
  readonly bundleDirectory: string;
  constructor(readonly config: AisbenchSshConfig, readonly digest: string, transport?: SshTransport) {
    this.transport = transport ?? openSsh(config.remote.ssh);
    this.bundleDirectory = posix.join(config.remote.workRoot, "bundles", digest);
  }
  static async connect(config: AisbenchSshConfig, digest: string, signal: AbortSignal) {
    if (config.remote.workRoot !== "auto") return new AisbenchRemoteClient(config, digest);
    const transport = openSsh(config.remote.ssh);
    const script = "import json,pathlib; print(json.dumps(str(pathlib.Path.home() / '.cache/arsi-evaluator/aisbench')))";
    const root = await transport(shellQuote(config.remote.pythonExecutable) + " -c " + shellQuote(script), {}, signal);
    if (typeof root !== "string" || !posix.isAbsolute(root)) throw new Error("Cannot resolve AISBench remote cache directory");
    return new AisbenchRemoteClient({ ...config, remote: { ...config.remote, workRoot: root } }, digest, transport);
  }
  async deploy(signal: AbortSignal): Promise<void> {
    await this.transport(`${shellQuote(this.config.remote.pythonExecutable)} -c ${shellQuote(bootstrap)}`, { directory: this.bundleDirectory, files: await bundleFiles() }, signal);
  }
  async call(action: string, jobDir: string, fingerprint: string, extra: Record<string, unknown>, signal: AbortSignal): Promise<Record<string, unknown>> {
    let failure: unknown;
    for (let attempt = 0; attempt < 4; attempt++) {
      signal.throwIfAborted();
      try {
        const response = expectRecord(await this.transport(`${shellQuote(this.config.remote.pythonExecutable)} ${shellQuote(posix.join(this.bundleDirectory, "remote.py"))}`,
          { action, jobDir, fingerprint, ...extra }, signal), "remote response");
        if (response.schemaVersion !== 1 || response.error !== undefined) throw new Error("Remote AISBench protocol error");
        return response;
      } catch (error) { failure = error; if (attempt < 3) await setTimeout(1000 * (attempt + 1), undefined, { signal }); }
    }
    throw new Error(`AISBench SSH ${action} failed after reconnect attempts`, { cause: failure });
  }
  async status(jobDir: string, fingerprint: string, offset: number, signal: AbortSignal): Promise<RemoteState> {
    const r = await this.call("status", jobDir, fingerprint, { offset }, signal);
    if (!["missing", "running", "completed", "failed", "cancelled"].includes(String(r.state)) || typeof r.offset !== "number" || !Number.isSafeInteger(r.offset) || r.offset < offset || typeof r.log !== "string" || !(r.exitCode === null || typeof r.exitCode === "number")) throw new TypeError("Invalid remote task status");
    return { state: String(r.state), phase: String(r.phase ?? "unknown"), heartbeat: r.heartbeat, exitCode: r.exitCode, log: r.log, offset: r.offset };
  }
  async download(jobDir: string, fingerprint: string, root: string, signal: AbortSignal): Promise<void> {
    const response = await this.call("manifest", jobDir, fingerprint, {}, signal);
    if (!Array.isArray(response.files)) throw new TypeError("Invalid remote artifact manifest");
    const seen = new Set<string>();
    for (const entry of response.files) {
      const file = expectRecord(entry, "artifact");
      const path = expectNonEmptyString(file.path, "artifact.path");
      if (path.includes("\\") || path.includes(":") || path.startsWith("/") || path.split("/").some(p => !p || p === "." || p === "..") || seen.has(path) || /[\0-\x1f]/u.test(path)) throw new TypeError("Unsafe remote artifact path");
      seen.add(path);
      if (typeof file.size !== "number" || !Number.isSafeInteger(file.size) || file.size < 0 || typeof file.sha256 !== "string" || !/^[a-f0-9]{64}$/u.test(file.sha256)) throw new TypeError("Invalid artifact size/hash");
      const target = join(root, ...path.split("/")), temporary = target + ".partial";
      await mkdir(dirname(target), { recursive: true });
      const output = await open(temporary, "w"), hash = createHash("sha256");
      try {
        let offset = 0;
        while (offset < file.size) {
          const length = Math.min(262144, file.size - offset);
          const chunk = await this.call("read", jobDir, fingerprint, { path, offset, length }, signal);
          if (typeof chunk.data !== "string") throw new TypeError("Invalid artifact chunk");
          const bytes = Buffer.from(chunk.data, "base64");
          if (bytes.length !== length || chunk.nextOffset !== offset + length) throw new TypeError("Truncated artifact chunk");
          await output.writeFile(bytes); hash.update(bytes); offset += bytes.length;
        }
        if (hash.digest("hex") !== file.sha256) throw new Error("Remote artifact digest mismatch");
      } catch (error) { await output.close(); await rm(temporary, { force: true }); throw error; }
      await output.close(); await rename(temporary, target);
    }
  }
}

export { parseCsv } from "./csv.js";
