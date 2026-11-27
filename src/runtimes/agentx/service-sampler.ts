import { spawn } from "node:child_process";
import { once } from "node:events";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { agentXAssets } from "./runtime.js";

type Sampling = {
  destination: string; preset?: string; devices?: number[]; signal: AbortSignal;
  nodeMetrics?: { endpoint: string; names: string[] };
};

export async function captureServiceSamples<T>(python: string, options: Sampling, measure: () => Promise<T>) {
  const { destination, preset, devices, nodeMetrics, signal } = options;
  signal.throwIfAborted();
  const child = spawn(python, ["-B", join(agentXAssets, "service_sampler.py"),
    JSON.stringify({ destination, preset, devices, nodeMetrics })], { windowsHide: true, stdio: "pipe" });
  const closed = once(child, "close");
  // Drain stderr while waiting for the readiness handshake and final summary.
  let diagnostic = "";
  child.stderr.setEncoding("utf8").on("data", text => { diagnostic = (diagnostic + text).slice(-4096); });
  child.stdin.on("error", () => { /* Early collector exit is reported by close. */ });
  const stop = () => { child.stdin.end(); };
  signal.addEventListener("abort", stop, { once: true });
  const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
  try {
    const ready = await Promise.race([lines.next(), closed.then(() => ({ value: undefined }))]);
    signal.throwIfAborted();
    if (ready.value !== "ready") throw new Error("AgentX diagnostic collector failed to start: " + diagnostic);
    const measurement = await measure();
    stop();
    const summary = await lines.next();
    const [code] = await closed;
    signal.throwIfAborted();
    if (code !== 0 || !summary.value) throw new Error("AgentX diagnostic collector failed: " + diagnostic);
    const evidence: Record<string, unknown> = JSON.parse(summary.value);
    return { measurement, evidence };
  } finally {
    signal.removeEventListener("abort", stop);
    if (!child.stdin.writableEnded) stop();
    await closed;
  }
}
