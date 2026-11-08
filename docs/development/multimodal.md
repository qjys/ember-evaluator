# 为插件提供图片和 PDF 输入

使用与当前限制见[用户指南](../users/multimodal.zh-CN.md)。最小实现见 [playbook/multimodal/plugin.mjs](../../playbook/multimodal/plugin.mjs)：不新增组件类别，不为不同 Harness 增加核心执行分支。

## Benchmark：声明公开文件

`PublicTask.prompt` 保持文本，`attachments` 是有序的可选数组。附件只能引用求解工作区内的公开文件：

```ts
const attachments: TaskAttachment[] = [{
  kind: "image",
  path: "figures/question.png",
  mediaType: "image/png",
  sha256: publicFile.sha256,
}];
```

PDF 需要指定 `mode`：

```ts
{ kind: "pdf", path: "document.pdf", sha256, mode: "native" }
{ kind: "pdf", path: "document.pdf", sha256, mode: "pages",
  pages: [3, 1], dpi: 144, rendererVersion: "22.02.0" }
```

`pages` 的顺序就是输入顺序；页码从 1 开始。不要自动补全未指定的页或在失败时切换模式。

1. 在 `resolveSource()` 下载、校验并锁定公开文件，将其 SHA-256 放入 `SourceLock.files`。附件选择、顺序、页码和渲染策略由配置或已锁定的任务元数据决定。
2. 在 `prepare()` 使用当前执行节点的来源缓存，通过 `solveEnv.initialFiles` 提供文件。`target` 和附件 `path` 对应；不要发送协调端的绝对路径。
3. 把附件放入 `input.attachments`，把答案和隐藏测试留在 `verification` 或独立验证环境。禁止根据私有答案提示挑选“相关图片”。
4. 多步骤任务分别在每个 `step.task.input` 声明附件。核心会在启动环境前校验路径、类型、来源摘要，在调用 Solver 前检查输入能力。

第三方插件从 `ember-evaluator` 包根导入 `TaskAttachment`、`InputModality` 和 `parseTaskAttachments`。不依赖 `src/runtimes` 内部文件。

## Solver：声明并实际发送能力

```ts
class ImageSolver implements Solver {
  readonly inputModalities = ["text", "image"] as const;
  // 其他 Solver 方法按现有契约实现。
}
```

有 `prepare()` 的 Solver 可以在返回的 `PreparedSolver.inputModalities` 声明本次实际可用的能力。省略声明表示仅支持文本；不能为了通过检查声明尚未实现的图片或 PDF 能力。

外部 Solver 负责使用 `EnvironmentSession.download()` 读取目标环境中的文件，校验大小、实际格式和摘要，检查模型/API 能力，并把字节转换成目标 SDK 的输入。`payload` 不能替代附件协议。读取附件、渲染和请求均需遵循 `AttemptContext.signal`。失败时保留任务、附件及失败原因。

内置适配器复用 `runtimes/multimodal/input.ts`，具体 SDK 转换留在各 Harness 目录。PDF 页图在执行节点生成；缓存按内容和渲染参数区分，文件进入当前 attempt 的独立产物后才传递给 Runner。核心模块不识别 Harness 名称。

运行中读图还需验证下一轮模型请求。只返回路径、OCR 或工具输出里的文字不算视觉输入。Pi 使用 `read`，DSH 使用原生 `read_image`；DeepAgents 的 `view_image` 通过工具回执和图像用户消息继续调用原目标模型。Hermes 禁止切换到辅助视觉模型。

## 协议、证据和兼容

- 新字段可选。纯文本任务和没有能力声明的纯文本插件继续使用原契约。
- 模型配置的 `inputModalities` 经过 YAML、有效配置、导出和分布式配置传输。显式声明覆盖目录推断；目录版本受运行时来源摘要保护。
- 每个附件的摘要必须出现在来源锁中。更换输入策略需要更改配置、来源元数据或插件版本，不能复用旧成绩。
- `AttemptRecord.inputAttachments` 保存最终步骤的附件，不会因此开启 prompt/answer 的保存；多步骤输入还保留在各次调用的输入清单和轨迹。源文件、页图和模型产生的图像作为独立文件收集。
- 不修改活动会话中的图片编码来减少日志。Pi 在会话结束后整理证据，保证压缩上下文期间仍能读到原图。
- Dify 检查开始节点文件变量直接进入 LLM 的文件选择器或普通提示模板，且该 LLM 位于通向结束节点的路径上；动态模型选择、文本提取后再进入 LLM 或孤立节点均不能通过此检查。原生 PDF 保留原字节并绑定为 `document`。执行前通过 Console 检查部署 Provider 的 `document` / `vision` 能力；上传成功不等于完整模型链路验收。
- JiuwenSwarm 使用固定提交的进程 CLI，Runner 只补入附件请求和原生图片处理组件，保留原 CLI 的权限、超时、取消及输出。固定版本的初始附件处理会替换最新用户消息内容，因此适配器额外保留该消息中工具读出的图像块。运行时文件摘要覆盖该 Runner。

## 受控验证

```bash
pnpm exec vitest run tests/unit/multimodal-input.test.ts tests/integration/multimodal.test.ts tests/integration/multimodal-runners.test.ts
```

PDF 渲染用例需要 PATH 中的 `pdftoppm` 和 `pdfinfo`，没有时明确跳过。完整 DeepAgents/DSH 受控请求测试不自动安装外部 Harness，分别设置：

```bash
export EVALUATOR_DEEPAGENTS_TEST_PYTHON=/path/to/venv/bin/python
# 此 venv 安装 deepagents==0.7.15 与 langchain-openai。
export EVALUATOR_DSH_TEST_RUNTIME=/path/to/dsh-runtime
# 此目录含 package.json 以及同版本 dsh、dsh-sdk-client 的 node_modules。
export EMBER_EVALUATOR_API_KEY=fixture
pnpm exec vitest run tests/integration/multimodal-runners.test.ts

# 安装固定提交 9b3706f 的 JiuwenSwarm 及其依赖后运行真实 Harness 请求回归。
export EVALUATOR_JIUWENSWARM_TEST_PYTHON=/path/to/jiuwenswarm-venv/bin/python
pnpm exec vitest run tests/integration/jiuwenswarm-multimodal.test.ts tests/unit/jiuwenswarm-multimodal.test.ts tests/integration/dify-multimodal.test.ts
```

这些测试启动本地受控服务并检查请求中的图像/文件块、工具后的请求、用量和资源释放，不调用真实计费模型。真实模型验收应另外运行示例并核对答案，单独报告结果。尚未验证的 Hermes、Dify 服务、完整 Ray 集群组合不能标记为已验收。
