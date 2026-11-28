"""Archive the new rank with its native layout so offline analysis can be repeated."""
import gzip
import json
from pathlib import Path
import shutil
import stat


def category(path):
    name = path.name.lower()
    if "communication" in name or "hccl" in name:
        return "communication"
    if "memory" in name or "npu_module_mem" in name:
        return "allocator"
    if "l2_cache" in name:
        return "cache"
    if name.startswith(("api_statistic", "task_time")):
        return "runtime"
    if name.startswith(("kernel_details", "op_statistic", "operator_details")):
        return "operators"
    if name.startswith(("trace_view", "step_trace")):
        return "timeline"
    if name.endswith(".db"):
        return "database"
    return "native"


def includes_secret(path, needles):
    if not needles:
        return False
    keep = max(map(len, needles)) - 1
    carry = b""
    with path.open("rb") as stream:
        while chunk := stream.read(1024 * 1024):
            data = carry + chunk
            if any(key in data for key in needles):
                return True
            carry = data[-keep:] if keep else b""
    return False


def archive_frontend(path, destination, redactions):
    if path.resolve() != path or not path.is_file():
        raise ValueError("Invalid frontend profiler trace")
    target = destination / path.name
    opener = gzip.open if path.suffix == ".gz" else open
    if redactions:
        with opener(path, "rt", encoding="utf-8") as source, opener(target, "wt", encoding="utf-8") as output:
            for line in source:
                for key in redactions:
                    line = line.replace(key, "[REDACTED]")
                output.write(line)
    else:
        shutil.copyfile(path, target)
    return (Path("trace") / path.name).as_posix()


def archive_rank(output, root, destination, redactions):
    rank = output.parent if output.parent.name.endswith("_ascend_pt") else output
    base = destination / rank.relative_to(root)
    inventory = []
    needles = [key.encode() for key in redactions]
    for path in sorted(rank.rglob("*")):
        if path.is_symlink() or path.resolve() != path:
            raise ValueError("Unexpected symlink in Ascend profiler rank")
        if not stat.S_ISREG(path.stat().st_mode):
            continue
        relative = path.relative_to(rank)
        target = base / relative
        entry = {"path": relative.as_posix(), "category": category(path) if output in path.parents else "native"}
        inventory.append(entry)
        if includes_secret(path, needles):
            if path.suffix.lower() not in (".csv", ".json", ".log", ".txt"):
                entry["omitted"] = "credential in binary file"
                continue
            target.parent.mkdir(parents=True, exist_ok=True)
            with path.open(encoding="utf-8", newline="") as source, target.open("w", encoding="utf-8", newline="") as out:
                for line in source:
                    for key in redactions:
                        line = line.replace(key, "[REDACTED]")
                    out.write(line)
        else:
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(path, target)
        entry["bytes"] = target.stat().st_size
    manifest = base / "evaluator-artifacts.json"
    manifest.write_text(json.dumps(inventory, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return {"manifest": (Path("trace") / manifest.relative_to(destination)).as_posix(),
            "files": len([entry for entry in inventory if "bytes" in entry]),
            "omitted": sum("omitted" in entry for entry in inventory),
            "outputs": [entry["path"] for entry in inventory if "bytes" in entry and
                        (rank == output or entry["path"].startswith("ASCEND_PROFILER_OUTPUT/"))]}
