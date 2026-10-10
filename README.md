# Ruukoto

拥有者自用的 Agent，同一仓库交付两个独立产品（见[两个 Agent 产品独立运行](.agents/notes/implemented/architecture/2026-10-02-two-agent-products.md)）：

<!-- Note: 见 .agents/notes/implemented/architecture/2026-10-02-two-agent-products.md -->

| | `ruukoto-code`（Coding Agent） | `ruukoto`（个人 Agent） |
| --- | --- | --- |
| 运行位置 | 开发机（macOS / Linux） | 专用 Linux 服务器 |
| 主要入口 | TUI | QQ 私聊、Telegram（共用一个 main 会话） |
| 组织方式 | 工作区 → 会话 | 一个持续的 main 会话 |
| 后台 | 打开 TUI 时按需拉起，`ruukoto-code stop` 才停止 | systemd 常驻 |
| 档案根 | `~/.ruukoto-code/` | `~/.ruukoto/`（生产为 `/var/lib/ruukoto/`） |

两端独立安装、运行和升级，任一端停止不影响另一端。

## 设计要点

- **任务在后台执行，终端只是客户端。** 关掉 TUI 任务继续跑，重开即重连。后台重启后
  不自动重放模型或工具调用，未完成任务由拥有者决定是否继续。
- **权限靠技术约束，不靠提示词。** 受限模式下工具在每任务一个的容器里执行；越界操作
  形成绑定具体目标的单次审批。缺少执行边界时明确失败，不静默降级。
- **一层 SubAgent。** 主 Agent 可把工作委派给 SubAgent；Git 仓库中的修改委派在独立
  worktree 进行，由主 Agent 汇总到工作区待提交区。SubAgent 不能再派生下一层。
- **完整历史与模型上下文分开管理。** 消息历史以 pi JSONL 会话文件为唯一权威副本，
  SQLite（`node:sqlite`）只存元数据、事件与索引。

## 当前状态

双产品首期已交付：两个产品入口、工作区与会话、受限/完全访问执行、通用 SubAgent
（委派、复用、通信、取消、汇总、重启恢复）、IM 审批、白名单服务管理与长期授权、
旧实例导入。尚未完成：

- 真实 QQ / Telegram 平台与 macOS 完全访问的正向路径缺少实测证据（目前均为模拟平台）；
- 跨端共享记忆、邮件与 GitHub comment 渠道、独立的 QQ 群聊外挂（核心群聊已退役，
  旧群资料保留为只读归档）。

逐项证据见 [发布与验收说明](docs/release-acceptance.md)。

## 快速开始

开发与离线检查需要 Node ≥ 22.19、Git、Bash 和支持 PTY 的 Python 3，使用 macOS 或
Linux 的普通用户账户。受限模式另需 Docker（macOS 用 Docker Desktop）。

```bash
npm run setup       # 按两份锁文件安装依赖、检查前提并安装轻量提交钩子
npm run check       # 构建 worker、lint、类型检查、应用与基础验证的全部离线测试
npm link            # 可选：把 ruukoto / ruukoto-code 装进 PATH（否则用 npm start -- …）
npm run build:worker-image   # 使用 Docker 构建受限模式的工具镜像 ruukoto-worker
```

### ruukoto-code（开发机）

```bash
ruukoto-code config               # 配置模型与 API key（后台未运行时进入离线模式）
ruukoto-code ~/code/my-repo       # 以该目录为工作区新建会话；首次自动拉起后台
ruukoto-code                      # 回到既有会话（不隐式新建）
ruukoto-code stop                 # 停止后台
```

工作区按真实目录身份归属：符号链接与路径变体复用同一工作区，同名不同目录不合并；
一个工作区可以包含多个仓库。默认执行后端是容器；macOS 尚无经验证的完全访问执行
账户，选择完全访问会在执行前被拒绝。

### ruukoto（Linux 服务器）

三个系统身份（拥有者 / 后台 `ruukoto-backend` / 执行账户 `ruukoto-exec`）、工具镜像、
受保护的提权入口、systemd 单元以及可选的服务管理 helper，安装步骤见
[deploy/systemd/README.md](deploy/systemd/README.md)。部署后拥有者的日常环境：

```bash
export RUUKOTO_DATA_DIR=/var/lib/ruukoto/data
export RUUKOTO_OWNER_TOKEN_FILE=~/.ruukoto-owner.token   # 0400，部署时复制
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

绑定的拥有者可在原私聊里查看、批准或拒绝审批。main 委派长任务后继续回应新消息，
最终结果沿发起时的入口汇报。

### 开发本项目

修改时先运行 `npm run check:static` 与相关测试，收尾运行 `npm run check`。
独立检查、测试导航、CI、环境配置与验收入口见 [开发说明](docs/development.md)。

```bash
npm run dev                # 启动 ruukoto 开发后台，源码变更自动重启
npm run dev -- --config     # 打开 ruukoto 开发实例的配置中心
npm run code               # 启动 ruukoto-code 开发后台并打开 TUI
npm run code -- ../my-project  # 以该目录创建/复用工作区，并进入新会话
npm run code -- --config    # 打开 ruukoto-code 开发实例的配置中心
npm run code -- --import-models ~/.ruukoto-code/agent   # 显式复制模型配置
```

`dev` 继续使用 `~/.ruukoto-dev/<仓库>-<哈希>/`，`code` 使用独立的
`~/.ruukoto-code-dev/<仓库>-<哈希>/`，各自与日常实例的数据、锁和控制面隔离，
不自动迁移历史。两个入口都支持 `--import-models <目录>`，只复制 `models.json` 与
`auth.json`；首次运行可先用对应的 `--config` 配置模型。旧 `dev -- --tui` 已删除。

`code` 的路径参数只接受一个已存在的目录，相对路径按 npm 脚本的当前目录
（通常为本仓库）解析；路径含空格时加引号，不能与 `--config` 同用。
源码重载时恢复原会话和草稿，不重复创建会话。

开发实例固定停用 QQ / Telegram，不继承生产拥有者令牌和执行账户配置。
`dev` 默认使用无隔离的 `local` 后端，`code` 默认使用 `container`，受限任务需要
Docker 和 worker 镜像。退出 TUI、配置中心或启动终端会停止整组开发进程。

## 权限模式

模式按会话设默认值、按任务生效，TUI 顶部持续显示。

| 模式 | 行为 |
| --- | --- |
| 请求确认 `confirm`（默认） | 工作区内读写与检查自主执行；越出工作区、未授权网络或凭据、对外写操作逐次请拥有者确认。批准绑定目标、内容指纹、方法与完整 URL，单次消费 |
| 自动审查 `auto-review` | 执行环境同上；越界的文件读取与无凭据 GET/HEAD 先经一次独立的无工具审查调用裁决，失败或拿不准一律转拥有者 |
| 完全访问 `full_access` | 只能由拥有者显式选择；在容器外以固定执行账户运行，不额外赋予系统权限。模型、工具、记忆或 IM 消息都不能开启 |
| 计划 `plan` | 仅普通开发会话；沿用自动审查的环境与审批，要求只调研不修改，持续到手动切换。保留的 `bash` 仍可能写入，不是全面只读保证 |

受限模式的容器：非 root、cap-drop ALL、no-new-privileges、只读根文件系统、默认无网络，
只挂载工作区与任务级授予路径，任务结束即回收。

## TUI

顶部是项目 / 会话 / 工作目录 / 连接状态 / 权限模式 / 执行后端，中间是消息与工具记录，
底栏是权限模式、token 用量与模型。TUI 只经本机 socket + 拥有者令牌连接后台，不加载
模型凭据、不读数据库。

**输入**

| 按键 | 行为 |
| --- | --- |
| `Enter` | 提交 |
| `Alt+Enter` / `Shift+Enter` / `Ctrl+J` | 换行（部分终端不上报 Shift+Enter） |
| `Shift+Tab` | 循环切换会话默认模式 |
| `Ctrl+C` | 有草稿先清空草稿；空草稿退出客户端 |
| `PageUp` / `PageDown` / 滚轮 | 翻页；滚动后新输出不会把视口拉回底部 |
| `End` | 回到最新位置，恢复跟随 |

**命令**

| 命令 | 说明 |
| --- | --- |
| `/help` | 命令与快捷键说明 |
| `/todo` | 打开或关闭右上角工作清单悬浮层 |
| `/resume` | 切换当前项目中的会话 |
| `/project` | 切换项目 |
| `/new-project <名称>`、`/new-session <目录>`、`/new` | 创建项目 / 在当前项目创建会话 / 在当前工作区创建会话 |
| `/history` | 重新加载当前会话历史；滚动到顶部自动加载更早历史 |
| `/artifact <id 前缀>` | 查看工具产物正文（按字节分页） |
| `/approvals` | 待处理审批；详情内 `a` 批准、`r` 拒绝，`Esc` / `q` 关闭不等于拒绝 |
| `/interrupt [taskId]`、`/cancel <taskId>`、`/continue [taskId]` | 中断 / 取消 / 继续任务 |
| `/resume-queue` | 恢复已暂停的会话队列 |
| `/model` | 选择提供方 / 模型 / 思考强度，作用于之后提交的任务 |
| `/mode` | 选择会话默认模式，作用于后续新任务 |
| `/status` | 查看当前任务详情 |
| `/search <关键词>` | 字面搜索会话历史原文 |
| `/memory <子命令>` | 长期记忆：list / show / revoke / restore |
| `/context` | 上下文窗口分解（各部分占比与压缩点） |
| `/prompt` | 本会话的模型请求列表与每次调用的 prompt |
| `/skill <名称> [参数]` | 显式调用技能（不带名称时同 `/skills`） |
| `/skills` | 技能库与诊断 |
| `/qq <子命令>` | QQ 入口：status / enable / disable / groups / inbox / outbox（后三者为旧群归档） |
| `/quit` | 退出客户端（后台任务继续运行） |

**断开与重连**：退出只关闭客户端。重连后从后台重建快照、历史与输出预览，不自动新建
任务、不恢复暂停的队列。提交带客户端生成的 `request_id` 并先落盘到 `pending/`；应答丢失时
按 `会话 + request_id` 核实，确认未接收才以原键原参数重试，不会换新键重复提交。

## 命令行

除 `server` 外都需要拥有者令牌（`RUUKOTO_OWNER_TOKEN`、`RUUKOTO_OWNER_TOKEN_FILE` 或控制面
目录的 `owner.token`）。两个产品共用同一套命令；`ruukoto help` 列出全部。

```bash
ruukoto server [--execution local|container] [--model provider/model]   # 前台运行后台
ruukoto status [任务 id] | events                    # 快照 / 持久事件流
ruukoto submit <会话 id> <request-id> "输入" [--mode ...] [--grant <路径>:<read|read_write>[:用途]]
ruukoto continue <任务 id> <request-id> "输入"       # 继续中断任务（新任务，旧批准不继承）
ruukoto interrupt | cancel <任务 id>; ruukoto resume-queue <会话 id>
ruukoto confirm <确认 id> approve|reject
ruukoto work list | show | close | cancel            # SubAgent 工作委派
ruukoto memory | history-search | credentials | mcp | grant | service-grant ...
ruukoto legacy-import preview | apply | revert | list   # 从旧实例离线导入
```

`--execution local` 没有任何隔离，只用于本机开发与测试。GitHub 能力经通用 MCP 服务接入
（专用模块已退役）。各命令的完整参数与语义见 [运行文档](docs/runtime.md)。

## 数据目录

以 `ruukoto` 默认值为例；`ruukoto-code` 结构相同，根目录换成 `~/.ruukoto-code/`。

```
~/.ruukoto/data/      0700  元数据库、会话 JSONL、产物、实例锁
~/.ruukoto/control/   0770  控制面 socket（0660）与拥有者令牌（0600）
~/.ruukoto/agent/     0700  models.json、auth.json、credentials.json、default-model.json
~/.ruukoto/pending/   0700  待核实的提交记录
```

目录可用 `RUUKOTO_{DATA,AGENT,CONTROL,PENDING}_DIR` 覆盖；`ruukoto-code` 只读
`RUUKOTO_CODE_*_DIR` 这一组，跨产品打开数据目录会被拒绝。执行相关变量
（`RUUKOTO_EXECUTION_BACKEND`、`RUUKOTO_EXEC_UID/GID`、`RUUKOTO_CONTAINER_UID/GID`、
`RUUKOTO_WORKER_IMAGE`）见部署文档。

## 已知限制

- 同一工作目录同时只允许一个写任务；并行修改靠 SubAgent 的 worktree，非 Git 目录串行。
- 上下文超出预算或 provider 返回 `context_overflow` 时任务中断、队列暂停，需人工继续。
- 原生 Linux 的 bind mount 不做 uid 映射，容器 uid/gid 须与工作区写权限匹配
  （部署文档第 5 步）；Docker Desktop 会掩盖这个问题。
- 服务器服务管理只覆盖白名单服务的检查与重启。

## 文档

- [CONTEXT.md](CONTEXT.md)：领域术语
- [docs/adr/](.agents/notes/)：架构决策记录
- [docs/runtime.md](docs/runtime.md)：实现细节、完整命令与验证状态
- [docs/development.md](docs/development.md)：可复现环境、开发检查与测试导航
- [docs/visual/index.html](docs/visual/index.html)：状态机、调用路径、协议、存储与部署图解（2026-10-09 快照，已停止维护）
- [docs/release-acceptance.md](docs/release-acceptance.md)：首期发布与验收证据
- [AGENTS.md](AGENTS.md)：面向编码代理的仓库约定
