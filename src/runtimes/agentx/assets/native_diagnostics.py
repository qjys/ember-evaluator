"""Extract typed optimization evidence from torch_npu's native rank exports."""
from contextlib import closing
import json
import math
import re
import sqlite3


def update_stat(stats, name, raw):
    try:
        value = float(raw)
    except (ValueError, TypeError):
        return
    if not math.isfinite(value):
        return
    stat = stats.setdefault(name, {"count": 0, "sum": 0, "max": value})
    stat["count"] += 1
    stat["sum"] += value
    stat["max"] = max(stat["max"], value)


def finish_stats(stats):
    for stat in stats.values():
        stat["mean"] = stat.pop("sum") / stat["count"]
    return stats


def hbm_channels(directory):
    channels = []
    errors = []
    for path in sorted(directory.glob("ascend_pytorch_profiler*.db")):
        try:
            with closing(sqlite3.connect(path.as_uri() + "?mode=ro&immutable=1", uri=True)) as db:
                db.execute("PRAGMA trusted_schema=OFF")
                tables = {r[0] for r in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
                if not {"HBM", "STRING_IDS"}.issubset(tables):
                    continue
                # CANN HBM.bandwidth is bytes/s. STRING_IDS keys are local to each rank database.
                for device, lane, direction, count, mean, peak in db.execute(
                    "SELECT h.deviceId,h.hbmId,s.value,count(h.bandwidth),avg(h.bandwidth),max(h.bandwidth) "
                    "FROM HBM h JOIN STRING_IDS s ON s.id=h.type WHERE lower(s.value) IN ('read','write') "
                    "AND typeof(h.bandwidth) IN ('integer','real') GROUP BY h.deviceId,h.hbmId,s.value ORDER BY 1,2,3"):
                    channels.append({"device": device, "channel": lane, "direction": direction, "count": count,
                                     "meanMBps": mean / 1e6, "peakMBps": peak / 1e6, "source": path.name})
        except sqlite3.Error as error:
            errors.append(path.name + ": " + str(error))
    return channels, errors


def communication(directory):
    links = []
    calls = {}
    errors = []
    for filename in ("communication.json", "communication_matrix.json"):
        path = directory / filename
        if not path.is_file():
            continue
        try:
            data = json.loads(path.read_text(encoding="utf-8-sig"))
            if not isinstance(data, dict):
                raise ValueError("expected steps keyed by name")
        except (UnicodeError, ValueError) as exc:
            errors.append(filename + ": " + str(exc))
            continue
        for step, groups in data.items():
            if not isinstance(groups, dict):
                continue
            for group in ("collective", "p2p"):
                entries = groups.get(group, {})
                if not isinstance(entries, dict):
                    continue
                has_totals = any("-total@" in key.lower() for key in entries)
                for op, record in entries.items():
                    if not isinstance(record, dict):
                        continue
                    if filename == "communication.json":
                        if op == "Total Op Info":
                            continue
                        timing = record.get("Communication Time Info", {})
                        for name in ("Elapse Time(ms)", "Transit Time(ms)", "Wait Time(ms)", "Synchronization Time(ms)"):
                            update_stat(calls, group + "/" + name, timing.get(name))
                    elif "-total@" in op.lower() or not has_totals:
                        # Exporters provide either native totals or individual operations. Exclude top/bottom exemplars.
                        if re.search(r"-(top\d+|bottom\d+|middle)@", op, re.I):
                            continue
                        for pair, info in record.items():
                            if not re.fullmatch(r"\d+-\d+", pair) or not isinstance(info, dict):
                                continue
                            links.append({"step": step, "op": op, "pair": pair, "transport": info.get("Transport Type"),
                                          "sizeMB": info.get("Transit Size(MB)"), "timeMs": info.get("Transit Time(ms)"),
                                          "bandwidthGBps": info.get("Bandwidth(GB/s)")})
    remote_links = sum(1 for link in links if len(set(link["pair"].split("-"))) > 1)
    return {"timeMs": finish_stats(calls), "interRankLinks": remote_links, "errors": errors,
            "links": sorted(links, key=lambda r: r["timeMs"] or 0, reverse=True)[:32]}


def native_evidence(directory, rows, pmu):
    memory = {}
    for row in rows(directory / "memory_record.csv"):
        for key in ("total allocated(mb)", "total reserved(mb)", "total active(mb)"):
            update_stat(memory, "/".join((row.get("device type") or "?", row.get("component") or "?", key)), row.get(key))
    l2 = {}
    for row in rows(directory / "l2_cache.csv"):
        for name, value in row.items():
            if "hit" in name or "miss" in name:
                update_stat(l2, name, value)
    hbm, errors = hbm_channels(directory)
    return {"pipeline": finish_stats(pmu), "allocatorMB": finish_stats(memory), "l2Cache": finish_stats(l2),
            "hbmChannels": hbm, "databaseErrors": errors, "communication": communication(directory)}
