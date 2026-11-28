import { configuredMcpNames, disabledSkillConfig } from "./codex-skill-config.mjs";
import { stageSkills, taskServers } from "./runtimes/shared/assets/task-resources.mjs";
import { startModelRelay } from "./runtimes/shared/assets/model-relay.mjs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { stageAttachments } from "./stage-attachments.mjs";

const [home, entry, ...args] = process.argv.slice(2);
const input = JSON.parse(readFileSync(0, "utf8"));
const { apiKey, prompt, media = [] } = input;
await mkdir(home, { mode: 0o700 });
let resources;
let relay;
try {
  const policy = input.toolPolicy ?? {};
  const env = { ...process.env, HOME: home, USERPROFILE: home, CODEX_HOME: home, EVALUATOR_CODEX_API_KEY: apiKey };
  const project = args.find(arg => arg.startsWith("projects="));
  const settings = project ? ["-c", project] : [];
  const configuredNames = () => configuredMcpNames(process.execPath, [entry], env, settings);
  resources = await taskServers(input, false, undefined, configuredNames);
  for (const { name, url, transport } of resources.servers) {
    if (transport !== "http") throw Error("This CLI requires streamable HTTP for task MCP");
    if (!/^[a-zA-Z0-9_-]+$/u.test(name)) throw Error("Unsupported MCP server name: " + name);
    args.splice(-1, 0, "-c", "mcp_servers." + name + ".url=" + JSON.stringify(url));
  }
  if (policy.skills !== "disabled") {
    await stageSkills(input.skillsDirectories, join(home, "skills"));
  }
  const images = await stageAttachments(home, media);
  if (images.length) args.splice(-1, 0, ...images.map(path => "--image=" + path));
  let cliToken = apiKey;
  if (policy.tools === "none") {
    cliToken = randomUUID();
    relay = await startModelRelay({ api: input.api, baseUrl: input.baseUrl, apiKey, token: cliToken,
      disableBuiltinTools: true, disableMcp: policy.mcp === "disabled" });
    args.splice(-1, 0, "-c", `model_providers.arsi-evaluator.base_url=${JSON.stringify(relay.endpoint)}`);
  }
  // Docker's process adapter places CommandSpec.env in docker exec arguments.
  // Receive the credential over stdin and set it only in the Codex process.
  const noProxy = [process.env.NO_PROXY ?? process.env.no_proxy, "127.0.0.1"].filter(Boolean).join(",");
  if (relay) env.NO_PROXY = env.no_proxy = noProxy;
  env.EVALUATOR_CODEX_API_KEY = cliToken;
  if (policy.skills === "disabled") {
    const config = await disabledSkillConfig(process.execPath, [entry], env, settings);
    args.splice(-1, 0, "-c", config);
  }
  const cli = spawn(process.execPath, [entry, ...args], {
    env,
    stdio: ["pipe", "inherit", "inherit"],
    windowsHide: true,
  });
  const exited = new Promise((resolve, reject) => {
    cli.once("error", reject);
    cli.once("close", (code, signal) => resolve(code ?? (signal ? 1 : 0)));
    cli.stdin.on("error", error => {
      if (error.code !== "EPIPE") reject(error);
    });
  });
  const terminate = () => { cli.kill("SIGTERM"); };
  process.once("SIGTERM", terminate);
  try {
    cli.stdin.end(prompt, "utf8");
    process.exitCode = await exited;
  } finally {
    process.removeListener("SIGTERM", terminate);
  }
} finally {
  relay?.close();
  resources?.close?.();
  await rm(home, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
}
