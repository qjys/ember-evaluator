"""Small argparse fixture for offline YAML-to-argv regression tests."""
import argparse
import json
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "runtime"))
from native import build_args

parser = argparse.ArgumentParser()
for name in ("batch-size", "num-prompts"):
    parser.add_argument("--" + name, nargs="+", type=int)
for name in ("request-rate", "num-warmups", "pressure-time"):
    parser.add_argument("--" + name, type=int)
parser.add_argument("--stream", action=argparse.BooleanOptionalAction)
parser.add_argument("--pressure", action="store_true")
parser.add_argument("--spec-decode", action="store_true")
parser.add_argument("--generation-kwargs", type=json.loads)
parser.add_argument("--extra-label", action="append")
config = {"native": json.load(sys.stdin), "endpoint": "https://example.invalid/proxy/", "model": "vl", "tokenizerPath": "/vl"}
args = build_args(config, Path("/job/run"), parser)
print(json.dumps(args))
