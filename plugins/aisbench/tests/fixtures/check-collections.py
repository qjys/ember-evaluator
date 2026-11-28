"""Exercise order, workload isolation and failure handling without accelerator hardware."""
import json
from pathlib import Path
import sys
from urllib.error import HTTPError
from tempfile import TemporaryDirectory
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "runtime"))
import service_collections as sc


def run_case(root, mode, separate):
    native = {"datasets": [{"name": "textvqa"}], "concurrency": [1, 8], "dataCount": [5, 9], "warmups": 1,
              "pressureSeconds": 10, "profiling": {"traceDirectory": str(root / "shared"), "exportTimeoutSeconds": 5},
              "engineMetrics": ["tokens_total", "waiting"]}
    config = {"native": native, "endpoint": "ordinary", "apiKey": "one"}
    if separate:
        config.update(profileEndpoint="diagnostic", profileApiKey="two")
    events = []
    trace = None
    cumulative = 100
    def control(service, route, body=None):
        nonlocal trace
        if route == "metrics":
            assert service["apiKey"] == "one"
            return f'# TYPE tokens counter\ntokens_total{{rank="0"}} {cumulative}\n# TYPE waiting gauge\nwaiting 2\n'
        assert service["apiKey"] == ("two" if separate else "one")
        events.append(route)
        if route == "start_profile":
            assert body["activities"] == ["CPU", "NPU"]
            trace = Path(body["output_dir"])
        else:
            assert route == "stop_profile" and trace
            target = trace / "rank0" / "ASCEND_PROFILER_OUTPUT"
            target.mkdir(parents=True)
            if mode == "host":
                (target / "operator_details.csv").write_text("Name,Host Total Duration(us)\naten::view,5\n")
                (target / "trace_view.json").write_text("[]")
            else:
                (target / "op_statistic.csv").write_text("OP Type,Core Type,Count,Total Time(us)\nMatMul,AI_CORE,2,31\n")
            trace = None
    def execute(service, name, dataset, work):
        nonlocal cumulative
        options = service["native"]
        batch, = options["concurrency"]
        n, = options["dataCount"]
        if work.relative_to(root).parts[0] == "warmup":
            assert options["warmups"] == 0 and n == 1 and "pressureSeconds" not in options
            cumulative += 1
            target = work / "time/performances/model/vqa.json"
            target.parent.mkdir(parents=True)
            target.write_text(json.dumps({"Success Requests": {"total": 1}, "Failed Requests": {"total": 0}}))
            return 0
        ordinary = "profiling" not in work.relative_to(root).parts
        events.append(("baseline" if ordinary else "sample" if trace else "warmup", batch, n))
        assert service["endpoint"] == ("ordinary" if ordinary or not separate else "diagnostic")
        if ordinary:
            assert options["pressureSeconds"] == 10
            cumulative += n
        else:
            assert "pressureSeconds" not in options and options["warmups"] == 0
            if trace and mode == "request-error":
                return 1
        target = work / "time" / "performances" / "model" / "vqa.json"
        target.parent.mkdir(parents=True)
        target.write_text(json.dumps({"Success Requests": {"total": n}, "Failed Requests": {"total": int(mode == "incomplete")}}))
        return 0
    with patch.object(sc, "http", control), patch.object(sc.time, "sleep", lambda _: None):
        sc.run_collections(config, root, [(None, None, root / "outputs")], execute)
    rows = json.loads((root / "collections.json").read_text())["points"]
    assert [p["engine"]["series"][0]["delta"] for p in rows] == [5, 9]
    assert all("delta" not in p["engine"]["series"][1] for p in rows)
    assert events[:2] == [("baseline", 1, 5), ("baseline", 8, 9)]
    if mode == "incomplete":
        assert len(events) == 2 and all(p["profiling"]["status"] == "skipped" for p in rows)
        return
    assert events[2:6] == [("warmup", 1, 1), "start_profile", ("sample", 1, 1), "stop_profile"]
    if mode == "request-error":
        assert len(events) == 6 and [p["profiling"]["status"] for p in rows] == ["failed", "skipped"]
        return
    assert events[6:] == [("warmup", 8, 1), "start_profile", ("sample", 8, 8), "stop_profile"]
    for p in rows:
        profile = p["profiling"]
        export, = profile["exports"]
        assert (root / export["artifactDirectory"]).is_dir()
        if mode == "host":
            assert profile["status"] == "host-only" and export["operatorDeviceUs"] is None
        else:
            assert profile["status"] == "measured" and export["operatorDeviceUs"] == 31


for mode in ("complete", "incomplete", "request-error", "host"):
    for separate in (False, True):
        with TemporaryDirectory() as root:
            run_case(Path(root), mode, separate)
with TemporaryDirectory() as root:
    try:
        sc.wait_for_exports(Path(root), 0)
    except TimeoutError:
        pass
    else:
        raise AssertionError("Missing trace counted as an export")

before = ({"x": ("x", 50)}, {"x"}), None
after = ({"x": ("x", 2)}, {"x"}), None
reset = sc.engine_result(["x", "absent"], before, after)
assert reset["series"][0]["delta"] is None and reset["status"] == "partial" and reset["missing"] == ["absent"]
for status_code, expected_calls in ((403, ["start_profile"]), (503, ["start_profile", "stop_profile"])):
    calls = []
    def reject(service, route, body):
        calls.append(route)
        if route == "start_profile":
            raise HTTPError("http://fixture/start_profile", status_code, "fixture", {}, None)
    with patch.object(sc, "http", reject):
        try:
            sc.capture({}, Path("trace"), lambda: sys.exit("unexpected inference"))
        except RuntimeError as error:
            assert str(status_code) in str(error)
    assert calls == expected_calls
print("Service collection checks passed")
