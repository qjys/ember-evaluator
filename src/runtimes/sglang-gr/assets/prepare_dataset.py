"""Offline GR source preparation. Output digests always describe the exact bytes parsed."""
import hashlib
import json
import random
import sys
import tempfile
from pathlib import Path

from measure import catalog_tokenizer, input_lengths, load_catalog

GENERATOR_VERSION = 1
INTRO = "你是一个智能跨域推荐助手，能够根据用户观看的视频内容和历史购物行为，预测用户接下来可能点击的商品。"
QUESTION = "分析用户的行为偏好，预测用户下一步会点击哪些商品。"


def sha(data):
    return hashlib.sha256(data).hexdigest()


def write_json(path, value):
    data = (json.dumps(value, ensure_ascii=False, separators=(",", ":"), sort_keys=True) + "\n").encode("utf-8")
    path.write_bytes(data)
    return sha(data)


def tokenizer_identity(tokenizer):
    import transformers
    import tokenizers
    # Snapshot only what the loaded tokenizer serializes, never the model weights.
    with tempfile.TemporaryDirectory() as temp:
        tokenizer.save_pretrained(temp)
        files = {f.relative_to(temp).as_posix(): sha(f.read_bytes())
                 for f in sorted(Path(temp).rglob("*")) if f.is_file()}
    return {"class": type(tokenizer).__name__, "files": files,
            "sha256": sha(json.dumps(files, sort_keys=True).encode()),
            "transformers": transformers.__version__, "tokenizers": tokenizers.__version__}


def generate_prompt(pool, tokenizer, target, tolerance, rng):
    items = []

    def candidate(count):
        while len(items) < count:
            a, b, choices = rng.choice(pool)
            c = rng.choice(choices)
            items.append(f"<|sid_begin|><s_a_{a}><s_b_{b}><s_c_{c}><|sid_end|>")
        split = (count + 1) // 2
        prompt = (INTRO + "\n用户长时间观看的视频：" + "".join(items[:split])
                  + "\n用户浏览过的商品：" + "".join(items[split:count]) + "\n" + QUESTION)
        return prompt, len(tokenizer.encode(prompt, add_special_tokens=False))

    first, minimum = candidate(1)
    if minimum > target + tolerance:
        raise ValueError(f"L={target}: template and one complete SID require {minimum} tokens (tolerance {tolerance})")
    # A complete item contains three validated SID component tokens. Five tokens
    # per wrapped SID is a useful estimate; accept only after encoding the text.
    guess = max(1, 1 + round((target - minimum) / 5))
    prompt, actual = candidate(guess)
    if abs(actual - target) <= tolerance:
        return prompt, actual
    low, high = 1, guess
    while actual < target - tolerance:
        low, high = high + 1, high * 2
        prompt, actual = candidate(high)
    while low <= high:
        count = (low + high) // 2
        prompt, actual = candidate(count)
        if abs(actual - target) <= tolerance:
            return prompt, actual
        if actual < target:
            low = count + 1
        else:
            high = count - 1
    raise ValueError(f"L={target}: no complete SID history fits lengthToleranceTokens={tolerance} (minimum {minimum})")


def prepare(config):
    digests = {}

    def read_file(name, path):
        data = Path(path).read_bytes()
        digests[name] = sha(data)
        return json.loads(data)

    p1 = read_file("prefix1.json", config["prefix1File"])
    p2 = read_file("prefix2.json", config["prefix2File"])
    load_catalog(p1, p2)
    tokenizer = catalog_tokenizer(config["tokenizerPath"], p1, p2) if config.get("tokenizerPath") else None
    tolerance = config["tolerance"]
    generator = config.get("generator")
    manifest = None
    if generator:
        if tokenizer is None:
            raise ValueError("generated data requires a local tokenizerPath")
        output = Path(config["staging"])
        pool = [(*key.split(","), values) for key, values in sorted(p2.items()) if values]
        manifest = {"generatorVersion": GENERATOR_VERSION, **generator, "lengthToleranceTokens": tolerance,
                    "catalogSha256": dict(digests), "tokenizer": tokenizer_identity(tokenizer), "points": []}
    for point in config["inputs"]:
        target = point["length"]
        logical = f"prompts-{target}.json"
        if generator:
            prompts, lengths = [], []
            for index in range(generator["samplesPerLength"]):
                rng = random.Random(f"{generator['seed']}:{target}:{index}")
                prompt, actual = generate_prompt(pool, tokenizer, target, tolerance, rng)
                prompts.append(prompt)
                lengths.append(actual)
            digests[logical] = write_json(output / point["file"], prompts)
            manifest["points"].append({"length": target, "file": point["file"], "samples": len(prompts),
                                       "uniquePrompts": len(set(prompts)), "tokenLengths": lengths, "sha256": digests[logical]})
        else:
            prompts = read_file(logical, point["file"])
            if not isinstance(prompts, list) or not prompts or not all(isinstance(p, str) and p.strip() for p in prompts):
                raise ValueError(f"L={target}: expected a non-empty array of prompt strings")
            if config["scenario"] == "north-star" and len(prompts) != 4:
                raise ValueError(f"L={target}: north-star expects four prompts")
            if tokenizer is not None:
                input_lengths(tokenizer, prompts, target, tolerance)
    result = {"digests": digests}
    if manifest is not None:
        result["manifestSha256"] = write_json(output / "dataset.json", manifest)
    return result


if __name__ == "__main__":
    try:
        print(json.dumps(prepare(json.load(sys.stdin))))
    except Exception as error:
        sys.exit(f"{type(error).__name__}: {error}")
