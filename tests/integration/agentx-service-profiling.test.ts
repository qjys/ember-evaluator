import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join, resolve } from "node:path";
import { expect, test } from "vitest";
import { captureAgentXProfile } from "../../src/runtimes/agentx/service-profile.js";
import { resolveAgentXPython } from "../../src/runtimes/agentx/runtime.js";

const python = await resolveAgentXPython(undefined, AbortSignal.timeout(15000)).catch(() => undefined);

test.skipIf(!python).each(["device", "host", "replay error", "no export", "start rejected"])("AgentX profiler control and evidence for %s", async kind => {
  await mkdir(".scratch", { recursive: true });
  const root = await mkdtemp(resolve(".scratch/agentx-service-profile-"));
  const key = "private-test-token";
  const calls: string[] = [];
  let output = "";
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    if (request.headers.authorization !== "Bearer " + key) { response.writeHead(403).end(); return; }
    calls.push(request.method + " " + request.url);
    if (request.url === "/proxy/start_profile") {
      const body = JSON.parse(Buffer.concat(chunks).toString());
      output = body.output_dir;
      if (kind === "start rejected") { response.writeHead(404).end(); return; }
      if (body.activities.join() !== "CPU,NPU") { response.writeHead(400).end(); return; }
    } else if (request.url === "/proxy/stop_profile" && ["host", "device"].includes(kind)) {
      const directory = join(output, "rank0", "ASCEND_PROFILER_OUTPUT");
      await mkdir(directory, { recursive: true });
      await writeFile(join(directory, "op_statistic.csv"), "OP Type,Count,Total Time(us)\n" + key + ",2," + (kind === "device" ? "42" : "0") + "\n");
      if (kind === "device") await writeFile(join(directory, "kernel_details.csv"), "Name,Duration(us),Wait Time(us)\nMatMul,10,2\n");
    }
    response.writeHead(200).end();
  });
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  try {
    const addr = server.address();
    if (!addr || typeof addr === "string") throw new Error("Missing fixture address");
    const destination = join(root, "trace");
    const measured = captureAgentXProfile({ endpoint: `http://127.0.0.1:${addr.port}/proxy/v1`, key,
      directory: root, destination, exportTimeoutSeconds: 2, signal: AbortSignal.timeout(15000) }, async () => {
      calls.push("load");
      if (kind === "replay error") throw new Error("controlled replay error");
      return 123;
    });
    if (kind === "device" || kind === "host") {
      expect(await measured).toMatchObject({ measurement: 123, profile: { status: kind === "device" ? "measured" : "host-only",
        exports: [{ deviceEvidence: kind === "device", operatorDeviceUs: kind === "device" ? 42 : null,
          kernelCount: kind === "device" ? 1 : null, kernelWaitUs: kind === "device" ? 2 : null }] } });
      expect(await readFile(join(destination, "rank0", "ASCEND_PROFILER_OUTPUT", "op_statistic.csv"), "utf8")).not.toContain(key);
    } else {
      await expect(measured).rejects.toThrow(kind === "start rejected" ? /404/u : kind === "replay error" ? /controlled replay error/u : /stable Ascend export/u);
    }
    expect(calls).toEqual(kind === "start rejected" ? ["POST /proxy/start_profile"] : ["POST /proxy/start_profile", "load", "POST /proxy/stop_profile"]);
  } finally {
    await new Promise<void>(done => server.close(() => done()));
    await rm(root, { recursive: true, force: true });
  }
}, 20000);
