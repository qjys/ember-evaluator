import { createServer } from "node:http";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { expect, test } from "vitest";
import { parse as parseYaml } from "yaml";
import type { ModelConfig } from "../../src/core/contracts/config.js";
import type { RunnerInput } from "../../src/runtimes/pi/protocol.js";
import { parseRunnerInput, projectRunnerInput } from "../../src/runtimes/pi/protocol.js";
import { modelFor } from "../../src/runtimes/pi/runner.js";
import { dshModelPatch } from "../../src/runtimes/dsh/model.js";
import { mergeJiuwenswarmModelConfig } from "../../src/runtimes/jiuwenswarm/prepare.js";

test("AgentX still applies replay effort and DeepAgents passes effort only to the graph factory", () => {
  const script = fileURLToPath(new URL("../fixtures/reasoning-python.py", import.meta.url));
  const root = fileURLToPath(new URL("../../", import.meta.url));
  const output = execFileSync(process.env.PYTHON_BIN ?? (process.platform === "win32" ? "python" : "python3"),
    [script, root], { encoding: "utf8", windowsHide: true });
  expect(output).toContain("Python reasoning overrides passed");
});

test.each([
  ["openai-completions", null, "private-reasoning-model", (effort: string) => ({ reasoning_effort: effort })],
  ["openai-responses", null, "private-reasoning-model", (effort: string) => ({ reasoning: { effort } })],
  ["anthropic-messages", null, "private-reasoning-model", (effort: string) => ({ output_config: { effort }, thinking: { type: "adaptive" } })],
  ["anthropic-messages", "anthropic", "claude-sonnet-4-5-20250929",
    (_effort: string) => ({ thinking: { type: "enabled", budget_tokens: expect.any(Number) } })],
] as const)("Pi and SimpleAgent preserve native thinking over %s (%s, %s)", async (api, provider, name, expected) => {
  const requests: unknown[] = [];
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    requests.push(JSON.parse(body));
    res.writeHead(400, { "content-type": "application/json" })
      .end('{"error":{"type":"invalid_request_error","message":"local capture complete"}}');
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Fixture did not bind");
  try {
    const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, refreshOnCreate: false });
    const source: RunnerInput = {
      schemaVersion: 1, key: { runId: "r", taskId: "t", attemptId: "a" },
      input: { id: "t", prompt: "hello" }, model: {
        name, endpoint: `http://127.0.0.1:${address.port}/v1`, provider, api, reasoningEffort: "max",
      }, auth: { value: "fixture", reference: null }, workdir: "/workspace", outputDir: "/output",
    };
    const input = parseRunnerInput(projectRunnerInput(source));
    expect(input.model.reasoningEffort).toBe("max");
    const model = await modelFor(input, runtime);
    for (const reasoning of ["max", "low"] as const) await runtime.completeSimple(model,
      { messages: [{ role: "user", content: "hello", timestamp: 1 }] },
      { apiKey: "fixture", maxRetries: 0, reasoning });
    expect(requests).toHaveLength(2);
    expect(requests[0]).toMatchObject(expected("max"));
    expect(requests[1]).toMatchObject(expected("low"));
    if (provider === "anthropic") {
      expect(requests[0]).not.toHaveProperty("output_config");
      expect(requests[1]).not.toHaveProperty("output_config");
      expect(requests[0]).not.toEqual(requests[1]);
    }
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test.each(["openai-completions", "openai-responses", "anthropic-messages"])("DSH declares and selects the exact service effort for %s", api => {
  const model: ModelConfig = { name: "fixture", endpoint: "https://fixture.invalid/v1", provider: null, api, reasoningEffort: "max" };
  const rows = parseYaml(dshModelPatch(model));
  expect(rows.find((row: { id: string }) => row.id === "agent-default-model").config).toMatchObject({ reasoningEffort: "max" });
  const provider = rows.find((row: { id: string }) => row.id === "llm-pi-ai").config.providers["arsi-evaluator"];
  expect(provider.reasoning).toBe("max");
  expect(provider.models[0].reasoningEfforts).toEqual({ max: "max" });
});

test("JiuwenSwarm changes only the selected model entry and leaves same-name auxiliary presets alone", () => {
  const existing = `models:
  defaults:
    - alias: auxiliary
      model_client_config: { model_name: fixture }
      model_config_obj: { reasoning_level: low, extra_body: { temperature: 0.2 } }
    - is_default: true
      model_client_config: { model_name: "\${MODEL_NAME}" }
      model_config_obj:
        reasoning_level: medium
        reasoning_effort: low
        max_tokens: 8192
        chat_template_kwargs: { enable_thinking: false, custom_flag: true }
        extra_body: { reasoning_effort: low }
  vision:
    model_config_obj: { reasoning_level: low }
`;
  const retained = parseYaml(mergeJiuwenswarmModelConfig(existing));
  const overridden = parseYaml(mergeJiuwenswarmModelConfig(existing, false, { modelName: "fixture", level: "max" }));
  expect(retained.models.defaults[1].model_config_obj).toMatchObject({ reasoning_level: "medium", reasoning_effort: "low", max_tokens: 8192 });
  expect(overridden.models.defaults[1].model_config_obj).toEqual({ reasoning_level: "max", max_tokens: 8192,
    extra_body: { chat_template_kwargs: { custom_flag: true } } });
  expect(overridden.models.defaults[0]).toEqual(retained.models.defaults[0]);
  expect(overridden.models.vision).toEqual(retained.models.vision);
});
