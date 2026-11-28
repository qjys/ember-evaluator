import type { EnvironmentSpec } from "../contracts/environment.js";
import { EvaluatorError } from "../errors/evaluator-error.js";
import { expectNonEmptyString, expectRecord, rejectUnknown } from "./input.js";

type WebToolMode = "default" | "disabled" | "enabled";
export type SolverToolPolicy = {
  subagent?: "default" | "disabled";
  mcp?: "default" | "disabled";
  skills?: "default" | "disabled";
  tools?: "default" | "none";
  webSearch?: WebToolMode;
  webFetch?: WebToolMode;
};
export type WebToolNames = { webSearchTools?: string[]; webFetchTools?: string[] };
export const PI_WEB_FETCH_TOOL_NAMES = ["web_fetch", "webfetch"] as const;
export const SOLVER_TOOL_FIELDS = ["tools", "webSearch", "webFetch", "subagent", "mcp", "skills"] as const;

export function parseSolverToolPolicy(
  value: unknown, path: string, extra: readonly string[] = [],
): SolverToolPolicy {
  const config = expectRecord(value, path);
  rejectUnknown(config, [...SOLVER_TOOL_FIELDS, ...extra], path);
  const { tools, webSearch, webFetch } = config;
  if (tools !== undefined && tools !== "default" && tools !== "none") {
    throw new TypeError(`${path}.tools must be default or none`);
  }
  for (const [key, mode] of [["webSearch", webSearch], ["webFetch", webFetch]] as const) {
    if (mode !== undefined && mode !== "default" && mode !== "disabled" && mode !== "enabled") {
      throw new TypeError(`${path}.${key} must be default, disabled or enabled`);
    }
  }
  const enabled = (["webSearch", "webFetch"] as const).filter(key => config[key] === "enabled");
  if (tools === "none" && enabled.length) {
    const settings = enabled.map(key => `${key}: enabled`).join(" and ");
    unsupportedToolPolicy(path, `tools: none cannot be combined with ${settings} because it disables built-in web tools and supplementary search. Omit tools to enable a web tool.`);
  }
  const extensions: SolverToolPolicy = {};
  for (const key of ["subagent", "mcp", "skills"] as const) {
    const mode = config[key];
    if (mode === "disabled") extensions[key] = mode;
    else if (mode !== undefined && mode !== "default") throw new TypeError(`${path}.${key} must be default or disabled`);
  }
  return {
    ...extensions,
    ...(tools === "none" ? { tools } : {}),
    ...(webSearch === "disabled" || webSearch === "enabled" ? { webSearch } : {}),
    ...(webFetch === "disabled" || webFetch === "enabled" ? { webFetch } : {}),
  };
}

export function pickSolverToolPolicy(policy: SolverToolPolicy): SolverToolPolicy {
  return Object.fromEntries(SOLVER_TOOL_FIELDS.filter(key => policy[key] !== undefined).map(key => [key, policy[key]]));
}

export function sessionToolPolicy<T extends SolverToolPolicy>(solver: string, policy: T, session: { solveNetwork?: EnvironmentSpec["network"] }): T {
  const network = session.solveNetwork;
  if (network === undefined || network === "bridge" || network === "host") return policy;
  const networkName = typeof network === "string" ? network : network.kind;
  if (policy.webSearch === "enabled") unsupportedToolPolicy(solver, `webSearch: enabled conflicts with task network ${networkName} because the available public search backends require unrestricted web search.`);
  if (policy.webFetch === "enabled" && (network === "none" || network === "model-api")) {
    unsupportedToolPolicy(solver, `webFetch: enabled conflicts with task network ${network} because the solve environment cannot request public web pages.`);
  }
  return { ...policy, webSearch: "disabled", ...(network === "none" || network === "model-api" ? { webFetch: "disabled" } : {}) };
}

export function parseWebToolNames(value: Record<string, unknown>, path: string, policy: SolverToolPolicy): WebToolNames {
  const result: WebToolNames = {};
  for (const key of ["webSearchTools", "webFetchTools"] as const) {
    const names = value[key];
    if (names === undefined) continue;
    if (!Array.isArray(names) || names.length === 0) {
      throw new TypeError(`${path}.${key} must be a non-empty array of tool names`);
    }
    const parsed = names.map(name => expectNonEmptyString(name, `${path}.${key}`));
    if (parsed.some(name => !/^[A-Za-z0-9_.:-]+$/u.test(name)) || new Set(parsed).size !== parsed.length) {
      throw new TypeError(`${path}.${key} must contain unique exact tool names`);
    }
    result[key] = parsed;
  }
  if ((policy.webSearch === "enabled" && policy.webFetch === "disabled") ||
      (policy.webFetch === "enabled" && policy.webSearch === "disabled")) {
    const fetch = [...PI_WEB_FETCH_TOOL_NAMES, ...(result.webFetchTools ?? [])];
    const shared = (result.webSearchTools ?? ["web_search"]).filter(name => fetch.includes(name));
    if (shared.length) unsupportedToolPolicy(path, `webSearch: ${policy.webSearch} conflicts with webFetch: ${policy.webFetch} because both use the same Pi tool: ${shared.join(", ")}.`);
  }
  return result;
}

export function unsupportedToolPolicy(solver: string, reason: string): never {
  throw new EvaluatorError("CONFIG_INVALID", `${solver}: ${reason}`);
}

export function toolPolicyProvenance(policy: SolverToolPolicy, method: string): Record<string, string> {
  return Object.keys(policy).length === 0 ? {} : {
    toolPolicyMethod: method,
    ...(policy.tools === "none" ? { toolsScope: "builtin" } : {}),
    ...pickSolverToolPolicy(policy),
    tools: policy.tools ?? "default",
    webSearch: policy.tools === "none" ? "disabled" : policy.webSearch ?? "default",
    webFetch: policy.tools === "none" ? "disabled" : policy.webFetch ?? "default",
  };
}
