import base64
import ast
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import time

runner = Path(sys.argv[1]).resolve()
# Exercise the vendored command/config patches without importing its heavy dependencies.
upstream = runner.parent / "upstream/aisbench_test.py"
tree = ast.parse(upstream.read_text())
functions = [node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name in {"generate_aisbench_command", "run_aisbench", "modify_aisbench_api"}]
namespace = {"subprocess": subprocess, "OUTPUT_DIR": "/tmp/path with spaces", "os": os,
             "request_rate": "0", "api_test_type": "VLLMCustomAPIChatStream", "api_test_abbr": "fixture",
             "MODEL_PATH": "/tmp/tokenizer", "MODEL_NAME": "quoted'\\model", "API_KEY": "secret'\\key",
             "HOST_IP": "localhost", "HOST_PORT": "8000", "URL": "http://localhost:8000/v1"}
exec(compile(ast.Module(body=functions, type_ignores=[]), str(upstream), "exec"), namespace)
assert isinstance(namespace["generate_aisbench_command"]("default_perf"), list)
with tempfile.TemporaryDirectory(prefix="aisbench-remote-") as temp:
    root = Path(temp)
    old_cwd = os.getcwd()
    os.chdir(root)
    namespace.update(WORK_PATH=str(root), symlink_force=lambda *_: None)
    namespace["modify_aisbench_api"]("2", "4")
    compiled = (root / "temp_api.py").read_text()
    assert repr(namespace["API_KEY"]) in compiled
    ast.parse(compiled)
    try:
        namespace["run_aisbench"]([sys.executable, "-c", "import sys;sys.exit(7)"])
        raise AssertionError("CLI failure was swallowed")
    except subprocess.CalledProcessError as error:
        assert error.returncode == 7
    os.chdir(old_cwd)
    bundle = root / "bundle"
    bundle.mkdir()
    shutil.copy2(runner, bundle / "remote.py")
    (bundle / "upstream").mkdir()
    (bundle / "upstream/aisbench_test.py").write_text(
        "import config,time,sys,pathlib\n"
        "pathlib.Path(config.WORK_PATH+'/ais_bench/datasets/marker').write_text('changed')\n"
        "print('secret='+config.API_KEY,flush=True)\n"
        "time.sleep(1 if config.MODEL_NAME != 'slow' else 30)\n"
        "open('aisbench_result.csv','w').write('total_req,qps\\n4,2\\n')\n"
        "sys.exit(7 if config.MODEL_NAME == 'fail' else 0)\n")
    fake = root / "install"
    package = fake / "ais_bench"
    (package / "benchmark/configs").mkdir(parents=True)
    (package / "benchmark/datasets").mkdir()
    (package / "datasets").mkdir()
    (package / "datasets/marker").write_text("untouched")
    (package / "__init__.py").write_text("")
    (package / "benchmark/__init__.py").write_text("")
    (fake / "ais_bench_benchmark-1.0.dist-info").mkdir()
    (fake / "ais_bench_benchmark-1.0.dist-info/METADATA").write_text("Name: ais-bench-benchmark\nVersion: 1.0\n")
    (fake / "transformers.py").write_text("class AutoTokenizer:\n @staticmethod\n def from_pretrained(path): return object()\n")
    for name in ["torch", "pandas", "requests"]:
        (fake / (name + ".py")).write_text("")
    (fake / "ais_bench_cli").mkdir()
    cli = fake / "ais_bench_cli/ais_bench"
    cli.write_text("#!/bin/sh\nexit 0\n")
    cli.chmod(0o700)
    env = {**os.environ, "PYTHONPATH": str(fake), "PATH": str(cli.parent) + os.pathsep + os.environ.get("PATH", "")}
    def call(action, job="job", **kwargs):
        request = {"action": action, "jobDir": str(root / job), "fingerprint": "a" * 64, **kwargs}
        proc = subprocess.run([sys.executable, str(bundle / "remote.py")], input=json.dumps(request), text=True, capture_output=True, env=env)
        if proc.returncode:
            raise RuntimeError(proc.stdout + proc.stderr)
        return json.loads(proc.stdout)
    config = {"pythonExecutable": sys.executable, "aisbenchWorkPath": str(fake), "aisbenchVersion": "1.0", "tokenizerPath": str(root), "endpoint": "http://localhost:8000/v1", "model": "ok", "apiKey": "SECRET-NEVER-EXPORT", "workload": {"inputLength": 16, "outputLength": 4, "dataCount": 4, "concurrency": 2, "requestRate": 0}}
    first = call("start", config=config)
    assert first["state"] == "running", first
    second = call("start", config=config)
    assert second["state"] == "running", second
    try:
        call("manifest")
        raise AssertionError("running artifacts accepted")
    except RuntimeError:
        pass
    def wait(job):
        for _ in range(100):
            status = call("status", job)
            if status["state"] != "running": return status
            time.sleep(.1)
        raise AssertionError("job did not stop")
    assert wait("job")["state"] == "completed"
    assert (package / "datasets/marker").read_text() == "untouched", "shared installation mutated"
    files = call("manifest")["files"]
    assert "aisbench_result.csv" in [f["path"] for f in files], files
    for entry in files:
        data = base64.b64decode(call("read", path=entry["path"], offset=0, length=262144)["data"])
        assert hashlib.sha256(data).hexdigest() == entry["sha256"]
        assert b"SECRET-NEVER-EXPORT" not in data
    assert call("start", config=config)["state"] == "completed"
    for request in [{"fingerprint": "b" * 64}, {"path": "../private.json"}]:
        try:
            call("read" if "path" in request else "status", **request)
            raise AssertionError("unsafe request accepted")
        except RuntimeError:
            pass
    call("start", "failed", config={**config,"model":"fail"}, restartToken="attempt-1")
    assert wait("failed")["exitCode"] == 7
    assert call("start", "failed", config={**config,"model":"fail"}, restartToken="attempt-1")["state"] == "failed"
    assert call("start", "failed", config=config, restartToken="attempt-2")["state"] == "running"
    assert wait("failed")["state"] == "completed"
    owned = root / "failed/generated-input"
    owned.mkdir()
    (owned / "dataset.jsonl").write_text("{}")
    call("release-generated-input", "failed")
    call("release-generated-input", "failed")
    assert not owned.exists() and (root / "failed/artifacts").is_dir()
    call("start", "slow", config={**config,"model":"slow"})
    time.sleep(.3)
    assert call("cancel", "slow")["state"] == "cancelled"
    assert not (root / "slow/private.json").exists()
    broken = root / "collection-error"
    (broken / "artifacts").mkdir(parents=True)
    (broken / "private.json").write_text(json.dumps(config))
    (broken / "state.json").write_text(json.dumps({"state":"running","fingerprint":"a"*64,"exitCode":None}))
    code = "import runpy,sys,pathlib;ns=runpy.run_path(sys.argv[1]);ns['supervise'].__globals__['collect']=lambda *args: (_ for _ in ()).throw(OSError('collection failed'));ns['supervise'](pathlib.Path(sys.argv[2]))"
    subprocess.run([sys.executable, "-c", code, str(bundle / "remote.py"), str(broken)], env=env, check=True, timeout=10)
    assert json.loads((broken / "state.json").read_text())["state"] == "failed"
    assert not (broken / "private.json").exists()
    assert not (broken / "run").exists()
    print(json.dumps({"passed": True, "files": len(files)}))
