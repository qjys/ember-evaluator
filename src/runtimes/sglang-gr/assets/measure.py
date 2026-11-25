"""Measure the non-streaming SGLang-GR catalog API on the serving host."""
import hashlib
import json
import math
import sys
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from http.client import HTTPException
from pathlib import Path


def locked_json(path, digest):
    data = Path(path).read_bytes()
    if hashlib.sha256(data).hexdigest() != digest:
        raise ValueError(f"input digest changed: {Path(path).name}")
    return json.loads(data)


def load_catalog(prefix1, prefix2):
    def components(value):
        return isinstance(value, list) and all(type(x) is int and 0 <= x < 8192 for x in value)

    if not isinstance(prefix1, dict) or not isinstance(prefix2, dict) or not prefix1 or not prefix2:
        raise ValueError("expected two non-empty sparse prefix dictionaries")
    for key, values in prefix1.items():
        if not key.isascii() or not key.isdecimal() or str(int(key)) != key or int(key) >= 8192 or not components(values):
            raise ValueError("invalid prefix1 catalog entry")
        prefix1[key] = set(values)
    for key, values in prefix2.items():
        pair = key.split(",")
        if (len(pair) != 2 or pair[0] not in prefix1 or not pair[1].isascii() or not pair[1].isdecimal()
                or str(int(pair[1])) != pair[1] or int(pair[1]) not in prefix1[pair[0]] or not components(values)):
            raise ValueError("invalid prefix2 catalog entry")
    if not any(prefix2.values()):
        raise ValueError("no complete SID in catalog")


def check_sid(ids, depth, prefix1, prefix2):
    if not isinstance(ids, list) or len(ids) != depth or not all(type(x) is int for x in ids):
        return "incomplete SID output"
    parts = [token - base for token, base in zip(ids, (151669, 159861, 168053))]
    if any(x < 0 or x >= 8192 for x in parts) or str(parts[0]) not in prefix1:
        return "output outside SID vocabulary or first-level catalog"
    if depth >= 2 and parts[1] not in prefix1[str(parts[0])]:
        return "output violates prefix1"
    if depth == 3 and parts[2] not in prefix2.get(f"{parts[0]},{parts[1]}", []):
        return "output violates prefix2"
    return None


def finite_score(value):
    try:
        score = float(value)
        return score if math.isfinite(score) else None
    except (ValueError, TypeError, OverflowError):
        return None


def record_choices(row, response, depth, prefix1, prefix2):
    if not isinstance(response, dict) or response.get("error"):
        row["error"] = "server returned a GR error"
        return
    choices = response.get("choices")
    if not isinstance(choices, list) or not choices or not all(isinstance(c, dict) for c in choices):
        row["error"] = "empty or malformed choices"
        return
    row.update(status="ok", choiceCount=len(choices), sidValid=True, scoresFinite=True)
    details = []
    row["candidates"] = []
    for index, choice in enumerate(choices):
        ids = choice.get("output_ids") or []
        score = finite_score(choice.get("score"))
        row["candidates"].append({"outputIds": ids, "score": score})
        problem = check_sid(ids, depth, prefix1, prefix2)
        details.append(problem or "(" + ",".join(str(i - base) for i, base in zip(ids, (151669, 159861, 168053))) + ")")
        row["sidValid"] &= problem is None
        row["scoresFinite"] &= score is not None
        row["outputTokens"] += len(ids) if isinstance(ids, list) else 0
        if index == 0:
            row.update(outputIds=ids if isinstance(ids, list) and all(type(i) is int for i in ids) else None,
                       score=score, finishReason=choice.get("finish_reason"))
        if problem:
            row["error"] = problem
        elif score is None:
            row["error"] = "non-finite candidate score"
    row["perTokenMs"] = row["e2eMs"] / row["outputTokens"] if row["outputTokens"] else 0.0
    row["sidDetail"] = "; ".join(details)


def catalog_tokenizer(directory, prefix1, prefix2):
    from transformers import AutoTokenizer
    tokenizer = AutoTokenizer.from_pretrained(directory, local_files_only=True)
    vocab = tokenizer.get_vocab()
    components = ({int(key) for key in prefix1}, {b for values in prefix1.values() for b in values},
                  {c for values in prefix2.values() for c in values})
    for axis, base, used in zip("abc", (151669, 159861, 168053), components):
        if any(vocab.get(f"<s_{axis}_{i}>") != base + i for i in used):
            raise ValueError(f"tokenizer has incompatible SID offsets for {axis}")
    return tokenizer


def input_lengths(tokenizer, prompts, target, tolerance):
    lengths = [len(tokenizer.encode(prompt, add_special_tokens=False)) for prompt in prompts]
    if any(abs(length - target) > tolerance for length in lengths):
        raise ValueError(f"prompt token lengths {lengths} differ from target {target} by more than {tolerance}")
    return lengths


def tokenize_inputs(directory, prompts, target, tolerance, prefix1, prefix2):
    return input_lengths(catalog_tokenizer(directory, prefix1, prefix2), prompts, target, tolerance)


def verify_catalog_files(paths, point):
    # The service opens the original paths. Detect replacements during the window.
    for name in ("prefix1.json", "prefix2.json"):
        digest = hashlib.sha256()
        with open(paths[name], "rb") as source:
            for chunk in iter(lambda: source.read(1024 * 1024), b""):
                digest.update(chunk)
        if digest.hexdigest() != point["digests"][name]:
            raise ValueError(f"catalog changed during the measurement: {name}")


def measure(config):
    point = config["workload"]
    paths = config["files"]
    length = point["length"]
    prompt_name = f"prompts-{length}.json"
    prompts = locked_json(paths[prompt_name], point["digests"][prompt_name])
    if not isinstance(prompts, list) or not prompts or not all(isinstance(p, str) and p.strip() for p in prompts):
        raise ValueError("prompt input must be a non-empty array of non-empty strings")
    if point["scenario"] == "north-star" and len(prompts) != 4:
        raise ValueError("north-star expects four prompts at each length")
    p1 = locked_json(paths["prefix1.json"], point["digests"]["prefix1.json"])
    p2 = locked_json(paths["prefix2.json"], point["digests"]["prefix2.json"])
    load_catalog(p1, p2)
    token_lengths = None
    if config.get("tokenizerPath"):
        token_lengths = tokenize_inputs(config["tokenizerPath"], prompts, length, config["lengthToleranceTokens"], p1, p2)

    def http(path, payload=None, timeout=60, parse=True):
        headers = {} if payload is not None else {"Accept": "application/json"}
        data = None
        if payload is not None:
            data = json.dumps(payload).encode("utf-8")
            headers["Content-Type"] = "application/json"
        if config["apiKey"] and config["apiKey"] != "EMPTY":
            headers["Authorization"] = "Bearer " + config["apiKey"]
        req = urllib.request.Request(config["endpoint"].rstrip("/") + path, data=data, headers=headers)
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            body = resp.read()
        return json.loads(body.decode("utf-8")) if parse else None

    http("/health", timeout=10, parse=False)
    catalog = {"begin_token": None, "end_token": None, "prefix1_file": paths["prefix1.json"], "prefix2_file": paths["prefix2.json"]}
    install = http("/v1/gr/catalog", catalog, config["timeout"])
    if not isinstance(install, dict) or install.get("error"):
        raise ValueError("GR catalog installation failed")
    options = {"beam_width": point["beamWidth"], "n": 1, "item_score_weight": 0.0, "ignore_eos": True,
               "constraint_backend": "catalog", "catalog_path": None, "prefix1_file": paths["prefix1.json"],
               "prefix2_file": paths["prefix2.json"], "begin_token": None, "end_token": None, "max_decode_steps": point["decodeSteps"]}

    def sample(phase, index):
        prompt_index = index % len(prompts)
        payload = {"prompt": prompts[prompt_index], **options}
        row = {"phase": phase, "index": index, "promptIndex": prompt_index, "promptCount": 1,
               "promptLength": len(prompts[prompt_index]), "status": "error", "error": None,
               "e2eMs": None, "ttftMs": None, "perTokenMs": None, "outputTokens": 0, "choiceCount": 0,
               "sidValid": None, "sidDetail": None, "scoresFinite": None, "outputIds": None, "score": None, "finishReason": None}
        start = time.perf_counter()
        try:
            response = http("/v1/gr/beam_search", payload, config["timeout"])
        except (OSError, ValueError, HTTPException) as exc:
            row["error"] = f"HTTP {exc.code}" if isinstance(exc, urllib.error.HTTPError) else type(exc).__name__
            if isinstance(exc, urllib.error.HTTPError):
                exc.close()
            return row
        elapsed = (time.perf_counter() - start) * 1000
        row.update(e2eMs=elapsed, ttftMs=elapsed)
        record_choices(row, response, point["decodeSteps"], p1, p2)
        return row

    output = Path(config["output"])
    if config.get("collection") == "profiling":
        from profile_capture import capture
        profile = capture(config, http, sample)
        verify_catalog_files(paths, point)
        return {"profile": profile}
    with (output / "session.jsonl").open("w", encoding="utf-8") as evidence:
        def save(row):
            evidence.write(json.dumps(row, allow_nan=False) + "\n")
            evidence.flush()

        for i in range(point["warmup"]):
            save(sample("warmup", i))
        try:
            reset = http("/debug/gr_counters?reset=true")
            reset_ok = isinstance(reset, dict) and reset.get("available") is not False and not reset.get("error")
        except (OSError, ValueError, HTTPException):
            reset_ok = False
        # Match gr_diag: include pool startup/drain, exclude evidence serialization.
        start = time.perf_counter()
        if point["concurrency"] == 1:
            records = [sample("measure", i) for i in range(point["requests"])]
        else:
            with ThreadPoolExecutor(max_workers=point["concurrency"]) as pool:
                records = list(pool.map(lambda i: sample("measure", i), range(point["requests"])))
        wall_seconds = time.perf_counter() - start
        for row in records:
            save(row)

    counters = None
    for path in ("/debug/gr_counters", "/v1/gr/counters"):
        try:
            candidate = http(path)
            if isinstance(candidate, dict) and candidate.get("available") is not False and not candidate.get("error"):
                counters = {k: v for k, v in candidate.items() if type(v) is int and v >= 0}
                note = candidate.get("gr_note_shared_prefix_exc")
                if isinstance(note, str):
                    key = config["apiKey"]
                    counters["gr_note_shared_prefix_exc"] = (note.replace(key, "[redacted]") if key else note)[:512]
            break
        except (OSError, ValueError, HTTPException):
            pass
    verify_catalog_files(paths, point)
    return {"wallSeconds": wall_seconds, "resetOk": reset_ok, "counters": counters, "inputTokens": token_lengths, "promptPoolSize": len(prompts)}


if __name__ == "__main__":
    try:
        print(json.dumps(measure(json.load(sys.stdin)), allow_nan=False))
    except Exception as error:
        print(f"{type(error).__name__}: {error}", file=sys.stderr)
        sys.exit(1)
