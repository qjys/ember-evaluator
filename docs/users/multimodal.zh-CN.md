# 图片与 PDF 评测

[English](multimodal.md) | 中文

任务通过 `attachments` 指定公开附件；模型服务通过 `inputModalities` 声明接收能力。把文件放进工作区并不等于把图片交给模型。

## 先运行图片示例

设置 `MODEL_NAME`、`MODEL_ENDPOINT`、`MODEL_API_KEY` 后，在仓库根目录运行：

```bash
pnpm build
node dist/cli.js run playbook/multimodal/image.yaml --patch playbook/multimodal/cordis.patch.yaml
```

[示例图片](../../playbook/multimodal/figure.png)没有文字答案。Benchmark 将图片上传到任务工作区，Solver 校验 SHA-256 并发送图片内容，评分只检查最终文本。模型配置如下：

```yaml
services:
  default:
    model: ${MODEL_NAME}
    base_url: ${MODEL_ENDPOINT}
    api_key: ${MODEL_API_KEY}
    inputModalities: [text, image]
```

显式声明优先于模型目录。未声明时，Pi、DSH、DeepAgents 和 Hermes 只使用随 Evaluator 固定的离线模型目录；无法唯一确认的模型按纯文本处理。声明能力不保证端点真正实现该能力，仍需检查实际请求和回答。

## 选择 PDF 输入方式

| 方式 | 实际发送内容 | 示例 |
| --- | --- | --- |
| `pages` | 指定页码按顺序生成的 PNG | [pdf-pages.yaml](../../playbook/multimodal/pdf-pages.yaml) |
| `native` | 原始 PDF 字节 | [pdf-native.yaml](../../playbook/multimodal/pdf-native.yaml) |

页图模式需要在**每个执行节点**安装 Poppler 的 `pdftoppm` 和 `pdfinfo`，版本必须匹配任务中的 `rendererVersion`。示例固定为 `22.02.0`、144 DPI、第 1 页。Docker 求解时也由执行节点渲染，再将图像内容交给容器中的 Harness；Ray worker 不读取协调端路径。

原生 PDF 示例使用 DeepAgents Bundle，需要设置 `DEEPAGENTS_BUNDLE_PATH`，目标模型服务必须接收 Chat Completions 的 `file.file_data`。原生 PDF 不会自动改成页图，页图也不会自动退回文本提取。

单任务最多 32 个附件或渲染后输入，单文件及总输入上限为 50 MiB。页码必须为正整数、不能重复，DPI 最大 300，单页渲染最多 4000 万像素。超限、损坏、摘要不符、页码越界、渲染器版本不符都会失败，不截断附件或页码。

## Harness 状态与配置

“请求验证”表示固定 Harness 或适配器与受控服务之间的检查，不能替代真实模型验收。

| Harness | 图片 / PDF 页图 | 原生 PDF | 运行中读图 | 验证范围 |
| --- | --- | --- | --- | --- |
| SimpleAgent / Pi | 已接入 | 明确拒绝 | Pi `read` | 受控 SDK 请求；Local 图片链路已通过 DeepSeek V4.1 Flash 真实模型验证 |
| DSH 0.2.2-rc.1 | SDK 结构化输入 | 明确拒绝 | 安装配置中的 `read_image` | 实际 SDK 与模型请求 |
| DeepAgents 0.7.15 | 用户图像消息 | `file.file_data` | 本仓 Runner 提供 `view_image` | 实际 SDK 与 ChatOpenAI 请求 |
| Hermes 固定版本 | 原生用户图像消息 | 明确拒绝 | 保留候选原生工具 | 适配已实现，完整 Harness 验收待执行 |
| Dify | 上传后绑定文件变量 | 原始 PDF 以 `document` 绑定 | 由工作流定义 | 受控上传、文件顺序、工作流与 Provider 能力检查；实际服务验收待执行 |
| JiuwenSwarm 0.2.5（9b3706f） | 原生图片消息 | 明确拒绝 | 原生 `read_file` | 固定版本请求回归；Local 多图及读图已通过真实模型验证 |

真实模型验证目前覆盖 SimpleAgent / Pi 的 Local 单图、多图和运行中读图，以及 JiuwenSwarm 的 Local 多图问答和读图链路，不代表代码修复通过 Benchmark 官方测试。PDF 的完整 Harness 链路、其他 Harness 和其他部署组合仍需分别验收，目标端点也应独立检查。外部 Solver 默认只支持文本；开发者必须声明并实现 `inputModalities` 才能接收附件。

- Pi 需要保留图片；`images.blockImages: true` 会与图片任务冲突。
- DSH 使用同版本的 `@deepseek-ai/dsh-sdk-client`。Docker 运行时包含该依赖；本地 DSH 安装也必须能解析同版本 SDK。适配器保留候选 Profile，只替换文本启动入口和对应权限上下文。
- DeepAgents 当前只适配 OpenAI-compatible Chat Completions。开启图片能力后，Runner 给候选增加 `view_image`，仅允许读取任务工作区内的图片，并把图片送给原目标模型。
- Hermes 使用 `agent.image_input_mode: native` 和 `model.supports_vision: true`；候选显式要求文本图像路由时拒绝运行，不调用独立视觉模型。当前图片适配只接受 `openai-completions`。
- JiuwenSwarm 图片使用 `openai-completions`，需显式声明 `inputModalities: [text, image]`。适配器启用 `react.enable_read_image_multimodal` 和 `model_client_config.supports_vision`；候选显式设置为 `false` 时失败。初始图片和 `read_file` 返回的图片一起保留，不调用独立视觉模型。固定版本每张初始图片最多 10 MiB，支持 PNG、JPEG、WebP；本地安装要求进程入口旁有对应环境的 Python。
- Dify 设置 `solver.config.dify.filesInput`，与开始节点的文件变量一致。该变量须直接绑定到 LLM 的文件选择器或普通提示模板中的文件引用，LLM 必须位于通往结束节点的路径上，模型名须匹配服务声明。原生 PDF 以 `document` 上传绑定，不经过文本提取节点，也不自动转页图。上传和执行使用同一个 `user`。
- Dify 每次多模态执行都需要 Console 访问权限，使用 `DIFY_ADMIN_API_KEY` 或 `DIFY_EMAIL` / `DIFY_PASSWORD` 检查部署的 Provider：图片必须声明 `vision`，PDF 必须声明 `document`。不满足时提前失败，避免 Dify 静默删除文件。配置 Provider 后，修改 [Dify Bundle](../../playbook/multimodal/dify/workflow.yaml) 的 Provider 与模型名；模型凭证保存在 Dify 服务端。

Dify 原生 PDF 示例使用同一 Bundle 的 `files` 变量，设置 `DIFY_BASE`、`MODEL_NAME` 与 Console 认证后运行：

```bash
node dist/cli.js run playbook/multimodal/pdf-native-dify.yaml --patch playbook/multimodal/cordis.patch.yaml
```

示例尚未经过真实 Dify 服务导入和模型调用验收；受控上传测试通过不表示任意 Provider 均支持 PDF。

## OfficeQA

`corpusFormat: pdf` 仍表示完整 PDF 工作区，允许提取文本。要附加视觉输入，需要另外指定公开文档：

```yaml
benchmark:
  name: officeqa-pro-v2
  config:
    corpusFormat: pdf
    visualInput:
      documents: [pdfs/公开文档名.pdf]
      mode: pages
      pages: [1, 2]
      dpi: 144
      rendererVersion: 22.02.0
```

实际文件名必须存在于锁定的语料中。选择来自实验配置，不会从私有的 `source_files` 或答案字段推导。完整语料仍保留；这是一种显式附加页图的实验变体，不能直接当作原版 OfficeQA 成绩。

## 结果、重试与开发

结果保存附件摘要、输入模式、页码和渲染参数；`agent/input-media/` 保存原文件、页图和输入清单。渲染缓存以摘要、版本、DPI、页码区分，复用前检查输出摘要。Dify 在当前 attempt 保存上传回执，已完成的同内容上传可复用。

Pi 轨迹将图片保存到独立 `media/` 文件；会话执行期间保留 SDK 所需图片，结束后再把会话证据中的编码换成文件引用。DeepAgents 和 DSH 也避免将图像编码重复写进普通轨迹。Harness 自己的运行缓存仍遵循各自生命周期。

附件文件属于 Benchmark 的公开来源，必须加入 `SourceLock`。输入方式和渲染策略应由 Benchmark 配置或锁定的任务元数据决定；配置、来源或插件版本变更会触发现有续跑一致性检查。不要在同一来源版本下临时改变附件选择。

开发契约、公开文件准备和受控验证命令见[多模态插件开发](../development/multimodal.md)。
