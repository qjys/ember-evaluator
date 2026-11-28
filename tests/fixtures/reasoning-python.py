import importlib.util
import json
import os
import subprocess
from pathlib import Path
import sys
from tempfile import TemporaryDirectory
import types

root = Path(sys.argv[1])


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


helper = load("reasoning_effort", root / "src/runtimes/shared/assets/reasoning_effort.py")
source = {"reasoning_effort": "high", "thinking": {"type": "disabled"}}
assert helper.apply_reasoning_effort(source, "low") == {
    "reasoning_effort": "low", "thinking": {"type": "enabled"}
}
assert source["reasoning_effort"] == "high"
assert source["thinking"]["type"] == "disabled"


class ChatEndpoint:
    def format_payload(self, request):
        return request


endpoint = types.ModuleType("aiperf.endpoints.openai_chat")
endpoint.ChatEndpoint = ChatEndpoint
sys.modules["aiperf.endpoints.openai_chat"] = endpoint
sys.modules["reasoning_effort"] = helper
os.environ["EVALUATOR_AGENTX_REASONING_EFFORT"] = "low"
load("controlled_agentx_startup", root / "src/runtimes/agentx/assets/sitecustomize.py")
assert ChatEndpoint().format_payload(source)["reasoning_effort"] == "low"
assert source["reasoning_effort"] == "high"

runner = root / "src/runtimes/deepagents/assets/runner.py"
with TemporaryDirectory() as directory:
    factory = Path(directory) / "agent.py"
    factory.write_text("""
class Message:
    type = "ai"
    content = "complete"


class Graph:
    def invoke(self, state):
        return {"messages": [Message()]}


def build_agent_for_run(*, policy, mcp_servers, skills_directories, tools, middleware, reasoning_effort=None):
    assert reasoning_effort == "max", reasoning_effort
    return Graph()
""", encoding="utf-8")
    command = [sys.executable, str(runner), "--bundle-dir", directory, "--factory-module", "agent.py"]
    result = subprocess.run(command, input=json.dumps({"prompt": "hello", "reasoningEffort": "max"}),
                            text=True, capture_output=True, check=True)
    assert json.loads(result.stdout.splitlines()[-1]) == {"type": "final", "text": "complete"}
    factory.write_text(factory.read_text(encoding="utf-8")
                       .replace(", reasoning_effort=None", "")
                       .replace('    assert reasoning_effort == "max", reasoning_effort\n', ""), encoding="utf-8")
    result = subprocess.run(command, input=json.dumps({"prompt": "hello", "reasoningEffort": "max"}),
                            text=True, capture_output=True, check=False)
    assert result.returncode == 1
    assert "must accept reasoning_effort" in json.loads(result.stdout.splitlines()[-1])["message"]
    subprocess.run(command, input=json.dumps({"prompt": "hello"}), text=True, capture_output=True, check=True)
print("Python reasoning overrides passed")
