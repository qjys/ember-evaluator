"""Controlled real-Harness check: local tokenizer, synthetic trace and SSE server.

The generated performance numbers describe the fixture only, not a model.
"""
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
import subprocess
import sys
import threading
import time
import psutil

from tokenizers import Tokenizer, decoders, models, pre_tokenizers, trainers
from transformers import PreTrainedTokenizerFast

root = Path(sys.argv[1]).resolve()
runner = Path(sys.argv[2]).resolve()
service_collections = "--service-collections" in sys.argv
service_engine = "--service-engine" in sys.argv or service_collections
full_replay = "--full-replay" in sys.argv or service_collections
smoke_concurrency = "--smoke-concurrency" in sys.argv
standard_duration = "--standard-duration" in sys.argv
network_automatic = "--network-automatic" in sys.argv
network_manual = "--network-manual" in sys.argv
telemetry_check = "--telemetry" in sys.argv
telemetry_error = "--telemetry-error" in sys.argv
root.mkdir(parents=True, exist_ok=True)
tokenizer = Tokenizer(models.BPE(unk_token="[UNK]"))
tokenizer.pre_tokenizer = pre_tokenizers.ByteLevel(add_prefix_space=False)
tokenizer.decoder = decoders.ByteLevel()
tokenizer.train_from_iterator(["def main():\n    return {'answer': 42}\n" * 100],
    trainers.BpeTrainer(vocab_size=512, initial_alphabet=pre_tokenizers.ByteLevel.alphabet(), special_tokens=["[UNK]", "[EOS]"]))
fast = PreTrainedTokenizerFast(tokenizer_object=tokenizer, unk_token="[UNK]", eos_token="[EOS]")
fast.save_pretrained(root / "tokenizer")

trace = {"id": "controlled-session", "models": ["recorded-model"], "block_size": 64,
         "hash_id_scope": "local", "tool_tokens": 0, "system_tokens": 0,
         "requests": [{"t": i * 0.02, "type": "n", "model": "recorded-model",
                       "in": 128 + 64 * i, "out": 8, "hash_ids": list(range(1, i + 3)),
                       "input_types": ["text"], "output_types": ["text"], "stop": "end_turn",
                       "api_time": 0.01, "think_time": 0.01} for i in range(3)]}
if standard_duration:
    # Leave enough turns for the standard warmup and random
    # trajectory starts; retain standard sampling and timing controls.
    trace["requests"] = [{**trace["requests"][0], "t": i * 0.02, "in": 128 + 64 * i,
                          "hash_ids": list(range(1, i + 3))} for i in range(100)]
if smoke_concurrency:
    # Without burst starts, only the earliest lane fits in the two-second
    # profiling window: the recorded gaps between lane starts are minutes long.
    trace["requests"] = [{**trace["requests"][0], "t": i * 120, "in": 128 + 64 * i,
                          "hash_ids": list(range(1, i + 3))} for i in range(12)]
input_dir = root / "input"
input_dir.mkdir(exist_ok=True)
traces = [trace]
if full_replay:
    traces = []
    for trace_index in range(8 if service_collections else 4):
        item = json.loads(json.dumps(trace))
        item["id"] = "controlled-session-%d" % trace_index
        child = {"t": 0.025, "type": "subagent", "agent_id": "child", "subagent_type": "Explore",
                 "duration_ms": 10, "total_tokens": 336, "tool_use_count": 0, "status": "completed",
                 "models": ["recorded-model"],
                 "requests": [{**trace["requests"][i], "t": 0.025 + i * 0.005} for i in range(2)]}
        item["requests"].insert(2, child)
        # This branch starts after the root's final request. Finishing all root
        # turns must not close the phase while this background work is pending.
        late_child = {**child, "t": 0.05, "agent_id": "late-child",
                      "requests": [{**trace["requests"][i], "t": 0.05 + i * 0.005} for i in range(2)]}
        item["requests"].append(late_child)
        traces.append(item)
data = ("".join(json.dumps(item) + "\n" for item in traces)).encode()
(input_dir / "traces.jsonl").write_bytes(data)
secret = "controlled-agentx-secret-123"
calls = []
diagnostics = []
metric_calls = []
metric_failed = False
active_profile = None
collection_events = []


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *_args):
        pass

    def do_GET(self):
        global metric_failed
        if service_engine and self.path == "/metrics":
            if self.headers.get("Authorization") != "Bearer " + secret:
                self.send_error(403)
                return
            collection_events.append(["metrics", len(calls)])
            contents = ("# TYPE fixture_requests counter\nfixture_requests_total %d\n" % len(calls)).encode()
        elif service_collections and self.path == "/events":
            contents = json.dumps(collection_events).encode()
        elif self.path in ("/metrics", "/npu/metrics"):
            metric_calls.append(self.path)
            if not telemetry_check:
                self.send_error(404)
                return
            if telemetry_error and not metric_failed and len(calls) > 3:
                metric_failed = True
                self.send_error(503)
                return
            readings = {"vllm:kv_cache_usage_perc": min(len(calls) / 30, 0.8),
                        "vllm:num_requests_running": 1, "vllm:num_requests_waiting": 0}
            readings.update({"ascend_npu_" + name: 30 + len(calls) for name in [
                "utilization_percent", "aicore_utilization_percent", "hbm_usage_percent", "hbm_capacity_megabytes",
                "hbm_bandwidth_percent", "power_watts", "temperature_celsius"]})
            body = []
            for name, value in readings.items():
                tags = '{model_name="fixture-model"}' if name.startswith("vllm:") else '{device_id="4",chip_id="0"}'
                body += ["# TYPE " + name + " gauge", name + tags + " " + str(value)]
            # Force a server restart-style counter reset during the real scrape window.
            value = 500 if len(calls) < 3 else len(calls) - 3
            body += ["# TYPE vllm:num_preemptions_total counter", 'vllm:num_preemptions_total{model_name="fixture-model"} ' + str(value)]
            contents = ("\n".join(body) + "\n").encode()
            self.send_response(200)
            self.send_header("Content-Type", "text/plain; version=0.0.4")
            self.send_header("Content-Length", str(len(contents)))
            self.end_headers()
            self.wfile.write(contents)
            return
        elif self.path.startswith("/api/datasets/"):
            contents = json.dumps({"sha": "a" * 40, "siblings": [{"rfilename": "traces.jsonl", "lfs": {"sha256": hashlib.sha256(data).hexdigest()}}]}).encode()
        elif self.path.endswith("/traces.jsonl"):
            contents = data
        else:
            self.send_error(404)
            return
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(contents)))
        self.end_headers()
        self.wfile.write(contents)

    def do_POST(self):
        global active_profile
        if service_collections and self.path in ("/start_profile", "/stop_profile"):
            if self.headers.get("Authorization") != "Bearer " + secret:
                self.send_error(403)
                return
            payload = self.rfile.read(int(self.headers.get("Content-Length", 0)))
            if self.path == "/start_profile":
                if "--reject-profile" in sys.argv:
                    collection_events.append([self.path, len(calls)])
                    self.send_error(409)
                    return
                assert active_profile is None
                if payload:
                    body = json.loads(payload)
                    assert body["activities"] == ["CPU", "NPU"]
                    active_profile = Path(body["output_dir"])
                else:
                    active_profile = root / "traces" / ("capture-" + str(len(calls)))
            else:
                directory = active_profile / "rank0" / "ASCEND_PROFILER_OUTPUT"
                directory.mkdir(parents=True)
                (directory / "op_statistic.csv").write_text("OP Type,Core Type,Count,Total Time(us)\nMatMul,AI_CORE,3,75\n")
                active_profile = None
            collection_events.append([self.path, len(calls)])
            self.send_response(200)
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        # In server-only mode the evaluator owns the Harness processes. This fixture has no Harness children to inspect.
        for process in ([] if "--serve" in sys.argv else psutil.Process().children(recursive=True)):
            try:
                assert secret not in "\0".join(process.cmdline()), "Credential in Harness process arguments"
            except (psutil.NoSuchProcess, psutil.AccessDenied):
                pass
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        diagnostics.append({"path": self.path, "authMatches": self.headers.get("Authorization") == "Bearer " + secret,
                            "authIsLiteral": self.headers.get("Authorization") == "Bearer ${EVALUATOR_AGENTX_API_KEY}",
                            "maxTokens": body.get("max_completion_tokens", body.get("max_tokens"))})
        if self.path != "/v1/chat/completions" or self.headers.get("Authorization") != "Bearer " + secret:
            self.send_error(400)
            return
        count = body.get("max_completion_tokens", body.get("max_tokens"))
        assert body["model"] == "fixture-model"
        assert body["stream"] and body["ignore_eos"] and 0 < count <= 8
        calls.append(body)
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Connection", "close")
        self.end_headers()
        for i in range(count):
            chunk = {"id": "fixture", "object": "chat.completion.chunk", "model": "fixture-model",
                     "choices": [{"index": 0, "delta": {"content": " x"}, "finish_reason": None}]}
            self.wfile.write(("data: " + json.dumps(chunk) + "\n\n").encode())
            self.wfile.flush()
            time.sleep(0.02 if telemetry_check else 0.001)
        usage = {"prompt_tokens": 128, "completion_tokens": count, "total_tokens": 128 + count}
        chunk = {"id": "fixture", "object": "chat.completion.chunk", "model": "fixture-model",
                 "choices": [{"index": 0, "delta": {}, "finish_reason": "length"}], "usage": usage}
        self.wfile.write(("data: " + json.dumps(chunk) + "\n\ndata: [DONE]\n\n").encode())
        self.wfile.flush()
        self.close_connection = True


server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
thread = threading.Thread(target=server.serve_forever, daemon=True)
thread.start()
request = {"schemaVersion": 1, "key": {"runId": "controlled", "taskId": "point", "attemptId": "attempt"},
           "workload": {"schemaVersion": 1, "kind": "agentx", "variant": "256k", "mode": "smoke",
                        "durationSeconds": 2, "seed": 42, "concurrency": 1,
                        "dataset": "semianalysisai/cc-traces-weka-062126-256k",
                        "loader": "semianalysis_cc_traces_weka_062126_256k", "revision": "a" * 40,
                        "sha256": hashlib.sha256(data).hexdigest(), "tracePath": "input/traces.jsonl"},
           "url": "http://127.0.0.1:%d" % server.server_port, "endpoint": "/v1/chat/completions",
           "model": "fixture-model", "tokenizerPath": str(root / "tokenizer"), "trustRemoteCode": False,
           "auth": {"value": secret, "reference": None}, "outputDir": str(root / "agent"),
           "artifactDir": str(root / "agentx-artifacts"), "requestTimeoutSeconds": 10}
if full_replay:
    # Exceed the official 900s minimum: finite replay must finish by source
    # count without being rejected for not filling its nominal safety cap.
    request["workload"].update(mode="replay", traceCount=3, concurrency=2, durationSeconds=1800)
if standard_duration:
    request["workload"].update(mode="standard", durationSeconds=60)
if network_automatic:
    request["networkLatency"] = {"mode": "automatic", "pingIntervalSeconds": 0.2}
if network_manual:
    request["networkLatency"] = {"mode": "manual", "meanMs": 4}
if smoke_concurrency:
    request["workload"]["concurrency"] = 4
if telemetry_check:
    request["telemetry"] = {"vllm": {"endpoint": request["url"] + "/metrics"},
                            "ascend": {"endpoint": request["url"] + "/npu/metrics", "deviceId": 4, "chipId": 0}}
if service_engine:
    request["engineMetrics"] = {"endpoint": request["url"], "apiKey": secret, "names": ["fixture_requests_total"]}
    request["workload"]["collection"] = {"type": "performance", "engineMetrics": ["fixture_requests_total"]}
if "--serve" in sys.argv:
    print(json.dumps({"url": request["url"], "tokenizer": request["tokenizerPath"], "key": secret}), flush=True)
    thread.join()
    sys.exit(0)
try:
    result = subprocess.run([sys.executable, str(runner)], input=json.dumps(request), text=True,
                            encoding="utf-8", capture_output=True, cwd=root, timeout=120 if standard_duration else 90)
    if result.returncode:
        logs = list((root / "agentx-artifacts").rglob("harness.log"))
        tail = logs[0].read_text(encoding="utf-8")[-12000:] if logs else result.stderr
        raise RuntimeError("Real Harness bridge failed: " + json.dumps(diagnostics[:3]) + "\n" + tail.replace(secret, "[redacted]"))
    messages = [json.loads(line) for line in result.stdout.splitlines() if line.strip()]
    terminals = [message for message in messages if message.get("type") != "activity"]
    assert len(terminals) == 1, "Expected one terminal bridge message"
    terminal = terminals[0]
    raw = terminal["export"]
    assert terminal["type"] == "result" and raw["schema_version"] == "1.4"
    assert raw["was_cancelled"] is False
    assert raw["metadata"]["scenario"] == "agentx"
    assert calls and raw["request_count"]["avg"] > 0
    if service_engine:
        metric = terminal["engine"]
        assert metric["status"] == "measured", metric
        series, = metric["series"]
        assert series["series"] == "fixture_requests_total" and 0 < series["delta"] <= len(calls), series
    if network_automatic or network_manual:
        assert raw["network_rtt"]["avg"] > 0
        assert raw["network_adjusted_time_to_first_token"]["avg"] <= raw["time_to_first_token"]["avg"]
        assert raw["network_adjusted_request_latency"]["avg"] <= raw["request_latency"]["avg"]
        if network_automatic:
            assert terminal["networkLatencyProbes"]["successful"] > 0
            assert list((root / "agentx-artifacts").rglob("profile_export_network_latency.jsonl"))
        else:
            assert raw["network_rtt"]["avg"] == 4
            assert not list((root / "agentx-artifacts").rglob("profile_export_network_latency.jsonl"))
    if standard_duration:
        # One mandatory snapshot primer plus ten additional warmup requests.
        assert raw["warmup_metrics"]["request_count"]["avg"] == 11
        assert raw["metadata"]["submission_valid"] is False
        assert "unsafe_override" in raw["metadata"]["submission_invalid_reasons"]
    if smoke_concurrency:
        assert raw["request_count"]["avg"] >= 4, "Not all smoke lanes entered profiling"
        log = (root / "agentx-artifacts" / "harness.log").read_text(encoding="utf-8")
        assert "resuming 4 trajectory sessions (burst; first-request spread 0.0s)" in log
    if not telemetry_check:
        assert not metric_calls, "API-only execution must not probe metrics"
    if full_replay:
        coverage = terminal["replayCoverage"]
        assert coverage["complete"] and coverage["completedTraces"] == 3, coverage
        assert coverage["expectedRequests"] == 21 and len(calls) == 21, coverage
        records = [json.loads(line) for path in (root / "agentx-artifacts").rglob("profile_export.jsonl")
                   for line in path.read_text().splitlines() if line.strip()]
        assert len(records) == 21 and all(record["metadata"]["benchmark_phase"] == "profiling" for record in records)
        assert {record["metadata"]["source_trace_id"] for record in records} == {item["id"] for item in traces[:3]}
        sys.path.insert(0, str(runner.parent))
        from replay_coverage import audit_replay, selected_requests
        expected = selected_requests(input_dir / "traces.jsonl", 3)
        audit_path = root / "audit-fixture.jsonl"

        def audit(values):
            audit_path.write_text("".join(json.dumps(item) + "\n" for item in values), encoding="utf-8")
            return audit_replay(expected, [audit_path])[0]

        assert audit(records)["complete"]
        missing = audit(records[:-1])
        assert not missing["complete"] and missing["missingRequests"] == 1
        duplicate = audit([*records, records[0]])
        assert not duplicate["complete"] and duplicate["duplicateRequests"] == 1
        changed = json.loads(json.dumps(records))
        changed[0]["metadata"]["was_cancelled"] = True
        cancelled = audit(changed)
        assert not cancelled["complete"] and cancelled["cancelledRequests"] == 1
        changed = json.loads(json.dumps(records))
        changed[0]["metadata"]["source_trace_id"] = "unselected"
        unknown = audit(changed)
        assert not unknown["complete"] and unknown["unexpectedRequests"] == 1
        changed = json.loads(json.dumps(records))
        changed[0]["error"] = {"message": "controlled failure"}
        failure = audit(changed)
        assert failure["complete"] and failure["failedRequests"] == 1 and failure["successfulRequests"] == 20
    for path in (root / "agentx-artifacts").rglob("*"):
        if path.is_file() and path.suffix in {".json", ".jsonl", ".log", ".yaml"}:
            assert secret not in path.read_text(encoding="utf-8"), path
    print(json.dumps({"requests": len(calls), "schema": raw["schema_version"], "scenario": raw["metadata"]["scenario"],
                      "raw": raw, "workload": request["workload"], "replayCoverage": terminal.get("replayCoverage"),
                      "telemetry": terminal.get("telemetry"), "telemetryConfig": request.get("telemetry"),
                      "networkLatencyConfig": request.get("networkLatency"), "networkLatencyProbes": terminal.get("networkLatencyProbes")}))
finally:
    server.shutdown()
    server.server_close()
