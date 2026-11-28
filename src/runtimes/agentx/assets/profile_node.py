"""Profiler filesystem and HTTP operations executed on the designated serving node."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
from urllib.error import HTTPError
from urllib.request import Request, build_opener
from engine_metrics import NoRedirect

root = Path(__file__).resolve().parent
destination = root / "trace"
action = sys.argv[1]
p = json.load(sys.stdin)
if action == "prepare":
    directory = Path(p["directory"]).resolve(strict=True)
    if not directory.is_dir() or not os.access(directory, os.R_OK | os.W_OK | os.X_OK):
        raise ValueError("Service trace directory is not accessible")
    trace = directory if p["fixed"] else Path(tempfile.mkdtemp(prefix="arsi-", dir=directory))
    if not p["fixed"]:
        trace.chmod(0o770)
    print(trace)
elif action == "check":
    subprocess.run([p["python"], "-B", str(root / "service_sampler.py"), "--check", json.dumps(p["config"])], check=True)
elif action == "baseline":
    with (destination / "existing-ranks.json").open("wb") as out:
        subprocess.run([sys.executable, "-B", str(root / "collect_profile.py"), "--snapshot", p["trace"]], check=True, stdout=out)
elif action == "http":
    headers = {"Content-Type": "application/json"}
    if p.get("key"):
        headers["Authorization"] = "Bearer " + p["key"]
    request = Request(p["url"], method="POST", headers=headers,
                      data=json.dumps(p["body"]).encode() if "body" in p else None)
    try:
        with build_opener(NoRedirect()).open(request, timeout=55) as response:
            print(response.status)
    except HTTPError as exc:
        print(exc.code)
elif action == "export":
    if p["full"]:
        (destination / "sampling-summary.json").write_text(json.dumps(p["resources"]))
    env = {**os.environ, "AGENTX_REDACT": p["key"], "AGENTX_FULL_PROFILE": "1" if p["full"] else ""}
    args = [sys.executable, "-B", str(root / "collect_profile.py"), p["trace"], str(destination), str(p["timeout"])]
    if p["baseline"]:
        args.append(str(destination / "existing-ranks.json"))
    if p.get("analysisPython"):
        args.append(p["analysisPython"])
    subprocess.run(args, env=env, check=True)
elif action == "cleanup":
    if root.parent != Path("/tmp") or not root.name.startswith("arsi-profile-"):
        raise ValueError("Invalid private profiler staging path")
    shutil.rmtree(root)
else:
    raise ValueError("Unknown service node operation")
