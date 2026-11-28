"""Exercise the installed official multimodal generator offline with tiny Parquet and tokenizer fixtures."""
import asyncio
import base64
import hashlib
import io
import json
from pathlib import Path
import sys
import tempfile
from unittest.mock import patch

import pyarrow as pa
import pyarrow.parquet as pq
from PIL import Image
from tokenizers import Tokenizer, models, pre_tokenizers
from transformers import PreTrainedTokenizerFast

sys.path.insert(0, str(Path(sys.argv[1]).resolve()))
from native import main, multimodal_inputs, multimodal_configs
from ais_bench.benchmark.models.output import RequestOutput
from ais_bench.benchmark.openicl.icl_inferencer import GenInferencer
from ais_bench.benchmark.openicl.icl_retriever import ZeroRetriever
from ais_bench.benchmark.utils.config import build_dataset_from_cfg
from ais_bench_prefix_cache.datasets import MultimodalPrefixCacheDataset
from ais_bench_prefix_cache.errors import ArtifactValidationError
from ais_bench_prefix_cache.openicl import Base64RefMMPromptTemplate

with tempfile.TemporaryDirectory(prefix="ais-mm-") as tmp:
    root = Path(tmp)
    corpus = root / "corpus.jsonl"
    corpus.write_text('{"question":"one alpha beta","answer":"1"}\n{"question":"two alpha beta","answer":"2"}\n', encoding="utf-8")
    raw = Tokenizer(models.WordLevel({"[UNK]": 0, "one": 1, "two": 2, "alpha": 3, "beta": 4}, unk_token="[UNK]"))
    raw.pre_tokenizer = pre_tokenizers.Whitespace()
    tokenizer = PreTrainedTokenizerFast(tokenizer_object=raw, unk_token="[UNK]")
    tokenizer.save_pretrained(root / "tokenizer")
    config = {"model": "fixture", "endpoint": "http://localhost/", "tokenizerPath": str(root / "tokenizer"),
              "native": {"dataCount": [2, 2], "concurrency": [1, 8], "maxOutputTokens": 32}}
    cases = [("single_1080p", (1920, 1080), 1), ("multi_720p_5", (1280, 720), 5)]
    images = {}
    for scenario, size, count in cases:
        image = io.BytesIO()
        Image.new("RGB", size, "white").save(image, format="PNG")
        encoded = image.getvalue()
        images[scenario] = encoded
        pq.write_table(pa.Table.from_pylist([{"id": scenario, "image_1": {"bytes": encoded, "path": "sample.png"}}]), root / (scenario + ".parquet"))
    config["native"]["multimodalGeneration"] = {"imageScenario": list(images), "mmmuParquetDir": str(root),
                                               "corpusPath": str(corpus), "textTokens": 2, "outputTokens": 256, "outputDirectory": str(root / "saved")}
    manifest, prepared = multimodal_inputs(config, root)
    assert prepared["requests"] == 2 and prepared["maxOutputTokens"] == 256 and manifest["output_tokens"] == 256
    assert "base64" not in json.dumps(prepared)
    generation = config["native"].pop("multimodalGeneration")
    config["native"]["multimodalManifest"] = prepared["manifestPath"]
    reused, validated = multimodal_inputs(config, root)
    assert validated == prepared and manifest == reused
    datasets = multimodal_configs(config, root, reused)
    assert {row.abbr for row in datasets} == set(images)
    assert {row["imageScenario"] for row in prepared["datasets"]} == set(images)
    for scenario, size, count in cases:
        dataset, = [row for row in datasets if row.abbr == scenario]
        summary, = [row for row in prepared["datasets"] if row["imageScenario"] == scenario]
        encoded = images[scenario]
        assert summary["imagesPerRequest"] == count and (summary["width"], summary["height"]) == size
        assert summary["imageSha256"] == hashlib.sha256(encoded).hexdigest()
        assert dataset.abbr == scenario
        rows = MultimodalPrefixCacheDataset.load(dataset.path)
        assert len(rows) == 2 and rows[0]["question"] != rows[1]["question"]
        template = dataset.infer_cfg.prompt_template
        formatter = Base64RefMMPromptTemplate(template=template.template, media=template.media)
        for row in rows:
            assert len(tokenizer.encode(row["question"], add_special_tokens=False)) == 2
            message, = [turn["prompt_mm"] for turn in formatter.generate_item(dict(row)) if "prompt_mm" in turn]
            assert [part["type"] for part in message] == ["image_url"] * count + ["text"]
            assert message[-1]["text"] == row["question"]
            for part in message[:-1]:
                header, data = part["image_url"]["url"].split(",", 1)
                assert header == "data:image/png;base64" and base64.b64decode(data) == encoded
    # Two datasets sharing the upstream Python class must never go through one
    # summarizer call: native perf would merge their request streams into one row.
    (root / "run").mkdir()
    run_options = {"backend": ["vllm_api_general_chat"], "concurrency": [1, 8], "dataCount": [1, 2]}
    saved = {"multimodalManifest": prepared["manifestPath"]}
    invocations = {}

    def capture(manager):
        dataset, = manager.config_manager._load_datasets_config()
        assert manager.args.batch_size == [1, 8] and manager.args.num_prompts == [1, 2]
        invocations[dataset.abbr] = manager.args.work_dir
        model, = manager.config_manager._load_models_config()
        inferencer = GenInferencer(model_cfg=model.to_dict(), mode="perf")
        retriever = ZeroRetriever(build_dataset_from_cfg(dataset.to_dict()),
                                  prompt_template=dataset.infer_cfg.prompt_template.to_dict())
        samples = inferencer.get_data_list(retriever)
        assert len(samples) == 2
        for sample in samples:
            body = asyncio.run(inferencer.model.get_request_body(
                sample["prompt"], sample["max_out_len"], RequestOutput(perf_mode=True)))
            assert body["max_tokens"] == expected_tokens, (body["max_tokens"], expected_tokens)

    with patch("ais_bench.benchmark.cli.task_manager.TaskManager.run", capture):
        for options, expected_tokens in [
            ({"multimodalGeneration": generation, "maxOutputTokens": 32}, 32),
            ({**saved, "maxOutputTokens": 32}, 32),
            ({**saved, "maxOutputTokens": 512}, 256),
            (saved, 256),
        ]:
            job = {**config, "native": {**run_options, **options}, "aisbenchVersion": "fixture"}
            (root / "private.json").write_text(json.dumps(job))
            invocations.clear()
            assert main(root) == 0
            assert set(invocations) == set(images) and len(set(invocations.values())) == 2
    assert multimodal_inputs(config, root) == (manifest, prepared)
    Path(manifest["datasets"]["multi_720p_5"]["path"]).write_text("{}\n", encoding="utf-8")
    try:
        multimodal_inputs(config, root)
    except ArtifactValidationError as exc:
        assert "checksum" in str(exc)
    else:
        raise AssertionError("Corrupt dataset passed manifest validation")
print(json.dumps({"passed": True}))
