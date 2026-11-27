"""Ascend profiler export statistics. All durations in this module are microseconds."""
import csv
import json
import math
from collections import Counter

from timeline import rank_timeline


def rows(path):
    if path.is_file():
        with path.open(encoding="utf-8-sig", newline="") as source:
            for row in csv.DictReader(source):
                yield {key.strip().lower(): val for key, val in row.items() if key}


def field(row, *keys):
    return next((row[k.lower()] for k in keys if k.lower() in row), None)


def number(row, *keys):
    value = field(row, *keys)
    if value in (None, "", "N/A", "N/A "):
        return None
    try:
        parsed = float(value)
    except ValueError:
        return None
    return parsed if math.isfinite(parsed) else None


def add(slot, key, value):
    if value is not None:
        slot[key] = slot.get(key, 0) + value


def summarize_export(directory, root):
    stage_row = next(rows(directory / "step_trace_time.csv"), {})
    stage = {key: number(stage_row, key + " Time(us)", key) for key in ("Stage", "Computing", "Free", "Preparing")}
    ops = {}
    source = "op_statistic.csv"
    def add_op(row, compact):
        name = field(row, "OP Type", "Name") or "?"
        core = field(row, "Core Type") or "?"
        slot = ops.setdefault((name, core), {"name": name, "core": core})
        add(slot, "count", 1 if compact else number(row, "Count"))
        add(slot, "deviceUs", number(row, "Device Total Duration(us)", "Device Duration(us)") if compact else number(row, "Total Time(us)"))
        if compact:
            for key, column in (("hostUs", "Host Total Duration(us)"), ("hostSelfUs", "Host Self Duration(us)"),
                                ("deviceSelfUs", "Device Self Duration(us)"), ("aiCoreUs", "Device Total Duration With AICore(us)")):
                add(slot, key, number(row, column))
    for row in rows(directory / source):
        add_op(row, False)
    if not ops:
        source = "operator_details.csv"
        for row in rows(directory / source):
            add_op(row, True)
    kernels = {}
    small = {}
    kernel_count = 0
    for row in rows(directory / "kernel_details.csv"):
        kernel_count += 1
        name = field(row, "Name", "Kernel Name") or "?"
        slot = kernels.setdefault(name, {"name": name})
        duration, wait = number(row, "Duration(us)", "Duration"), number(row, "Wait Time(us)", "Wait Time")
        for target in ([slot, small] if duration is not None and duration <= 10 else [slot]):
            add(target, "count", 1)
            add(target, "durationUs", duration)
            add(target, "waitUs", wait)
    categories = Counter()
    spans = {"EXTEND": [], "DECODE": []}
    atb = {}
    events = []
    trace_file = directory / "trace_view.json"
    if trace_file.is_file():
        with trace_file.open(encoding="utf-8-sig") as trace:
            events = json.load(trace)
        if isinstance(events, dict):
            events = events["traceEvents"]
        for event in events:
            if not isinstance(event, dict):
                continue
            name = str(event.get("name", ""))
            categories[str(event.get("cat", "?"))] += 1
            duration = number(event, "dur")
            if duration is not None and name.startswith("step["):
                for key in spans:
                    if key in name:
                        spans[key].append(duration)
            if name.startswith("atb::"):
                slot = atb.setdefault(name, {"name": name})
                add(slot, "count", 1)
                add(slot, "durationUs", duration)

    def total(items, key):
        values = [item[key] for item in items if key in item]
        return sum(values) if values else None

    def top(items, key, limit=15):
        return sorted((i for i in items if key in i), key=lambda i: i[key], reverse=True)[:limit]

    host_ops = {}
    for row in rows(directory / "operator_details.csv"):
        name = field(row, "Name")
        if not name:
            continue
        slot = host_ops.setdefault(name, {"name": name})
        add(slot, "count", 1)
        add(slot, "hostUs", number(row, "Host Self Duration(us)"))
    shapes = {}
    for row in rows(directory / "kernel_details.csv"):
        shape = field(row, "Input Shapes", "Input Shape")
        name = field(row, "Name", "Kernel Name")
        if shape and name:
            slot = shapes.setdefault((name, shape), {"name": name, "shape": shape})
            add(slot, "count", 1)
            add(slot, "durationUs", number(row, "Duration(us)", "Duration"))
    timeline = rank_timeline(events, rows(directory / "kernel_details.csv"))
    device_us = total(ops.values(), "deviceUs")
    by_core = {}
    for op in ops.values():
        core = op["core"]
        if core == "?" and source == "operator_details.csv":
            core = "AI_CORE" if op.get("aiCoreUs", 0) > 0 else (
                "DEVICE_OP" if op["name"].startswith(("atb::", "npu::", "aclnn", "Ascend")) else "HOST_OP")
            op["core"] = core
        slot = by_core.setdefault(core, {"core": core})
        add(slot, "count", op.get("count"))
        add(slot, "deviceUs", op.get("deviceUs"))
    def host_group(names):
        group = [op for op in ops.values() if op["name"] in names]
        return {"count": total(group, "count"), "hostUs": total(group, "hostUs")}
    def share(value, denominator):
        return value / denominator if value is not None and denominator else None
    wait = total(kernels.values(), "waitUs")
    duration = total(kernels.values(), "durationUs")
    device = bool(timeline["computeUs"] or timeline["communicationUs"] or kernel_count or (device_us or 0) > 0 or (stage["Computing"] or 0) > 0 or
                  any(categories[c] for c in ("Kernel", "AI Core", "AI_CPU", "AI CPU", "async_npu")))
    return {"directory": directory.relative_to(root).as_posix(), "deviceEvidence": device, "stageUs": stage,
            "operatorSource": source if ops else None, "operatorDeviceUs": device_us if device else None,
            "operatorHostUs": total(ops.values(), "hostUs") if source == "operator_details.csv" else total(host_ops.values(), "hostUs"), "topDevice": top(ops.values(), "deviceUs") if device else [],
            "topHost": top(host_ops.values(), "hostUs"), "operatorTypes": len(ops), "operatorInstances": total(ops.values(), "count"),
            "byCore": list(by_core.values()), "kernelCount": kernel_count or None, "kernelDurationUs": duration,
            "kernelWaitUs": wait, "smallKernels": small or None,
            "kernelWaitRatio": share(wait, wait + duration) if duration is not None and wait is not None else None,
            "freeStageRatio": share(stage["Free"], stage["Stage"]) if device else None,
            "computingStageRatio": share(stage["Computing"], stage["Stage"]) if device else None,
            "hostMetadata": host_group({"empty_tensor", "aten::as_strided", "aten::view", "aten::empty", "aten::empty_strided", "aten::copy_"}),
            "hostSync": host_group({"aten::_local_scalar_dense", "aten::nonzero", "aten::_unique"}),
            "topKernelWait": top(kernels.values(), "waitUs", 10), "traceCategories": dict(categories),
            "topShapes": top(shapes.values(), "durationUs"), "timeline": timeline,
            "stepSpansUs": spans, "atb": list(atb.values())}
