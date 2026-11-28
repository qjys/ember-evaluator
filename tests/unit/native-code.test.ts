import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import type { CommandSpec, EnvironmentSession, ProcessHandle } from "../../src/core/contracts/environment.js";
import type { ServiceBinding } from "../../src/core/contracts/plugin.js";
import type { AttemptContext } from "../../src/core/contracts/solver.js";
import { NativeCodeSolver, parseNativeCodeConfig } from "../../src/plugins/solvers/native-code.js";
import { consumeNativeCode } from "../../src/runtimes/shared/native-code-protocol.js";
import { nativeCodeInstallation, nativeCodeVersions } from "../../src/runtimes/shared/native-code-runtime.js";

const names = ["qwencode", "kimicode", "minimaxcode", "opencode"] as const;
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const binding: ServiceBinding = { model: { name: "fixture", endpoint: "https://fixture.invalid/v1", api: "openai-completions", provider: null }, auth: { value: "fixture-secret", reference: null } };

test.each(names)("%s validates tool policies and native step limits", name => {
  expect(parseNativeCodeConfig(name, {})).toEqual({});
  expect(parseNativeCodeConfig(name, { tools: "default", webSearch: "default", maxTurns: 2000 })).toEqual({ maxTurns: 2000 });
  expect(parseNativeCodeConfig(name, { tools: "none", webFetch: "disabled" })).toEqual({ tools: "none", webFetch: "disabled" });
  for (const value of [0, -1, 1.5, "2000", Number.MAX_SAFE_INTEGER + 1]) expect(() => parseNativeCodeConfig(name, { maxTurns: value })).toThrow();
  expect(parseNativeCodeConfig(name, { maxTokens: 2 })).toEqual({ maxTokens: 2 });
  expect(() => parseNativeCodeConfig(name, { webFetch: false })).toThrow(/default, disabled or enabled/u);
});

test.each(names)("%s ships a locked CLI and its launch dependencies", async name => {
  const installation = await nativeCodeInstallation(name, new AbortController().signal);
  const manifest = installation.files.find(file => file.target === "package.json");
  const lock = installation.files.find(file => file.target === "package-lock.json");
  if (!manifest || !lock) throw Error("Missing runtime manifests");
  const pkg = JSON.parse(await readFile(manifest.source, "utf8"));
  const locked = JSON.parse(await readFile(lock.source, "utf8"));
  expect(Object.values(pkg.dependencies)).toEqual([nativeCodeVersions[name]]);
  expect(locked.packages[""].dependencies).toEqual(pkg.dependencies);
  for (const file of installation.files) expect((await readFile(file.source)).length).toBeGreaterThan(0);
});

test.each(names)("%s binds service controls and does not pretend an unavailable search works", name => {
  const service = { ...binding, model: { ...binding.model, maxTokens: 70000, reasoningEffort: "low" as const } };
  const solver = new NativeCodeSolver(name, service, { tools: "none", maxTurns: 2 });
  expect(solver.inputModalities).toContain("image");
  for (const api of ["openai-completions", "openai-responses", "anthropic-messages"]) {
    const cli = new NativeCodeSolver(name, { ...service, model: { ...service.model, api } });
    expect(cli.inputModalities.includes("pdf")).toBe(name === "opencode" || (name === "qwencode" && api !== "openai-responses"));
  }
  expect(() => new NativeCodeSolver(name, { ...binding, model: { ...binding.model, api: "unsupported" } })).toThrow(/requires api/u);
  expect(() => new NativeCodeSolver(name, service, { webSearch: "enabled" })).not.toThrow();
});

test("Qwen Code rejects a service tier unavailable in its native effort selector", () => {
  expect(() => new NativeCodeSolver("qwencode", { ...binding, model: { ...binding.model, reasoningEffort: "minimal" } }))
    .toThrow(/Qwen Code does not offer reasoningEffort: minimal/u);
});

async function context(): Promise<AttemptContext> {
  const root = await mkdtemp(join(tmpdir(), "native-code-protocol-"));
  roots.push(root);
  return { key: { runId: "r", taskId: "t", attemptId: "a" }, paths: { root, agent: root, verifier: root, artifacts: root }, signal: new AbortController().signal };
}

async function* chunks(...events: object[]) { yield Buffer.from(events.map(event => JSON.stringify(event) + "\n").join("")); }
function handle(events: object[], code = 0): ProcessHandle {
  return { stdout: chunks(...events), stderr: chunks(), done: Promise.resolve({ code, signal: null }), stop: vi.fn(async () => {}) };
}

test("native code protocol keeps raw turns, final text and missing usage separate", async () => {
  const ctx = await context();
  const result = await consumeNativeCode("kimicode", handle([
    { type: "acp.message", message: { method: "session/update", params: { update: { sessionUpdate: "agent_message_chunk", content: { text: "Intermediate" } } } } },
    { type: "evaluator.result", finalText: "Final answer", usage: { inputTokens: 12, outputTokens: 3 } },
  ]), ctx, ["fixture-secret"]);
  expect(result).toEqual({ finalText: "Final answer", usage: { inputTokens: 12, outputTokens: 3, totalTokens: 15 } });
  expect(await readFile(join(ctx.paths.agent, "session.jsonl"), "utf8")).toContain("Intermediate");
  const missing = await consumeNativeCode("opencode", handle([{ type: "evaluator.result", finalText: "42", usage: {} }]), await context(), []);
  expect(missing.usage).toEqual({ inputTokens: null, outputTokens: null, totalTokens: null });
});

test("native CLI failures, duplicate finals and missing finals never become scored answers", async () => {
  await expect(consumeNativeCode("opencode", handle([{ type: "evaluator.error", message: "401 authentication failed" }], 1), await context(), [])).rejects.toMatchObject({ code: "MODEL_AUTH_FAILED" });
  await expect(consumeNativeCode("qwencode", handle([]), await context(), [])).rejects.toMatchObject({ code: "SOLVER_RESULT_INCOMPLETE" });
  await expect(consumeNativeCode("minimaxcode", handle([{ type: "evaluator.result", finalText: "a" }, { type: "evaluator.result", finalText: "b" }]), await context(), [])).rejects.toMatchObject({ code: "SOLVER_PROTOCOL_INVALID" });
});

test.each(names)("%s passes the selected service and gateway only through stdin", async name => {
  const ctx = await context();
  let command: CommandSpec | undefined;
  const session: EnvironmentSession = {
    id: "fixture", workdir: "/workspace", agentOutputDir: "/output", verifierOutputDir: "/private", metadata: {},
    runtime: { root: "/runtime", stateRoot: "/state", persistent: false, identity: "fixture" },
    modelEndpoint: { originEndpoint: "https://fixture.invalid/v1", baseUrl: "http://model-gateway/v1" },
    start: vi.fn(async input => { command = input; return handle([{ type: "evaluator.result", finalText: "Answer: A", usage: { inputTokens: 12, outputTokens: 3 } }]); }),
    upload: vi.fn(), download: vi.fn(), exportState: vi.fn(), restoreState: vi.fn(), dispose: vi.fn(),
  };
  const solver = new NativeCodeSolver(name, { ...binding, model: { ...binding.model, maxTokens: 70000, reasoningEffort: "low" } }, { tools: "none", maxTurns: 2000 });
  expect(await solver.solve({ id: "t", prompt: "question" }, session, ctx)).toMatchObject({ finalText: "Answer: A", usage: { totalTokens: 15 } });
  if (!command || !command.input) throw Error("No launch command");
  expect(JSON.parse(Buffer.from(command.input).toString("utf8"))).toMatchObject({ apiKey: binding.auth.value, model: "fixture", api: "openai-completions",
    baseUrl: "http://model-gateway/v1", reasoningEffort: "low", maxTokens: 70000, maxTurns: 2000, toolPolicy: { tools: "none" } });
  expect(command.executable).toBe("node");
  expect(JSON.stringify({ args: command.args, env: command.env })).not.toContain(binding.auth.value);
});
