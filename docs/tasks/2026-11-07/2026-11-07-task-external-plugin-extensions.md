# 外部插件扩展与 tracer 接入

- 类型：功能修改
- 状态：代码和本地验收完成；真实 Docker、Ray 集群及模型验收待执行
- 基线：PR #20，e1e765d52b319eec810ff81df844a2a0085fe74f
- 设计：[外部插件扩展](../../design/2026-11-07/2026-11-07-external-plugin-extensions.md)

## 目标与实施

保留 `--tracer [url]`，删除核心内的 tracer 参数映射，以完整插件索引、CLI 注册和 Store 包装接口替代。恢复续跑及重试配置，向 Ray 协调端传递通用配置，worker 只注册和校验预装模块。

已完成以下修改：

- 构建扫描所有插件 manifest，生成独立的 `dist/external-plugins/index.json`，无 CLI 的插件也进入索引。插件源码、清单和资源参与自动重建摘要。
- 新增 `PluginCliRegistrar`，由插件注册子命令和 `run` 参数，拒绝命令、参数和别名冲突。删除宿主中的 tracer 参数映射及旧 `plugins-commands.ts`。
- 删除第九类 `store-decorator` 组件，改为独立的 `registerStoreDecorator`，按所属模块启用包装，支持安装索引和显式 patch 两种来源。
- `pluginRuntime.plugins` 保存启用项和配置，resume/retry 恢复这些配置；Ray 传递通用插件配置，worker 只加载和校验模块。
- tracer 实现、CLI 注册、资源和测试全部位于 `plugins/tracer`。包装保留底层 Store 可选能力，远端 attempt 导入成功后镜像结果和轨迹，取消信号传入网络请求及轮询器。
- 离线报告可加载安装索引中的 reporting provider，支持 Cordis 默认导出。更新中英文插件开发说明及 README 产物路径。

## 验收记录

- 验证环境：Windows、Node 24.22.1、pnpm 11.22.0；本机默认 Node 24.18.0 低于仓库要求，正式验证显式使用 24.22.1。
- `pnpm typecheck`、`pnpm build`：最终通过。
- `pnpm test --run`：2179 通过、77 跳过、13 失败。11 项 kernel profiling 路径检查失败和 1 项缺少 `python3`，均在 PR 原始提交上复现；另 1 项插件装配超时，单独重跑该文件后 25 项全部通过。默认测试集仍不记为通过。
- 针对插件、CLI、SDK、摘要、checkout 构建、resume/retry 和 Ray 协议的回归：151 通过、3 跳过。最后补充的 tracer 回归 3 项通过。
- 补充离线报告测试后，插件扩展及 CLI 两个文件最终 54 项全部通过。期间修正报告断言中遗漏的摘要注释；另一次误用旧 Node 的复验出现超时，切回规定版本后通过。
- 非 tracer 测试插件：仅新增插件目录即可构建并注册命令和参数；删除临时源码后仍能加载。另覆盖无 CLI 插件、patch 插件包装、冲突拒绝、配置恢复及 worker 版本检查。
- npm 包实际运行：在没有 `src` 的解包目录中验证帮助、评测、Collector 启动、轨迹写入、Dashboard、状态查询及续跑；结束后停止 Collector。测试使用受控 Solver，没有调用真实模型。
- `git diff --check` 通过；`src`、构建脚本和 TypeScript/Vitest 配置中未保留 tracer 名称或参数的专用判断。已移除复现基线失败使用的临时 Git worktree。
- 真实 Docker、Ray 集群及真实模型评测未执行。当前 tracer 采集协调端接收的远端结果和轨迹，不提供 worker 实时流。
