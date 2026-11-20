import { expectRecord } from "../../../core/validation/input.js";

const countFields = [
  "groups_finished", "groups_admitted", "decode_steps", "decode_forward", "decode_selection", "prefill_forward",
  "shared_prefix_forward", "shared_prefix_groups", "shared_prefix_rows", "shared_prefix_skip_no_plan", "shared_prefix_skip_gate",
  "shared_prefix_skip_group", "shared_prefix_exception", "gr_counter_schema", "decode_api_calls", "decode_api_graph",
  "decode_api_fia", "decode_api_fa", "decode_api_paged", "decode_api_sinks", "decode_api_beam_graph", "sdpa_decode_calls",
] as const;

export function sglangDiagnostics(value: unknown, meanMs: number | null = null) {
  const raw = expectRecord(value, "SGLang GR counters");
  function count(key: string): number {
    const n = raw[key] ?? 0;
    if (typeof n !== "number" || !Number.isSafeInteger(n) || n < 0) throw new TypeError(`Invalid GR counter ${key}`);
    return n;
  }
  const counts = Object.fromEntries(countFields.map(key => [key, count(key)]));
  const admitted = count("groups_admitted"), finished = count("groups_finished"), steps = count("decode_steps");
  const decodeForward = count("decode_forward"), selections = count("decode_selection"), fastpathForward = count("shared_prefix_forward");
  const stageMs: Record<string, number> = {};
  for (const [name, field, groups] of [
    ["span", "request_span_us", finished], ["prefill", "prefill_wait_us", admitted], ["pf_sel", "prefill_selection_us", admitted],
    ["decode1", "first_decode_us", finished], ["decode2", "decode_step_us", finished],
    ["admission", "admission_us", admitted], ["prefillCommit", "prefill_commit_us", admitted],
    ["overshoot", "overshoot_step_us", finished], ["decodeCommit", "decode_commit_us", finished],
  ] as const) {
    if (groups) stageMs[name] = count(field) / groups / 1000;
  }
  const { span, prefill, pf_sel, decode1, decode2 } = stageMs;
  if (span !== undefined && prefill !== undefined && pf_sel !== undefined && decode1 !== undefined && decode2 !== undefined)
    stageMs.tail = span - (prefill + pf_sel + decode1 + decode2);
  const shares: Record<string, number> = {};
  let dominant: string | null = null;
  for (const key of ["prefill", "pf_sel", "decode1", "decode2", "tail"]) {
    const duration = stageMs[key];
    if (span === undefined || duration === undefined) continue;
    shares[key] = span ? 100 * duration / span : 0;
    if (dominant === null || shares[key] > shares[dominant]!) dominant = key;
  }
  const clientGapMs = meanMs !== null && span !== undefined ? meanMs - span : null;
  const groups = finished || 1;
  const decodeWall = decode1 !== undefined && decode2 !== undefined ? decode1 + decode2 : null;
  const processIds = Object.fromEntries(["gr_pid_snapshot", "gr_pid_sched", "gr_pid_attn"].map(key => [key, raw[key] == null ? null : count(key)]));
  return { stageMs, shares, dominant, clientGapMs, clientPercent: clientGapMs === null ? null : meanMs ? 100 * clientGapMs / meanMs : 0,
    counts, processIds, exceptionNote: typeof raw.gr_note_shared_prefix_exc === "string" ? raw.gr_note_shared_prefix_exc : null,
    fastpathForward, decodeForward, fastpathRatio: decodeForward ? fastpathForward / decodeForward : 0,
    stepMs: count("decode_step_us") / Math.max(steps - groups, 1) / 1000,
    selectionMs: count("decode_selection_us") / Math.max(selections, 1) / 1000, stepsPerRequest: steps / groups,
    overshootRatio: decodeForward ? (decodeForward - selections) / decodeForward : 0,
    overshootWallShare: decodeWall === null ? null : decodeWall ? (stageMs.overshoot ?? 0) / decodeWall : 0 };
}
