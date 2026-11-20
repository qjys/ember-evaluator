# 生成式推荐服务性能测评

[English](recommendation.md) · [五档实验](../../../playbook/recommendation/north-star.yaml) · [自定义实验](../../../playbook/recommendation/custom.yaml)

在运行 SGLang-GR 的 NPU 机器上启动 Evaluator。服务地址填写根 URL，例如 `http://127.0.0.1:30000`。实验期间独占该服务，预热后会重置服务端 GR 计数器。模型和词表由服务加载。

```bash
export MODEL_API_KEY=EMPTY  # 无鉴权的本地服务
export GR_PROMPT_DIR=/path/to/prompts
export GR_TOKENIZER_DIR=/path/to/Qwen3-0.6B-OneRecVocab
export GR_PREFIX1_FILE=/path/to/catalog/prefix1.json
export GR_PREFIX2_FILE=/path/to/catalog/prefix2.json
arsi-evaluator benchmark info recommendation
arsi-evaluator run playbook/recommendation/north-star.yaml --dry-run
arsi-evaluator run playbook/recommendation/north-star.yaml
arsi-evaluator report <run-directory>
```

在 SGLang-GR 已安装的 Python 环境中执行。服务和客户端都需要访问同一绝对路径下的两份 catalog。base 启动示例为

```bash
ASCEND_RT_VISIBLE_DEVICES=0 SGLANG_NPU_FORCE_NATIVE_SDPA=1 SGLANG_NPU_SDPA_DECODE_BLOCK=128 \
python -m sglang.launch_server --model "$GR_TOKENIZER_DIR" --device npu --attention-backend ascend \
  --page-size 1 --disable-decode-cuda-graph --disable-radix-cache --context-length 12288 \
  --max-running-requests 1024 --mem-fraction-static 0.4 --host 127.0.0.1 --port 30000
```

两个示例通过本机 Transformers 读取词表，检查 catalog 中实际出现的 SID 分量与 token ID 的映射，并记录每条原始 prompt 的 token 数。示例允许目标长度偏差 8 token，可按数据集调整 `lengthToleranceTokens`。默认解释器为 `python3`，可在 `benchmark.solver.config.pythonExecutable` 填写虚拟环境的 Python 绝对路径。省略 `tokenizerPath` 和 `lengthToleranceTokens` 时只记录标称长度，依然检查返回 ID 的范围和 catalog 约束。

每档先向 `/v1/gr/catalog` 提交两份 catalog 的路径。预热和正式阶段均从文件的第一条开始循环，每次向 `/v1/gr/beam_search` 发一条 prompt，固定 `n=1`。计时从请求体序列化前开始，到非流式响应全部读取并解析完毕；SID 和分数校验在计时结束后进行。标准档的 p50 为 8 个正式请求按耗时升序排列的第 4 个。自定义 `decodeSteps` 支持 1、2、3，前两种分别验证 A、AB 前缀，第三种验证完整 ABC。逐请求数据保存在 attempt 的 `agent/session.jsonl`，包括阶段、prompt 下标、耗时、返回 ID 和分数或失败原因。重置计数器失败、样本不足或响应校验失败时，该档标为无效，主表 p50 留空。客户端诊断表仍按原脚本展示收到有效响应的请求分布。

标准实验依次读取五个 `prompts_<L>_batch_4.json`。每个文件是一组完整字符串，L 表示目标 token 长度。文件原样参与 SHA-256 校验，保留重复 prompt、换行和边界截断。自定义实验通过 `inputs` 逐档指定长度和文件，另可设置 `beamWidth`、`decodeSteps`、`concurrency`、`warmup`、`requests`。

分别运行 base 与 fast。fast 服务进程启动时设置 `SGLANG_NPU_SHARED_PREFIX_DECODE=1`、`SGLANG_NPU_SHARED_PREFIX_MIN_LEN=32`，实验中的 `tag` 设置为 `fast`。这里测量同一条 prompt 的多个 beam 共享前缀的 decode 路径。报告展示正式窗口的 `shared_prefix_forward / decode_forward`，标准 fast 组以 L=128 的命中比例判定，即使长档命中，L=128 零命中也会使 fast 无效。某档取不到计数器快照时视为缺档。已有快照中缺少的计数字段按原脚本取 0。阶段时间以服务端微秒累加值除以对应 group 数再换算为毫秒，tail 为 span 减去四个互不重叠阶段的余量。Profiler 单独采集。

要对比同一 session 的 vLLM-GR eager 结果，在 `benchmark.config.comparison` 填写实际的 `session`、`machine`、`devices`、`modelRevision`、`tokenizerRevision`（均为字符串）。每档 `comparisonKey` 根据这些声明、输入文件摘要、负载和计时口径计算。将基线端按相同条件计算的逐档 `{ length, comparisonKey, p50Ms }` 记录填入 `recommendation-performance` 指标的 `config.eagerBaseline`。无匹配基线时仍可读取实测 p50。五档完整且 fast 条件满足后，报告才对标准实验给出同 session 的 L=128 门槛结论。

基线端生成 key 时，取其实际输入文件的 SHA-256（小写十六进制），按下列结构生成 JSON。所有对象键按字典序排序，使用 UTF-8 编码，省略空白，最后对 JSON 字节计算 SHA-256。示例中的尖括号表示应替换的值。

```json
{
  "identity": {
    "session": "<同一轮同机测试编号>", "machine": "<主机标识>", "devices": "<卡型及物理卡号>",
    "modelRevision": "<权重版本>", "tokenizerRevision": "<词表版本>"
  },
  "length": 128,
  "digests": {"prompts-128.json": "<sha256>", "prefix1.json": "<sha256>", "prefix2.json": "<sha256>"},
  "requests": 8, "warmup": 2, "concurrency": 1, "beamWidth": 128, "decodeSteps": 3,
  "timing": "recommendation-http-e2e-v1"
}
```

gr-a2 手工脚本中的 910B2 eager 历史读数依次为 68.7、66.7、69.3、99.8、180.178 ms。原脚本将其标为较早软件版本和测量窗口中的预算，正式对标应填写同一 session 重采的数值。

## 从源码运行 base 和 fast

从源码调试时，在仓库根目录运行以下命令。使用 Node.js ≥24.19 和 pnpm 11.22.0，客户端 Python 需要能导入 transformers。两个终端进入同一仓库目录，共享服务网络和 catalog 的绝对路径。

```bash
pnpm install --frozen-lockfile
mkdir -p .scratch
read -rp '输入模型、源码和 data 所在的父目录: ' gr_home
printf 'GR_HOME=%q\nGR_PORT=30404\nGR_DEVICE=4\n' "$gr_home" > .scratch/gr-debug.env
bash scripts/recommendation/gr-debug.sh info
```

在宿主机确认物理 NPU 4 健康且空闲。服务端使用 GR_SERVICE_PYTHON，客户端使用 GR_PYTHON，默认均为 python3。可在 .scratch/gr-debug.env 中分别指定。

```bash
# 终端 A，使用原先运行 gr-a2 的容器和 Python 环境
bash scripts/recommendation/gr-debug.sh serve base
# 终端 B，等 health 成功后开始
bash scripts/recommendation/gr-debug.sh health
bash scripts/recommendation/gr-debug.sh dry smoke
bash scripts/recommendation/gr-debug.sh run smoke
bash scripts/recommendation/gr-debug.sh run base
# 终端 A，按 Ctrl+C 停掉自己的 base 服务，再启动 fast
bash scripts/recommendation/gr-debug.sh serve fast
# 终端 B
bash scripts/recommendation/gr-debug.sh health
bash scripts/recommendation/gr-debug.sh run fast
```

smoke 只测 L=128。base 和 fast 分别运行五档，将命令日志、实验 YAML 和报告写入 results/recommendation 下的独立目录。

## 各档性能指标

| 指标 | 计算方法 |
| --- | --- |
| E2E mean、p50、p95、p99 | 用正式阶段收到非空候选的成功响应。排序后取第 `ceil(q × n)` 个样本，8 次测量的 p95、p99 都是第 8 个。没有成功响应时，诊断分布按原脚本记 0，测量标为无效。 |
| TTFT、per-token | 每条记录保存 `ttftMs` 和 `perTokenMs`。该端点一次返回整份 JSON，所以 TTFT 与 E2E 相等。per-token 为该请求 E2E 除以全部候选的输出 token 总数，分母为零时记 0。 |
| QPS、正式窗口 | 所有正式请求数（含失败）除以正式批次墙钟秒数。窗口包含客户端校验、并发池启动和收尾，排除预热、计数器读写和证据落盘。QPS 使用未舍入的秒数。 |
| 输出 token、TPOT | 输出 token 汇总成功响应内所有候选。TPOT 为成功请求的 E2E 均值除以每请求平均输出 token，分母为零时记 0。 |
| 成功、失败、SID 合法、分数有限 | 分别计数。收到候选后，即使候选违反 catalog 或分数非有限，响应仍计入客户端时延；该档不能参与达标判定。 |
| 阶段占比、主段、client | prefill、pf_sel、decode1、decode2、tail 分别除以平均服务端 span；主段取最大占比。client = E2E 均值 − span 均值，cli% = client / E2E 均值 × 100，可为负。 |
| Decode 诊断 | 报告另列 admission、prefill/decode commit、overshoot、每个后续 decode 间隔的均值、每次 selection 的均值、步数/请求、快路命中或跳过次数、decode API 分支及 PID。 |

标准报告按原脚本给出 910B2 历史 eager 的逐档差额、L=128 子目标和五档整体判定，五档全部在预算内才算整体达标。910B1 graph 一列为本次 p50 与跨机历史 p50 的比值。自定义场景只展示选定档位。旧 run 可离线重算有证据的指标，未记录的正式窗口和无法区分的历史失败状态显示为 `—`。
