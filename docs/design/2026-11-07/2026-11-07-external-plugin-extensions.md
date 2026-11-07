# 外部插件发现、CLI 注册与运行扩展

用户已确认按 PR #20（e1e765d）检视方案修改，保留 `--tracer [url]`。tracer 的实现、命令和测试放在 `plugins/tracer`，宿主只提供通用接口。

## 构建与发现

- 扫描 `plugins/*/ember-plugin.json`，生成 `dist/external-plugins/index.json`，包含有 CLI 和无 CLI 的插件。
- `entry` 指向 Cordis 注册入口，`cli` 可选，指向导出 `registerCli` 的模块。安装保持清单的相对路径有效，资源允许明确的 from/to 复制。
- 外部插件输出独立于内置组件的 `dist/plugins`。路径必须位于插件目录内，拒绝符号链接。
- 构建摘要包含带 manifest 的插件源码和静态资源，排除 dist、依赖和缓存。TypeScript 和测试配置不写死插件名称。

## CLI 与运行时

- 先读取安装索引和显式 patch，再注册命令和参数，最后严格解析完整 argv。已注册命令、参数及别名冲突时拒绝启动。
- `PluginCliRegistrar.addCommand` 注册插件子命令，`extendCommand("run", ...)` 增加运行参数。插件回调通过已绑定插件身份的 activation 生成 `{ id, config }`。
- 八类评测组件保持不变。`registerStoreDecorator(name, validate, factory)` 单独注册 Store 包装工厂；宿主记录工厂所属模块，不要求注册名等于模块 ID。
- 注册和校验不分配资源。显式启用后才创建包装；轮询器通过 Cordis effect 释放，网络遵循 AbortSignal。

## 配置恢复与分布式执行

- `pluginRuntime.plugins` 保存启用项和非敏感配置，resume/retry 自动恢复。显式传入不同配置拒绝续跑；凭证通过环境变量引用，不保存 token 明文。
- Ray Jobs 向协调端传输可移植插件配置。worker 根据版本记录从本机安装索引加载模块，并严格校验版本；不创建协调端 Store 包装。
- tracer 在协调端镜像已导入的远端结果和轨迹，不声称支持 worker 实时流。Store 包装保留可选方法的缺省状态和 importAttempt 的接收/拒绝结果。

## 验收

新增非 tracer 测试插件，只增加插件目录即可构建、注册命令或参数。覆盖无 CLI 插件、patch 插件、冲突拒绝、续跑/重试配置恢复、无源码安装运行、源码摘要变化及取消资源释放。真实 Docker/Ray 验收与本地受控测试分别记录。
