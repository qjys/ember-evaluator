# 推荐模拟数据与回放

在 recommendation 的来源准备阶段解析 files/generated。生成器仅使用本机 tokenizer 和两个 catalog，按合法 SID 构造完整历史，逐条核实实际 token 数。数据与清单按内容摘要发布到实验输出目录下，供性能与 profiling 任务共享。文件模式继续使用已有的文件摘要口径，回放相同字节得到相同输入 revision。报告额外记录来源模式和清单位置。原有 services 和运行顺序沿用[双服务采集设计](../2026-11-24/2026-11-24-recommendation-collections.md)。
