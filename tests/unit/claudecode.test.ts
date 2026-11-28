import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import type { ExitResult, ProcessHandle } from "../../src/core/contracts/environment.js";
import type { AttemptContext } from "../../src/core/contracts/solver.js";
import type { ServiceBinding } from "../../src/core/contracts/plugin.js";
import { ClaudeCodeSolver, parseClaudeCodeConfig } from "../../src/plugins/solvers/claudecode.js";
import { consumeClaudeCode } from "../../src/runtimes/claudecode/protocol.js";

const secret = "fixture-claude-key";
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

async function attempt(signal = new AbortController().signal): Promise<AttemptContext> {
  const agent = await mkdtemp(join(tmpdir(), "claude-protocol-"));
  roots.push(agent);
  return { key: { runId: "run", taskId: "task", attemptId: "attempt" },
    paths: { root: agent, agent, verifier: agent, artifacts: agent }, signal };
}

async function* chunks(...values: Uint8Array[]) {
  yield* values;
}

function processWith(stdout: ProcessHandle["stdout"], code = 0): ProcessHandle {
  return { stdout, stderr: chunks(Buffer.from("diagnostic fixture-claude-"), Buffer.from("key\n")),
    done: Promise.resolve({ code, signal: null }), stop: vi.fn(async () => {}) };
}

const jsonl = (...events: object[]) => Buffer.from(events.map(event => JSON.stringify(event) + "\n").join(""));
const resultEvent = { type: "result", subtype: "success", is_error: false, result: `答案\n${secret}`,
  usage: { input_tokens: 10, cache_read_input_tokens: 5, cache_creation_input_tokens: 2, output_tokens: 7,
    output_tokens_details: { thinking_tokens: 2 } } };

test("Claude Code handles split UTF-8, includes cached input and redacts evidence", async () => {
  const context = await attempt();
  const output = jsonl({ type: "assistant" }, resultEvent);
  const split = output.indexOf(Buffer.from("答")) + 1;
  expect(await consumeClaudeCode(processWith(chunks(output.subarray(0, split), output.subarray(split))), context, secret))
    .toEqual({ finalText: "答案\n[redacted]", usage: { inputTokens: 17, outputTokens: 7, totalTokens: 24 } });
  for (const filename of ["session.jsonl", "trajectory.jsonl", "stderr.log"]) {
    expect(await readFile(join(context.paths.agent, filename), "utf8")).not.toContain(secret);
  }
  expect((await readFile(join(context.paths.agent, "trajectory.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line).type))
    .toEqual(["start", "claudecode.assistant", "claudecode.result", "usage", "end"]);
});

test.each([
  [chunks(jsonl(resultEvent)), 1, "SOLVER_PROCESS_CRASHED"],
  [chunks(jsonl({ type: "result", subtype: "error_max_turns", is_error: false })), 1, "SOLVER_RESULT_INCOMPLETE"],
  [chunks(jsonl({ type: "result", subtype: "error_during_execution", is_error: true, api_error_status: 401 })), 1, "MODEL_AUTH_FAILED"],
  [chunks(jsonl({ type: "assistant" })), 0, "SOLVER_RESULT_INCOMPLETE"],
  [chunks(jsonl({ type: "assistant" }), Buffer.from('{"type":')), 0, "SOLVER_PROTOCOL_INVALID"],
  [chunks(jsonl(resultEvent, resultEvent)), 0, "SOLVER_PROTOCOL_INVALID"],
  [chunks(jsonl({ ...resultEvent, result_index: 0 }, { ...resultEvent, result_index: 0 })), 0, "SOLVER_PROTOCOL_INVALID"],
  [chunks(jsonl({ ...resultEvent, result_index: 0 }, { type: "result", result_index: 1,
    subtype: "error_during_execution", is_error: true, api_error_status: 401 })), 0, "MODEL_AUTH_FAILED"],
  [chunks(jsonl({ type: "result", result_index: 0, subtype: "error_max_turns", is_error: false },
    { ...resultEvent, result_index: 1 })), 0, "SOLVER_RESULT_INCOMPLETE"],
  [chunks(jsonl({ type: "result", result_index: 0, subtype: "error_during_execution", is_error: true, api_error_status: 401 },
    { ...resultEvent, result_index: 1 })), 0, "MODEL_AUTH_FAILED"],
] as const)("Claude Code preserves evidence on failure (%#)", async (stdout, code, expected) => {
  const context = await attempt();
  const handle = processWith(stdout, code);
  await expect(consumeClaudeCode(handle, context, secret)).rejects.toMatchObject({ code: expected });
  expect(handle.stop).toHaveBeenCalledOnce();
  const trajectory = await readFile(join(context.paths.agent, "trajectory.jsonl"), "utf8");
  expect(trajectory).toContain('"type":"error"');
  expect(trajectory).not.toContain('"type":"end"');
});

test("Claude Code returns the last completed turn and sums each result's usage", async () => {
  const context = await attempt();
  const handle = processWith(chunks(jsonl(
    { ...resultEvent, result_index: 0, result: "I'll check the tool output." },
    { type: "assistant" },
    { ...resultEvent, result_index: 1, result: "Final answer",
      usage: { input_tokens: 30, cache_read_input_tokens: 4, output_tokens: 11 } },
  )));
  expect(await consumeClaudeCode(handle, context, secret)).toEqual({
    finalText: "Final answer", usage: { inputTokens: 51, outputTokens: 18, totalTokens: 69 },
  });
  expect(handle.stop).not.toHaveBeenCalled();
  const events = (await readFile(join(context.paths.agent, "session.jsonl"), "utf8")).trim().split("\n")
    .map(line => JSON.parse(line).result_index);
  expect(events).toEqual([0, undefined, 1]);
});

test("Claude Code rejects a requested web tool missing from the native inventory", async () => {
  const context = await attempt();
  const handle = processWith(chunks(jsonl({ type: "system", subtype: "init", tools: ["Bash", "WebFetch"] }, resultEvent)));
  await expect(consumeClaudeCode(handle, context, secret, ["WebFetch", "WebSearch"])).rejects.toMatchObject({
    code: "CONFIG_INVALID", message: expect.stringContaining("webSearch: enabled requires WebSearch"),
  });
  expect(handle.stop).toHaveBeenCalledOnce();
});

test.each([new DOMException("cancelled", "AbortError"), new DOMException("timed out", "TimeoutError")])(
  "Claude Code stops and preserves the abort reason (%s)", async reason => {
    const controller = new AbortController();
    const context = await attempt(controller.signal);
    const { promise: done, resolve } = Promise.withResolvers<ExitResult>();
    const handle = processWith(chunks(jsonl({ type: "assistant" })));
    handle.done = done;
    handle.stop = vi.fn(async () => { resolve({ code: null, signal: "SIGTERM" }); });
    const result = consumeClaudeCode(handle, context, secret);
    controller.abort(reason);
    await expect(result).rejects.toBe(reason);
    expect(handle.stop).toHaveBeenCalledOnce();
    expect(await readFile(join(context.paths.agent, "session.jsonl"), "utf8")).toContain('"type":"assistant"');
  },
);

test("Claude Code validates service settings and supports preparation without credentials", () => {
  const binding: ServiceBinding = { model: { name: "fixture", endpoint: "https://fixture.invalid/anthropic", provider: null, api: "anthropic-messages" },
    auth: { value: secret, reference: null } };
  expect(parseClaudeCodeConfig({})).toEqual({});
  expect(() => parseClaudeCodeConfig({ tools: "Bash" })).toThrow(/tools must be default or none/u);
  expect(() => new ClaudeCodeSolver({ ...binding, model: { ...binding.model, api: "openai-responses" } })).toThrow(/anthropic-messages/u);
  expect(() => new ClaudeCodeSolver({ ...binding, model: { ...binding.model, retry: { maxAttempts: 2 } } })).toThrow(/retry/u);
  expect(() => new ClaudeCodeSolver({ ...binding, model: { ...binding.model, contextWindow: 90_000 } })).toThrow(/contextWindow/u);
  expect(() => new ClaudeCodeSolver({ ...binding, auth: { value: "", reference: null } }).requirements()).not.toThrow();
});
