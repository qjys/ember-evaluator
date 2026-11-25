"""Single profiled request against the independently managed GR service."""
import json
import signal
import time

from profile_export import summarize_export


def wait_for_exports(root, timeout):
    deadline = time.monotonic() + timeout
    previous = None
    while time.monotonic() < deadline:
        exports = sorted(p for p in root.rglob("ASCEND_PROFILER_OUTPUT") if p.is_dir())
        if exports and all((p / "op_statistic.csv").is_file() or
                           ((p / "operator_details.csv").is_file() and (p / "trace_view.json").is_file())
                           for p in exports):
            sizes = [(f, f.stat().st_size, f.stat().st_mtime_ns)
                     for p in exports for f in sorted(p.iterdir()) if f.is_file()]
            if sizes == previous:
                return exports
            previous = sizes
        else:
            previous = None
        time.sleep(min(3, max(0, deadline - time.monotonic())))
    raise TimeoutError(f"profiler export unavailable at {root}; check shared mount and SGLANG_NPU_PROFILE_AUTO_EXPORT=1")


def capture(config, http, sample, output):
    root = output / "trace"
    root.mkdir()
    timeout = config["timeout"]

    def interrupted(sig, frame):
        raise InterruptedError("Profiling cancelled")

    signal.signal(signal.SIGTERM, interrupted)
    with (output / "session.jsonl").open("w", encoding="utf-8") as log:
        def request(phase):
            row = sample(phase, 0)  # gr-a2 always profiles the first prompt
            log.write(json.dumps(row, allow_nan=False) + "\n")
            log.flush()
            if row["error"] or row["status"] != "ok":
                raise RuntimeError(f"{phase} beam request failed: {row['error']}")
            return row

        probe = http("/debug/gr_counters")
        if probe.get("available") is False:
            raise RuntimeError("GR counters unavailable on profiling endpoint")
        for _ in range(5):
            if request("warmup")["e2eMs"] <= 1000:
                break
        http("/start_profile", {"output_dir": str(root), "activities": ["CPU", "NPU"],
                                "profile_by_stage": False, "with_stack": False, "record_shapes": True},
             timeout, parse=False)
        try:
            http("/debug/gr_counters?reset=true")
            row = request("profiled")
            counters = http("/debug/gr_counters")
        finally:
            http("/stop_profile", {}, timeout, parse=False)
    exports = [summarize_export(path, root) for path in wait_for_exports(root, config["exportTimeoutSeconds"])]
    return {"profiledE2eMs": row["e2eMs"], "deviceEvidence": all(e["deviceEvidence"] for e in exports),
            "exports": exports, "counters": {k: v for k, v in counters.items() if type(v) is int}}
