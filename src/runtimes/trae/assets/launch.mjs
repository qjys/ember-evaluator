import { configuredMcpNames, disabledSkillConfig } from "./codex-skill-config.mjs";
import { stageSkills, taskServers } from "./runtimes/shared/assets/task-resources.mjs";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { stageAttachments } from "./stage-attachments.mjs";
import { startModelRelay } from "./runtimes/shared/assets/model-relay.mjs";

const [home, ...args] = process.argv.slice(2);
const input = JSON.parse(readFileSync(0, "utf8"));
const { apiKey, prompt, media, relay: modelRelay } = input;
const root = import.meta.dirname;
const entry = join(root, process.platform === "win32" ? "traecli.exe" : "traecli");
await mkdir(home, { mode: 0o700 });
let relay;
let resources;
try {
  const policy = input.toolPolicy ?? {};
  const env = { ...process.env, HOME: home, USERPROFILE: home, CODEX_HOME: home, TRAE_HOME: home };
  const project = args.find(arg => arg.startsWith("projects="));
  const settings = project ? ["-c", project] : [];
  const configuredNames = () => configuredMcpNames(entry, [], env, settings);
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
  if (images.length) args.splice(-1, 0, ...images.map(path => `--image=${path}`));
  // Docker passes CommandSpec.env in docker exec arguments, so receive the key over stdin.
  if (modelRelay || resources.completeWebTools) {
    const token = randomUUID();
    relay = await startModelRelay({ api: input.api, baseUrl: input.baseUrl, ...modelRelay, disableWebFetch: input.toolPolicy?.webFetch === "disabled", completeWebTools: resources.completeWebTools, apiKey, token });
    args.splice(-1, 0, "-c", `model_providers.arsi-evaluator.base_url=${JSON.stringify(relay.endpoint)}`);
    env.EVALUATOR_TRAE_API_KEY = token;
    env.NO_PROXY = env.no_proxy = [env.NO_PROXY ?? env.no_proxy, "127.0.0.1"].filter(Boolean).join(",");
  } else {
    env.EVALUATOR_TRAE_API_KEY = apiKey;
  }
  if (process.platform === "linux") {
    env.PATH = [join(root, "traecli-resources"), process.env.PATH].filter(Boolean).join(delimiter);
  }
  if (policy.skills === "disabled") {
    const config = await disabledSkillConfig(entry, [], env, settings);
    args.splice(-1, 0, "-c", config);
  }
  const cli = spawn(entry, args, { env, stdio: ["pipe", "inherit", "inherit"], windowsHide: true });
  const exited = new Promise((resolve, reject) => {
    cli.once("error", reject);
    cli.once("close", code => resolve(code ?? 1));
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
  resources?.close?.();
  relay?.close();
  await rm(home, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
}
