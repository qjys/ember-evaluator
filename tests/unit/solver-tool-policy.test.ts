import { expect, test } from "vitest";
import { parseSolverToolPolicy, sessionToolPolicy } from "../../src/core/validation/solver-tool-policy.js";
import { parseAgentBundleConfig } from "../../src/plugins/solvers/agentbundle.js";
import { parseClaudeCodeConfig } from "../../src/plugins/solvers/claudecode.js";
import { parseCodeBuddyConfig } from "../../src/plugins/solvers/codebuddy.js";
import { parseCodexConfig } from "../../src/plugins/solvers/codex.js";
import { parseNativeCodeConfig } from "../../src/plugins/solvers/native-code.js";
import { parseSimpleAgentConfig } from "../../src/plugins/solvers/simpleagent.js";
import { parseTraeConfig } from "../../src/plugins/solvers/trae.js";
import { parseZCodeConfig } from "../../src/plugins/solvers/zcode.js";
import { parseRunnerInput, projectRunnerInput } from "../../src/runtimes/pi/protocol.js";

test.each([parseClaudeCodeConfig, parseCodeBuddyConfig, parseSimpleAgentConfig, parseTraeConfig, parseZCodeConfig])(
  "%s accepts a strict no-tools policy and preserves omitted defaults",
  parse => {
    expect(parse({ tools: "none", webSearch: "disabled" })).toMatchObject({ tools: "none", webSearch: "disabled" });
    expect(parse({ tools: "default", webSearch: "default", webFetch: "default" })).toEqual({});
    expect(() => parse({ webSearch: false })).toThrow(/webSearch/u);
    expect(() => parse({ tool: "none" })).toThrow(/unknown field/u);
  },
);

test.each([
  ["codex", parseCodexConfig], ["trae", parseTraeConfig], ["claudecode", parseClaudeCodeConfig],
  ["codebuddy", parseCodeBuddyConfig], ["zcode", parseZCodeConfig], ["simpleagent", parseSimpleAgentConfig],
  ...(["qwencode", "kimicode", "minimaxcode", "opencode"] as const).map(name => [name, (v: unknown) => parseNativeCodeConfig(name, v)] as const),
  ["agentbundle", (v: Record<string, unknown>) => parseAgentBundleConfig({ path: "bundle", ...v })],
] as const)("%s reports conflicting built-in and web requests without blocking independent MCP settings", (name, parse) => {
  for (const field of ["webSearch", "webFetch"]) {
    expect(() => parse({ tools: "none", [field]: "enabled" })).toThrow(new RegExp(name + ".*tools: none.*" + field + ": enabled.*because"));
  }
  expect(parse({ tools: "none", mcp: "disabled", webFetch: "disabled" })).toMatchObject({ tools: "none", mcp: "disabled", webFetch: "disabled" });
});

test("native launchers reject modes unavailable on their locked headless paths", () => {
  expect(parseCodexConfig({ tools: "none" })).toEqual({ tools: "none" });
  expect(parseCodexConfig({ shellTool: "disabled", webSearch: "enabled" })).toEqual({ shellTool: "disabled", webSearch: "enabled" });
  expect(() => parseCodexConfig({ tools: false })).toThrow(/tools must be default or none/u);
  expect(parseCodexConfig({ webSearch: "enabled", webFetch: "disabled" })).toEqual({ webSearch: "enabled", webFetch: "disabled" });
  expect(parseCodexConfig({ webSearch: "disabled", webFetch: "enabled" })).toEqual({ webSearch: "disabled", webFetch: "enabled" });
  expect(parseCodexConfig({ webSearch: "enabled", webFetch: "enabled", mcp: "disabled" }))
    .toEqual({ webSearch: "enabled", webFetch: "enabled", mcp: "disabled" });
  expect(() => parseCodexConfig({ webSearch: "disabled", webFetch: "enabled", mcp: "disabled" })).toThrow(/Independent fetching requires the evaluator MCP/u);
  expect(() => parseCodexConfig({ webFetch: "enabled", mcp: "disabled" })).toThrow(/webFetch: enabled.*mcp: disabled.*evaluator MCP/u);
  expect(() => parseCodexConfig({ webSearch: "enabled", webFetch: "disabled", mcp: "disabled" })).toThrow(/webSearch: enabled.*webFetch: disabled.*mcp: disabled.*combined search/u);
  expect(parseCodexConfig({ webSearch: "enabled" })).toEqual({ webSearch: "enabled" });
  expect(parseTraeConfig({ webFetch: "enabled" })).toEqual({ webFetch: "enabled" });
  expect(() => parseZCodeConfig({ webSearch: "enabled", mcp: "disabled" })).toThrow(/custom model route/u);
  expect(parseSimpleAgentConfig({ webFetch: "enabled" })).toEqual({ webFetch: "enabled" });
});

test("AgentBundle and Pi runner preserve policy and exact external tool names", () => {
  const config = parseAgentBundleConfig({
    path: "bundle", webSearch: "disabled", pi: { webSearchTools: ["mcp__search__query"] },
  });
  expect(config).toEqual({ path: "bundle", webSearch: "disabled", pi: { webSearchTools: ["mcp__search__query"] } });
  expect(() => parseAgentBundleConfig({ path: "bundle", pi: { webSearchTools: ["*"] } })).toThrow(/exact tool names/u);

  expect(() => parseSimpleAgentConfig({ bundle: { path: "bundle", webSearchTools: ["lookup"], webFetchTools: ["lookup"] },
    webSearch: "disabled", webFetch: "enabled" })).toThrow(/webSearch: disabled.*webFetch: enabled.*lookup/u);
  expect(() => parseAgentBundleConfig({ path: "bundle", pi: { webSearchTools: ["web_fetch"] },
    webSearch: "enabled", webFetch: "disabled" })).toThrow(/webSearch: enabled.*webFetch: disabled.*web_fetch/u);

  const toolAccess = { webSearch: "disabled", webSearchTools: ["mcp__search__query"] } as const;
  const input = projectRunnerInput({
    key: { runId: "r", taskId: "t", attemptId: "a" },
    input: { id: "t", prompt: "Respond with text." },
    model: { name: "fixture", endpoint: "http://127.0.0.1/v1", api: "openai-completions", provider: null },
    auth: { value: "fixture", reference: null },
    workdir: "/workspace", outputDir: "/agent",
    toolAccess: { ...toolAccess, webSearchTools: [...toolAccess.webSearchTools] },
  });
  expect(parseRunnerInput(JSON.parse(JSON.stringify(input))).toolAccess).toEqual(toolAccess);
});

test("solve network prevents both external search and provider-hosted search", () => {
  for (const network of ["none", "model-api", ["docs.example.org"]] as const) {
    const solveNetwork = typeof network === "string" ? network : { kind: "allowlist" as const, allowedHosts: [...network] };
    expect(sessionToolPolicy("codex", { mcp: "disabled" }, { solveNetwork })).toEqual({ mcp: "disabled", webSearch: "disabled",
      ...(typeof solveNetwork === "string" ? { webFetch: "disabled" } : {}) });
    expect(() => sessionToolPolicy("codex", { webSearch: "enabled" }, { solveNetwork })).toThrow(/network/u);
  }
  for (const solveNetwork of ["none", "model-api"] as const) {
    expect(() => sessionToolPolicy("qwencode", { webFetch: "enabled" }, { solveNetwork })).toThrow(new RegExp("qwencode: webFetch: enabled.*" + solveNetwork));
  }
  expect(sessionToolPolicy("codex", { webFetch: "enabled" }, { solveNetwork: { kind: "allowlist", allowedHosts: ["example.org"] } })).toEqual({ webFetch: "enabled", webSearch: "disabled" });
  expect(sessionToolPolicy("codex", { skills: "disabled" }, { solveNetwork: "bridge" })).toEqual({ skills: "disabled" });
});

test.each(["subagent", "mcp", "skills"])("%s accepts only default or disabled", field => {
  expect(parseSolverToolPolicy({ [field]: "default" }, "solver")).toEqual({});
  expect(parseSolverToolPolicy({ [field]: "disabled" }, "solver")).toEqual({ [field]: "disabled" });
  expect(() => parseSolverToolPolicy({ [field]: "enabled" }, "solver")).toThrow(field);
});
