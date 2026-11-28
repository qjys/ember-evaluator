"""Exercise the adapter against an installed upstream parser and config manager (no model)."""
import json
import os
from pathlib import Path
import sys
import tempfile
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "runtime"))
from native import build_args, configured_manager, main
from ais_bench.benchmark.cli.argument_parser import ArgumentParser
from ais_bench.benchmark.cli.config_manager import ConfigManager

# Upstream resolves named configs relative to cwd/configs. Stand-ins use plain config
# types so this check needs the upstream CLI/config dependencies, not torch or a model.
with tempfile.TemporaryDirectory() as temp:
    root = Path(temp)
    before = Path.cwd()
    os.chdir(root)
    try:
        for kind, name, content in [
            ("models", "fixture_model", "models = [dict(type=str, attr='service', abbr='srv', url='', api_key='', batch_size=1)]"),
            ("datasets", "fixture_vqa", "fixture_datasets = [dict(abbr='images', path='old', reader_cfg=dict(input_columns=['image']))]"),
            ("summarizers", "fixture_perf", "summarizer = dict(attr='performance')"),
        ]:
            folder = root / "configs" / kind
            folder.mkdir(parents=True)
            (folder / (name + ".py")).write_text(content)
        dataset = {"name": "fixture_vqa"}
        native = {"backend": ["fixture_model"], "datasets": [dataset], "summarizer": "fixture_perf", "concurrency": [1, 8],
                  "dataCount": [100, 100], "stream": False, "warmups": 0, "requestRate": 0, "speculativeDecoding": True,
                  "pressureSeconds": 60, "maxOutputTokens": 32, "generationParams": {"temperature": 0}, "options": {"cooldown": 0}}
        config = {"native": native, "endpoint": "https://example.invalid/prefix/", "model": "fixture-vl",
                  "tokenizerPath": "/tokenizer", "apiKey": "fixture-key"}
        parser = ArgumentParser().parser
        argv = build_args(config, root, parser)
        args = parser.parse_args(argv)
        assert args.models == ["fixture_model"] and args.datasets == ["fixture_vqa"]
        assert (args.batch_size, args.num_prompts) == ([1, 8], [100, 100])
        assert args.spec_decode and args.stream is False and args.pressure and args.pressure_time == 60
        assert args.generation_kwargs == {"temperature": 0} and args.max_out_len == 32 and args.cooldown == 0
        assert args.num_warmups == args.request_rate == 0 and args.host_port == 443 and args.model_name == "fixture-vl"

        dataset["config"] = {"path": "/my photos/requests.jsonl", "reader_cfg": {"output_column": "answer"}}
        args = parser.parse_args(build_args(config, root, parser))
        assert args.models == ["fixture_model"] and args.datasets == ["fixture_vqa"]
        loaded = configured_manager(args, config)._get_config_from_arg()
        assert loaded.datasets[0].path == "/my photos/requests.jsonl"
        assert loaded.datasets[0].reader_cfg == {"input_columns": ["image"], "output_column": "answer"}
        assert loaded.models[0].url == config["endpoint"] and loaded.models[0].api_key == config["apiKey"]
        # Exercise the actual launcher with upstream TaskManager, stopping at workflow execution.
        (root / "run").mkdir()
        (root / "private.json").write_text(json.dumps({**config, "aisbenchVersion": "fixture"}))
        def capture(manager):
            model = manager.config_manager._load_models_config()[0]
            assert model.url == config["endpoint"] and model.api_key == config["apiKey"]
            assert manager.config_manager._load_datasets_config()[0].path == "/my photos/requests.jsonl"
            return 17
        with patch("ais_bench.benchmark.cli.task_manager.TaskManager.run", capture):
            assert main(root) == 17
        plan = (root / "run/native-plan.json").read_text()
        assert "fixture-key" not in plan and "--api-key=[REDACTED]" in plan
        assert ConfigManager(parser.parse_args(["--datasets", "fixture_vqa"]))._load_datasets_config()[0]["path"] == "old"
        for native_file in ({"remoteConfigFile": str(root / "config/model.py")}, {"configFile": "model.py"}):
            folder = root / "config"
            folder.mkdir(exist_ok=True)
            (folder / "model.py").write_text("models = []")
            file_args = parser.parse_args(build_args({**config, "native": {**native_file, "stream": True}}, root, parser))
            assert file_args.config and file_args.stream and file_args.model_name is None
        dataset["abbr"] = "missing-member"
        try:
            configured_manager(args, config)._load_datasets_config()
        except ValueError as error:
            assert "datasets[].abbr" in str(error)
        else:
            raise AssertionError("wrong override target accepted")
    finally:
        os.chdir(before)
print("Native CLI parameter and dataset override checks passed")
