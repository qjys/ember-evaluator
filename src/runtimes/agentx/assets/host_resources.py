"""Linux serving-node counters in the mount and network namespace of the sampler."""
import json
from pathlib import Path

DISK_COUNTERS = {"host_disk_reads_total": (3, 1), "host_disk_read_bytes_total": (5, 512),
                 "host_disk_writes_total": (7, 1), "host_disk_write_bytes_total": (9, 512),
                 "host_disk_io_milliseconds_total": (12, 1)}
NETWORK_COUNTERS = {"host_receive_bytes_total", "host_transmit_bytes_total"}


def host_reader(proc=Path("/proc")):
    last_cpu = None

    def read():
        nonlocal last_cpu
        values = {}
        def put(name, value, label=""):
            values[name + label] = (name, value)
        try:
            cpu = [int(x) for x in (proc / "stat").read_text().splitlines()[0].split()[1:9]]
            total, idle, wait = sum(cpu), cpu[3] + cpu[4], cpu[4]
            if last_cpu and total > last_cpu[0]:
                elapsed = total - last_cpu[0]
                put("host_cpu_busy_percent", 100 * (1 - (idle - last_cpu[1]) / elapsed))
                put("host_cpu_iowait_percent", 100 * (wait - last_cpu[2]) / elapsed)
            last_cpu = (total, idle, wait)
        except OSError:
            pass
        try:
            memory = {line.split(":")[0]: int(line.split()[1]) * 1024 for line in
                      (proc / "meminfo").read_text().splitlines() if line.endswith(" kB")}
            if "MemAvailable" in memory and "MemTotal" in memory:
                put("host_memory_available_bytes", memory["MemAvailable"])
                put("host_memory_total_bytes", memory["MemTotal"])
                put("host_memory_used_bytes", memory["MemTotal"] - memory["MemAvailable"])
        except OSError:
            pass
        try:
            for line in (proc / "net/dev").read_text().splitlines()[2:]:
                dev, fields = line.split(":", 1)
                label = "{interface=" + json.dumps(dev.strip()) + "}"
                put("host_receive_bytes_total", int(fields.split()[0]), label)
                put("host_transmit_bytes_total", int(fields.split()[8]), label)
        except OSError:
            pass
        try:
            for line in (proc / "diskstats").read_text().splitlines():
                fields = line.split()
                if len(fields) < 14 or fields[2].startswith(("ram", "loop")):
                    continue
                label = "{device=" + json.dumps(fields[2]) + "}"
                for name, (index, multiplier) in DISK_COUNTERS.items():
                    put(name, int(fields[index]) * multiplier, label)
        except OSError:
            pass
        return values, NETWORK_COUNTERS.union(DISK_COUNTERS)

    return read
