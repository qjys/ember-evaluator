"""Per-rank device intervals in the profiler's microsecond time domain."""
from collections import defaultdict
from decimal import Decimal, InvalidOperation
import math
import re


def merged(spans):
    result = []
    for start, end in sorted(spans):
        if result and start <= result[-1][1]:
            result[-1] = (result[-1][0], max(end, result[-1][1]))
        else:
            result.append((start, end))
    return result


def overlap(compute, communication):
    a, b = merged(compute), merged(communication)
    total = 0
    i = j = 0
    while i < len(a) and j < len(b):
        total += max(0, min(a[i][1], b[j][1]) - max(a[i][0], b[j][0]))
        if a[i][1] < b[j][1]:
            i += 1
        else:
            j += 1
    return total


def device_kind(name, category, task, process):
    label = (name + " " + category + " " + task).lower()
    if any(word in label for word in ("memcpy", "mem copy", "mem_cpy")):
        return "copy"
    if any(word in label for word in ("hccl", "hcom", "allreduce", "all_reduce", "allgather",
                                      "all_gather", "reduce_scatter", "reducescatter")) or process.lower() == "hccl":
        return "communication"
    if re.search(r"ai[ _]?(core|cpu|vector)|aiv(ec)?\b|mix_aic|cube|vector_core", label):
        return "compute"
    return None


def rank_timeline(events, kernel_rows):
    processes = {e.get("pid"): str(e.get("args", {}).get("name", "")) for e in events
                 if isinstance(e, dict) and e.get("name") == "process_name"}
    streams = defaultdict(list)
    groups = defaultdict(lambda: defaultdict(lambda: [0, 0.0]))
    explicit = defaultdict(list)
    origin = None
    def timestamp(value):
        nonlocal origin
        # CANN serializes epoch microseconds with sub-microsecond precision.
        try:
            stamp = Decimal(str(value))
        except InvalidOperation:
            return None
        if not stamp.is_finite():
            return None
        if origin is None:
            origin = stamp
        return float(stamp - origin)

    for e in events:
        if not isinstance(e, dict) or e.get("ph") != "X":
            continue
        start, duration = timestamp(e.get("ts")), e.get("dur")
        if not all(isinstance(x, (float, int)) and math.isfinite(x) for x in (start, duration)) or duration < 0:
            continue
        name, category = str(e.get("name", "")), str(e.get("cat", ""))
        args = e.get("args") or {}
        process = processes.get(e.get("pid"), "")
        device = ("ascend hardware" in process.lower() or process.lower() == "hccl" or
                  category.lower() in ("kernel", "ai core", "ai cpu", "async_npu", "ai_core", "ai_cpu"))
        if process.lower() == "overlap analysis" and name.lower() in ("computing", "communication"):
            lane = "compute" if name.lower() == "computing" else "communication"
            explicit[lane].append((start, start + duration))
            continue
        if device:
            kind = device_kind(name, category, str(args.get("Task Type", "")), process)
        elif process.lower() == "cann" or category.lower() in ("cann", "runtime", "acl", "runtime_api") or name.startswith(("aclrt", "rtLaunch", "rtMemcpy")):
            kind = "runtime"
        else:
            continue
        if not kind:
            continue
        if device:
            streams[kind].append((start, start + duration))
        slot = groups[kind][name]
        slot[0] += 1
        slot[1] += duration

    # Some CANN versions omit the device task type in the Chrome event.
    # Use the kernel table in the same profiler clock for absent categories only.
    fallback = defaultdict(list)
    fallback_groups = defaultdict(lambda: defaultdict(lambda: [0, 0.0]))
    for row in kernel_rows:
        name = row.get("name") or row.get("kernel name") or ""
        kind = device_kind(name, "", " ".join(row.get(k) or "" for k in ("type", "task type", "accelerator core")), "")
        if not kind:
            continue
        try:
            start, duration = timestamp(row["start time(us)"].strip()), float(row["duration(us)"])
        except (KeyError, TypeError, ValueError):
            continue
        if start is not None and math.isfinite(start) and math.isfinite(duration) and duration >= 0:
            fallback[kind].append((start, start + duration))
            slot = fallback_groups[kind][name]
            slot[0] += 1
            slot[1] += duration
    # Never intersect CSV and Chrome timestamps without an explicit clock alignment.
    def coverage(source):
        return sum(bool(source.get(kind)) for kind in ("compute", "communication"))
    # Both explicit lanes and device X events share the Chrome clock.
    streams.update(explicit)
    chosen = streams if coverage(streams) >= coverage(fallback) else fallback
    for kind, items in fallback_groups.items():
        if not groups[kind]:
            groups[kind] = items
    def total(kind):
        return sum(b - a for a, b in merged(chosen[kind])) if chosen.get(kind) else None

    computing, comm = total("compute"), total("communication")
    shared = overlap(chosen["compute"], chosen["communication"]) if computing is not None and comm is not None else None
    top = {kind: [{"name": name, "count": count, "durationUs": us} for name, (count, us) in
                  sorted(items.items(), key=lambda pair: pair[1][1], reverse=True)[:15]]
           for kind, items in groups.items() if items}
    return {"source": "trace_view.json" if chosen is streams else "kernel_details.csv",
            "computeUs": computing, "communicationUs": comm, "overlapUs": shared,
            "exposedCommunicationUs": comm - shared if shared is not None else None, "top": top}
