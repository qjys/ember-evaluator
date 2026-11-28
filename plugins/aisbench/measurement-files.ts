import { measurementDirectory, serviceDiagnosticSection } from "arsi-evaluator";
import type { JsonValue, MeasurementMetricFile, ResultSnapshot } from "arsi-evaluator";

type Row = Record<string, JsonValue>;
function row(value: JsonValue | undefined): Row {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}
function rows(value: JsonValue | undefined): Row[] {
  return Array.isArray(value) ? value.map(row) : [];
}
function coverage(states: JsonValue[]): string {
  if (states.length && states.every(s => s === "measured")) return "measured";
  return states.some(s => s === "measured" || s === "partial" || s === "host-only") ? "partial" : "unavailable";
}

export function aisbenchMeasurementFiles(snapshot: ResultSnapshot, value: JsonValue): MeasurementMetricFile[] {
  const metric = row(value), layout = snapshot.run.resultLayout;
  if (!layout || metric.applicable !== true) return [];
  const points = new Map(rows(metric.points).map(p => [p.taskId, p]));
  return layout.requestedMetrics.map(path => {
    const file: MeasurementMetricFile = { path, status: {}, points: [] };
    for (const id of snapshot.run.taskIds) {
      const point = points.get(id) ?? {}, concurrency = layout.points[id];
      if (concurrency === undefined) throw new Error(`Missing measurement point for ${id}`);
      const label = measurementDirectory(concurrency);
      const profiling = path !== "service/requests" && path !== "engine/engine";
      const phase = profiling ? "profiling" : "performance";
      const source = label + "/" + phase;
      const collections = rows(point.collections);
      if (profiling && point.managed) {
        const profile = row(collections.find(c => c.profiling)?.profiling);
        const section = serviceDiagnosticSection(path, { ...profile, artifactDirectory: "profiling" }, source);
        file.status[label] = section.status;
        file.points.push({ concurrency, status: section.status, profiling: section });
        continue;
      }
      let status = "unavailable";
      let values: Row = {};
      if (path === "service/requests") {
        if (point.measurement) {
          status = "measured";
          values = { workload: point.workload ?? null, statistics: point.metrics ?? {}, rows: row(point.measurement).rows ?? [] };
        } else {
          const groups = rows(point.groups).map(g => ({ ...g, file: typeof g.file === "string" ? source + "/" + g.file : null }));
          status = coverage(groups.map(g => row(g).status ?? "missing"));
          values = { groups };
        }
      } else if (path === "engine/engine") {
        const datasets = collections.filter(c => c.engine).map(c => {
          const engine = row(c.engine);
          return { dataset: c.dataset ?? null, ...engine, ...(engine.rawSeries ? { source: source + "/" + engine.rawSeries } : {}) };
        });
        status = coverage(datasets.map(d => row(d).status ?? "missing"));
        values = datasets.length ? { datasets } : { datasets, reason: "No engine metrics were collected for this service binding" };
      } else if (profiling) {
        const datasets = collections.map(c => {
          const profile = row(c.profiling);
          const ranks = rows(profile.exports).map(r => {
            const statistics = path === "parallelism/timeline" ? { stageUs: r.stageUs ?? null, stepSpansUs: r.stepSpansUs ?? null } :
              Object.fromEntries(["operatorSource", "operatorDeviceUs", "operatorHostUs", "operatorInstances", "operatorTypes",
                "byCore", "kernelCount", "kernelDurationUs", "kernelWaitUs", "topDevice", "topHost", "topKernelWait"]
                .filter(k => r[k] !== undefined).map(k => [k, r[k]!]));
            return { source: typeof r.artifactDirectory === "string" ? label + "/" + r.artifactDirectory : null, statistics };
          });
          const hasData = ranks.map(rank => path === "parallelism/timeline"
            ? Object.values(row(rank.statistics.stageUs)).some(t => typeof t === "number") ||
              Object.values(row(rank.statistics.stepSpansUs)).some(t => Array.isArray(t) && t.length > 0)
            : Object.values(rank.statistics).some(v => typeof v === "number"));
          const rankStatus = hasData.length && hasData.every(Boolean) ? profile.status ?? "missing" :
            hasData.some(Boolean) ? "partial" : "unavailable";
          return { dataset: c.dataset ?? null, status: rankStatus, captureStatus: profile.status ?? "missing", ranks,
            ...(profile.error ? { error: profile.error } : {}) };
        });
        status = coverage(datasets.map(d => d.status));
        values = { datasets };
      }
      file.status[label] = status;
      file.points.push({ concurrency, status, [phase]: { source, status, values } });
    }
    return file;
  });
}
