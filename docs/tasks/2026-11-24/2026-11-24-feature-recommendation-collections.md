# 推荐双服务采集

已实现一份 YAML 选择 performance、profiling 或两者。两个外部服务共用源数据锁，输入点和采集角色持久化到同一 run。先运行性能测量，再根据已落盘的性能结果启动允许的采集点。参见[设计](../../design/2026-11-24/2026-11-24-recommendation-collections.md)。

## 验收

- 构建产物通过五档 Playbook 的 CLI dry-run，枚举五个性能点和五个 profiling 点。
- 两个独立 HTTP 夹具验证不同凭据和端口、五档请求顺序、完整和精简导出、仅 Host 的无效读数、零快路跳过、请求失败后的 stop、服务关闭后的报告重建以及完成后的续跑。
- `pnpm typecheck`、`pnpm build` 和 `node scripts/check-dependencies.mjs` 通过，依赖违规为零。六个相关测试文件共 60 个用例通过。
- 全量套件在 Windows 上仍有其他模块失败，涉及算子 SDK、遥测、AISBench、镜像与路径测试。真实 gr-a2 服务、CANN 导出和 NPU 性能待现场验收；夹具数字仅用于验证流程。
