# Ruukoto

拥有者自用的 Agent，同仓交付两个产品：

<!-- Note: 见 .agents/notes/implemented/architecture/2026-10-02-two-agent-products.md -->

| | `ruukoto-code`（Coding Agent） | `ruukoto`（个人 Agent） |
| --- | --- | --- |
| 运行位置 | 开发机（macOS / Linux） | 专用 Linux 服务器 |
| 主要入口 | TUI | QQ 私聊、Telegram（共用一个 main 会话） |
| 组织方式 | 工作区 → 会话 | 一个持续的 main 会话 |
| 后台 | 打开 TUI 时按需拉起，`ruukoto-code stop` 才停止 | systemd 常驻 |
| 档案根 | `~/.ruukoto-code/` | `~/.ruukoto-durable/`（生产须显式选择新目录） |

两端独立启停；设计见[架构总览](docs/architecture.md)。

## 当前状态

个人正式入口使用 Pi durable，Coding 保留原有工作区、会话、SubAgent、工作流与开发资料导入。个人保留能力及入口制品在隔离档案验收，生产切换另行安排。尚未完成：

- 最终候选组合验收与生产接管，旧首期平台替身不能替代当前真实验收；
- 跨端共享记忆、邮件与 GitHub comment 渠道、独立的 QQ 群聊外挂（核心群聊已退役，旧群资料保留为只读归档）。

[逐项验收证据](docs/release-acceptance.md)。

个人 [`ruukoto`](docs/usage.md#25-个人-agent-引导与管理) 使用 Pi 1.3.0；无参打开配置与管理菜单，`serve` 前台托管后台，`npm run personal:durable` 是同入口兼容命令。IM 用 `/帮助` 查入口。Coding 使用 Pi 0.85.1，入口与档案保持。

## 快速开始

开发与离线检查需要 Node ≥ 22.19、Git、Bash 和支持 PTY 的 Python 3，使用 macOS 或 Linux 的普通用户账户。两个产品的受限执行均使用原生沙箱，无需 Docker；平台前置见[操作手册](docs/usage.md#1-前提与安装)。

```bash
npm run setup       # 按两份锁文件安装依赖、检查前提并安装轻量提交钩子
npm run check       # 构建两类 worker/WASM，静态及全部离线测试
npm link            # 可选：把 ruukoto / ruukoto-code 装进 PATH（否则用 npm start -- …）
```

### ruukoto-code（开发机）

```bash
ruukoto-code config               # 配置模型与 API key（后台未运行时进入离线模式）
ruukoto-code ~/code/my-repo       # 以该目录为工作区新建会话；首次自动拉起后台
ruukoto-code                      # 回到既有会话（不隐式新建）
ruukoto-code stop                 # 停止后台
```

工作区按真实目录身份归属：符号链接与路径变体复用同一工作区，同名不同目录不合并；一个工作区可以包含多个仓库。默认 native，正式入口拒绝旧 local/container 覆盖；迁移见[操作手册](docs/usage.md#21-启动后台)。完全访问在 macOS 与 Linux 直接使用启动账户，不施加任务沙箱；环境继承、工作区外访问及停止已有两平台真实 worker 验证。

| TUI 命令 | 用途 |
| --- | --- |
| `/new` | 在当前工作区建立空会话 |
| `/branch [名称]` | 从已落盘历史建立独立会话并切换，父子共享工作目录 |
| `/resume` | 切回父会话或其他会话 |

分支不调用模型、不启动原任务；名称支持中文和空格。来源范围与失败核实见[操作手册](docs/usage.md#72-命令)。

### ruukoto（Linux 服务器）

当前账户、Linux 原生命令前置、常驻 user manager、systemd 单元和可选服务 helper 的安装步骤见[部署说明](deploy/systemd/README.md)。先使用新档案配置模型与凭据环境变量，再配对专用 QQ/Telegram 入口；旧档案保留归档，不导入。

```bash
ruukoto                       # 模型、IM、权限、工作与实例管理菜单
ruukoto serve                 # 前台托管后台，信号触发停止
# 显式隔离目录：RUUKOTO_PERSONAL_DIR=/absolute/new-profile ruukoto
```

QQ/Telegram 共用主会话；后台分析完成后沿首次入口回报。退出日常菜单不停止已启动的后台，停止从菜单操作。

### 开发本项目

后台工作流与可打断等待见[操作说明](docs/usage.md#511-工作流问题与回报)，六输入组合及真实模型验证见[测试导航](docs/development.md#日常反馈)。

修改时先运行 `npm run check:static` 与相关测试，按改动面选最小检查集（[提交前检查](.agents/skills/pre-push-checks/SKILL.md)）；全量 `npm run check` 由 CI 与显式复跑执行。macOS 应用测试先串行隔离共享 UID 的进程夹具，其余并行。

```bash
npm run dev                # 隔离个人开发档案，前台后台随源码变更重启
npm run dev -- --config     # 同一开发档案的配置菜单，退出停止本次后台
npm run code               # 启动 ruukoto-code 开发后台并打开 TUI
npm run code -- --desktop   # 以桌面前端连接开发后台（macOS）
npm run desktop:build      # 构建含本机终端的 Electron 应用
npm run code -- ../my-project  # 以该目录创建/复用工作区，并进入新会话
```

开发与测试见[开发说明](docs/development.md)；MyGo：`npm run desktop:mygo`，见[桌面开发](docs/desktop-development.md)；[浏览器用法](docs/usage.md#12-浏览器)含登录与截图导出。

## 文档

- [docs/usage.md](docs/usage.md)：操作手册——运行、配置（含子代理角色文件）、启用各入口、导入旧实例与故障排查
- [docs/architecture.md](docs/architecture.md)：模块地图与四条主流程
- [docs/modules/](docs/modules/)：各模块的设计文档
- [docs/development.md](docs/development.md)：可复现环境、开发检查、开发实例与测试导航
- [docs/release-acceptance.md](docs/release-acceptance.md)：首期发布与验收证据
- [docs/postmortem/](docs/postmortem/)：事故复盘——失败机制与据此加的护栏
- [CONTEXT.md](CONTEXT.md)：领域术语
- [.agents/notes/](.agents/notes/)：架构决策记录
- [AGENTS.md](AGENTS.md)：面向编码代理的仓库约定
