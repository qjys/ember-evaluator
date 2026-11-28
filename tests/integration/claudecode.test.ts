import { createServer } from "node:http";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { Evaluator } from "../../src/index.js";
import { safeTaskKey } from "../../src/core/artifacts/artifacts.js";
import { PINNED_NODE_IMAGE } from "../../src/infrastructure/containers/runtime-contract.js";
import { LocalEnvironment } from "../../src/plugins/environments/local/environment.js";
import { ClaudeCodeSolver } from "../../src/plugins/solvers/claudecode.js";
import { CLAUDE_CODE_VERSION } from "../../src/runtimes/claudecode/runtime.js";
import { writeFixture } from "../fixtures/dataset-tasks.js";

const secret = "fixture-claude-auth-value";
const model = "fixture-claude";
const finalText = "答案：完成";
type Tool = { name: string; input: object };

async function messagesFixture(docker: boolean, steps: readonly Tool[]) {
  const requests: Array<{ model: unknown; maxTokens: unknown; authenticated: boolean; input: string; tools: string[] }> = [];
  const server = createServer(async (req, res) => {
    if (req.method !== "POST" || req.url?.split("?")[0] !== "/v1/messages") {
      res.writeHead(404).end();
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    const step = steps[requests.length];
    requests.push({ model: body.model, maxTokens: body.max_tokens, authenticated: req.headers["x-api-key"] === secret,
      input: JSON.stringify(body.messages), tools: (body.tools ?? []).map((tool: { name: string }) => tool.name) });
    const n = requests.length;
    const usage = { input_tokens: 15, cache_creation_input_tokens: 4, cache_read_input_tokens: 3, output_tokens: 0 };
    const message = { id: `msg_${n}`, type: "message", role: "assistant", model, content: [], stop_reason: null, stop_sequence: null, usage };
    const block = step ? { type: "tool_use", id: `toolu_${n}`, name: step.name, input: {} } : { type: "text", text: "" };
    const delta = step ? { type: "input_json_delta", partial_json: JSON.stringify(step.input) } : { type: "text_delta", text: finalText };
    res.writeHead(200, { "content-type": "text/event-stream" });
    for (const event of [
      { type: "message_start", message },
      { type: "content_block_start", index: 0, content_block: block },
      { type: "content_block_delta", index: 0, delta },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: step ? "tool_use" : "end_turn", stop_sequence: null }, usage: { output_tokens: 7 } },
      { type: "message_stop" },
    ]) res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    res.end();
  });
  await new Promise<void>(resolve => server.listen(0, docker ? "0.0.0.0" : "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Fixture did not bind a TCP port");
  return { requests, endpoint: `http://${docker ? "host.docker.internal" : "127.0.0.1"}:${address.port}`,
    close: () => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }) };
}

function enabled(environment: string): boolean {
  return [environment, "all"].includes(process.env.EVALUATOR_CLAUDECODE_TEST ?? "");
}

async function checkEvidence(agent: string): Promise<void> {
  for (const filename of ["session.jsonl", "trajectory.jsonl", "stderr.log"]) {
    expect(await readFile(join(agent, filename), "utf8")).not.toContain(secret);
  }
}

test.skipIf(!enabled("local")).each(["none", "model-api"] as const)("Claude local hides both web tools on %s by default", async network => {
  const root = await mkdtemp(join(tmpdir(), "arsi-claude-network-"));
  const paths = { root, agent: join(root, "agent"), verifier: join(root, "verifier"), artifacts: join(root, "artifacts") };
  const fixture = await messagesFixture(false, []);
  const signal = AbortSignal.timeout(180_000);
  try {
    const solver = new ClaudeCodeSolver({ model: { name: model, endpoint: fixture.endpoint, provider: null, api: "anthropic-messages" },
      auth: { value: secret, reference: null } });
    const session = await new LocalEnvironment().prepare({ image: null, workdir: ".", network, initialFiles: [], runtime: solver.requirements(),
      installation: await solver.runtimeInstallation(signal) }, paths, "solve", signal);
    try {
      const result = await solver.solve({ id: "restricted", prompt: "Reply with the answer." }, session, {
        key: { runId: "local", taskId: "restricted", attemptId: "first" }, paths, signal });
      expect(result.finalText).toBe(finalText);
      expect(fixture.requests[0]?.tools).toContain("Bash");
      expect(fixture.requests[0]?.tools).not.toContain("WebFetch");
      expect(fixture.requests[0]?.tools).not.toContain("WebSearch");
    } finally { await session.dispose(signal); }
  } finally {
    await fixture.close();
    await rm(root, { recursive: true, force: true });
  }
}, 210_000);

test.skipIf(!enabled("local"))("Claude Code uses Bash locally and limits native file tools to the task workspace", async () => {
  const root = await mkdtemp(join(tmpdir(), "arsi-evaluator-claude-local-"));
  const steps: Tool[] = [];
  const fixture = await messagesFixture(false, steps);
  const signal = AbortSignal.timeout(900_000);
  const paths = { root, agent: join(root, "agent"), verifier: join(root, "verifier"), artifacts: join(root, "artifacts") };
  const key = { runId: "local", taskId: "file-test", attemptId: "first" };
  const solver = new ClaudeCodeSolver({
    model: { name: model, endpoint: fixture.endpoint, provider: null, api: "anthropic-messages", maxTokens: 1024, contextWindow: 200_000 },
    auth: { value: secret, reference: null } });
  try {
    const outside = join(root, "outside.txt");
    const outsideCreated = join(root, "outside-created.txt");
    const seed = join(root, "seed.txt");
    await writeFile(outside, "outside-private-sentinel");
    await writeFile(seed, "before");
    const session = await new LocalEnvironment().prepare({ image: null, workdir: ".", runtime: solver.requirements(),
      installation: await solver.runtimeInstallation(signal), initialFiles: [{ source: seed, target: "proof.txt" }] }, paths, "solve", signal);
    try {
      const file = join(session.workdir, "proof.txt");
      const created = join(session.workdir, "created.txt");
      steps.push({ name: "Read", input: { file_path: outside } },
        { name: "Edit", input: { file_path: outsideCreated, old_string: "", new_string: "forbidden" } },
        { name: "Read", input: { file_path: file } },
        { name: "Edit", input: { file_path: file, old_string: "before", new_string: "after" } },
        { name: "Edit", input: { file_path: created, old_string: "", new_string: "written" } },
        { name: "Bash", input: {
          command: 'test -z "${ANTHROPIC_API_KEY:-}${ANTHROPIC_AUTH_TOKEN:-}" && printf answer > result.txt && echo written',
          description: "Write the answer",
        } });
      const result = await solver.solve({ id: key.taskId, prompt: "检查文件并给出结果" }, session, { key, paths, signal });
      expect(result).toEqual({ finalText, usage: { inputTokens: 154, outputTokens: 49, totalTokens: 203 } });
      expect(await readFile(file, "utf8")).toBe("after");
      expect(fixture.requests[5]?.input.slice(-600)).not.toContain('"is_error":true');
      expect(await readFile(created, "utf8")).toBe("written");
      await expect(access(outsideCreated)).rejects.toMatchObject({ code: "ENOENT" });
      expect(fixture.requests).toHaveLength(7);
      expect(fixture.requests[0]).toMatchObject({ model, maxTokens: 1024, authenticated: true });
      expect(fixture.requests[0]?.input).toContain("检查文件");
      expect(fixture.requests[0]?.tools).toEqual(expect.arrayContaining(["Read", "Edit", "Bash"]));
      expect(fixture.requests[1]?.input).toContain('"is_error":true');
      expect(fixture.requests[1]?.input).not.toContain("outside-private-sentinel");
      expect(fixture.requests[2]?.input).toContain('"is_error":true');
      expect(fixture.requests[6]?.input).toMatch(/"type":"tool_result","content":"written(?:\\n)?"/u);
      expect(await readFile(join(session.workdir, "result.txt"), "utf8")).toBe("answer");
      await checkEvidence(paths.agent);
    } finally {
      await session.dispose(AbortSignal.timeout(10_000));
    }
  } finally {
    await fixture.close();
    await rm(root, { recursive: true, force: true });
  }
}, 930_000);

test.skipIf(!enabled("docker"))("Claude Code uses Bash and scores its file through the Docker model gateway", async () => {
  const root = await mkdtemp(join(tmpdir(), "arsi-evaluator-claude-docker-"));
  const fixture = await messagesFixture(true, [{
    name: "Read",
    input: { file_path: "/etc/os-release" },
  }, {
    name: "Bash",
    input: {
      command: 'test "$(id -u)" -eq 0 && test -z "${ANTHROPIC_API_KEY:-}${ANTHROPIC_AUTH_TOKEN:-}${ANTHROPIC_BASE_URL:-}" && printf answer > /workspace/result.txt && echo written',
      description: "Write the answer",
    },
  }]);
  try {
    const configPath = join(root, "experiment.yaml");
    await writeFixture(root, {
      "dataset/tasks/claudecode/task.toml": `artifacts = []\n[environment]\ndocker_image = "${PINNED_NODE_IMAGE}"\nworkdir = "/workspace"\n[agent]\nnetwork_mode = "no-network"\n[verifier]\nenvironment_mode = "shared"\n`,
      "dataset/tasks/claudecode/instruction.md": "Write answer to /workspace/result.txt.",
      "dataset/tasks/claudecode/tests/test.sh": "set -eu\ntest \"$(cat /workspace/result.txt)\" = answer\nprintf '{\"reward\":1}' > /logs/verifier/reward.json\n",
    });
    await writeFile(configPath, JSON.stringify({
      services: { fixture: { model, base_url: fixture.endpoint, api: "anthropic-messages", api_key: "${CLAUDE_FIXTURE_KEY}" } },
      benchmark: { name: "harbor", config: { source: { kind: "local", path: "./dataset" } },
        solver: { name: "claudecode", service: "fixture" } },
      environment: "docker",
      run: { maxTasks: 1, preparation: { environmentTimeoutSeconds: 900, roundTimeoutSeconds: 900 } },
      output: { directory: "./results" },
    }));
    const networkConfigPath = process.env.EVALUATOR_CLAUDECODE_TEST_NETWORK;
    const result = await new Evaluator().run({ configPath, env: { CLAUDE_FIXTURE_KEY: secret }, signal: AbortSignal.timeout(900_000),
      ...(networkConfigPath === undefined ? {} : { networkConfigPath }) });
    if (result.kind !== "local") throw new Error("Expected evaluation on the local scheduler");
    const [attempt] = result.snapshot.records;
    expect(fixture.requests).toHaveLength(3);
    for (const request of fixture.requests) expect(request).toMatchObject({ model, authenticated: true });
    expect(fixture.requests[0]?.tools).toContain("Bash");
    expect(fixture.requests[1]?.input).toContain("VERSION_CODENAME=bookworm");
    expect(fixture.requests[2]?.input).toMatch(/"type":"tool_result","content":"written(?:\\n)?"/u);
    expect(attempt, JSON.stringify(attempt?.errors)).toMatchObject({ executionStatus: "completed", scoreStatus: "valid", verdict: { score: 1 },
      collection: { trajectory: "complete" }, solve: { finalText, usage: { inputTokens: 66, outputTokens: 21, totalTokens: 87 } } });
    if (!attempt) throw new Error("Missing attempt");
    expect(result.snapshot.run.solverProvenance).toMatchObject({ claudeCodeVersion: CLAUDE_CODE_VERSION });
    await checkEvidence(join(result.runDirectory, "tasks", safeTaskKey(attempt.key.taskId), "attempts", attempt.key.attemptId, "agent"));
  } finally {
    await fixture.close();
    await rm(root, { recursive: true, force: true });
  }
}, 930_000);
