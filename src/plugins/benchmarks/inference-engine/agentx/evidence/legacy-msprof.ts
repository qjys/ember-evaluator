// Read-only support for results produced by the retired AgentX sampler.
import { expectRecord, rejectUnknown } from "../../../../../core/validation/input.js";
export type MsprofSummary = {
  schemaVersion: 1;
  kind: "profiling-summary";
  requestedDevices?: number[] | ["all"];
  resolvedDevices?: number[];
  deviceMapping?: Record<string, number[]>;
  aggregate: { device_count: number; mac_fp16_ratio_mean: number | null };
  devices: Record<string, { mac_fp16_ratio: number; mac_int8_ratio: number | null; samples: number }>;
  availability: Record<string, string>;
  csv_parse_errors: string[];
  sqlite_devices?: Record<string, number>;
};

export function parseMsprofSummary(value: unknown): MsprofSummary {
  const raw = expectRecord(value, "msprof summary");
  rejectUnknown(raw, ["schemaVersion", "kind", "requestedDevices", "resolvedDevices", "deviceMapping", "aggregate", "devices", "availability", "csv_parse_errors", "sqlite_devices"], "msprof summary");
  if (raw.schemaVersion !== 1 || raw.kind !== "profiling-summary")
    throw new TypeError("Invalid msprof summary schema");
  if (raw.requestedDevices !== undefined) {
    const requested = raw.requestedDevices;
    const all = Array.isArray(requested) && requested.length === 1 && requested[0] === "all";
    if (!Array.isArray(requested) || !requested.length || (!all && requested.some(entry =>
      entry === "all" || typeof entry !== "number" || !Number.isSafeInteger(entry) || entry < 0)) ||
      (all && (raw.resolvedDevices === undefined || raw.deviceMapping === undefined)))
      throw new TypeError("Invalid msprof requestedDevices");
  }
  if (raw.resolvedDevices !== undefined) {
    const resolved = raw.resolvedDevices;
    if (!Array.isArray(resolved) || !resolved.length ||
        resolved.some(entry => typeof entry !== "number" || !Number.isSafeInteger(entry) || entry < 0))
      throw new TypeError("Invalid msprof resolvedDevices");
  }
  if (raw.deviceMapping !== undefined) {
    const mapping = expectRecord(raw.deviceMapping, "msprof summary deviceMapping");
    const keys = Object.keys(mapping);
    const mappedChips = Object.values(mapping).flat().filter((entry): entry is number =>
      typeof entry === "number" && Number.isSafeInteger(entry) && entry >= 0);
    const invalidMapping = !keys.length || keys.some(key => !/^[0-9]+$/u.test(key)) ||
      Object.values(mapping).some(chips => !Array.isArray(chips) || !chips.length ||
        chips.some(entry => typeof entry !== "number" || !Number.isSafeInteger(entry) || entry < 0)) ||
      new Set(mappedChips).size !== mappedChips.length;
    const resolved = raw.resolvedDevices;
    const mappingMatchesResolved = !Array.isArray(resolved) ||
      (mappedChips.length === resolved.length &&
       [...mappedChips].sort((left, right) => left - right)
         .every((entry, index) => entry === resolved[index]));
    if (invalidMapping || !mappingMatchesResolved)
      throw new TypeError("Invalid msprof deviceMapping");
  }
  const aggregate = expectRecord(raw.aggregate, "msprof summary aggregate");
  rejectUnknown(aggregate, ["device_count", "mac_fp16_ratio_mean"], "msprof summary aggregate");
  if (typeof aggregate.device_count !== "number" || !Number.isSafeInteger(aggregate.device_count) || aggregate.device_count < 0)
    throw new TypeError("Invalid msprof aggregate device_count");
  const mean = aggregate.mac_fp16_ratio_mean;
  if (mean !== null && (typeof mean !== "number" || !Number.isFinite(mean) || mean < 0 || mean > 1))
    throw new TypeError("Invalid msprof aggregate mac_fp16_ratio_mean");
  const devices = expectRecord(raw.devices, "msprof summary devices");
  for (const entry of Object.values(devices)) {
    const device = expectRecord(entry, "msprof device entry");
    rejectUnknown(device, ["mac_fp16_ratio", "mac_int8_ratio", "samples"], "msprof device entry");
    if (typeof device.mac_fp16_ratio !== "number" || !Number.isFinite(device.mac_fp16_ratio) || device.mac_fp16_ratio < 0 || device.mac_fp16_ratio > 1)
      throw new TypeError("Invalid msprof mac_fp16_ratio");
    if (device.mac_int8_ratio !== null && (typeof device.mac_int8_ratio !== "number" || !Number.isFinite(device.mac_int8_ratio) || device.mac_int8_ratio < 0 || device.mac_int8_ratio > 1))
      throw new TypeError("Invalid msprof mac_int8_ratio");
    if (typeof device.samples !== "number" || !Number.isSafeInteger(device.samples) || device.samples <= 0)
      throw new TypeError("Invalid msprof samples");
  }
  const availability = expectRecord(raw.availability, "msprof summary availability");
  if (Object.values(availability).some(value => typeof value !== "string"))
    throw new TypeError("Invalid msprof summary availability");
  if (!Array.isArray(raw.csv_parse_errors) || raw.csv_parse_errors.some(error => typeof error !== "string"))
    throw new TypeError("Invalid msprof csv_parse_errors");
  if (raw.sqlite_devices !== undefined) {
    const sqliteDevices = expectRecord(raw.sqlite_devices, "msprof summary sqlite_devices");
    if (Object.values(sqliteDevices).some(value => typeof value !== "number" || !Number.isFinite(value)))
      throw new TypeError("Invalid msprof sqlite_devices");
  }
  return raw as unknown as MsprofSummary;
}
