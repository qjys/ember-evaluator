"""Run the locked AgentX bridge on a selected OpenSSH host. Credentials travel on stdin."""
import hashlib
import json
import os
from pathlib import Path
import re
import shlex
import shutil
import tempfile
import signal
import subprocess
import sys
import threading

OPTIONS = ["-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes", "-o", "ConnectTimeout=10"]


def tokenizer(path):
    root = Path(path).resolve(strict=True)
    h = hashlib.sha256()
    def visit(directory):
        for f in sorted(directory.iterdir()):
            if f.is_symlink():
                raise ValueError("The AgentX tokenizer contains a symbolic link")
            if f.is_dir():
                visit(f)
            else:
                h.update(f.relative_to(root).as_posix().encode() + b"\0")
                with f.open("rb") as stream:
                    while chunk := stream.read(1048576):
                        h.update(chunk)
                h.update(b"\0")
    visit(root)
    return h.hexdigest()


def worker():
    req = json.loads(sys.stdin.buffer.readline())
    root = Path.cwd()
    req["artifactDir"], req["outputDir"] = str(root / "artifacts"), str(root / "agent")
    if tokenizer(req["tokenizerPath"]) != req.pop("tokenizerDigest"):
        raise ValueError("AgentX load-node tokenizer has changed")
    child = subprocess.Popen([sys.executable, "-B", str(root / "bridge" / "runner.py")], stdin=subprocess.PIPE,
                             start_new_session=True)
    child.stdin.write(json.dumps(req).encode())
    child.stdin.close()
    def disconnect():
        while os.read(0, 4096):
            pass
        if child.poll() is None:
            try:
                os.killpg(child.pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
    threading.Thread(target=disconnect, daemon=True).start()
    return child.wait()


def coordinator(action, alias, python, path, digest=None):
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._@-]*", alias):
        raise ValueError("Invalid load-node SSH alias")
    def ssh(args, **kwargs):
        return subprocess.run(["ssh", "-T", *OPTIONS, alias, shlex.join(args)], check=True, **kwargs)
    if action == "identify":
        with Path(__file__).open("rb") as source:
            ssh([python, "-B", "-", "tokenizer", path], stdin=source)
        return 0
    req = json.load(sys.stdin)
    assets = Path(__file__).resolve().parent
    name = ssh(["mktemp", "-d", "/tmp/arsi-agentx-XXXXXXXX"], capture_output=True, text=True).stdout.strip()
    if not re.fullmatch(r"/tmp/arsi-agentx-[A-Za-z0-9]+", name):
        raise RuntimeError("Invalid remote staging path")
    agent, artifacts = Path(req["outputDir"]), Path(req["artifactDir"])
    def scp(src, dest, **kwargs):
        return subprocess.run(["scp", "-q", "-r", *OPTIONS, src, dest], check=True, **kwargs)
    try:
        ssh(["mkdir", "-p", name + "/input", name + "/agent", name + "/artifacts"])
        scp(str(assets), alias + ":" + name + "/bridge")
        scp(req["workload"]["tracePath"], alias + ":" + name + "/input/traces.jsonl")
        # Install the pinned Harness and its evaluator entry point once per interpreter and bridge digest.
        install = ("import fcntl,os,pathlib,sys,subprocess; p=pathlib.Path.home()/'.cache/arsi-evaluator/agentx'/sys.argv[2]; "
                   "p.mkdir(parents=True,exist_ok=True); f=(p/'lock').open('a'); fcntl.flock(f,fcntl.LOCK_EX); "
                   "ready=p/'ready'; ready.exists() or (subprocess.run([sys.executable,sys.argv[1],str(p/'venv')],check=True,stdout=sys.stderr),ready.touch()); "
                   "print(p/'venv/bin/python')")
        key = hashlib.sha256((python + "\0" + digest).encode()).hexdigest()
        runtime = ssh([python, "-c", install, name + "/bridge/install.py", key], stdout=subprocess.PIPE, text=True).stdout.strip()
        args = ["ssh", "-T", *OPTIONS, alias, "cd " + shlex.quote(name) + " && exec " + shlex.join([runtime, "-B", "bridge/load_node.py", "worker"])]
        req["tokenizerPath"], req["tokenizerDigest"] = path, req.pop("remoteTokenizerDigest")
        with subprocess.Popen(args, stdin=subprocess.PIPE) as child:
            child.stdin.write(json.dumps(req).encode() + b"\n")
            child.stdin.flush()
            try:
                code = child.wait()
            finally:
                child.stdin.close()
                if child.poll() is None:
                    child.wait(timeout=30)
        for source, dest in [("agent", agent), ("artifacts", artifacts)]:
            dest.mkdir(parents=True, exist_ok=True)
            with tempfile.TemporaryDirectory(dir=dest.parent) as stage:
                scp(alias + ":" + name + "/" + source, stage)
                for item in (Path(stage) / source).iterdir():
                    shutil.move(str(item), dest / item.name)
        return code
    finally:
        ssh([python, "-c", "import shutil,sys;shutil.rmtree(sys.argv[1])", name])



if __name__ == "__main__":
    if sys.argv[1] == "tokenizer":
        print(json.dumps({"digest": tokenizer(sys.argv[2]), "version": ".".join(map(str, sys.version_info[:3]))}))
    elif sys.argv[1] == "worker":
        sys.exit(worker())
    else:
        def cancel(*_):
            raise KeyboardInterrupt()
        signal.signal(signal.SIGTERM, cancel)
        sys.exit(coordinator(*sys.argv[1:]))
