"""Service-node diagnostic sampling. EOF on stdin ends this measurement window."""
import csv
import json
import math
import os
from pathlib import Path
import re
import shutil
import signal
import subprocess
import sys
from threading import Event, Thread
import time
from urllib.request import build_opener

from ascend_metrics import parse_readings
from engine_metrics import NoRedirect, parse_samples
from host_resources import DISK_COUNTERS, NETWORK_COUNTERS, host_reader


def chip_mapping(physical):
    result = subprocess.run(["npu-smi", "info", "-m"], capture_output=True, check=True, text=True, timeout=10)
    mapping = {}
    for line in result.stdout.splitlines():
        match = re.match(r"^\s*(\d+)\s+\d+\s+(\d+)\s+", line)
        if match and int(match[1]) in physical:
            mapping[int(match[2])] = int(match[1])
    if set(mapping.values()) != set(physical):
        raise ValueError("Cannot resolve every requested physical NPU using npu-smi info -m")
    return mapping


def metric_column(name, preset, table):
    key = name.lower()
    if preset == "full":
        return metric_column(name, "bandwidth", table) or metric_column(name, "cache", table)
    if preset == "compute":
        return any(s in key for s in ("cube", "mac", "vec", "mte")) and ("ratio" in key or "(%)" in key)
    if preset == "cache":
        return (key.endswith(("_cache_hit", "_cache_miss_allocate", "_local_l2_hit", "_local_l2_miss")) or
                ("l2" in key or "l2" in table) and "hit" in key and any(s in key for s in ("rate", "ratio", "%")))
    return ("hbm" in key or "hbm" in table) and any(s in key for s in ("mb/s", "gb/s", "mbps", "gbps"))


def counter_exports(root, preset, mapping):
    stats = {chip: {} for chip in mapping}
    for path in sorted(root.rglob("*.csv")):
        if path.is_symlink():
            continue
        table = re.sub(r"_\d{14}$", "", path.stem)
        with path.open(encoding="utf-8-sig", newline="") as source:
            for row in csv.DictReader(source):
                ident = next((v.strip() for k, v in row.items() if k and k.strip().lower() in
                              ("device id", "device_id", "deviceid") and v), "")
                if not ident.isdigit() or int(ident) not in mapping:
                    continue
                for column, raw in row.items():
                    if not column or not metric_column(column, preset, path.stem.lower()):
                        continue
                    try:
                        value = float(raw)
                    except (ValueError, TypeError):
                        continue
                    if not math.isfinite(value):
                        continue
                    # CANN emits separate AIC and AIV files, and HBM summary and channel rows.
                    # Keep their scopes distinct even when the column names match.
                    scope = "/".join([table, row["Metric"].strip()]) if row.get("Metric") else table
                    metric = scope + "/" + column
                    slot = stats[int(ident)].setdefault(metric, {"sum": 0, "count": 0, "max": value,
                                                                 "source": path.relative_to(root).as_posix()})
                    slot["sum"] += value
                    slot["count"] += 1
                    slot["max"] = max(slot["max"], value)
    exports = []
    for chip, metrics in stats.items():
        for slot in metrics.values():
            slot["mean"] = slot["sum"] / slot["count"]
        fractions = {}
        if preset in ("cache", "full"):
            for name, hits in metrics.items():
                if not name.endswith("_cache_hit"):
                    continue
                misses = metrics.get(name.removesuffix("_hit") + "_miss_allocate")
                if misses and hits["count"] == misses["count"]:
                    denominator = hits["sum"] + misses["sum"]
                    fractions[name.removesuffix("_cache_hit")] = hits["sum"] / denominator if denominator else None
        exports.append({"deviceEvidence": bool(metrics), "physicalDevice": mapping[chip], "logicalDevice": chip,
                        "artifactDirectory": "trace/msprof", "counters": metrics, "hitOverHitsAndMissAllocations": fractions})
    return exports


def local_reader(devices):
    from local_telemetry import discover_chips
    targets = []
    if devices:
        try:
            inventory = subprocess.run(["npu-smi", "info", "-m"], capture_output=True, check=True, text=True, timeout=5).stdout
            targets = [(device, chip) for device in devices for chip in discover_chips(inventory, device)]
        except (OSError, ValueError, subprocess.SubprocessError):
            pass
    expected = {"host_memory_available_bytes", "host_cpu_busy_percent", *NETWORK_COUNTERS, *DISK_COUNTERS}
    read_host = host_reader()
    device_fields = ("ascend_npu_hbm_usage_percent", "ascend_npu_utilization_percent", "ascend_npu_hbm_capacity_megabytes")
    for device in devices:
        expected.update(name + '{device="%d",chip="%d"}' % (device, chip)
                        for name in device_fields for chip in ([c for d, c in targets if d == device] or [0]))

    def read():
        values, counters = read_host()
        for device, chip in targets:
            try:
                result = subprocess.run(["npu-smi", "info", "-t", "usages", "-i", str(device), "-c", str(chip)],
                                        capture_output=True, check=True, text=True, timeout=3)
                readings = parse_readings(result.stdout)
            except (OSError, ValueError, subprocess.SubprocessError):
                continue
            for name, value in readings.items():
                values[name + '{device="%d",chip="%d"}' % (device, chip)] = (name, value)
        return values, counters

    return read, expected


def sample_series(read, names, endpoint, output_path, stopped, result):
    series = {}
    errors = 0
    result.update(endpoint=endpoint, rawSeries="trace/" + output_path.name)
    with output_path.open("w", encoding="utf-8") as output:
        while True:
            now = time.time_ns()
            sampled_at = time.monotonic_ns()
            try:
                values, counters = read()
                for label, (name, value) in values.items():
                    row = series.setdefault(label, {"name": name, "count": 0, "sum": 0, "peak": value,
                                                    "first": value, "counter": name in counters, "reset": False,
                                                    "firstNs": sampled_at})
                    row["reset"] |= row["counter"] and value < row.get("last", value)
                    row.update(count=row["count"] + 1, sum=row["sum"] + value, last=value,
                               lastNs=sampled_at, peak=max(row["peak"], value))
                sample = {key: value for key, (_, value) in values.items()}
            except (OSError, ValueError, subprocess.SubprocessError):
                errors += 1
                sample = None
            output.write(json.dumps({"timestampNs": str(now), "values": sample}) + "\n")
            output.flush()
            if stopped.wait(1):
                break
    missing = set(names) - {v["name"] for v in series.values()} - series.keys()
    for row in series.values():
        total = row.pop("sum")
        seconds = (row.pop("lastNs") - row.pop("firstNs")) / 1e9
        if row["counter"]:
            row["delta"] = None if row["reset"] or row["count"] < 2 else row["last"] - row["first"]
            row["ratePerSecond"] = row["delta"] / seconds if row["delta"] is not None and seconds > 0 else None
        else:
            row["mean"] = total / row["count"]
    incomplete = errors or missing or any(r["counter"] and r["delta"] is None for r in series.values())
    result.update(status="partial" if incomplete else "measured", errors=errors, missing=sorted(missing), series=series)


def run(config):
    root = Path(config["destination"])
    preset = config.get("preset", "timeline")
    stopped = Event()
    def wait_for_stop():
        while os.read(0, 4096):
            pass
        stopped.set()
    Thread(target=wait_for_stop, daemon=True).start()
    proc = None
    workers = []
    result = {"preset": preset, "traceDirectory": str(root)}
    try:
        if preset != "timeline" and config.get("devices"):
            try:
                mapping = chip_mapping(config["devices"])
                raw = root / "msprof"
                raw.mkdir()
                flags = ["--sys-period=86400", "--sys-devices=" + ",".join(map(str, mapping)), "--output=" + str(raw)]
                if preset in ("bandwidth", "full"):
                    flags += ["--sys-hardware-mem=on"]
                if preset != "bandwidth":
                    group = "PipeUtilization" if preset == "compute" else "L2Cache"
                    flags += ["--ai-core=on", "--aic-mode=sample-based", "--aic-freq=10", "--aic-metrics=" + group]
                with (root / "msprof.log").open("w") as log:
                    proc = subprocess.Popen(["msprof", *flags], stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
                if stopped.wait(1) or proc.poll() is not None:
                    raise RuntimeError("msprof did not start; inspect trace/msprof.log")
            except (OSError, ValueError, RuntimeError, subprocess.SubprocessError) as exc:
                if preset != "full":
                    raise
                result["counterError"] = str(exc)
        def start_reader(key, read, names, endpoint, filename):
            result[key] = {}
            worker = Thread(target=sample_series, args=(read, names, endpoint, root / filename, stopped, result[key]))
            workers.append(worker)
            worker.start()
        if config.get("devices") or config.get("localHost"):
            read, names = local_reader(config.get("devices") or [])
            start_reader("localMetrics", read, names, os.uname().nodename, "local-metrics.jsonl")
        if config.get("nodeMetrics"):
            node = config["nodeMetrics"]
            def read_exporter():
                with build_opener(NoRedirect()).open(node["endpoint"], timeout=3) as response:
                    return parse_samples(response.read().decode(), node["names"])
            start_reader("nodeMetrics", read_exporter, node["names"], node["endpoint"], "node-metrics.jsonl")
        print("ready", flush=True)
        stopped.wait()
        if proc is not None and proc.poll() is not None:
            if preset != "full":
                raise RuntimeError("msprof exited before the diagnostic finished; inspect trace/msprof.log")
            result["counterError"] = "msprof exited before replay finished; inspect trace/msprof.log"
    finally:
        stopped.set()
        for worker in workers:
            worker.join()
        if proc and proc.poll() is None:
            os.killpg(proc.pid, signal.SIGINT)
            try:
                proc.wait(timeout=60)
            except subprocess.TimeoutExpired:
                os.killpg(proc.pid, signal.SIGKILL)
                proc.wait()
                if preset != "full":
                    raise RuntimeError("msprof failed to stop and export within 60 seconds")
                result["counterError"] = "msprof export timed out"
    if proc and "counterError" not in result:
        try:
            for capture in raw.glob("PROF_*"):
                if capture.is_dir() and not any(capture.rglob("*.csv")):
                    with (root / "msprof.log").open("a") as log:
                        subprocess.run(["msprof", "--export=on", "--output=" + str(capture)], stdout=log,
                                       stderr=subprocess.STDOUT, timeout=180, check=True)
            exports = counter_exports(raw, preset, mapping)
            if preset == "full":
                result["hardwareExports"] = exports
            else:
                result.update(exports=exports, status="measured" if all(r["deviceEvidence"] for r in exports) else "partial")
        except (OSError, ValueError, subprocess.SubprocessError) as exc:
            if preset != "full":
                raise
            result["counterError"] = str(exc)
    print(json.dumps(result, allow_nan=False), flush=True)


if __name__ == "__main__":
    if sys.argv[1] == "--check":
        config = json.loads(sys.argv[2])
        chip_mapping(config["devices"])
        if config["preset"] != "timeline" and not shutil.which("msprof"):
            raise RuntimeError("msprof is missing on the serving host; initialize the CANN environment")
    else:
        run(json.loads(sys.argv[1]))
