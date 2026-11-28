"""Translate an evaluator measurement into one installed AISBench performance command."""
import argparse
import base64
import hashlib
import importlib.metadata
import json
import os
from pathlib import Path
import shutil
import sys
import tempfile
from copy import copy
from urllib.parse import urlsplit


def prepare_run(root, config):
    if importlib.metadata.version("ais-bench-benchmark") != config["aisbenchVersion"]:
        raise ValueError("AISBench version differs from configured aisbenchVersion")
    run = root / "run"
    run.mkdir()
    for item in config.get("uploads", []):
        dest = run / "config" / item["path"]
        if not dest.resolve().is_relative_to((run / "config").resolve()):
            raise ValueError("Invalid AISBench config file path")
        data = base64.b64decode(item["data"], validate=True)
        if hashlib.sha256(data).hexdigest() != item["sha256"]:
            raise ValueError("AISBench config upload digest mismatch")
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_bytes(data)
    env = {**os.environ, "PATH": str(Path(config["pythonExecutable"]).parent) + os.pathsep + os.environ.get("PATH", ""),
           "PYTHONUNBUFFERED": "1"}
    return config.get("workingDirectory", run), [config["pythonExecutable"], "-u", str(Path(__file__).resolve()), str(root)], env


def scalar(value):
    if isinstance(value, (list, dict, bool)) or value is None:
        return json.dumps(value, ensure_ascii=False, allow_nan=False, separators=(",", ":"))
    return str(value)


def option_args(parser, key, value):
    flag = "--" + key
    action = parser._option_string_actions.get(flag)
    if action is None:
        raise ValueError(f"Installed AISBench does not support {flag}")
    if isinstance(value, bool) and action.nargs == 0:
        if isinstance(action, argparse.BooleanOptionalAction):
            return [flag if value else next(name for name in action.option_strings if name != flag)]
        if not isinstance(action, (argparse._StoreTrueAction, argparse._StoreFalseAction)):
            raise ValueError(f"Cannot map boolean value to {flag}")
        if not value and action.default != (not action.const):
            raise ValueError(f"No explicit off switch for {flag}")
        return [flag] if value else []
    if action.nargs == 0:
        raise ValueError(f"{flag} expects a YAML boolean")
    if isinstance(value, list):
        if isinstance(action, argparse._AppendAction):
            if action.nargs is None:
                return [f"{flag}={scalar(item)}" for item in value]
            if any(isinstance(item, list) for item in value):
                repeated = []
                for group in value:
                    if not isinstance(group, list) or not group or any(scalar(item).startswith("-") for item in group):
                        raise ValueError(f"{flag} expects a list of argument groups")
                    repeated.extend([flag, *map(scalar, group)])
                return repeated
        if action.nargs not in ("*", "+") and not isinstance(action.nargs, int):
            raise ValueError(f"{flag} does not accept a list in this AISBench version")
        values = [scalar(item) for item in value]
        if any(item.startswith("-") and not item.lstrip("-").replace(".", "", 1).isdigit() for item in values):
            raise ValueError(f"{flag} list contains an option-like value")
        return [flag, *values]
    return [f"{flag}={scalar(value)}"]


def merge_fields(target, fields):
    for key, value in fields.items():
        if isinstance(value, dict) and isinstance(target.get(key), dict):
            merge_fields(target[key], value)
        else:
            target[key] = value


def multimodal_inputs(config, run):
    """Produce or validate the official manifest before binding any model or sending requests."""
    try:
        from ais_bench_prefix_cache.multimodal import prepare_multimodal_datasets, validate_multimodal_manifest
    except ImportError as exc:
        raise RuntimeError("Multimodal generation requires the AISBench plugins/prefix_cache package "
                           "and its dependencies in the remote Python environment") from exc
    native = config["native"]
    generation = native.get("multimodalGeneration", {})
    if "multimodalManifest" in native:
        manifest_path = Path(native["multimodalManifest"])
        validate_multimodal_manifest(manifest_path)
    else:
        directory = run / "generated"
        if "outputDirectory" in generation:
            parent = Path(generation["outputDirectory"])
            parent.mkdir(parents=True, exist_ok=True)
            directory = Path(tempfile.mkdtemp(prefix="aisbench-mm-", dir=parent))
        try:
            manifest_path = prepare_multimodal_datasets(
                tokenizer_path=config["tokenizerPath"],
                gsm8k_path=generation.get("corpusPath", Path(__file__).parent / "upstream/GSM8K.jsonl"),
                mmmu_parquet_dir=generation["mmmuParquetDir"], output_dir=directory,
                scenarios=generation["imageScenario"], request_count=config.get("generationCount", max(native["dataCount"])),
                text_tokens=generation["textTokens"], output_tokens=generation.get("outputTokens", native["maxOutputTokens"]),
                trust_remote_code=native.get("options", {}).get("trust-remote-code") is True,
            )
        except Exception:
            if "outputDirectory" in generation:
                shutil.rmtree(directory)
            raise
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    summaries = []
    for name, dataset in manifest["datasets"].items():
        image = dataset["image"]
        summaries.append({"imageScenario": name, "requests": dataset["rows"],
                          "imagesPerRequest": dataset["image_count_per_request"], "width": image["width"],
                          "height": image["height"], "imageSha256": image["sha256"], "datasetSha256": dataset["sha256"]})
    summary = {"datasets": summaries, "requests": manifest["request_count"], "textTokens": manifest["text_tokens"],
               "maxOutputTokens": manifest["output_tokens"], "corpusSha256": manifest["corpus"]["sha256"],
               "generatorVersion": manifest["plugin_version"], "manifestSha256": hashlib.sha256(manifest_path.read_bytes()).hexdigest()}
    if len(summaries) == 1:
        summary.update(summaries[0])  # Preserve the single-preset evidence format.
    if "multimodalManifest" in native or "outputDirectory" in generation:
        summary["manifestPath"] = str(manifest_path)
    return manifest, summary


def multimodal_configs(config, run, manifest):
    from ais_bench_prefix_cache.multimodal_aisbench_config import build_aisbench_config
    from mmengine.config import Config

    datasets = []
    abbr = config["native"].get("options", {}).get("dataset-abbr")
    model_limit = config["native"].get("maxOutputTokens", manifest["output_tokens"])
    for name, dataset in manifest["datasets"].items():
        image = dataset["image"]
        path = run / f"dataset_{name}.py"
        path.write_text(build_aisbench_config(
            dataset_path=dataset["path"], dataset_abbr=(f"{abbr}-{name}" if abbr and len(manifest["datasets"]) > 1 else abbr or name),
            tokenizer_path=config.get("tokenizerPath", manifest["tokenizer"]["path"]),
            inference_url=config["endpoint"], model=config["model"], work_dir=run / "outputs",
            image_ref=image["ref"], image_data_url=image["data_url"], output_tokens=manifest["output_tokens"],
        ), encoding="utf-8")
        dataset_config, = Config.fromfile(str(path)).datasets
        if model_limit < manifest["output_tokens"]:
            # The validated rows all use the manifest length. AISBench prioritizes
            # that column over the model limit whenever the reader exposes it.
            columns = dataset_config.reader_cfg.input_columns
            dataset_config.reader_cfg.input_columns = [col for col in columns if col != "max_out_len"]
        datasets.append(dataset_config)
    return datasets


def configured_manager(args, config, generated_datasets=None):
    from ais_bench.benchmark.cli.config_manager import ConfigManager

    class YamlConfigManager(ConfigManager):
        def load_config(self, workflow):
            cfg = super().load_config(workflow)
            output = Path(cfg.work_dir)
            # A single concurrency setting has no upstream combos manifest, even when
            # several model/dataset pairs will be attempted. Keep their expected IDs.
            if not (output / "combos_manifest.json").exists() and not self.args.merge_ds:
                pairs = cfg.get("model_dataset_combinations") or [cfg]
                combos = [{"model_abbr": m["abbr"], "dataset_abbr": d["abbr"], "batch_size": m.get("batch_size")}
                          for pair in pairs for m in pair["models"] for d in pair["datasets"] if m.get("abbr") and d.get("abbr")]
                (output / "evaluator-expected.json").write_text(json.dumps({"combos": combos}), encoding="utf-8")
            return cfg

        def _load_models_config(self):
            models = super()._load_models_config()
            for model in models:
                if model.get("attr", "service") != "service" or model.get("url") != config["endpoint"]:
                    raise ValueError("backend must support the bound evaluator service URL")
                if config.get("apiKey") and model.get("api_key") != config["apiKey"]:
                    raise ValueError("backend does not accept the bound service credentials")
            return models

        def _load_datasets_config(self):
            if generated_datasets is not None:
                return generated_datasets
            items = config["native"]["datasets"]
            if not any("config" in item or "abbr" in item for item in items):
                return super()._load_datasets_config()
            datasets = []
            for index, item in enumerate(items):
                single = copy(self.args)
                single.datasets = [item["name"]]
                members = ConfigManager(single)._load_datasets_config()
                if "config" in item or "abbr" in item:
                    targets = [m for m in members if "abbr" not in item or m.get("abbr") == item["abbr"]]
                    if len(targets) != 1:
                        raise ValueError(f"datasets[{index}] must select one member to override; check datasets[].abbr")
                    merge_fields(targets[0], item.get("config", {}))
                datasets.extend(members)
            return datasets

    return YamlConfigManager(args)


def build_args(config, run, parser, generated_name=None, work_dir=None):
    native = config["native"]
    args = []
    if "backend" in native:
        datasets = [generated_name] if generated_name else [d["name"] for d in native["datasets"]]
        args += ["--models", *native["backend"], "--datasets", *datasets,
                 "--summarizer", native.get("summarizer", "default_perf")]
        endpoint = urlsplit(config["endpoint"])
        args += ["--model-name=" + config["model"], "--url=" + config["endpoint"], "--host-ip=" + endpoint.hostname,
                 "--host-port=" + str(endpoint.port or (443 if endpoint.scheme == "https" else 80))]
        if config.get("apiKey"):
            args += ["--api-key=" + config["apiKey"]]
    else:
        path = Path(native["remoteConfigFile"]) if "remoteConfigFile" in native else run / "config" / native["configFile"]
        if not path.is_file():
            raise ValueError(f"Cannot read AISBench configuration {path}")
        args.append(str(path))
    args += ["--mode", "perf", "--work-dir", str(work_dir or run / "outputs")]
    if config.get("tokenizerPath"):
        args += ["--path", config["tokenizerPath"]]
    fields = {"concurrency": "batch-size", "dataCount": "num-prompts", "requestRate": "request-rate",
              "warmups": "num-warmups", "maxOutputTokens": "max-out-len", "stream": "stream",
              "speculativeDecoding": "spec-decode", "generationParams": "generation-kwargs"}
    for field, key in fields.items():
        if field in native:
            value = native[field]
            if field in ("concurrency", "dataCount") and len(value) == 1:
                value = value[0]
            args += option_args(parser, key, value)
    if "pressureSeconds" in native:
        args += option_args(parser, "pressure", True) + option_args(parser, "pressure-time", native["pressureSeconds"])
    for key, value in native.get("options", {}).items():
        if key == "dataset-abbr" and generated_name:
            continue  # The generated dataset already has its scenario-specific abbreviation.
        action = parser._option_string_actions.get("--" + key)
        if action and action.container.title in {"agent_args", "agentx_args", "accuracy_args", "custom_dataset_args"}:
            raise ValueError(f"options.{key} does not apply to this native performance selection")
        args += option_args(parser, key, value)
    return args


def main(root):
    config = json.loads((root / "private.json").read_text(encoding="utf-8"))
    native = config["native"]
    run = root / "run"
    plan = {"workingDirectory": str(Path.cwd()), "version": config["aisbenchVersion"]}
    selections = [(None, None, run / "outputs")]
    if "multimodalGeneration" in native or "multimodalManifest" in native:
        manifest, plan["multimodalGeneration"] = multimodal_inputs(config, run)
        action = native.get("multimodalAction", "run")
        plan["multimodalAction"] = action
        if action in ("prepare", "validate"):
            (run / "native-plan.json").write_text(json.dumps(plan, ensure_ascii=False, indent=2), encoding="utf-8")
            return 0
        counts = native.setdefault("dataCount", [manifest["request_count"]] * len(native.get("concurrency", [1])))
        if max(counts) > manifest["request_count"]:
            raise ValueError("dataCount exceeds the number of requests in the multimodal manifest")
        native.setdefault("maxOutputTokens", manifest["output_tokens"])
        native.setdefault("stream", True)
        if "generation-kwargs" not in native.get("options", {}):
            native.setdefault("generationParams", {"temperature": 0, "ignore_eos": True})
        config.setdefault("tokenizerPath", manifest["tokenizer"]["path"])
        # The native performance summarizer merges datasets of the same Python class.
        # Isolate each image preset exactly as the upstream multimodal runner does.
        datasets = multimodal_configs(config, run, manifest)
        selections = [(name, [dataset], run / "outputs" / name if len(datasets) > 1 else run / "outputs")
                      for name, dataset in zip(manifest["datasets"], datasets, strict=True)]
        print("AISBench multimodal dataset prepared", flush=True)
    from ais_bench.benchmark.cli.argument_parser import ArgumentParser
    from ais_bench.benchmark.cli.task_manager import TaskManager
    parser = ArgumentParser().parser
    def execute(args, service, selected):
        sys.argv = ["ais_bench", *args]
        manager = TaskManager()
        manager.config_manager = configured_manager(manager.args, service, selected)
        return manager.run()

    def public_args(args):
        return ["ais_bench", *["--api-key=[REDACTED]" if a.startswith("--api-key=") else a for a in args]]

    if native.get("profiling") or native.get("engineMetrics"):
        from service_collections import run_collections
        plan["commands"] = []
        def run_window(service, name, selected, work_dir):
            args = build_args(service, run, parser, name, work_dir)
            plan["commands"].append(public_args(args))
            (run / "native-plan.json").write_text(json.dumps(plan, ensure_ascii=False, indent=2), encoding="utf-8")
            return execute(args, service, selected)
        run_collections(config, run, selections, run_window)
        return 0
    commands = [(build_args(config, run, parser, name, work_dir), selected) for name, selected, work_dir in selections]
    public_commands = [public_args(args) for args, _ in commands]
    if len(commands) == 1:
        plan["argv"] = public_commands[0]
    else:
        plan["commands"] = public_commands
    if "configFile" in native or "remoteConfigFile" in native:
        entry = Path(commands[0][0][0])
        plan["configSha256"] = hashlib.sha256(entry.read_bytes()).hexdigest()
        sys.path.insert(0, str(entry.parent))
        os.environ["PYTHONPATH"] = os.pathsep.join([str(entry.parent), str(run / "config"), os.environ.get("PYTHONPATH", "")])
        os.environ.update(EVALUATOR_AISBENCH_MODEL=config["model"], EVALUATOR_AISBENCH_BASE_URL=config["serviceEndpoint"],
                          EVALUATOR_AISBENCH_API_KEY=config.get("apiKey", ""))
    (run / "native-plan.json").write_text(json.dumps(plan, ensure_ascii=False, indent=2), encoding="utf-8")
    # The secret is passed to the installed CLI inside this process, outside OS argv.
    for args, selected in commands:
        code = execute(args, config, selected)
        if code:
            return code
    return 0


if __name__ == "__main__":
    sys.exit(main(Path(sys.argv[1])))
