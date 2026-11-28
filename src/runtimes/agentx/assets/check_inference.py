"""Read-only service and filesystem probes for the evaluator doctor command."""
from importlib.metadata import version
import json
import os
from pathlib import Path
import re
import subprocess
import sys
from urllib.request import Request, build_opener, HTTPRedirectHandler


class DirectRequests(HTTPRedirectHandler):
    def redirect_request(self, *args):
        return None


def main():
    config = json.load(sys.stdin)
    root = re.sub(r"(/v1)?(/chat/completions)?/?$", "", config["endpoint"].rstrip("/"))
    headers = {"Authorization": "Bearer " + config["key"]} if config.get("key") else {}
    def get(path):
        with build_opener(DirectRequests()).open(Request(root + path, headers=headers), timeout=10) as response:
            return json.load(response)
    if config["model"] not in [model.get("id") for model in get("/v1/models").get("data", [])]:
        raise ValueError("Selected model is absent from /v1/models")
    for name in config.get("paths", []):
        if not os.access(name, os.R_OK):
            raise ValueError("Cannot read " + name)
    if config.get("version") and version("ais-bench-benchmark") != config["version"]:
        raise ValueError("AISBench installation version mismatch")
    if "trace" in config:
        path = Path(config["trace"])
        if not path.is_dir() or not os.access(path, os.R_OK | os.W_OK | os.X_OK):
            raise ValueError("Profiler trace directory is not readable and writable: " + str(path))
        routes = get("/openapi.json").get("paths", {})
        for route in ("/start_profile", "/stop_profile"):
            if "post" not in routes.get(route, {}):
                raise ValueError("Service does not advertise POST " + route)
        if config.get("devices"):
            interpreter = config.get("samplerPython") or sys.executable
            program = ("import subprocess; print(subprocess.check_output(['npu-smi','info','-m'],text=True))")
            output = subprocess.check_output([interpreter, "-c", program], text=True)
            visible = {int(m[1]) for line in output.splitlines() if (m := re.match(r"^\s*(\d+)\s+\d+\s+\d+\s+", line))}
            if set(config["devices"]) - visible:
                raise ValueError("Physical NPU IDs are missing from the service node inventory")
            if config.get("preset") in ["full", "compute", "bandwidth", "cache"]:
                subprocess.run([interpreter, "-c", "import shutil,sys; sys.exit(0 if shutil.which('msprof') else 'msprof missing on serving node')"], check=True)
        if config.get("analysisPython"):
            subprocess.run([config["analysisPython"], "-c", "from torch_npu.profiler.profiler import analyse"], check=True)


if __name__ == "__main__":
    main()
