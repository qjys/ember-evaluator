"""Add optional tool policy and validated images to the pinned process CLI."""

from __future__ import annotations

import base64
import contextlib
import json
import os
import sys
import tempfile
from pathlib import Path


def main() -> None:
    # The SDK passes an empty proxy URL to HTTPX instead of connecting directly.
    # Docker uses empty values to clear inherited proxies.
    for name in ("http_proxy", "https_proxy", "HTTP_PROXY", "HTTPS_PROXY", "all_proxy", "ALL_PROXY"):
        if name in os.environ and not os.environ[name].strip():
            del os.environ[name]

    incoming = json.load(sys.stdin)
    # Older image-only callers send a media array.
    media = incoming if isinstance(incoming, list) else incoming.get("media", [])
    resources = {} if isinstance(incoming, list) else incoming
    policy_errors = []
    tool_policy = json.loads(os.environ.pop("EVALUATOR_JIUWENSWARM_TOOL_POLICY", "{}"))
    with contextlib.redirect_stdout(sys.stderr):
        if tool_policy:
            from tool_policy import install_tool_policy

            install_tool_policy(tool_policy, policy_errors.append)
        from tool_policy import install_task_resources

        install_task_resources(tool_policy, resources)
    # Keep the original CLI's renderer, cancellation, permissions and Runtime close.
    # Only its text-only request builder needs an attachment bridge.
    with contextlib.redirect_stdout(sys.stderr):
        from jiuwenswarm.channels.process_cli import app
        from jiuwenswarm.channels.process_cli.main import main as cli_main
    def run_cli():
        try:
            cli_main()
        finally:
            # The SDK can finish a turn normally after a rail stops it. Keep the
            # diagnostic out of scored answers and let the host classify it.
            if policy_errors:
                print("\n" + json.dumps({"evaluatorConfigurationError": policy_errors[0]}), flush=True)
                raise SystemExit(78)

    if not media:
        run_cli()
        return
    with contextlib.redirect_stdout(sys.stderr):
        from jiuwenswarm.server.runtime.agent_adapter.interface_deep import JiuWenSwarmDeepAdapter
        from jiuwenswarm.server.runtime.agent_adapter.interface_code import JiuwenSwarmCodeAdapter
        from jiuwenswarm.agents.harness.common.rails.multimodal_image_rail import MultimodalImageRail
        from jiuwenswarm.agents.harness.common.prompt import user_prompt_builder
        from jiuwenswarm.agents.harness.common.prompt.user_prompt_builder import ensure_multimodal_image_window_mutator

    original_build = app._build_request
    original_status = JiuWenSwarmDeepAdapter._native_image_input_status

    def require_native(config, model):
        status = original_status(config, model)
        if status != "supported":
            raise RuntimeError(f"Evaluator requires native image input; JiuwenSwarm reports {status}")
        return status

    JiuWenSwarmDeepAdapter._native_image_input_status = staticmethod(require_native)
    # The pinned builder replaces the latest user's content when attaching files.
    # That user message may already contain a native read_file image from a tool.
    original_append = user_prompt_builder._append_image_files_to_content

    def append_images(content, image_files):
        updated, count = original_append(content, image_files)
        if count and isinstance(content, list):
            for part in content:
                if user_prompt_builder.is_image_content_block(part) and part not in updated:
                    updated.append(part)
        return updated, count

    user_prompt_builder._append_image_files_to_content = append_images
    # The pinned Code adapter omits the image rail that its Work adapter uses.
    # Add that upstream rail to the existing list; keep every permission/tool rail.
    original_rails = JiuwenSwarmCodeAdapter._build_agent_rails

    class AttachedImageRail(MultimodalImageRail):
        async def before_model_call(self, ctx):
            if images and (ctx.context is None or not ensure_multimodal_image_window_mutator(ctx.context, images)):
                raise RuntimeError("JiuwenSwarm cannot attach images to the native model context")

    def build_rails(adapter, *args, **kwargs):
        rails = original_rails(adapter, *args, **kwargs)
        if not any(isinstance(rail, MultimodalImageRail) for rail in rails):
            rails.append(AttachedImageRail(enable_image_multimodal=True))
        return rails

    JiuwenSwarmCodeAdapter._build_agent_rails = build_rails
    with tempfile.TemporaryDirectory(prefix=".evaluator-images-", dir=Path.cwd()) as directory:
        images = []
        extensions = {"image/png": ".png", "image/jpeg": ".jpg", "image/webp": ".webp"}
        for index, item in enumerate(media):
            mime = item["mediaType"]
            if mime not in extensions:
                raise ValueError("JiuwenSwarm accepts image attachments only")
            data = base64.b64decode(item["data"], validate=True)
            # The pinned upstream silently omits files larger than 10 MiB.
            if not data or len(data) > 10 * 1024 * 1024:
                raise ValueError("JiuwenSwarm image must be between 1 byte and 10 MiB")
            target = Path(directory) / f"{index}{extensions[mime]}"
            target.write_bytes(data)
            images.append({"type": "image", "path": str(target), "filename": item["name"],
                           "mime_type": mime, "size_bytes": len(data)})

        def build_request(*args, **kwargs):
            request = original_build(*args, **kwargs)
            request.params["files"] = {"uploaded_images": images}
            return request

        app._build_request = build_request
        run_cli()


if __name__ == "__main__":
    main()
