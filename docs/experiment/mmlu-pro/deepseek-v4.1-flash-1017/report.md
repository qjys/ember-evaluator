# MMLU-Pro 运行报告

`deepseek-v4.1-flash-1017`。九种 Solver 各运行 210 题，共 1,890 条最终计分记录，其中 1,639 条答对，0 条求解超时。[实验设置与三张原图](README.md)

## 各 Solver 的最终成绩

表中求解耗时按秒显示，Token 栏列出实际个数。最后一列为两项分位数各自采用的题数。

| Solver | 答对 / 题数 | 准确率 | 求解超时 | 耗时中位数 | 耗时 P90 | Token 中位数 | Token P90 | 耗时与用量样本数 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Claude Code | 186/210 | 88.57% | 0 | 5.5 | 23.9 | 1,759 | 3,812.3 | 210/210 |
| Pi | 185/210 | 88.10% | 0 | 8.7 | 24.7 | 1,807.5 | 3,653.8 | 210/210 |
| Codex | 184/210 | 87.62% | 0 | 6.3 | 13.4 | 9,442.5 | 11,548.5 | 210/210 |
| CodeBuddy | 183/210 | 87.14% | 0 | 18.4 | 34.4 | 5,537.5 | 6,993.4 | 210/210 |
| DeepSeek Harness | 181/210 | 86.19% | 0 | 13.7 | 30.2 | 2,265 | 4,176 | 210/210 |
| JiuwenSwarm | 181/210 | 86.19% | 0 | 36.3 | 46.0 | 7,664.5 | 9,076.6 | 210/210 |
| ZCode | 181/210 | 86.19% | 0 | 15.8 | 31.5 | 2,529.5 | 4,483.2 | 210/210 |
| TRAE | 179/210 | 85.24% | 0 | 8.8 | 21.9 | 3,396.5 | 5,078.3 | 210/210 |
| SimpleAgent | 179/210 | 85.24% | 0 | 8.1 | 25.6 | 1,779.5 | 3,826.7 | 210/210 |

准确率以每个 Solver 的全部 210 题为分母。耗时取最终尝试的求解阶段，含已完成的错题，剔除求解超时。Token 取最终尝试上报的总量，缺失值跳过。P90 按排序样本的 `0.9 × (n − 1)` 位置线性插值。

## 分领域成绩

各领域 15 题，表内数字为答对题数。

| 领域 | Claude Code | Pi | Codex | CodeBuddy | DeepSeek Harness | JiuwenSwarm | ZCode | TRAE | SimpleAgent |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| biology | 13 | 13 | 13 | 13 | 13 | 14 | 14 | 13 | 13 |
| business | 14 | 14 | 13 | 14 | 14 | 14 | 14 | 14 | 14 |
| chemistry | 15 | 15 | 15 | 13 | 15 | 14 | 14 | 15 | 15 |
| computer science | 15 | 15 | 15 | 15 | 15 | 14 | 15 | 15 | 15 |
| economics | 14 | 14 | 14 | 15 | 14 | 14 | 15 | 15 | 15 |
| engineering | 12 | 11 | 10 | 11 | 10 | 10 | 9 | 8 | 10 |
| health | 11 | 10 | 11 | 11 | 10 | 12 | 10 | 10 | 10 |
| history | 13 | 14 | 13 | 13 | 14 | 13 | 13 | 11 | 14 |
| law | 10 | 11 | 12 | 9 | 9 | 9 | 10 | 9 | 9 |
| math | 14 | 14 | 14 | 14 | 14 | 14 | 14 | 14 | 14 |
| other | 13 | 12 | 12 | 12 | 12 | 12 | 11 | 13 | 11 |
| philosophy | 14 | 13 | 14 | 14 | 12 | 13 | 13 | 14 | 12 |
| physics | 14 | 15 | 14 | 15 | 15 | 15 | 15 | 14 | 14 |
| psychology | 14 | 14 | 14 | 14 | 14 | 13 | 14 | 14 | 13 |

## 本次运行题单

九种 Solver 使用相同的 210 道题，来自 MMLU-Pro 测试集的 14 个领域，每个领域 15 题。表中的题目 ID 格式为 `test:<question_id>`，各领域内按题号排序。[MMLU-Pro 官方题库](https://huggingface.co/datasets/TIGER-Lab/MMLU-Pro)

| 领域 | 入选题目 ID（每领域 15 题） |
| --- | --- |
| biology | `test:2714`、`test:2716`、`test:2747`、`test:2882`、`test:2951`、`test:3037`、`test:3053`、`test:3136`、`test:3165`、`test:3196`、`test:3231`、`test:3236`、`test:3270`、`test:3293`、`test:3331` |
| business | `test:41`、`test:61`、`test:97`、`test:209`、`test:286`、`test:299`、`test:311`、`test:352`、`test:355`、`test:476`、`test:511`、`test:552`、`test:624`、`test:669`、`test:670` |
| chemistry | `test:3488`、`test:3491`、`test:3552`、`test:3599`、`test:3626`、`test:4021`、`test:4034`、`test:4058`、`test:4075`、`test:4142`、`test:4208`、`test:4298`、`test:4337`、`test:4376`、`test:4405` |
| computer science | `test:10174`、`test:10184`、`test:10189`、`test:10294`、`test:10318`、`test:10362`、`test:10396`、`test:10401`、`test:10403`、`test:10412`、`test:10421`、`test:10424`、`test:10471`、`test:10479`、`test:10524` |
| economics | `test:6738`、`test:6751`、`test:6784`、`test:6792`、`test:6900`、`test:6928`、`test:6929`、`test:7161`、`test:7181`、`test:7217`、`test:7290`、`test:7304`、`test:7312`、`test:7448`、`test:7462` |
| engineering | `test:11093`、`test:11210`、`test:11354`、`test:11491`、`test:11496`、`test:11506`、`test:11559`、`test:11576`、`test:11629`、`test:11660`、`test:11802`、`test:11808`、`test:11824`、`test:11925`、`test:12002` |
| health | `test:5919`、`test:5940`、`test:6055`、`test:6095`、`test:6120`、`test:6123`、`test:6147`、`test:6198`、`test:6223`、`test:6235`、`test:6403`、`test:6436`、`test:6508`、`test:6593`、`test:6655` |
| history | `test:4552`、`test:4560`、`test:4568`、`test:4580`、`test:4603`、`test:4625`、`test:4627`、`test:4651`、`test:4670`、`test:4700`、`test:4709`、`test:4763`、`test:4770`、`test:4786`、`test:4879` |
| law | `test:796`、`test:828`、`test:841`、`test:883`、`test:938`、`test:1026`、`test:1229`、`test:1252`、`test:1399`、`test:1454`、`test:1514`、`test:1531`、`test:1785`、`test:1806`、`test:1827` |
| math | `test:7526`、`test:7727`、`test:7752`、`test:7838`、`test:7954`、`test:7976`、`test:8199`、`test:8207`、`test:8304`、`test:8366`、`test:8511`、`test:8525`、`test:8604`、`test:8740`、`test:8839` |
| other | `test:5078`、`test:5123`、`test:5174`、`test:5198`、`test:5243`、`test:5309`、`test:5319`、`test:5328`、`test:5361`、`test:5457`、`test:5461`、`test:5530`、`test:5578`、`test:5580`、`test:5795` |
| philosophy | `test:10607`、`test:10656`、`test:10674`、`test:10683`、`test:10690`、`test:10765`、`test:10770`、`test:10815`、`test:10846`、`test:10898`、`test:10940`、`test:10966`、`test:11045`、`test:11050`、`test:11060` |
| physics | `test:8939`、`test:8967`、`test:8989`、`test:9136`、`test:9222`、`test:9391`、`test:9395`、`test:9405`、`test:9769`、`test:9843`、`test:9864`、`test:9901`、`test:9931`、`test:10127`、`test:10140` |
| psychology | `test:1904`、`test:1943`、`test:1998`、`test:2023`、`test:2096`、`test:2152`、`test:2175`、`test:2177`、`test:2206`、`test:2280`、`test:2347`、`test:2400`、`test:2527`、`test:2636`、`test:2641` |
