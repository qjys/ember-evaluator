export const legacyBudget = "legacy-eager";
export const currentBudget = "gr-a2-2026-11-23";
export type BudgetVersion = typeof legacyBudget | typeof currentBudget;

export function parseBudgetVersion(value: unknown): BudgetVersion {
  if (value !== legacyBudget && value !== currentBudget) throw new TypeError("Unknown recommendation budgetVersion: " + String(value));
  return value;
}

type Budget = { version: BudgetVersion; gate: "graph" | "eager"; timing: string; eager: Record<number, number>; graph: Record<number, number> };
export const budgets: Record<BudgetVersion, Budget> = {
  [legacyBudget]: { version: legacyBudget, gate: "eager", timing: "historical-profiler-stage",
    eager: { 128: 68.7, 512: 66.7, 1024: 69.3, 5120: 99.8, 10240: 180.178 }, graph: {} },
  [currentBudget]: { version: currentBudget, gate: "graph", timing: "engine-iteration-excludes-http-admission",
    eager: { 128: 68.10, 512: 73.56, 1024: 70.07, 5120: 111.01, 10240: 196.00 },
    graph: { 128: 35.22, 512: 36.90, 1024: 41.01, 5120: 84.58, 10240: 169.99 } },
};
