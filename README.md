# Ruukoto

拥有者自用的 Agent，同仓交付两个产品：

<!-- Note: 见 .agents/notes/implemented/architecture/2026-10-02-two-agent-products.md -->

| | `ruukoto-code`（Coding Agent） | `ruukoto`（个人 Agent） |
| --- | --- | --- |
| 运行位置 | 开发机（macOS / Linux） | 专用 Linux 服务器 |
| 主要入口 | TUI | QQ 私聊、Telegram（共用一个 main 会话） |
| 组织方式 | 工作区 → 会话 | 一个持续的 main 会话 |
| 后台 | 打开 TUI 时按需拉起，`ruukoto-code stop` 才停止 | systemd 常驻 |
| 档案根 | `~/.ruukoto-code/` | `~/.ruukoto/`（生产为 `/var/lib/ruukoto/`） |

两端独立运行，停止一端不影响另一端；设计见[架构总览](docs/architecture.md)。

## 当前状态

双产品首期已交付：两个产品入口、工作区与会话、受限/完全访问执行、通用 SubAgent（委派、复用、通信、取消、汇总、重启恢复）、IM 审批、白名单服务管理与长期授权、旧实例导入。尚未完成：

- 真实 QQ / Telegram 平台缺少实测证据（消息平台目前使用模拟验证）；
- 跨端共享记忆、邮件与 GitHub comment 渠道、独立的 QQ 群聊外挂（核心群聊已退役，旧群资料保留为只读归档）。

[逐项验收证据](docs/release-acceptance.md)。

个人用 [`npm run personal:durable`](docs/usage.md#25-个人-durable-隔离向导)：Pi 1.3.0 隔离向导、Telegram 文本配对、Linux 服务配置、权限与分析追加、控制与回报；Coding 用 Pi 0.85.1，正式入口未变。

## 快速开始

开发与离线检查需要 Node ≥ 22.19、Git、Bash 和支持 PTY 的 Python 3，使用 macOS 或 Linux 的普通用户账户。两个产品的受限执行均使用原生沙箱，无需 Docker；平台前置见[操作手册](docs/usage.md#1-前提与安装)。

```bash
npm run setup       # 按两份锁文件安装依赖、检查前提并安装轻量提交钩子
npm run check       # 构建 worker 与 WASM、静态检查及全部离线测试
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

当前账户、原生沙箱与宿主工具、常驻 user manager、systemd 单元以及可选的固定服务管理 helper，安装步骤见[deploy/systemd/README.md](deploy/systemd/README.md)。部署后拥有者的日常环境：

```bash
export RUUKOTO_DATA_DIR=/var/lib/ruukoto/data
ruukoto status
```

绑定 IM 入口（token 只经环境变量传入，不进命令行）：

```bash
TG_TOKEN=... ruukoto credentials add --name tg --host api.telegram.org \
  --header none --purpose telegram_bot --secret-env TG_TOKEN
ruukoto telegram configure --credential tg --user-id <拥有者 user_id>
ruukoto telegram enable

QQ_ONEBOT_TOKEN=... ruukoto credentials add --name qq-onebot --host 127.0.0.1:3001 \
  --header authorization --purpose qq_onebot --secret-env QQ_ONEBOT_TOKEN
ruukoto qq configure --endpoint ws://127.0.0.1:3001 --self-id <登录 QQ 号> \
  --credential qq-onebot --owner-id <拥有者 QQ 号>
ruukoto qq enable
```

绑定的拥有者可在原私聊里查看、批准或拒绝审批。main 委派长任务后继续回应新消息，最终结果沿发起时的入口汇报。

### 开发本项目

后台工作流与可打断等待见[操作说明](docs/usage.md#511-工作流问题与回报)，六输入组合及真实模型验证见[测试导航](docs/development.md#日常反馈)。

修改时先运行 `npm run check:static` 与相关测试，按改动面选最小检查集（[提交前检查](.agents/skills/pre-push-checks/SKILL.md)）；全量 `npm run check` 由 CI 与显式复跑执行。macOS 应用测试先串行隔离共享 UID 的进程夹具，其余并行。

```bash
npm run dev                # 启动 ruukoto 开发后台，源码变更自动重启
npm run code               # 启动 ruukoto-code 开发后台并打开 TUI
npm run code -- --desktop   # 以桌面前端连接开发后台（macOS）
npm run desktop:build      # 构建并 ad-hoc 签名 dist/mac-arm64/Ruukoto.app
npm run code -- ../my-project  # 以该目录创建/复用工作区，并进入新会话
```

开发与桌面回归见[开发说明](docs/development.md)；[浏览器用法](docs/usage.md#12-浏览器)含登录与截图导出。

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
