import type { EvaluationScenario } from "../core/contracts/config.js";
import { expectNonEmptyString, expectRecord, parseEvaluationScenario, rejectUnknown } from "../core/validation/input.js";

export type ScenarioDefault = EvaluationScenario | {
  default: EvaluationScenario;
  configKey: string;
  cases: Record<string, EvaluationScenario>;
};

/** Profiles may classify operations of one implementation by a benchmark.config field. */
export function resolveEvaluationScenario(value: unknown, config: Record<string, unknown>): EvaluationScenario {
  const path = "benchmark.evaluationScenario";
  if (typeof value !== "object" || value === null) return parseEvaluationScenario(value, path);
  const rule = expectRecord(value, path);
  rejectUnknown(rule, ["default", "configKey", "cases"], path);
  const field = expectNonEmptyString(rule.configKey, `${path}.configKey`);
  const fallback = parseEvaluationScenario(rule.default, `${path}.default`);
  const action = config[field];
  const cases = expectRecord(rule.cases, `${path}.cases`);
  let selected = fallback;
  for (const [name, candidate] of Object.entries(cases)) {
    const scenario = parseEvaluationScenario(candidate, `${path}.cases.${name}`);
    if (action === name) selected = scenario;
  }
  return selected;
}
