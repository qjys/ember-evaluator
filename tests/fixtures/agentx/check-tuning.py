"""Exercise native CANN table scopes and request sampling without hardware."""
from pathlib import Path
import json
import sys
from tempfile import TemporaryDirectory

sys.path.insert(0, sys.argv[1])
from service_sampler import counter_exports
from request_statistics import per_request_tpot
from native_diagnostics import hbm_channels, native_evidence
from profile_export import rows
from host_resources import host_reader
import sqlite3


with TemporaryDirectory() as tmp:
    root = Path(tmp)
    for table, ratio in (("ai_core_utilization", .2), ("ai_vector_core_utilization", .8)):
        (root / (table + "_20261127185309.csv")).write_text(
            f"Device_id,Core ID,mac_ratio,write_cache_hit,write_cache_miss_allocate\n1,Core0,{ratio},30,10\n",
            encoding="utf-8")
    db = sqlite3.connect(root / "ascend_pytorch_profiler_1.db")
    db.executescript("""CREATE TABLE HBM(deviceId, hbmId, type, bandwidth);
        CREATE TABLE STRING_IDS(id, value); INSERT INTO STRING_IDS VALUES (2, 'write');
        INSERT INTO HBM VALUES (1, 0, 2, 21000000), (1, 0, 2, 9000000);""")
    db.close()
    (root / "l2_cache.csv").write_text("Read Hit Rate(%)\n")
    assert native_evidence(root, rows, {})["l2Cache"] == {}
    (root / "l2_cache.csv").write_text("Read Hit Rate(%)\n20\n")
    assert native_evidence(root, rows, {})["l2Cache"]["read hit rate(%)"]["mean"] == 20
    channels, errors = hbm_channels(root)
    assert not errors and channels[0]["direction"] == "write" and channels[0]["meanMBps"] == 15
    (root / "diskstats").write_text("8 0 sda 3 0 5 0 2 0 4 0 0 17 0\n")
    values, counters = host_reader(root)()
    assert values['host_disk_read_bytes_total{device="sda"}'][1] == 5 * 512
    assert "host_disk_io_milliseconds_total" in counters
    data, = counter_exports(root, "compute", {1: 1})
    assert data["counters"]["ai_core_utilization/mac_ratio"]["mean"] == .2
    assert data["counters"]["ai_vector_core_utilization/mac_ratio"]["mean"] == .8
    data, = counter_exports(root, "cache", {1: 1})
    assert data["hitOverHitsAndMissAllocations"]["ai_core_utilization/write"] == .75
    (root / "hbm_20261127185309.csv").write_text(
        "Device_id,Metric,Read(MB/s)\n1,Average,15\n1,0,10\n1,1,20\n", encoding="utf-8")
    data, = counter_exports(root, "bandwidth", {1: 1})
    assert data["counters"]["hbm/Average/Read(MB/s)"]["mean"] == 15
    assert data["counters"]["hbm/0/Read(MB/s)"]["mean"] == 10
    with (root / "profile_export.jsonl").open("w", encoding="utf-8") as stream:
        for phase, end, tokens, failed in (("profiling", 30, 3, False), ("profiling", 50, 3, False),
                                          ("warmup", 999, 2, False), ("profiling", 999, 1, False),
                                          ("profiling", 999, 2, True)):
            row = {"metadata": {"benchmark_phase": phase}, "error": failed, "metrics": {
                "request_latency": {"value": end, "unit": "ms"}, "time_to_first_token": {"value": 10, "unit": "ms"},
                "output_sequence_length": {"value": tokens, "unit": "tokens"}}}
            stream.write(json.dumps(row) + "\n")
    stat = per_request_tpot(root)
    assert stat["count"] == 2 and stat["avg"] == 15 and stat["p50"] == 15 and stat["p95"] == 19.5
