# 安装与部署

> [English](./installation.md) | 中文

[返回项目主页](../../README.zh-CN.md) · [用户手册](README.zh-CN.md)

## 直接安装

准备 Node.js **24.22.1 或更新的 24.x**、pnpm **11 或 12** 和 Git。

没有 pnpm 时，先运行 `npm install --global pnpm`。然后克隆仓库并安装 CLI：

```bash
git clone https://github.com/evolving-foundry/ember-evaluator.git
cd ember-evaluator
pnpm install --frozen-lockfile
pnpm add -g .
ember-evaluator --help
```

看到帮助信息即安装成功。pnpm 会从公开的 GitHub 仓库下载 AgentBundle SDK 并自动构建。请保留 Evaluator 目录及其依赖。 [AgentBundle 仓库](https://github.com/evolving-foundry/agentbundle)

顶层 `--help` 列出各命令用途。使用 `ember-evaluator run --help` 查看运行参数，使用 `ember-evaluator cleanup images --help` 查看嵌套命令；各命令的帮助会列出位置参数和选项含义。

更新源码后重新执行 `pnpm install --frozen-lockfile`。使用 WSL 时，安装和运行都在同一个 WSL 环境中完成。

## 安装全局命令

上面的 `pnpm add -g .` 会注册命令。如果提示全局目录未配置或找不到命令，运行：

```bash
pnpm setup
```

按提示重新打开终端，再回到 Evaluator 仓库重试 `pnpm add -g .` 和 `ember-evaluator --help`。

## 安装 Agent Skill

在使用编程 Agent 的项目目录执行以下命令，并选择对应的 Agent：

```bash
npx skills add evolving-foundry/ember-evaluator --skill ember-evaluator
```

也可以将以下指令交给编程 Agent 安装 CLI 和 Skill：

```text
请从 https://github.com/evolving-foundry/ember-evaluator 安装 Ember Evaluator CLI 和配套的 ember-evaluator skill。
按 docs/users/installation.zh-CN.md 安装 CLI，并在目标项目中为当前 Agent 安装 skill。
运行 ember-evaluator --help，并确认当前 Agent 能发现和读取该 skill。验证安装后结束任务。
```

## 从 TypeScript 源码运行 CLI

在仓库根目录使用 `pnpm dev` 可以直接运行 TypeScript 源码。新克隆的仓库安装依赖后，第一次执行需要插件注册表的命令会自动构建运行时资源和插件包。

```bash
pnpm dev run playbook/gsm8k/gsm8k-quick-start.yaml --tracer
```

运行前按 [Tracer 指南](tracer.zh-CN.md#查看评测过程)设置模型变量。

## 在任意目录运行

按[快速上手](quick-start.zh-CN.md)准备评测配置和模型变量，再执行：

```bash
ember-evaluator doctor '/path/to/config.yaml'
ember-evaluator run '/path/to/config.yaml'
```

YAML 中的相对路径以配置文件所在目录为准；`--patch` 建议使用绝对路径。需要 Docker 等额外环境时，按对应[场景指南](README.zh-CN.md)准备。

## 在管理容器中运行（Linux 服务器）

宿主机已有 Docker 时，可以在管理容器内安装和运行，无需在宿主机安装 Node.js 等依赖。步骤见[管理容器指南](deployment/container-toolbox.zh-CN.md)。

## 本机运行时缓存与 Windows 路径长度

运行时依赖会自动缓存。Windows 若出现 `WinError 206`，可指定更短的缓存路径后重试：

```powershell
$env:EVALUATOR_RUNTIME_CACHE_DIR = "D:\ae"
ember-evaluator run "D:\experiments\config.yaml"
```

其他安装或运行问题见[常见问题](faq/README.zh-CN.md)。
