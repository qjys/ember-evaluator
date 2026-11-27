"""One TPOT observation per successful multi-token request in the formal window."""
import json
import math


def per_request_tpot(artifacts):
    values = []
    for path in artifacts.rglob("profile_export.jsonl"):
        with path.open(encoding="utf-8") as source:
            for line in source:
                if not line.strip():
                    continue
                row = json.loads(line)
                meta = row.get("metadata", {})
                if (meta.get("benchmark_phase") != "profiling" or row.get("error") or
                        meta.get("was_cancelled") or meta.get("context_overflow_skip")):
                    continue
                metrics = row.get("metrics", {})
                latency, first, length = (metrics.get(key) or {} for key in
                                          ("request_latency", "time_to_first_token", "output_sequence_length"))
                if (latency.get("unit"), first.get("unit"), length.get("unit")) != ("ms", "ms", "tokens"):
                    continue
                end, start, tokens = latency.get("value"), first.get("value"), length.get("value")
                if (all(isinstance(x, (int, float)) and math.isfinite(x) for x in (start, end, tokens))
                        and tokens > 1 and int(tokens) == tokens and end >= start >= 0):
                    values.append((end - start) / (tokens - 1))
    if not values:
        return None
    values.sort()

    def percentile(q):
        pos = (len(values) - 1) * q
        frac = pos % 1
        return values[math.floor(pos)] * (1 - frac) + values[math.ceil(pos)] * frac

    return {"unit": "ms", "avg": sum(values) / len(values), "count": len(values),
            "p50": percentile(.5), "p95": percentile(.95), "p99": percentile(.99)}
