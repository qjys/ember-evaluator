import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import type { CommandSpec, EnvironmentSession, ExitResult, ProcessHandle } from "../../src/core/contracts/environment.js";
import type { ServiceBinding } from "../../src/core/contracts/plugin.js";
import type { AttemptContext } from "../../src/core/contracts/solver.js";
import { parseTraeConfig, TraeSolver } from "../../src/plugins/solvers/trae.js";
import { consumeTrae } from "../../src/runtimes/trae/protocol.js";

const secret = "fixture-trae-auth-value";
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

async function attempt(signal = new AbortController().signal): Promise<AttemptContext> {
  const agent = await mkdtemp(join(tmpdir(), "trae-protocol-"));
  roots.push(agent);
  return { key: { runId: "run", taskId: "task", attemptId: "attempt" }, paths: { root: agent, agent, verifier: agent, artifacts: agent }, signal };
}

async function* chunks(...values: Uint8Array[]) { yield* values; }

function processWith(stdout: ProcessHandle["stdout"], code = 0): ProcessHandle {
  return { stdout, stderr: chunks(Buffer.from(secret + "\n")), done: Promise.resolve({ code, signal: null }), stop: vi.fn(async () => {}) };
}

const jsonl = (...events: object[]) => Buffer.from(events.map(event => JSON.stringify(event) + "\n").join(""));
const message = (text: string) => ({ type: "item.completed", item: { type: "agent_message", text } });
const complete = { type: "turn.completed", usage: { input_tokens: 13, cached_input_tokens: 5, cache_creation_input_tokens: 1, output_tokens: 7, reasoning_output_tokens: 2 } };

test("TRAE selects the final message and records aggregate usage without exposing the key", async () => {
  const context = await attempt();
  const result = await consumeTrae(processWith(chunks(jsonl(message("draft"), message(`答案 ${secret}`), complete))), context, secret);
  expect(result).toEqual({ finalText: "答案 [redacted]", usage: { inputTokens: 13, outputTokens: 7, totalTokens: 20 } });
  for (const filename of ["session.jsonl", "trajectory.jsonl", "stderr.log"]) {
    expect(await readFile(join(context.paths.agent, filename), "utf8")).not.toContain(secret);
  }
});

test("TRAE records missing usage as unknown", async () => {
  const result = await consumeTrae(processWith(chunks(jsonl(message("answer"), { type: "turn.completed" }))), await attempt(), secret);
  expect(result.usage).toEqual({ inputTokens: null, outputTokens: null, totalTokens: null });
});

const start = { type: "turn.started" };
const secondComplete = { type: "turn.completed", usage: { input_tokens: 18, output_tokens: 9 } };

test.each([
  [message("revised answer"), "revised answer"],
  [{ type: "item.completed", item: { type: "command_execution" } }, "answer"],
])("TRAE accepts a second completed turn and uses the final cumulative usage (%#)", async (secondItem, expected) => {
  const output = jsonl(start, message("answer"), complete, start, secondItem, secondComplete);
  const result = await consumeTrae(processWith(chunks(output)), await attempt(), secret);
  expect(result).toEqual({ finalText: expected, usage: { inputTokens: 18, outputTokens: 9, totalTokens: 27 } });
});

test.each([
  [jsonl(complete), 1, "SOLVER_PROCESS_CRASHED"],
  [jsonl({ type: "turn.failed", error: { message: "HTTP 401 Unauthorized" } }), 0, "MODEL_AUTH_FAILED"],
  [jsonl(message("partial")), 0, "SOLVER_RESULT_INCOMPLETE"],
  [jsonl(complete), 0, "SOLVER_RESULT_INCOMPLETE"],
  [jsonl(complete, complete), 0, "SOLVER_PROTOCOL_INVALID"],
  [jsonl(start), 0, "SOLVER_PROTOCOL_INVALID"],
  [jsonl(message("answer"), complete, start, message("unfinished")), 0, "SOLVER_RESULT_INCOMPLETE"],
  [jsonl(message("answer"), complete, start, { type: "turn.failed", error: { message: "HTTP 403 Forbidden" } }), 0, "MODEL_AUTH_FAILED"],
  [Buffer.from('{"type":'), 0, "SOLVER_PROTOCOL_INVALID"],
] as const)("TRAE stops failed attempts and keeps partial evidence (%#)", async (output, code, expected) => {
  const context = await attempt();
  const handle = processWith(chunks(jsonl({ type: "turn.started" }), output), code);
  await expect(consumeTrae(handle, context, secret)).rejects.toMatchObject({ code: expected });
  expect(handle.stop).toHaveBeenCalledOnce();
  expect(await readFile(join(context.paths.agent, "session.jsonl"), "utf8")).toContain('"type":"turn.started"');
  expect(await readFile(join(context.paths.agent, "trajectory.jsonl"), "utf8")).toContain('"type":"error"');
});

test.each([new DOMException("cancelled", "AbortError"), new DOMException("timed out", "TimeoutError")])(
  "TRAE preserves evidence and the abort reason (%s)", async reason => {
    const controller = new AbortController();
    const context = await attempt(controller.signal);
    const { promise: done, resolve } = Promise.withResolvers<ExitResult>();
    const handle = processWith(chunks(jsonl({ type: "turn.started" })));
    handle.done = done;
    handle.stop = vi.fn(async () => { resolve({ code: null, signal: "SIGTERM" }); });
    const result = consumeTrae(handle, context, secret);
    controller.abort(reason);
    await expect(result).rejects.toBe(reason);
    expect(handle.stop).toHaveBeenCalledOnce();
    expect(await readFile(join(context.paths.agent, "session.jsonl"), "utf8")).toContain('"type":"turn.started"');
  },
);

test("TRAE validates the service and allows preparation without credentials", async () => {
  const binding: ServiceBinding = {
    model: { name: "fixture", endpoint: "http://127.0.0.1:1234/v1", provider: null, api: "openai-responses" },
    auth: { value: "", reference: null },
  };
  expect(parseTraeConfig({})).toEqual({});
  expect(() => parseTraeConfig({ executable: "traecli" })).toThrow(/unknown field executable/u);
  expect(() => new TraeSolver({ ...binding, model: { ...binding.model, api: "google-generative-ai" } })).toThrow(/requires api/u);
  expect(() => new TraeSolver({ ...binding, model: { ...binding.model, endpoint: "https://service.test/v1?key=value" } })).toThrow(/base_url/u);
  for (const fields of [{ maxTokens: 50 }, { retry: { maxAttempts: 2 } }]) {
    expect(() => new TraeSolver({ ...binding, model: { ...binding.model, ...fields } })).toThrow(/does not support/u);
  }
  await expect(new TraeSolver(binding).runtimeInstallation(AbortSignal.timeout(5000))).resolves.toMatchObject({ id: "trae:0.214.1" });
});

test.each(["openai-responses", "anthropic-messages"])("TRAE rejects a configured reasoning effort on %s", api => {
  expect(() => new TraeSolver({
    model: { name: "fixture", endpoint: "http://127.0.0.1:1234/v1", provider: null, api, reasoningEffort: "max" },
    auth: { value: secret, reference: null },
  })).toThrow(/native reasoningEffort only with api: openai-completions/u);
});

test.each([
  ["openai-responses", "responses", undefined],
  ["openai-completions", "chat_completions", undefined],
  ["openai-completions", "chat_completions", "disabled"],
  ["anthropic-messages", "anthropic_messages", undefined],
])("TRAE launches with the wire protocol for %s", async (api, wireApi, webSearch) => {
  const endpoint = "http://127.0.0.1:1234/v1";
  const start = vi.fn(async (_command: CommandSpec) => processWith(chunks(jsonl(message("answer"), complete))));
  const session: EnvironmentSession = {
    id: "fixture", workdir: "/workspace", agentOutputDir: "/agent", verifierOutputDir: "/verifier", metadata: null,
    runtime: { root: "/runtime", stateRoot: "/runtime-state", persistent: false, identity: "fixture-trae" },
    modelEndpoint: { originEndpoint: endpoint, baseUrl: "http://127.0.0.1:4321/v1" },
    start, upload: vi.fn(), download: vi.fn(), exportState: vi.fn(), restoreState: vi.fn(), dispose: vi.fn(),
  };
  const solver = new TraeSolver({
    model: { name: "fixture", endpoint, provider: null, api,
      ...(api === "openai-completions" ? { reasoningEffort: "max" } : {}) }, auth: { value: secret, reference: null },
  }, webSearch === "disabled" ? { webSearch } : {});
  await expect(solver.solve({ id: "task", prompt: "Find the answer" }, session, await attempt()))
    .resolves.toMatchObject({ finalText: "answer" });
  const command = start.mock.calls[0]?.[0];
  expect(command?.args).toContain(`model_providers.arsi-evaluator.wire_api="${wireApi}"`);
  if (api === "openai-completions") expect(command?.args).toContain('model_reasoning_effort="max"');
  if (api === "anthropic-messages" || webSearch === "disabled") {
    if (!command?.input) throw Error("Missing TRAE launch input");
    expect(JSON.parse(Buffer.from(command.input).toString("utf8"))).toMatchObject({
      baseUrl: "http://127.0.0.1:4321/v1",
      relay: { disableHostedSearch: webSearch === "disabled", disableBuiltinTools: false, disableMcp: false },
    });
    expect(command.args.some(arg => arg.startsWith("model_providers.arsi-evaluator.base_url="))).toBe(false);
  } else {
    expect(command?.args).toContain('model_providers.arsi-evaluator.base_url="http://127.0.0.1:4321/v1"');
  }
});
