import { execFile, spawn } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import { nativeCodeInstallation, nativeCodeVersions, type NativeCodeName } from "../../src/runtimes/shared/native-code-runtime.js";
import { nativeCodeModel } from "../fixtures/native-code-model.js";

const names = ["qwencode", "kimicode", "minimaxcode", "opencode"] as const;
const enabled = process.env.EVALUATOR_NATIVE_CODE_TEST === "local";

async function run(name: NativeCodeName, api: string, toolPolicy: object, mode: "answer" | "read" | "loop" | "discover-fetch" | "fetch" = "answer", maxTurns = 4, pdf = false, contextWindow?: number, reasoningEffort: "low" | "max" = "low") {
  const root = resolve(process.env.EVALUATOR_NATIVE_CODE_ROOT ?? ".scratch/new-code-runtimes", name);
  const installation = await nativeCodeInstallation(name, new AbortController().signal);
  for (const file of installation.files.filter(file => !file.target.startsWith("package"))) {
    const target = join(root, file.target);
    await mkdir(dirname(target), { recursive: true });
    await copyFile(file.source, target);
  }
  if (name === "minimaxcode") await promisify(execFile)(process.execPath, ["apply-capability-patch.mjs"], { cwd: root });
  const workspace = await mkdtemp(join(tmpdir(), "native-code-smoke-"));
  const mock = await nativeCodeModel(mode, "127.0.0.1", join(workspace, "input.txt"));
  try {
    await writeFile(join(workspace, "input.txt"), contextWindow ? "TOOL_EVIDENCE\n".repeat(3000) : "TOOL_EVIDENCE");
    const filename = pdf ? "document.pdf" : "figure.png";
    const data = (await readFile(new URL("../fixtures/multimodal/" + filename, import.meta.url))).toString("base64");
    const input = { apiKey: "fixture-upstream-secret", token: "fixture-relay-token", baseUrl: mock.endpoint, model: "fixture-model", api,
      reasoningEffort, maxTokens: contextWindow ? 2345 : 70000, maxTurns, contextWindow, supportsImages: !pdf, supportsPdf: pdf, toolPolicy,
      prompt: mode === "answer" ? "Describe the image." : "Read input.txt then answer.",
      media: [{ name: filename, mediaType: pdf ? "application/pdf" : "image/png", data }] };
    const child = spawn(process.execPath, [join(root, "launch.mjs"), join(workspace, "state")], { cwd: workspace, windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", chunk => { stdout += String(chunk); });
    child.stderr.on("data", chunk => { stderr += String(chunk); });
    const timer = setTimeout(() => {
      if (process.platform === "win32" && child.pid) execFile("taskkill", ["/pid", String(child.pid), "/t", "/f"], { windowsHide: true });
      else child.kill("SIGTERM");
    }, 30000);
    child.stdin.end(JSON.stringify(input));
    const code = await new Promise<number | null>((resolveExit, reject) => { child.once("error", reject); child.once("close", code => resolveExit(code)); });
    clearTimeout(timer);
    await writeFile(join(root, `smoke-${api}-${mode}.json`), JSON.stringify({ stdout, stderr, requests: mock.requests }, null, 2));
    console.info(`${name}/${api}/${mode}: exit=${code}, requests=${mock.requests.length}`);
    const events = stdout.trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
    const result = events.find(event => event.type === "evaluator.result");
    return { code, result, requests: mock.requests, diagnostic: stdout.slice(-1500) + stderr.slice(-1500), stdout };
  } finally {
    await mock.close();
    await rm(workspace, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
}

for (const name of ["qwencode", "opencode"] as const) {
  test.skipIf(!enabled)(`${name} transmits native PDF bytes using the selected model protocol`, async () => {
    const pdf = (await readFile(new URL("../fixtures/multimodal/document.pdf", import.meta.url))).toString("base64");
    for (const api of ["openai-completions", "anthropic-messages", ...(name === "opencode" ? ["openai-responses"] : [])]) {
      const result = await run(name, api, { webSearch: "disabled", mcp: "disabled" }, "answer", 4, true);
      expect(result.code, result.diagnostic).toBe(0);
      const messages = JSON.stringify(result.requests.map(request => request.messages ?? request.input));
      expect(messages).toContain(pdf);
      expect(messages).toContain(api === "anthropic-messages" ? '"type":"document"' : api === "openai-responses" ? '"type":"input_file"' : '"type":"file"');
    }
  }, 190000);
}

test.skipIf(!enabled)("Qwen Code uses native thinking settings for the main turn and WebFetch extraction", async () => {
  const result = await run("qwencode", "openai-completions", { webSearch: "disabled", webFetch: "enabled", mcp: "disabled" },
    "fetch", 8, false, undefined, "max");
  expect(result.code, result.diagnostic).toBe(0);
  const extraction = result.requests.filter(request => JSON.stringify(request.messages).includes("Local webfetch evidence"));
  expect(extraction).toHaveLength(1);
  expect(extraction[0]?.reasoning_effort).toBe("none");
  expect(result.requests[0]?.reasoning_effort).toBe("max");
  const resumed = result.requests.find(request => JSON.stringify(request.messages).includes("call_fixture_fetch") &&
    JSON.stringify(request.messages).includes("Status: 200 OK"));
  expect(resumed?.reasoning_effort).toBe("max");
}, 70000);

for (const name of names) {
  test.skipIf(!enabled)(`${name} ${nativeCodeVersions[name]} transmits images without tools over all supported APIs`, async () => {
    for (const api of ["openai-completions", "openai-responses", "anthropic-messages"]) {
      const result = await run(name, api, { tools: "none", webSearch: "disabled", webFetch: "disabled" }, "answer", 4, false, undefined, "max");
      expect(result.code, `${api}: ${result.diagnostic}`).toBe(0);
      expect(result.result).toMatchObject({ finalText: "The answer is 42." });
      expect(result.requests.length).toBeGreaterThan(0);
      for (const request of result.requests) {
        expect(request.model).toBe("fixture-model");
        expect(request.tools ?? []).toHaveLength(0);
        expect(request.max_tokens ?? request.max_completion_tokens ?? request.max_output_tokens).toBe(70000);
      }
      const main = result.requests[0];
      const effort = api === "openai-completions" ? main?.reasoning_effort
        : api === "openai-responses" ? (main?.reasoning as { effort?: string })?.effort
        : (main?.output_config as { effort?: string })?.effort;
      expect(effort).toBe("max");
      expect(JSON.stringify(result.requests)).toMatch(/image_url|input_image|"type":"image"/u);
      expect(result.stdout).not.toContain("fixture-upstream-secret");
      expect(result.result.usage.inputTokens).toBeGreaterThan(0);
    }
  }, 190000);

  test.skipIf(!enabled)(`${name} keeps file tools while disabling native web tools`, async () => {
    const result = await run(name, "openai-completions", { webSearch: "disabled", webFetch: "disabled" }, "read");
    expect(result.code, result.diagnostic).toBe(0);
    expect(result.result.finalText).toBe("The answer is 42.");
    expect(JSON.stringify(result.requests)).toContain("TOOL_EVIDENCE");
    const tools = result.requests.flatMap(request => request.tools ?? []).map(tool => tool.function?.name ?? tool.name ?? "");
    expect(tools).toContainEqual(expect.stringMatching(/^(?:read|Read|read_file)$/u));
    expect(tools.filter(tool => /web[_]?(?:fetch|search)|FetchURL|WebSearch/iu.test(tool))).toEqual([]);
  }, 70000);

  test.skipIf(!enabled)(`${name} counts main-model requests at native step limits 1 and 2`, async () => {
    for (const maxTurns of [1, 2]) {
      const result = await run(name, "openai-completions", { webSearch: "disabled", webFetch: "disabled" }, "loop", maxTurns);
      const modelRequests = result.requests.filter(request => request.tools?.length);
      expect(modelRequests.length, result.diagnostic).toBe(maxTurns);
      if (name === "minimaxcode") expect(result.diagnostic).toContain("limit_exceeded");
    }
  }, 90000);

  test.skipIf(!enabled)(`${name} enables native fetch independently of search`, async () => {
    const result = await run(name, "openai-completions", { webSearch: "disabled", webFetch: "enabled" }, "discover-fetch");
    expect(result.code, result.diagnostic).toBe(0);
    const tools = result.requests.flatMap(request => request.tools ?? []).map(tool => tool.function?.name ?? tool.name ?? "");
    if (name === "qwencode") expect(JSON.stringify(result.requests)).toMatch(/web_fetch[\s\S]*url/u);
    else expect(tools).toContainEqual(expect.stringMatching(/^(?:web_fetch|webfetch|FetchURL)$/u));
    expect(tools.filter(tool => /^(?:web_search|websearch|WebSearch)$/u.test(tool))).toEqual([]);
  }, 70000);
}

test.skipIf(!enabled)("MiniMax checkpoints do not consume main turns in a small window", async () => {
  for (const maxTurns of [1, 2]) {
    const result = await run("minimaxcode", "openai-completions", { webSearch: "disabled" }, "loop", maxTurns, false, 24000);
    const checkpoints = result.requests.filter(request => !request.tools?.length &&
      JSON.stringify(request.messages?.[0]).includes("loss-aware checkpoint"));
    expect(checkpoints.length, result.diagnostic).toBeGreaterThan(0);
    expect(result.requests.filter(request => request.tools?.length)).toHaveLength(maxTurns);
    expect(result.diagnostic).toContain("limit_exceeded");
  }
}, 90000);

test.skipIf(!enabled)("MiniMax returns the final answer on the last allowed turn", async () => {
  for (const [mode, maxTurns] of [["answer", 1], ["read", 2]] as const) {
    const result = await run("minimaxcode", "openai-completions", { webSearch: "disabled" }, mode, maxTurns);
    expect(result.code, result.diagnostic).toBe(0);
    expect(result.result.finalText).toBe("The answer is 42.");
    expect(result.requests.filter(request => request.tools?.length)).toHaveLength(maxTurns);
  }
}, 90000);

test.skipIf(!enabled)("OpenCode enables Exa search on custom model services while fetch remains disabled", async () => {
  const result = await run("opencode", "openai-completions", { webSearch: "enabled", webFetch: "disabled" });
  expect(result.code, result.diagnostic).toBe(0);
  const tools = result.requests.flatMap(request => request.tools ?? []).map(tool => tool.function?.name ?? tool.name ?? "");
  expect(tools).toContain("websearch");
  expect(tools).not.toContain("webfetch");
}, 70000);
