"""Apply the configured service effort in every pinned AgentX worker process."""

import os

# AgentX 1.0.7 resolves absolute tokenizer paths as Hub IDs when offline.
# Weka also starts fresh interpreters to reconstruct trees with this tokenizer.
staged = os.environ.get("EVALUATOR_AGENTX_TOKENIZER")
if staged:
    from aiperf.common.tokenizer import Tokenizer

    resolve_snapshot = Tokenizer._resolve_local_snapshot

    def local_snapshot(cls, name, revision):
        if str(name) == staged:
            return staged
        return resolve_snapshot(name, revision)

    Tokenizer._resolve_local_snapshot = classmethod(local_snapshot)

effort = os.environ.get("EVALUATOR_AGENTX_REASONING_EFFORT")
if effort:
    try:
        from aiperf.endpoints.openai_chat import ChatEndpoint
        from reasoning_effort import apply_reasoning_effort

        original = ChatEndpoint.format_payload

        def format_payload(self, request_info):
            return apply_reasoning_effort(original(self, request_info), effort)

        ChatEndpoint.format_payload = format_payload
    except Exception as error:
        raise SystemExit(f"Cannot apply AgentX service reasoning effort: {error}") from error
