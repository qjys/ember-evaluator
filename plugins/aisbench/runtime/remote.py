"""One-request SSH control protocol; Linux-only, stdlib-only supervisor."""
import base64
import fcntl
import hashlib
import html
import importlib.metadata
import json
import os
from pathlib import Path
import shutil
import signal
import subprocess
import sys
import threading
import time
from urllib.parse import urlsplit

TERMINAL = {"completed", "failed", "cancelled"}


def atomic(path, value):
    temp = path.with_suffix(".tmp")
    temp.write_text(json.dumps(value), encoding="utf-8")
    os.chmod(temp, 0o600)
    os.replace(temp, path)


def load(path):
    return json.loads(path.read_text(encoding="utf-8"))


def identity(pid):
    try:
        # starttime remains stable across argv changes and prevents PID reuse.
        fields = Path(f"/proc/{pid}/stat").read_text().rsplit(")", 1)[1].split()
        return fields[19] if fields[0] != "Z" else None
    except (OSError, IndexError):
        return None


def redact(text, secret):
    secrets = secret if isinstance(secret, list) else [secret]
    forms = {form for key in secrets if key for form in
             (key, json.dumps(key)[1:-1], json.dumps(key, ensure_ascii=False)[1:-1], repr(key)[1:-1], html.escape(key))}
    for form in sorted(forms, key=len, reverse=True):
        text = text.replace(form, "[REDACTED]")
    return text


def status(root, offset=0):
    if not (root / "state.json").exists():
        return {"state": "missing", "phase": "missing", "heartbeat": None, "exitCode": None, "log": "", "offset": 0}
    value = load(root / "state.json")
    if value["state"] == "running" and value.get("pid") and identity(value["pid"]) != value.get("identity"):
        value.update(state="failed", phase="supervisor-lost", exitCode=-1)
    log = root / "artifacts/runner.log"
    chunk = b""
    if log.exists():
        with log.open("rb") as stream:
            stream.seek(max(0, offset))
            chunk = stream.read(65536)
    # Runner log is redacted before writing, including while the job is active.
    return {**{key: value.get(key) for key in ["state", "phase", "heartbeat", "exitCode"]},
            "log": chunk.decode("utf-8", errors="replace"), "offset": max(0, offset) + len(chunk)}


def isolated_install(source, target):
    package = source / "ais_bench"
    if not (package / "benchmark/configs").is_dir():
        raise RuntimeError("aisbenchWorkPath must contain ais_bench/benchmark/configs")
    target.mkdir()
    # Copy configurations/data, link immutable installed code to avoid copying large dependencies.
    for item in source.iterdir():
        if item.name == "ais_bench":
            continue
        (target / item.name).symlink_to(item, target_is_directory=item.is_dir())
    local = target / "ais_bench"
    local.mkdir()
    for item in package.iterdir():
        if item.name == "datasets":
            shutil.copytree(item, local / item.name, symlinks=False)
        elif item.name != "benchmark":
            (local / item.name).symlink_to(item, target_is_directory=item.is_dir())
    (local / "datasets").mkdir(exist_ok=True)
    benchmark = local / "benchmark"
    benchmark.mkdir()
    for item in (package / "benchmark").iterdir():
        if item.name in {"configs", "datasets"}:
            shutil.copytree(item, benchmark / item.name, symlinks=False)
        else:
            (benchmark / item.name).symlink_to(item, target_is_directory=item.is_dir())
    return target


def prepare(root, config):
    if "native" in config:
        from native import prepare_run
        return prepare_run(root, config)
    if config["workload"].get("dataset") == "synthetic":
        from synthetic import prepare_run
        return prepare_run(root, config)
    if importlib.metadata.version("ais-bench-benchmark") != config["aisbenchVersion"]:
        raise RuntimeError("AISBench version differs from configured aisbenchVersion")
    for module in ["ais_bench", "transformers", "torch", "pandas", "requests"]:
        __import__(module)
    path = str(Path(config["pythonExecutable"]).parent) + os.pathsep + os.environ.get("PATH", "")
    if shutil.which("ais_bench", path=path) is None:
        raise RuntimeError("ais_bench CLI is missing from the selected Python environment PATH")
    from transformers import AutoTokenizer
    AutoTokenizer.from_pretrained(config["tokenizerPath"])
    work = isolated_install(Path(config["aisbenchWorkPath"]), root / "install")
    run = root / "run"
    shutil.copytree(Path(__file__).resolve().parent / "upstream", run)
    endpoint = urlsplit(config["endpoint"])
    if endpoint.scheme not in {"http", "https"} or not endpoint.hostname:
        raise RuntimeError("Invalid endpoint")
    settings = {"DATASET_PATH": str(root / "data"), "WORK_PATH": str(work),
                "MODEL_NAME": config["model"], "MODEL_PATH": config["tokenizerPath"],
                "HOST_IP": endpoint.hostname, "HOST_PORT": str(endpoint.port or (443 if endpoint.scheme == "https" else 80)),
                "URL": config["endpoint"], "API_KEY": config.get("apiKey", ""),
                "DEFAULT_PERFORMANCE_TEST": "default_perf", "OUTPUT_DIR": str(run / "outputs"), "POD_INFO": config.get("podInfo", [])}
    (run / "config.py").write_text("\n".join(f"{key} = {value!r}" for key, value in settings.items()) + "\n")
    os.chmod(run / "config.py", 0o600)
    workload = config["workload"]
    args = [config["pythonExecutable"], "-u", "aisbench_test.py"]
    args += ["--test_type", workload.get("testType", "stream")]
    for key, flag in [("inputLength", "input_len"), ("outputLength", "output_len"), ("dataCount", "data_num"), ("concurrency", "concurrency"), ("requestRate", "request_rate")]:
        args += ["--" + flag, str(workload[key])]
    cache = workload.get("prefixCache", {})
    if cache.get("enabled"):
        args += ["--dataset_type", "prefix_cache", "--prefix_num", str(cache["prefixCount"]), "--repeat_rate", str(cache["prefixRatio"]), "--dp", str(cache["dp"]), "--seed", str(cache["seed"])]
        if cache.get("warmup"):
            args.append("--prefix_test")
    env = {**os.environ, "PYTHONPATH": str(work) + os.pathsep + os.environ.get("PYTHONPATH", ""),
           "PATH": str(Path(config["pythonExecutable"]).parent) + os.pathsep + os.environ.get("PATH", ""), "PYTHONUNBUFFERED": "1"}
    return run, args, env


def collect(root, secret, native=False):
    run = root / "run"
    artifacts = root / "artifacts"
    skipped = []
    for name in ["native-plan.json", "collections.json", "profiling", "aisbench_result.csv", "aisbench.log", "aisbench_all.log", "aisbench_client.log", "outputs"]:
        source = run / name
        if not source.exists() or source.is_symlink():
            continue
        entries = source.rglob("*") if source.is_dir() else [source]
        for item in entries:
            if not item.is_file() or item.is_symlink():
                continue
            # Upstream snapshots contain executable config and can embed escaped credentials.
            relative = item.relative_to(run)
            if native and ("configs" in relative.parts or item.suffix.lower() not in {".csv", ".json", ".jsonl", ".log", ".out", ".txt", ".md", ".html", ".yaml", ".yml"}):
                skipped.append({"path": relative.as_posix(), "reason": "private config or unsupported format"})
                continue
            dest = artifacts / relative
            dest.parent.mkdir(parents=True, exist_ok=True)
            try:
                with item.open(encoding="utf-8") as source_file, dest.open("w", encoding="utf-8") as output:
                    for line in source_file:
                        output.write(redact(line, secret))
            except UnicodeError:
                dest.unlink(missing_ok=True)
                skipped.append({"path": relative.as_posix(), "reason": "not UTF-8"})
    if native:
        atomic(artifacts / "collection.json", {"skipped": skipped})


def cleanup_private(root):
    (root / "private.json").unlink(missing_ok=True)
    for directory in [root / "run", root / "install"]:
        if directory.is_symlink():
            directory.unlink()
        elif directory.exists():
            shutil.rmtree(directory)


def supervise(root):
    os.umask(0o077)
    config = load(root / "private.json")
    with (root / ".lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        state = load(root / "state.json")
        state.update(pid=os.getpid(), identity=identity(os.getpid()), phase="checking", heartbeat=time.time())
        atomic(root / "state.json", state)
    stopped = threading.Event()
    cancelled = threading.Event()
    child = None
    secret = [config.get("apiKey"), config.get("profileApiKey")]
    def heartbeat():
        while not stopped.wait(2):
            state["heartbeat"] = time.time()
            atomic(root / "state.json", state)
    def cancel(_sig, _frame):
        cancelled.set()
        if child and child.poll() is None:
            child.terminate()
    signal.signal(signal.SIGTERM, cancel)
    thread = threading.Thread(target=heartbeat, daemon=True)
    thread.start()
    code = -1
    try:
        run, args, env = prepare(root, config)
        if cancelled.is_set() or (root / "cancelled").exists():
            cancelled.set()
            return
        state["phase"] = "benchmark" if "native" in config and "multimodalGeneration" not in config["native"] else "generating-data"
        child = subprocess.Popen(args, cwd=run, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
        with (root / "artifacts/runner.log").open("a", encoding="utf-8") as log:
            for line in iter(child.stdout.readline, b""):
                text = line.decode("utf-8", errors="replace")
                if "[开始] 前缀数据集测试" in text:
                    state["phase"] = "warmup"
                elif "[开始] 全量数据集测试" in text or text.strip() == "AISBench multimodal dataset prepared":
                    state["phase"] = "benchmark"
                log.write(redact(text, secret))
                log.flush()
        code = child.wait()
    except Exception as error:
        with (root / "artifacts/runner.log").open("a", encoding="utf-8") as log:
            log.write(redact(f"{type(error).__name__}: {error}\n", secret))
    finally:
        stopped.set()
        thread.join()
        try:
            collect(root, secret, native="native" in config)
        except Exception as error:
            code = -1
            try:
                with (root / "artifacts/runner.log").open("a", encoding="utf-8") as log:
                    log.write(redact(f"Artifact collection failed: {error}\n", secret))
            except OSError:
                pass
        finally:
            try:
                # Generated configurations/bytecode may embed auth, even if collection failed.
                cleanup_private(root)
            except OSError:
                code = -1
            finally:
                state.update(state="cancelled" if cancelled.is_set() else "completed" if code == 0 else "failed", phase="finished", exitCode=code, heartbeat=time.time())
                try:
                    atomic(root / "artifacts/execution.json", {key: value for key, value in state.items() if key not in {"pid", "identity"}})
                    atomic(root / "artifacts/environment.json", {"aisbenchVersion": config["aisbenchVersion"], "pythonVersion": sys.version.split()[0]})
                except OSError:
                    state.update(state="failed", exitCode=-1, phase="metadata-write-failed")
                finally:
                    # Publish terminal state last: restart/download can proceed immediately.
                    atomic(root / "state.json", state)


def public_file(root, name):
    relative = Path(name)
    if relative.is_absolute() or ".." in relative.parts or not relative.parts:
        raise ValueError("Unsafe artifact path")
    base = root / "artifacts"
    path = base / relative
    for parent in [path, *path.parents]:
        if parent == base.parent:
            break
        if parent.is_symlink():
            raise ValueError("Symlink artifact refused")
    if not path.is_file():
        raise ValueError("Artifact missing")
    return path


def dispatch(request):
    root = Path(request["jobDir"])
    if not root.is_absolute() or root.is_symlink():
        raise ValueError("jobDir must be absolute and not a symlink")
    action = request["action"]
    if action == "start":
        root.mkdir(parents=True, exist_ok=True, mode=0o700)
    if not root.exists():
        if action == "release-generated-input":
            return {}
        if action == "status":
            return status(root)
        raise ValueError("Job missing")
    with (root / ".lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        state_path = root / "state.json"
        if state_path.exists() and load(state_path)["fingerprint"] != request["fingerprint"]:
            raise ValueError("Job fingerprint differs")
        if action == "release-generated-input":
            if not state_path.exists():
                return {}
            if status(root)["state"] not in TERMINAL:
                raise ValueError("Cannot release generated input for an active job")
            target = root / "generated-input"
            if target.exists():
                shutil.rmtree(target)
            return {}
        if action == "start" and state_path.exists():
            existing = load(state_path)
            token = request.get("restartToken")
            if existing["state"] in {"failed", "cancelled"} and token and token != existing.get("restartToken"):
                # A new local attempt may retry a failed point. Repeated start with the
                # same token never retries, including a lost response after fast failure.
                history = root / "history" / hashlib.sha256(str(existing.get("restartToken", "initial")).encode()).hexdigest()
                history.mkdir(parents=True, exist_ok=True)
                if (root / "artifacts").exists():
                    os.replace(root / "artifacts", history / "artifacts")
                os.replace(state_path, history / "state.json")
                cleanup_private(root)
                (root / "cancelled").unlink(missing_ok=True)
        if action == "start" and not state_path.exists():
            (root / "artifacts").mkdir(mode=0o700)
            atomic(root / "private.json", request["config"])
            atomic(state_path, {"fingerprint": request["fingerprint"], "restartToken": request.get("restartToken"), "state": "running", "phase": "starting", "heartbeat": time.time(), "exitCode": None})
            process = subprocess.Popen([sys.executable, str(Path(__file__).resolve()), "--supervise", str(root)], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)
            # Commit process identity before acknowledging a successful start.
            state = load(state_path)
            state.update(pid=process.pid, identity=identity(process.pid))
            atomic(state_path, state)
        if action in {"start", "status"}:
            return status(root, int(request.get("offset", 0)))
        if action == "cancel":
            state = load(state_path)
            (root / "cancelled").touch(mode=0o600)
            if state["state"] not in TERMINAL and identity(state.get("pid")) == state.get("identity"):
                try:
                    os.killpg(state["pid"], signal.SIGTERM)
                except ProcessLookupError:
                    pass
                for _ in range(50):
                    if load(state_path)["state"] in TERMINAL:
                        break
                    time.sleep(.1)
                else:
                    try:
                        os.killpg(state["pid"], signal.SIGKILL)
                    except ProcessLookupError:
                        pass
                    state.update(state="cancelled", phase="killed", exitCode=-9)
                    atomic(state_path, state)
                    cleanup_private(root)
            return status(root)
        if action == "manifest":
            if status(root)["state"] == "running":
                raise ValueError("Artifacts are not final")
            files = []
            for item in sorted((root / "artifacts").rglob("*")):
                if item.is_symlink() or not item.is_file():
                    continue
                path = public_file(root, str(item.relative_to(root / "artifacts")))
                files.append({"path": path.relative_to(root / "artifacts").as_posix(), "size": path.stat().st_size, "sha256": hashlib.sha256(path.read_bytes()).hexdigest()})
            return {"files": files}
        if action == "read":
            length, offset = int(request.get("length", 262144)), int(request.get("offset", 0))
            if length < 1 or length > 262144 or offset < 0:
                raise ValueError("Invalid chunk range")
            if status(root)["state"] == "running":
                raise ValueError("Artifacts are not final")
            with public_file(root, request["path"]).open("rb") as stream:
                stream.seek(offset)
                data = stream.read(length)
            return {"data": base64.b64encode(data).decode(), "nextOffset": offset + len(data)}
        raise ValueError("Unknown action")


if __name__ == "__main__":
    if len(sys.argv) == 3 and sys.argv[1] == "--supervise":
        supervise(Path(sys.argv[2]))
    else:
        try:
            print(json.dumps({"schemaVersion": 1, **dispatch(json.load(sys.stdin))}))
        except Exception as error:
            print(json.dumps({"schemaVersion": 1, "error": str(error)}))
            sys.exit(1)
