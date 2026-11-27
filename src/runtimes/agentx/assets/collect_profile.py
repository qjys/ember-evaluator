"""Read stable server exports on the evaluator host, including Docker Harness runs."""
import json
from pathlib import Path
import os
import signal
import subprocess
import sys
import time

from profile_export import summarize_export


def rank_roots(root):
    # A previous, unanalysed rank may finish exporting during this window.
    return {p for p in root.rglob("*") if p.is_dir() and
            (p.name.endswith("_ascend_pt") or p.name == "ASCEND_PROFILER_OUTPUT")}


def analyse_rank(python, rank, deadline):
    program = "import sys; from torch_npu.profiler.profiler import analyse; analyse(sys.argv[1])"
    with subprocess.Popen([python, "-c", program, str(rank)], stdout=sys.stderr, stderr=sys.stderr,
                          start_new_session=os.name == "posix") as process:
        try:
            if process.wait(timeout=max(1, deadline - time.monotonic())):
                raise RuntimeError(f"torch_npu offline analysis failed for {rank.name}")
        finally:
            if process.poll() is None:
                if os.name == "posix":
                    os.killpg(process.pid, signal.SIGKILL)
                else:
                    process.kill()


def wait_for_exports(root, timeout, excluded=(), analysis_python=None):
    deadline = time.monotonic() + timeout
    previous = None
    analysed = set()
    first_seen = {}
    while True:
        current = {p for p in rank_roots(root) if p not in excluded and not any(parent in excluded for parent in p.parents)}
        ranks = {p for p in current if p.name.endswith("_ascend_pt")}
        for rank in sorted(ranks - analysed):
            if rank.resolve() != rank:
                raise ValueError("Unexpected symlink in Ascend profiler rank")
            ready = any(rank.glob("profiler_info*.json"))
            # Give the service-side exporter first opportunity to finish after stop_profile.
            if ready and time.monotonic() - first_seen.setdefault(rank, time.monotonic()) >= 2 and not (rank / "ASCEND_PROFILER_OUTPUT").exists():
                analysed.add(rank)
                analyse_rank(analysis_python or sys.executable, rank, deadline)
        exports = sorted(p for p in current if p.name == "ASCEND_PROFILER_OUTPUT")
        if any(not any(rank in p.parents for p in exports) for rank in ranks):
            exports = []
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


def collect(root, destination, timeout, excluded=(), analysis_python=None):
    secret = os.environ.get("AGENTX_REDACT")
    redact = {secret, json.dumps(secret)[1:-1], json.dumps(secret, ensure_ascii=False)[1:-1]} if secret else set()
    exports = []
    for path in wait_for_exports(root, timeout, excluded, analysis_python):
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
    ranked = [item for item in exports if item["timeline"]["exposedCommunicationUs"] is not None]
    worst = max(ranked, key=lambda item: item["timeline"]["exposedCommunicationUs"]) if ranked else None
    return {"worstRankByExposedCommunication": worst["artifactDirectory"] if worst else None,
            "status": "measured" if all(e["deviceEvidence"] for e in exports) else "host-only",
            "traceDirectory": str(root), "exports": exports}


if __name__ == "__main__":
    def cancel(_sig, _frame):
        raise KeyboardInterrupt()
    signal.signal(signal.SIGTERM, cancel)
    if sys.argv[1] == "--snapshot":
        print(json.dumps(sorted(str(p) for p in rank_roots(Path(sys.argv[2])))))
    else:
        baseline = set(map(Path, json.loads(Path(sys.argv[4]).read_text(encoding="utf-8")))) if len(sys.argv) > 4 else set()
        print(json.dumps(collect(Path(sys.argv[1]), Path(sys.argv[2]), int(sys.argv[3]), baseline,
                                 sys.argv[5] if len(sys.argv) > 5 else None), allow_nan=False))
