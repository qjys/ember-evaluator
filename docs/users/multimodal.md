# Image and PDF evaluation

English | [中文](multimodal.zh-CN.md)

Tasks declare public files in `attachments`. Model services declare accepted inputs in `inputModalities`. A file in the workspace alone is not a model image input.

## Run an image task

Set `MODEL_NAME`, `MODEL_ENDPOINT`, and `MODEL_API_KEY`, then run from the repository root:

```bash
pnpm build
node dist/cli.js run playbook/multimodal/image.yaml --patch playbook/multimodal/cordis.patch.yaml
```

The [fixture](../../playbook/multimodal/figure.png) contains no textual answer. The Benchmark stages it in the public workspace; the Solver checks its SHA-256 and sends the image bytes. Output remains a text answer.

```yaml
services:
  default:
    model: ${MODEL_NAME}
    base_url: ${MODEL_ENDPOINT}
    api_key: ${MODEL_API_KEY}
    inputModalities: [text, image]
```

Explicit declarations take priority. Without them, Pi, DSH, DeepAgents, and Hermes consult the pinned offline model catalog. Unknown or ambiguous models default to text. A declaration cannot prove that a custom endpoint actually supports the input; verify the request and the answer.

## PDF modes

| Mode | Sent to the model | Example |
| --- | --- | --- |
| `pages` | Ordered PNGs of explicitly selected pages | [Page images](../../playbook/multimodal/pdf-pages.yaml) |
| `native` | Original PDF bytes | [Native PDF](../../playbook/multimodal/pdf-native.yaml) |

Page rendering requires Poppler `pdftoppm` and `pdfinfo` on every execution node. `rendererVersion` must match exactly. The example uses `22.02.0`, 144 DPI, page 1. For Docker, rendering occurs on the execution node and media bytes reach the container Runner. Ray workers use their own prepared files.

The native example requires `DEEPAGENTS_BUNDLE_PATH` and a target service accepting Chat Completions `file.file_data`. Modes never switch automatically. Limits are 32 attachments/rendered inputs and 50 MiB per file and per request, with positive unique page numbers, DPI up to 300, and at most 40 megapixels per rendered page. Oversized, damaged, mismatched, or out-of-range inputs fail instead of being truncated.

## Harness matrix

Request validation uses a controlled model service; it does not establish real-model quality.

| Harness | Images / PDF pages | Native PDF | Image tools | Validation |
| --- | --- | --- | --- | --- |
| SimpleAgent / Pi | Connected | Rejected | Pi `read` | Controlled SDK requests; Local image delivery validated against real DeepSeek V4.1 Flash |
| DSH 0.2.2-rc.1 | Structured SDK input | Rejected | Candidate `read_image` | Actual SDK and model requests |
| DeepAgents 0.7.15 | Image messages | `file.file_data` | Runner `view_image` | Actual SDK and ChatOpenAI requests |
| Pinned Hermes | Native user image messages | Rejected | Candidate native tools | Adapter implemented; full Harness acceptance pending |
| Dify | File upload and variable binding | Original PDF bound as `document` | Workflow-defined | Controlled uploads, file order, workflow and Provider capability checks; service acceptance pending |
| JiuwenSwarm 0.2.5 (9b3706f) | Native image messages | Rejected | Native `read_file` | Pinned-runtime request regression; Local multi-image and image-tool real-model validation |

Real-model validation covers SimpleAgent / Pi on Local with single images, multiple images, and image tools, plus JiuwenSwarm Local multi-image questions and image tools. This does not establish that a code repair passes the Benchmark's official tests. Full Harness PDF paths, other Harnesses, and other deployment combinations still need separate acceptance, as does each target endpoint. External Solvers default to text and must implement and declare their modalities before receiving attachments.

- Pi rejects image tasks when `images.blockImages` is enabled.
- Local DSH must resolve `@deepseek-ai/dsh-sdk-client` at the same pinned version. The Docker runtime includes it. The adapter preserves the candidate Profile and replaces its text ingress with SDK ingress.
- DeepAgents currently uses OpenAI-compatible Chat Completions. Declaring image capability enables `view_image`, restricted to the public workspace. Its output reaches the same target model.
- Hermes uses native image routing and rejects an explicit text route. Images currently require `openai-completions`; the adapter does not substitute a separate vision model.
- JiuwenSwarm images require `openai-completions` and an explicit `inputModalities: [text, image]`. The adapter enables `react.enable_read_image_multimodal` and `model_client_config.supports_vision`, rejecting an explicit `false`. Initial attachments and native `read_file` images are preserved together, without a separate vision model. The pinned runtime accepts PNG, JPEG and WebP initial images up to 10 MiB each. Local installations need the matching Python interpreter beside the process entry point.
- Dify requires `solver.config.dify.filesInput` and an accepting start-node file variable bound directly to an LLM file selector or a file reference in its ordinary prompt template. The LLM must lead to an end node and use the declared target model name. Native PDFs are uploaded and bound as `document`, without text extraction or automatic page rendering. Upload and workflow calls use the same user.
- Every Dify multimodal execution needs Console access through `DIFY_ADMIN_API_KEY` or `DIFY_EMAIL` / `DIFY_PASSWORD`. The deployed Provider must advertise `vision` for images and `document` for PDFs; otherwise execution fails before Dify can silently drop files. Configure the Provider and model in the [example Bundle](../../playbook/multimodal/dify/workflow.yaml). Model credentials remain on the Dify server.

For the native PDF example, set `DIFY_BASE`, `MODEL_NAME` and Console credentials, then run:

```bash
node dist/cli.js run playbook/multimodal/pdf-native-dify.yaml --patch playbook/multimodal/cordis.patch.yaml
```

The example uses the Bundle's `files` variable. Real Dify import and model-call acceptance are pending; controlled upload tests do not establish PDF support for every Provider.

## OfficeQA and evidence

`corpusFormat: pdf` retains the complete workspace corpus and permits text extraction. Add `visualInput` to attach explicitly selected public documents:

```yaml
benchmark:
  name: officeqa-pro-v2
  config:
    corpusFormat: pdf
    visualInput:
      documents: [pdfs/public-document.pdf]
      mode: pages
      pages: [1, 2]
      dpi: 144
      rendererVersion: 22.02.0
```

Use real names from the locked corpus. Selection never uses private answer/source columns. This adds visual inputs while retaining the corpus and must be reported as a separate experimental variant.

Results and `agent/input-media/` retain attachment identities, PDF mode, rendering parameters, originals, and page images. Page caches use source digest, renderer version, DPI, and page number; cached output digests are checked before reuse. Dify saves upload receipts within the attempt.

Pi keeps SDK session media during execution, then replaces encoded images in final evidence with independent artifact references. DeepAgents and DSH also avoid duplicating image bytes in ordinary trajectories. Harness runtime caches retain their native lifecycle.

Benchmark authors must lock public attachment files in `SourceLock` and encode input policy in configuration or locked task metadata. Existing configuration/source/plugin consistency checks protect resume; do not change selection under an unchanged source version. See [multimodal development](../development/multimodal.md) for the contract and controlled tests.
