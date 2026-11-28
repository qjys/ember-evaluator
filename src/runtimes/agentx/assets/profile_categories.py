"""Coverage for the optimization questions addressed by one diagnostic replay."""


def classify(ranks, sampler):
    result = {}
    devices = sampler.get("devices", [])
    rank_count = max(len(ranks), len(devices))
    def record(key, observed, expected, source, missing):
        result[key] = {"status": "measured" if observed and observed == expected else "partial" if observed else "unavailable",
                       "observed": observed, "expected": expected, "source": source}
        if not observed or observed != expected:
            result[key]["reason"] = missing

    for key, source, check, reason in (
        ("timeline", "torch_npu / trace_view", lambda r: r["timeline"]["computeUs"] is not None or r["timeline"]["communicationUs"] is not None, "no device intervals"),
        ("operators", "torch_npu / operator and kernel tables", lambda r: r["operatorDeviceUs"] is not None or r["kernelCount"], "no device operator statistics"),
        ("runtime", "CANN / host timeline", lambda r: r["timeline"]["top"].get("runtime"), "no host Runtime events"),
        ("memcpy", "CANN / device timeline", lambda r: r["timeline"]["top"].get("copy"), "no Memcpy event observed"),
        ("allocator", "torch_npu / memory_record.csv", lambda r: r["native"]["allocatorMB"], "no allocation samples; check service memory profiling"),
        ("pipeline", "torch_npu / kernel_details.csv", lambda r: r["native"]["pipeline"], "no per-kernel PMU columns with numeric values"),
        ("communication", "HCCL / timeline and communication exports", lambda r: r["timeline"]["communicationUs"] is not None or r["native"]["communication"]["timeMs"], "no collective or P2P activity observed"),
        ("links", "HCCL / communication_matrix.json", lambda r: r["native"]["communication"]["interRankLinks"], "no inter-rank link record"),
    ):
        record(key, sum(bool(check(r)) for r in ranks), rank_count, source, reason)

    series = [r for group in ("localMetrics", "nodeMetrics") for r in sampler.get(group, {}).get("series", {}).values()
              if r.get("count") and (not r.get("counter") or r.get("delta") is not None)]
    for key, source, prefixes in (
        ("cpu", "/proc/stat or node exporter", ("host_cpu_busy_percent", "node_cpu_seconds_total")),
        ("memory", "/proc/meminfo or node exporter", ("host_memory_available_bytes", "node_memory_MemAvailable_bytes")),
        ("disk", "/proc/diskstats or node exporter", ("host_disk_", "node_disk_")),
        ("network", "/proc/net/dev or node exporter", ("host_receive_bytes_total", "host_transmit_bytes_total", "node_network_")),
    ):
        record(key, int(any(s["name"].startswith(prefixes) for s in series)), 1, source,
               "no usable service-node samples; check node access and the sampling window")

    local = sampler.get("localMetrics", {}).get("series", {})
    external = sampler.get("nodeMetrics", {}).get("series", {})
    hardware = sampler.get("hardwareExports", [])
    for key, names in (("npuMemory", ("ascend_npu_hbm_capacity_megabytes", "ascend_npu_hbm_usage_percent")),
                       ("npuUtilization", ("ascend_npu_utilization_percent",))):
        count = sum(all(any(r["name"] == name and ('device="%d"' % device) in label
                            for label, r in local.items()) for name in names) for device in devices)
        if devices:
            record(key, count, len(devices), "npu-smi", "missing readings for selected physical devices")
        else:
            labels = {label.partition("{")[2] for label, r in external.items() if r["name"] in names}
            covered = sum(all(any(r["name"] == name and label.partition("{")[2] == scope for label, r in external.items())
                              for name in names) for scope in labels)
            record(key, covered, len(labels), "service-node exporter", "no physical devices or matching exporter samples")

    # Use the DB or CSV source independently; the same capture can be exported through both.
    db_count = sum(bool(r["native"]["hbmChannels"]) for r in ranks)
    csv_count = sum(any("hbm" in name.lower() for name in d["counters"]) for d in hardware)
    if db_count and db_count >= csv_count:
        record("hbmBandwidth", db_count, rank_count, "torch_npu DB / HBM", "no HBM samples in some ranks")
    else:
        record("hbmBandwidth", csv_count, len(devices), "msprof / HBM", sampler.get("counterError") or "no HBM bandwidth export")
    native_cache = sum(bool(r["native"]["l2Cache"]) for r in ranks)
    cache_devices = sum(any("cache" in name.lower() for name in d["counters"]) for d in hardware)
    if native_cache and native_cache >= cache_devices:
        record("l2Cache", native_cache, rank_count, "torch_npu / l2_cache.csv", "missing L2 samples in some ranks")
    else:
        record("l2Cache", cache_devices, len(devices), "msprof / L2Cache", sampler.get("counterError") or "no L2 events exported for selected devices")
    return result
