"""Read stable server exports on the evaluator host, including Docker Harness runs."""
import json
from pathlib import Path
import os
import sys
import time

from profile_export import summarize_export


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


def collect(root, destination, timeout):
    secret = os.environ.get("AGENTX_REDACT")
    redact = {secret, json.dumps(secret)[1:-1], json.dumps(secret, ensure_ascii=False)[1:-1]} if secret else set()
    exports = []
    for path in wait_for_exports(root, timeout):
        target = destination / path.relative_to(root)
        target.mkdir(parents=True, exist_ok=True)
        for name in ("step_trace_time.csv", "op_statistic.csv", "operator_details.csv", "kernel_details.csv", "trace_view.json"):
            if (path / name).is_file():
                with (path / name).open(encoding="utf-8", newline="") as source, (target / name).open("w", encoding="utf-8", newline="") as out:
                    for line in source:
                        for value in redact:
                            line = line.replace(value, "[REDACTED]")
                        out.write(line)
        summary = summarize_export(target, destination)
        exports.append({**summary, "artifactDirectory": (Path("trace") / path.relative_to(root)).as_posix()})
    return {"status": "measured" if all(e["deviceEvidence"] for e in exports) else "host-only",
            "traceDirectory": str(root), "exports": exports}


if __name__ == "__main__":
    print(json.dumps(collect(Path(sys.argv[1]), Path(sys.argv[2]), int(sys.argv[3])), allow_nan=False))
