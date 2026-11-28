"""Service-side measurements coordinated with native AISBench request windows."""
import json
import math
from pathlib import Path
import re
import shutil
import signal
import time
from threading import Event, Thread
from urllib.error import HTTPError
from urllib.request import HTTPRedirectHandler, Request, build_opener
from uuid import uuid4

from profile_export import summarize_export


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, *args):
        return None  # Control requests and bearer tokens belong to the selected service.


def http(config, route, body=None):
    headers = {"Content-Type": "application/json"}
    if config.get("apiKey"):
        headers["Authorization"] = "Bearer " + config["apiKey"]
    request = Request(config["endpoint"].rstrip("/") + "/" + route, headers=headers,
                      data=json.dumps(body).encode() if body is not None else None)
    with build_opener(NoRedirect()).open(request, timeout=60) as response:
        return response.read().decode("utf-8")


# Preserve separate label sets; gauges only have before/after readings.
SAMPLE = re.compile(r'^([\w:]+)(\{(?:[^"{}]|"(?:[^"\\]|\\.)*")*\})?\s+(\S+)(?:\s+\S+)?$')


def scrape(config, names):
    counters, series = set(), {}
    for line in http(config, "metrics").splitlines():
        words = line.split()
        if len(words) == 4 and words[:2] == ["#", "TYPE"] and words[3] == "counter":
            counters.update([words[2], words[2] + "_total"])
        match = SAMPLE.fullmatch(line)
        if match and match[1] in names:
            value = float(match[3])
            if math.isfinite(value):
                series[match[1] + (match[2] or "")] = (match[1], value)
    return series, counters


def read_metrics(config, names):
    try:
        return scrape(config, names), None
    except (OSError, ValueError) as error:
        return ({}, set()), str(error)


def engine_result(names, before, after):
    (first, _), before_error = before
    (last, counters), after_error = after
    result = []
    missing = set(names)
    complete = True
    for series in sorted(first.keys() | last.keys()):
        name = (last.get(series) or first[series])[0]
        start = first.get(series, (None, None))[1]
        end = last.get(series, (None, None))[1]
        row = {"series": series, "before": start, "after": end}
        if start is not None and end is not None:
            missing.discard(name)
            if name in counters:
                row["delta"] = end - start if end >= start else None
                complete &= row["delta"] is not None
        else:
            complete = False
        result.append(row)
    return {"status": "measured" if complete and not missing and not before_error and not after_error else "partial",
            "series": result, "missing": sorted(missing), "errors": [e for e in (before_error, after_error) if e]}


class ServiceWindow:
    """Sample gauges while requests are active, preserving label sets and missing readings."""
    def __init__(self, config, names, directory):
        self.config, self.names, self.directory = config, names, directory
        self.stop = Event()
        self.before = read_metrics(config, names)
        self.summary = {}
        self.worker = Thread(target=self.sample, daemon=True)

    def sample(self):
        with (self.directory / "engine-series.jsonl").open("w", encoding="utf-8") as output:
            while not self.stop.is_set():
                (series, _), error = read_metrics(self.config, self.names)
                values = {}
                for label, (_, value) in series.items():
                    stats = self.summary.setdefault(label, {"count": 0, "sum": 0, "peak": value})
                    stats["count"] += 1
                    stats["sum"] += value
                    stats["peak"] = max(stats["peak"], value)
                    values[label] = value
                output.write(json.dumps({"time": time.time(), "values": values, "error": error}) + "\n")
                output.flush()
                self.stop.wait(1)

    def finish(self):
        self.stop.set()
        self.worker.join()
        result = engine_result(self.names, self.before, read_metrics(self.config, self.names))
        result["rawSeries"] = "engine-series.jsonl"
        result["window"] = {label: {"mean": s["sum"] / s["count"], "peak": s["peak"], "samples": s["count"]}
                            for label, s in self.summary.items()}
        return result


def wait_for_exports(root, timeout):
    deadline = time.monotonic() + timeout
    previous = None
    while True:
        exports = sorted(p for p in root.rglob("ASCEND_PROFILER_OUTPUT") if p.is_dir())
        for directory in exports:
            if directory.resolve() != directory or any(f.is_symlink() for f in directory.iterdir()):
                raise ValueError("Unexpected symlink in Ascend profiler export")
        if exports and all((p / "op_statistic.csv").is_file() or
                           ((p / "operator_details.csv").is_file() and (p / "trace_view.json").is_file())
                           for p in exports):
            snapshot = [(f, f.stat().st_size, f.stat().st_mtime_ns)
                        for p in exports for f in sorted(p.iterdir()) if f.is_file()]
            if snapshot == previous:
                return exports
            previous = snapshot
        else:
            previous = None
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise TimeoutError(f"No stable Ascend export at {root}; check the shared mount and NPU auto-export")
        time.sleep(min(1, remaining))


def verify_window(work, count=None):
    """AISBench may exit zero even when requests failed or a selected dataset is missing."""
    files = set(work.glob("**/performances/*/*.json"))
    if not files:
        raise ValueError("AISBench produced no performance report")
    for name in ("combos_manifest.json", "evaluator-expected.json"):
        for path in work.rglob(name):
            for pair in json.loads(path.read_text(encoding="utf-8"))["combos"]:
                expected = path.parent / "performances" / pair["model_abbr"] / (pair["dataset_abbr"] + ".json")
                if expected not in files:
                    raise ValueError(f"Missing AISBench report for {expected.name}")
    for path in files:
        report = json.loads(path.read_text(encoding="utf-8"))
        def requests(field):
            value = float(str(report[field]["total"]).split()[0])
            if not value.is_integer() or value < 0:
                raise ValueError(f"Invalid request count in {path.name}")
            return int(value)
        success = requests("Success Requests")
        if (success < 1 or requests("Failed Requests") != 0 or (count is not None and success != count)
                or ("Total Requests" in report and success != requests("Total Requests"))):
            raise ValueError(f"Incomplete AISBench requests in {path.name}")


def capture(config, trace, invoke):
    def interrupt(*_):
        signal.signal(signal.SIGTERM, signal.SIG_IGN)
        raise InterruptedError("AISBench profiling cancelled")

    previous = signal.signal(signal.SIGTERM, interrupt)
    try:
        # An interrupted/timed-out start may already have enabled the profiler.
        stop = True
        try:
            try:
                http(config, "start_profile", {"output_dir": str(trace), "activities": ["CPU", "NPU"],
                                              "profile_by_stage": False, "with_stack": False, "record_shapes": True})
            except HTTPError as error:
                stop = error.code >= 500
                raise RuntimeError(f"start_profile returned HTTP {error.code}") from error
            invoke()
        finally:
            if stop:
                try:
                    http(config, "stop_profile", {})
                except OSError as error:
                    raise RuntimeError(f"stop_profile unconfirmed; check profiler state on the service: {error}") from error
    finally:
        signal.signal(signal.SIGTERM, previous)


def bounded_window(options, count):
    result = {**options, "warmups": 0, "dataCount": [count],
              "options": {k: v for k, v in options.get("options", {}).items()
                          if k not in {"pressure", "no-pressure", "pressure-time"}}}
    result.pop("pressureSeconds", None)
    return result


def run_collections(config, run, selections, execute):
    native = config["native"]
    settings = native.get("profiling")
    metrics = native.get("engineMetrics")
    batches = native.get("concurrency", [1])
    profile_service = {**config, "endpoint": config.get("profileEndpoint", config["endpoint"]),
                       "apiKey": config.get("profileApiKey", config.get("apiKey", ""))}
    points, windows = [], []

    def save():
        (run / "collections.json").write_text(json.dumps({"points": points}, allow_nan=False), encoding="utf-8")

    def measure(service, options, work, name, datasets):
        code = execute({**service, "native": options}, name, datasets, work)
        if code:
            raise RuntimeError(f"AISBench exited with code {code}")

    def warmup(service, options, count, work, name, datasets):
        n = options.get("warmups", 1)
        if n:
            n = min(n, count or n)
            measure(service, bounded_window(options, n), work, name, datasets)
            verify_window(work, n)

    for name, datasets, output in selections:
        for index, batch in enumerate(batches):
            count = native["dataCount"][index] if "dataCount" in native else None
            options = {**native, "concurrency": [batch]}
            if count is not None:
                options["dataCount"] = [count]
            work = output / f"point-{index + 1}"
            point = {"dataset": name or ", ".join(d["name"] for d in native["datasets"]), "concurrency": batch,
                     "performanceDirectory": work.relative_to(run).as_posix()}
            points.append(point)
            if metrics:
                warmup(config, options, count, run / "warmup" / str(len(points)), name, datasets)
            before = read_metrics(config, metrics) if metrics else None
            measure(config, {**options, "warmups": 0} if metrics else options, work, name, datasets)
            if metrics:
                point["engine"] = engine_result(metrics, before, read_metrics(config, metrics))
            try:
                verify_window(work, None if native.get("pressureSeconds") or native.get("options", {}).get("pressure") else count)
                point["performanceStatus"] = "measured"
            except (ValueError, OSError, KeyError) as error:
                point.update(performanceStatus="partial", error=str(error))
            if settings:
                windows.append((point, options, name, datasets, count))
            save()

    skip = any(point["performanceStatus"] != "measured" for point in points)
    for index, (point, options, name, datasets, count) in enumerate(windows, start=1):
        profile = point["profiling"] = {"status": "skipped"}
        if skip:
            profile["error"] = "A previous measurement or profiler control failed"
            save()
            continue
        try:
            n = settings.get("requestsPerPoint", min(point["concurrency"], count or point["concurrency"]))
            if count is not None and n > count:
                raise ValueError("profiling.requestsPerPoint exceeds the available dataset")
            folder = run / "profiling" / f"point-{index}"
            warmup(profile_service, options, count, folder / "warmup", name, datasets)
            shared = Path(settings["traceDirectory"])
            shared.mkdir(parents=True, exist_ok=True)
            trace = shared.resolve() / ("aisbench-" + uuid4().hex)
            trace.mkdir()
            trace.chmod(0o770)  # The service may run as a different member of the shared group.
            profile.update(requestsPerPoint=n, traceDirectory=str(trace))
            capture(profile_service, trace, lambda: measure(profile_service, bounded_window(options, n), folder / "outputs", name, datasets))
            verify_window(folder / "outputs", n)
            exports = []
            for path in wait_for_exports(trace, settings.get("exportTimeoutSeconds", 1800)):
                summary = summarize_export(path, trace)
                artifact = folder / "trace" / path.relative_to(trace)
                artifact.mkdir(parents=True)
                for filename in ("step_trace_time.csv", "op_statistic.csv", "operator_details.csv", "kernel_details.csv", "trace_view.json"):
                    if (path / filename).is_file():
                        shutil.copyfile(path / filename, artifact / filename)
                exports.append({**summary, "artifactDirectory": artifact.relative_to(run).as_posix()})
            profile.update(status="measured" if all(e["deviceEvidence"] for e in exports) else "host-only", exports=exports)
        except InterruptedError:
            raise
        except (Exception, SystemExit) as error:
            profile.update(status="failed", error=f"{type(error).__name__}: {error}")
            skip = True
        save()
