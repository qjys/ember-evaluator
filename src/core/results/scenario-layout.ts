import type { Benchmark } from "../contracts/benchmark.js";
import type { EffectiveConfig } from "../contracts/config.js";
import type { MeasurementLayout } from "../contracts/result.js";
import type { TaskRef } from "../contracts/task.js";

export function scenarioLayout(benchmark: Benchmark, config: EffectiveConfig): MeasurementLayout | undefined {
  if (benchmark.evaluationScenario === undefined) return benchmark.resultLayout?.(config);
  if (benchmark.evaluationScenario === "task") return undefined;
  return { kind: "inference-engine", version: 2, points: {},
    requestedMetrics: benchmark.requestedMeasurements?.(config) ?? ["service/requests"] };
}

/** Atomically bind the selected workload settings to the same IDs as the source lock. */
export function selectedMeasurementPoints(layout: MeasurementLayout | undefined, selected: TaskRef[]) {
  if (!layout || Object.keys(layout.points).length) return undefined;
  return Object.fromEntries(selected.map(ref => {
    if (ref.measurementConcurrency === undefined) throw new TypeError(`Missing measurement concurrency for ${ref.id}`);
    return [ref.id, ref.measurementConcurrency] as const;
  }));
}
