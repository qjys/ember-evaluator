import type { ResultSnapshot } from "./result.js";
import type { JsonValue } from "./task.js";

export type MeasurementMetricFile = {
  path: string;
  /** Point status keyed by concurrency, also included in the lightweight index. */
  status: Record<string, string>;
  points: JsonValue[];
};

export interface Metrics {
  measurementFiles?(snapshot: ResultSnapshot, value: JsonValue): MeasurementMetricFile[];
  name: string;
  compute(snapshot: ResultSnapshot): Promise<JsonValue>;
}

export type MetricResults = Record<string, JsonValue>;
