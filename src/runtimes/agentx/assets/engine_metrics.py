"""Authenticated service metrics for AgentX replay and official standard phase windows."""
from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import math
import re
from threading import Thread
from urllib.request import HTTPRedirectHandler, Request, build_opener


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, *args):
        return None  # Control requests and bearer tokens belong to the selected service.


def get_metrics(config):
    headers = {}
    if config.get("apiKey"):
        headers["Authorization"] = "Bearer " + config["apiKey"]
    request = Request(config["endpoint"].rstrip("/") + "/metrics", headers=headers)
    with build_opener(NoRedirect()).open(request, timeout=60) as response:
        return response.read().decode("utf-8")


# Preserve separate label sets; gauges only have before/after readings.
SAMPLE = re.compile(r'^([\w:]+)(\{(?:[^"{}]|"(?:[^"\\]|\\.)*")*\})?\s+(\S+)(?:\s+\S+)?$')


def declared_counters(content):
    counters = set()
    for line in content.splitlines():
        words = line.split()
        if len(words) == 4 and words[:2] == ["#", "TYPE"] and words[3] == "counter":
            counters.update([words[2], words[2] + "_total"])
    return counters


def parse_samples(content, names):
    series = {}
    for line in content.splitlines():
        match = SAMPLE.fullmatch(line)
        if match and match[1] in names:
            value = float(match[3])
            if math.isfinite(value):
                series[match[1] + (match[2] or "")] = (match[1], value)
    return series, declared_counters(content)


def read_metrics(config, names):
    try:
        return parse_samples(get_metrics(config), names), None
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


@contextmanager
def standard_metrics_source(config):
    # The pinned Harness scrapes anonymous endpoints. Keep the bearer token in
    # the bridge and let the Harness collect its own warmup and formal phases.
    counters = set()

    class Proxy(BaseHTTPRequestHandler):
        def do_GET(self):
            if self.path != "/metrics":
                self.send_error(404)
                return
            try:
                content = get_metrics(config)
                counters.update(declared_counters(content))
            except (OSError, ValueError):
                self.send_error(502)
                return
            self.send_response(200)
            self.send_header("Content-Type", "text/plain; version=0.0.4")
            self.end_headers()
            self.wfile.write(content.encode())

        def log_message(self, *args):
            pass

    with ThreadingHTTPServer(("127.0.0.1", 0), Proxy) as server:
        worker = Thread(target=server.serve_forever, daemon=True)
        worker.start()
        try:
            yield f"http://127.0.0.1:{server.server_port}/metrics", counters
        finally:
            server.shutdown()
            worker.join()


def standard_engine_result(artifacts, endpoint, names, declared):
    """Use the Harness phase timestamps to exclude its mandatory standard warmup."""
    try:
        summary_file, = artifacts.rglob("server_metrics_export.json")
        summary = json.loads(summary_file.read_text(encoding="utf-8"))
        window = summary["summary"]["phase_time_ranges"]["profiling"]
        start, end = int(window["start_ns"]), int(window["end_ns"])
        source_file, = artifacts.rglob("server_metrics_export.jsonl")
        first, last, counters = {}, {}, set()
        samples_seen = 0
        resets = set()
        aggregates = {}
        previous_values = {}
        with source_file.open(encoding="utf-8") as source:
            for line in source:
                row = json.loads(line)
                timestamp = int(row["timestamp_ns"])
                if row["endpoint_url"] != endpoint or not start <= timestamp <= end:
                    continue
                samples_seen += 1
                snapshot = {}
                for field, samples in row.get("metrics", {}).items():
                    counter = field in declared or summary.get("metrics", {}).get(field, {}).get("type") == "counter"
                    name = field if field in names else field + "_total" if counter else field
                    if name not in names:
                        continue
                    if counter:
                        counters.add(name)
                    for sample in samples:
                        value = sample["value"]
                        if not isinstance(value, (int, float)) or not math.isfinite(value):
                            continue
                        labels = ",".join(k + "=" + json.dumps(v) for k, v in sorted((sample.get("labels") or {}).items()))
                        series = name + ("{" + labels + "}" if labels else "")
                        snapshot[series] = (name, value)
                        agg = aggregates.setdefault(series, {"samples": 0, "sum": 0, "peak": value})
                        agg["samples"] += 1
                        agg["sum"] += value
                        agg["peak"] = max(agg["peak"], value)
                        previous_value = previous_values.get(series)
                        previous_values[series] = value
                        if counter and previous_value is not None and previous_value > value:
                            resets.add(series)
                if samples_seen == 1:
                    first = snapshot
                last = snapshot
        if samples_seen < 2:
            last = {}
        result = engine_result(names, ((first, counters), None), ((last, counters), None))
        series_by_name = {row["series"]: row for row in result["series"]}
        for key, agg in aggregates.items():
            if key not in series_by_name:
                row = {"series": key, "before": None, "after": None}
                result["series"].append(row)
            else:
                row = series_by_name[key]
            row["samples"] = agg["samples"]
            if key.split("{", 1)[0] not in counters:
                row.update(mean=agg["sum"] / agg["samples"], peak=agg["peak"])
            if agg["samples"] < samples_seen:
                result["status"] = "partial"
        result.update(rawSeries=source_file.relative_to(artifacts).as_posix(),
                      window={"startNs": str(start), "endNs": str(end)}, samples=samples_seen)
        for series in result["series"]:
            if series["series"] in resets:
                result["status"] = "partial"
                series["delta"] = None
        return result
    except (OSError, ValueError, KeyError, TypeError):
        return {"status": "partial", "series": [], "missing": names, "errors": ["Missing or invalid AgentX engine metric export"]}
