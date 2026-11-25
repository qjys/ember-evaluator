import json
import sys
from pathlib import Path

path = Path(sys.argv[1])
m = json.loads(path.read_text(encoding="utf-8"))["metrics"]["recommendation-performance"]
print("report:", path.with_name("report.md"))
print("scenario:", m["scenario"], "tag:", m["tag"], "fast:", m["fast"])
if m["scenario"] == "north-star":
    gate = m.get("northStar") or {}
    print("five_lengths_valid:", m["complete"], "budget:", gate.get("budgetVersion", "legacy-eager"),
          "gate:", gate.get("gate", "eager"), "L128:", gate.get("l128"), "overall:", gate.get("overall"))
print("L\tvalid\trequests\tp50_ms\tfastpath\tshared/decode\tratio")
for r in m["points"]:
    ratio = r["fastpathRatio"]
    print(r["length"], r["valid"], f'{r["successfulRequests"]}/{r["requests"]}', r["p50Ms"], r.get("fastpathStatus", "unverified"),
          f'{r["fastpathForward"]}/{r["decodeForward"]}',
          "unknown" if ratio is None else f"{ratio:.1%}", sep="\t")
    if r.get("invalidReasons"):
        print("  ", "；".join(r["invalidReasons"]))
