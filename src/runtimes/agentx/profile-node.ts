import { execFile, spawn } from "node:child_process";
import { readFile, mkdir, mkdtemp, readdir, rename, rm } from "node:fs/promises";
import { dirname, join, posix } from "node:path";
import { promisify } from "node:util";
import { agentXAssets } from "./runtime.js";

const exec = promisify(execFile);
const files = ["collect_profile", "profile_artifacts", "profile_categories", "profile_export", "native_diagnostics", "timeline",
  "service_sampler", "ascend_metrics", "engine_metrics", "host_resources", "local_telemetry", "profile_node"];
const quote = (s: string) => "'" + s.replaceAll("'", "'\"'\"'") + "'";
const sshArgs = ["-T", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes", "-o", "ConnectTimeout=10"];

function request(alias: string, command: string, input: unknown, signal: AbortSignal) {
  return new Promise<string>((resolve, reject) => {
    const child = execFile("ssh", [...sshArgs, alias, command], { signal, windowsHide: true, maxBuffer: 16 * 1024 * 1024 },
      (error, stdout, stderr) => error ? reject(new Error("Service node operation failed: " + stderr.slice(-1200), { cause: error })) : resolve(stdout));
    child.stdin?.on("error", () => {});
    child.stdin?.end(JSON.stringify(input));
  });
}

/** Private staging on the inference host. The load generator never owns the service's hardware counters. */
export class ProfileNode {
  private constructor(readonly alias: string, readonly root: string) {}
  static async open(alias: string, signal: AbortSignal) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._@-]*$/u.test(alias)) throw new TypeError("profiling.serviceNode must be an SSH alias");
    const sources = Object.fromEntries(await Promise.all(files.map(async name => [name + ".py", await readFile(join(agentXAssets, name + ".py"), "utf8")])));
    const init = "import json,tempfile,pathlib,sys; p=pathlib.Path(tempfile.mkdtemp(prefix='arsi-profile-',dir='/tmp')); [(p/k).write_text(v,encoding='utf8') for k,v in json.load(sys.stdin).items()]; (p/'trace').mkdir(); print(p)";
    const root = (await request(alias, "python3 -c " + quote(init), sources, signal)).trim();
    if (!/^\/tmp\/arsi-profile-[A-Za-z0-9_-]+$/u.test(root)) throw new Error("Invalid service profiler staging path");
    return new ProfileNode(alias, root);
  }
  run(action: string, payload: unknown, signal: AbortSignal) {
    return request(this.alias, "python3 -B " + quote(posix.join(this.root, "profile_node.py")) + " " + quote(action), payload, signal);
  }
  sample(python: string, settings: object) {
    const command = [python, "-B", posix.join(this.root, "service_sampler.py"), JSON.stringify(settings)].map(quote).join(" ");
    return spawn("ssh", [...sshArgs, this.alias, command], { windowsHide: true, stdio: "pipe" });
  }
  async finish(destination: string) {
    const signal = AbortSignal.timeout(600000);
    await mkdir(destination, { recursive: true });
    const stage = await mkdtemp(join(dirname(destination), ".node-export-"));
    try {
      await exec("scp", ["-q", "-r", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes", this.alias + ":" + this.root + "/trace", stage],
        { signal, windowsHide: true });
      for (const file of await readdir(join(stage, "trace"))) await rename(join(stage, "trace", file), join(destination, file));
      await this.run("cleanup", {}, signal);
    } catch (cause) {
      throw new Error("Profiler evidence retained on " + this.alias + " at " + this.root, { cause });
    } finally { await rm(stage, { recursive: true, force: true }); }
  }
}
