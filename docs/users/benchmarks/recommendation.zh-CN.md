# 生成式推荐服务性能测评

[English](recommendation.md) · [五档实验](../../../playbook/recommendation/north-star.yaml) · [自定义实验](../../../playbook/recommendation/custom.yaml)

## 选择数据来源

`benchmark.config.dataMode` 默认是 `files`。已有的 north-star 用 `promptDir` 读取五档文件，custom 用 `inputs` 指定每档的 JSON 字符串数组。使用 `generated` 时，填写词表和两级 catalog 路径，省略 `inputs`、`promptDir`。两种模式均在来源准备阶段检查全部输入；配置 tokenizer 时也校验实际 token 长度。此阶段和 dry-run 都只读本地模型文件，不访问推理服务。

```bash
arsi-evaluator run playbook/recommendation/generated.yaml --dry-run
arsi-evaluator run playbook/recommendation/generated.yaml
```

[生成模式示例](../../../playbook/recommendation/generated.yaml)使用自定义长度，每档生成 100 条并正式请求 100 次。生成器从 catalog 的合法 A/B/C 路径抽取完整商品 SID，构造观看和购物历史，按整条 prompt 的真实编码和 `lengthToleranceTokens` 匹配目标长度。可调 `generator.seed`（默认 42）、`generator.lengths` 和 `generator.samplesPerLength`（默认 4）。正式请求从第一个样本开始循环，预热独立计数。标准 north-star 可以只设置 `dataMode: generated`，自动生成五档各四条；需提供 `benchmark.solver.config.tokenizerPath`，建议沿用标准示例的 8 token 容差。

生成模式不需要 `GR_PROMPT_DIR`。每次抽样先在有合法后继的 `(A,B)` 前缀中等概率选一组，再从该组抽一个 C。小目录可能产生重复历史，清单中的 `samples` 和 `uniquePrompts` 分别记录生成总数和去重数。

数据写入 **实验的 output.directory 下的 `datasets/<清单SHA-256>/`**，与 run 目录并列。数据文件名为 `prompts_<长度>_batch_<样本数>.json`，`dataset.json` 记录种子、版本、词表和 catalog 的摘要、每条实际长度及数据摘要。E2E 和 profiling 共享这些文件。相同输入、生成器与 tokenizer 环境可生成相同字节。已有同摘要目录会在核对内容后复用。原始结果的 report.md 有清单链接；归档时请同时保留 datasets 目录。如需严格重放，把清单列出的文件路径填入 files/custom 的 `inputs`，或把五档各 4 条的目录用作 files/north-star 的 `promptDir`。

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

## 一个 run 同时采集 E2E 和算子指标

使用[双服务实验](../../../playbook/recommendation/north-star-collections.yaml)。两端使用同一候选构建、模型、词表、catalog 和 base/fast 设置。外部启动普通服务并监听 30000。启动 profiling 服务时，在同一条启动命令前设置 `SGLANG_NPU_PROFILE_AUTO_EXPORT=1`，端口改为 30001。原脚本通过 HTTP 请求 CPU、NPU activities，其诊断依赖此环境变量自动导出。私有服务构建的其他前置条件可在其 `profiler_manager` 实现中核实。Evaluator 和两端都需要能读相同绝对路径的 catalog。profiling 服务必须能按 evaluator 提供的绝对路径写入 attempt 目录；分容器部署时用相同绝对路径挂载 results 目录并赋予相应读写权限。

在已配置 GR 路径与设备映射的两个服务终端分别执行。base 实验将两条命令的 `fast` 和 YAML 的 `tag` 一起改为 `base`。

```bash
# 终端 A：普通性能服务
GR_PORT=30000 bash scripts/recommendation/gr-debug.sh serve fast
# 终端 B：支持导出的采集服务
SGLANG_NPU_PROFILE_AUTO_EXPORT=1 GR_PORT=30001 bash scripts/recommendation/gr-debug.sh serve fast
```

在 evaluator 终端执行：

```bash
arsi-evaluator run playbook/recommendation/north-star-collections.yaml --dry-run
arsi-evaluator run playbook/recommendation/north-star-collections.yaml
arsi-evaluator report "$RUN"  # RUN 取上一步末行的 run 目录
```

按 `benchmark.collections[].service` 绑定地址和凭据。只保留一类 collection 及对应 service 即可单采；原有 `services.default` 示例仍只测 E2E。五档性能测完后，各 profiling 档取本档第一条 prompt，先预热 1–5 次（单次 ≤1000 ms 时结束），再 POST `/start_profile`，设置 CPU/NPU 活动、record_shapes=true、with_stack=false、profile_by_stage=false。重置计数器后仅采一次约束搜索，再 POST `/stop_profile`，等待导出文件稳定。默认每档等候 1800 秒，可用 `benchmark.solver.config.exportTimeoutSeconds` 调整，并为整个任务留足超时余量。在 profiling 条目添加 `lengths: [128, 10240]` 可只采首尾档。组合采集遇到 E2E 点失败或 fast 快路未验证（north-star 以 L=128 为准）会跳过 profiling；超过历史时延预算仍可采集。

父级 `metrics.json` 同时提供 `recommendation-performance` 和 `recommendation-profiling` 给 RSI。两个子目录各有 report.md 和 metrics.json，关联同一 run ID、输入摘要与父快照。profiling 读数使用微秒，profiling 请求 E2E 单独保存，不进入性能 p50。每个 profiling attempt 的 `agent/trace/` 留存原始导出，报告链接指向具体目录。只有 host 数据时会保留 host 统计并将该点标为缺少设备证据；失败原因可在父报告和对应 attempt 查看。


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

旧版 `legacy-eager` 的 910B2 eager 历史读数依次为 68.7、66.7、69.3、99.8、180.178 ms。原脚本将其标为较早软件版本和测量窗口中的预算，正式对标应填写同一 session 重采的数值。

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

标准报告按本轮保存的预算版本给出 L=128 子目标和五档整体判定，五档全部在预算内才算整体达标。910B1 graph 一列为本次 p50 与跨机历史 p50 的比值。自定义场景只展示选定档位。旧 run 可离线重算有证据的指标，未记录的正式窗口和无法区分的历史失败状态显示为 `—`。

## 预算、快路与 base/fast 输出对比

新的 north-star run 默认锁定 `gr-a2-2026-11-23`。需要复现实验时可在 `benchmark.config` 显式写 `budgetVersion: legacy-eager` 或 `budgetVersion: gr-a2-2026-11-23`。旧 run 没有版本字段时，离线报告沿用 `legacy-eager`。custom 不设历史预算。

| 910B2 预算（ms） | L=128 | L=512 | L=1024 | L=5120 | L=10240 |
| --- | ---: | ---: | ---: | ---: | ---: |
| 当前 graph 门槛 | 35.22 | 36.90 | 41.01 | 84.58 | 169.99 |
| 同批 eager 参考 | 68.10 | 73.56 | 70.07 | 111.01 | 196.00 |
| 旧 eager 门槛 | 68.70 | 66.70 | 69.30 | 99.80 | 180.178 |

当前预算取自 gr-a2 提交 `1406e1c` 的引擎内 profiler 段，排除 HTTP 和准入。与客户端 E2E 的差额用于检查预算；计算两引擎实测加速比需同协议重采。逐档 `fastpathStatus` 为 `hit`、`miss`、`unverified`。分子是 shared-prefix decode forward 次数，分母是 decode forward 次数。窗口已重置、分母为正且分子在有效范围时，正分子为命中，零为未命中；缺字段、零分母或重置未确认时为未验证。north-star 的 fast 门槛看 L=128，报告保留其他四档的证据。

先以相同模型、词表、catalog、prompt 和负载各跑一次 base、fast。命令按 base、fast 顺序接收 evaluator 打印的两个 **run 根目录**。推理服务停止后仍可执行。

```bash
arsi-evaluator compare-recommendation "$BASE_RUN" "$FAST_RUN" > sid-comparison.json
rc=$?
echo "comparison exit=$rc"
```

命令核对模型名、已声明的模型/词表版本、输入摘要、长度和负载，选取各 run 生效的 attempt，仅比较正式请求。每行按长度、请求序号（从 0 开始）和 prompt 索引对齐，按返回顺序比较全部候选的 SID token IDs 和分数。分数使用严格数值相等，`scoreDeltas` 为 fast 减 base。顶层 `summary` 汇总全部档位并给出首个差异所在的长度和序号。每档含 `requests`、`verified`、`sidMatches`、`sidMatchRate`（分母为 verified）、`scoreMatches` 和 `firstMismatch`。运行未声明 revision 时，JSON 中对应字段为 null。同名模型的实际部署版本由实验方核实。

退出码 0 表示全部输出一致，1 表示完整证据中存在差异，2 表示条件不匹配、输入错误或证据不全。条件不匹配的原因输出到 stderr。旧 run 的单候选证据可以回放；旧多候选记录缺少其余候选分数时显示未验证。输出一致性与性能达标、快路是否命中分别判断。
