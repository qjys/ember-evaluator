"""Attach validated images to the pinned process CLI's native Runtime request."""

from __future__ import annotations

import base64
import contextlib
import json
import sys
import tempfile
from pathlib import Path


def main() -> None:
    media = json.load(sys.stdin)
    # Keep the original CLI's renderer, cancellation, permissions and Runtime close.
    # Only its text-only request builder needs an attachment bridge.
    with contextlib.redirect_stdout(sys.stderr):
        from jiuwenswarm.channels.process_cli import app
        from jiuwenswarm.channels.process_cli.main import main as cli_main
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
        cli_main()


if __name__ == "__main__":
    main()
