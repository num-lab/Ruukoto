# ruukoto

面向拥有者日常使用的通用个人 Agent。当前最重要的用途是开发协助：接受仓库和
需求，读取代码、修改文件、运行检查、按失败继续修复，交付可审查的改动。项目维护
（GitHub CI 分析与 PR 评审）与 QQ 群聊是后续用途。

设计上的关键点：**任务在后台进程中执行，交互终端只是客户端**。关掉终端任务继续
跑，重新打开即可重连；后台或服务器重启后不自动重放工具与模型调用，未完成任务交
由拥有者决定是否继续。

- 术语表：[CONTEXT.md](CONTEXT.md)
- 架构决策：[docs/adr/](docs/adr/)
- 实现细节与验证状态：[docs/runtime.md](docs/runtime.md)
- 面向代理的仓库约定：[AGENTS.md](AGENTS.md)

当前状态：首期（后台运行时、编码工具与两种权限模式、TUI、上下文与长期记忆、
目标服务器部署）已完成。GitHub 接入经通用 MCP 服务（专用模块已退役，见
docs/runtime.md）。Jev 上下文筛选适配器已实现，默认关闭；QQ 接入与实验配置见运行文档。

## 快速开始（本机，开发用）

需要 Node ≥ 22.19。

```bash
npm install
npm run typecheck
npm test                 # 全部离线集成验证（mock 模型，不联网、不需要凭据）
npm link                 # 可选：把 ruukoto 命令装进 PATH（否则用 npm start -- …）

# 模型配置：交互式初始化（离线写入 ~/.ruukoto/agent 的 models.json/auth.json）
ruukoto config
# 或手动放置：cp <你的 models.json> <你的 auth.json> ~/.ruukoto/agent/

# 日常开发循环：隔离的开发后台 + 任务界面，源码变更自动重启
npm run dev -- --tui
```

生产/日常后台前台运行（生产环境由 systemd 管理）：

```bash
ruukoto server --execution container    # start 是兼容别名，推荐 server
```

后台启动后：

```bash
ruukoto                      # 任务界面（选择既有会话，不隐式新建）
ruukoto /path/to/workdir     # 以该目录为工作区创建新会话并进入（项目自动归属/创建）
ruukoto config               # 配置中心（在线管理模型/项目/MCP/QQ/凭据）
ruukoto status               # 非交互管理命令：快照、任务、审批……
```

`--execution local`（默认）没有隔离，只用于本机开发/验证；生产部署必须用
`--execution container`，见 [deploy/systemd/README.md](deploy/systemd/README.md)。

## 部署到 Linux 服务器

三个系统身份（拥有者 / 后台 `ruukoto-backend` / 执行账户 `ruukoto-exec`）、固定
工具镜像、受保护的提权入口与 systemd 单元，安装步骤见
[deploy/systemd/README.md](deploy/systemd/README.md)。

部署后拥有者的日常环境：

```bash
export RUUKOTO_DATA_DIR=/var/lib/ruukoto/data
export RUUKOTO_OWNER_TOKEN_FILE=~/.ruukoto-owner.token   # 0400，部署时复制
ruukoto status
```

## 日常使用：TUI

`ruukoto` 打开全屏交互终端（旧拼法 `ruukoto tui` 仍可用，会提示迁移）：顶部是项目/会话/工作目录/连接状态/任务权限模式/
执行后端，中间滚动显示消息与工具记录，底部是多行输入与任务/队列状态。

`ruukoto <路径>` 以指定目录为工作区创建新会话并直接进入：相对路径按当前目录
解析，符号链接按同一目录身份归属；目录已有开发会话所属项目时复用（多个候选
先选择），从未用过的目录自动创建项目。每次独立启动都创建新会话；创建请求带
稳定的启动请求标识，断线重连与重试不会重复创建。

TUI 只连接已运行的后台（本机 Unix socket + 拥有者令牌），不创建模型会话、不加载
模型凭据、不直接读后台数据库。后台不可达时显示连接状态并按有上限的退避重连，不会
悄悄另起一个任务。

**输入**

| 按键 | 行为 |
| --- | --- |
| `Enter` | 提交 |
| `Alt+Enter` / `Shift+Enter` / `Ctrl+J` | 换行（部分终端不上报 Shift+Enter） |
| `Ctrl+C` | 有草稿先清空草稿；空草稿退出客户端 |
| `PageUp` / `PageDown` / 滚轮 | 翻页；滚动后新输出不会把视口拉回底部 |
| `End` | 回到最新位置，恢复跟随 |

支持中文与 bracketed paste；大段粘贴在编辑器内折叠显示，提交保留展开后的原文。
补全只覆盖 `/` 固定命令，不扫描本地文件。

**命令**

| 命令 | 说明 |
| --- | --- |
| `/help` | 命令与快捷键说明 |
| `/sessions` | 切换项目与会话 |
| `/new-project <名称>`、`/new-session <目录>` | 创建项目 / 在当前项目创建会话 |
| `/older`、`/history` | 向前翻页加载更早历史 / 重新加载当前会话历史 |
| `/expand <id 前缀>` | 展开完整消息或工具参数 |
| `/artifact <id 前缀>` | 查看工具产物正文（按字节分页） |
| `/approvals` | 待处理审批列表；详情内 `a` 批准、`r` 拒绝，`Esc` 关闭不等于拒绝 |
| `/interrupt [taskId]`、`/cancel <taskId>`、`/continue [taskId]` | 中断 / 取消 / 继续任务 |
| `/resume-queue` | 恢复已暂停的会话队列 |
| `/mode <confirm\|full_access\|auto-review> [taskId]` | 经显式确认覆盖层按任务切换访问模式 |
| `/status` | 刷新并查看当前任务详情 |
| `/search <关键词>` | 搜索会话历史原文（字面匹配） |
| `/memory <子命令>` | 长期记忆：list / show / revoke / restore |
| `/context` | 查看本轮上下文选择记录（预算组成与排除原因） |
| `/skill <名称> [参数]` | 显式调用技能库中的技能（提交任务；不带名称时同 `/skills`） |
| `/skills` | 查看技能库（名称、是否仅显式调用、描述摘要）与诊断 |
| `/plan <内容>` | 计划模式：只调研不修改，最终回答即计划；下一条普通消息即按计划执行（逐次审批不变） |
| `/quit` | 退出客户端（后台任务继续运行） |

**断开与重连**：退出只关闭客户端，后台任务继续执行。重连后从后台重建快照、历史与
最新输出预览（生成中与中断前已捕获部分分别标注），不自动新建任务、不恢复暂停队列。
事件序号出现缺口时自动重新同步。

**输入去重**：提交前生成 `request_id`，并把完整请求原子保存到拥有者私有目录
（默认 `~/.ruukoto/pending/`，0600）。应答丢失时界面显示"接收结果待核实"，重连后
按 `会话 + request_id` 核实：已接收则关联原任务，明确未接收才以原键原参数重试。
同键不同参数返回冲突，不会换新键重发。

## CLI 参考

交互入口：`ruukoto`（任务界面）、`ruukoto <路径>`（工作区新会话）、
`ruukoto config [--offline]`（配置中心）、`ruukoto server`（前台后台）。
`ruukoto start` 是 `server` 的兼容别名，`ruukoto tui` 由无参入口替代（旧拼法
给出迁移指引）。命令名优先于路径：与命令同名的目录用 `./config` 或 `-- <路径>`
打开。非交互管理命令（脚本与非 TTY 环境）如下；除 `server` 外都需要拥有者令牌：
`RUUKOTO_OWNER_TOKEN`、`RUUKOTO_OWNER_TOKEN_FILE` 或控制面目录的 `owner.token`。

### 任务与运行

```bash
ruukoto server [--data-dir D] [--agent-dir A] [--execution local|container] [--model provider/model]
ruukoto create-project <名称>                 # 返回项目 id（后续命令用 id，不是名称）
ruukoto create-session <项目 id> <工作目录>
ruukoto submit <会话 id> <request-id> "任务输入" [--mode confirm|full_access|auto-review] [--grant <路径>:<read|read_write>[:用途];...]
ruukoto continue <任务 id> <request-id> "继续输入" [--mode ...] [--grant ...]
ruukoto switch-mode <任务 id> confirm|full_access|auto-review [--grant ...]
ruukoto status [任务 id]                      # 无参数 = 全局快照
ruukoto events                                # 订阅持久事件流（seq 单调递增）
ruukoto interrupt <任务 id> | cancel <任务 id> | resume-queue <会话 id>
ruukoto stop                                  # 优雅停止（SIGTERM/SIGINT 同一路径）
```

`request_id` 由客户端生成，唯一范围是会话。提交已落盘但应答丢失时，同键同参数
（含模式与授权范围）重试返回原任务。

### 审批与产物

```bash
ruukoto confirm <确认 id> approve|reject
ruukoto read-artifact <任务 id> <产物 id> [--offset N] [--length N]   # 正文写到 stdout
```

### 历史检索、记忆与上下文

```bash
ruukoto history-search <关键词> [--project P] [--session S] [--task T] [--role R]
                                [--since T] [--until T] [--limit N] [--scan-limit N] [--cursor B64]
ruukoto memory list [--project <id> | --personal]
ruukoto memory show <id>
ruukoto memory save <内容...> --category preference|convention|decision|experience
                                [--project <id> | --personal] [--id <id> --expected-version N] [--reason R]
ruukoto memory revoke <id> --expected-version N [--reason R]
ruukoto memory restore <id> --from-version N [--reason R]
ruukoto selection-records --task <id> | --session <id>       # 每轮上下文选择记录
ruukoto project set-instructions <项目 id> <工作区相对路径...>   # 项目指令（空列表 = 清除）
ruukoto grant create --from <项目> --to <项目> --category history|artifact|memory [--purpose P]
ruukoto grant list [--all] | grant revoke <grant-id>
```

历史搜索是字面关键词匹配（中文按原文匹配）；达到扫描上限时如实返回"结果不完整"
与继续游标。记忆的修改用预期版本号做条件更新，并发冲突明确报错，不静默覆盖。

### 服务凭据

```bash
ruukoto credentials list
ruukoto credentials add --name N --host H --header H --purpose P --secret-env VAR   # 秘密值取自环境变量，不进命令行
ruukoto credentials remove <name>
```

### GitHub（经 MCP 接入）

专用 GitHub 模块已退役（issue 17）：PR / issue / CI 等读取操作在普通任务中经
GitHub MCP 工具完成，配置与发现走通用 MCP 入口：

```bash
ruukoto credentials add --name github-mcp --host api.githubcopilot.com --header authorization --purpose mcp --secret-env GITHUB_MCP_PAT
ruukoto mcp configure --project <id> --name github --endpoint https://api.githubcopilot.com/mcp/readonly --credential github-mcp --tools get_me,get_file_contents
ruukoto mcp list [--project <id>] | check <service-id> | disable <service-id> | enable | remove
```

上述配置只启用读取工具；通用写工具见 issue 18。旧模块的历史草稿与发布记录在
升级后首次启动时归档为原任务产物，清单见 `<数据目录>/github-archive-manifest.json`。

PR webhook 可经后台 `--github-webhook-config` 显式启用：固定仓库的事件触发只读
review，报告留为任务产物，main 摘要经 outbox 通知固定 owner；不自动发布评论。

旧 `ruukoto github …` 命令只保留退役提示。详见 [运行文档](docs/runtime.md) 中
「GitHub：MCP 操作与 PR webhook」和「MCP 服务」两节。

## 权限模式

权限用技术约束实现，不是靠提示词要求模型自律。模式按任务生效，TUI 顶部持续显示。

**请求确认（默认）**：工作区内的读写、测试与检查自主执行；越出工作区、访问未授权
网络或凭据、对外写操作（发布、合并、部署）需要拥有者逐次确认。批准只放行该次具体
操作（绑定目标、内容指纹、方法、完整 URL、凭据名称与用途），单次消费，其他 URL、
方法、正文或任务不能复用。TUI 不在线时请求保持等待，重连后继续处理，其他会话不受
影响。

**完全访问**：拥有者在可信入口显式选择，跳过应用内逐次确认，使用运行账户已有的系统
权限。它不额外赋予系统权限，也不让其他会话或群成员获得同样授权；模型、工具、记忆
内容或 QQ 消息都不能开启它。模式改变只作用于后续操作，不能撤销已经执行的外部效果。

**自动审查**：与请求确认同一受限执行环境；越界的外部文件读取与无凭据 HTTP 读取
（GET/HEAD）先经一次独立的无工具审查调用自动审批，结论为批准、拒绝或转拥有者确认。
写操作、带凭据请求与其他越界操作仍需拥有者确认；审查失败、超时或上下文不足一律转
拥有者。审查结论、理由、模型与策略版本随审批记录保存，可在审批详情查看。

请求确认与自动审查模式下，任务的编码工具在按任务建立的容器内执行：非 root、cap-drop ALL、
no-new-privileges、只读根文件系统、默认无网络，只挂载授权的工作区与任务级授予路径，
任务结束回收容器。完全访问在容器外由 systemd 以固定执行账户启动。缺少执行后端或
身份配置时明确失败，不回退到后台账户执行。

```bash
ruukoto submit <会话 id> req-1 "在 /srv/data 下生成报告" --mode confirm --grant /srv/data:read_write:报告数据源
```

## 配置中心

`ruukoto config` 打开独立配置界面（复用控制面认证连接，任务执行审批仍在任务
界面）。在线管理：provider 与模型目录（端点、协议、模型及上下文/输出参数）、
模型 API key、后台默认模型、项目指令/Web Search/资料授权、会话默认模型/
思考档位/权限模式、MCP 服务、QQ 配置与允许群、服务凭据。

- 并发保存经配置修订号/版本号校验，冲突时要求重新加载，不静默覆盖。
- provider、模型目录与 API key 的修改只在没有受影响的 running /
  awaiting_confirmation / queued 任务时应用；占用期间明确拒绝且不部分应用。
  应用成功后持久配置、ModelRuntime、模型目录与驱动一致切换，重启后仍有效。
- 秘密输入遮蔽显示；响应只展示是否已配置，秘密不进入日志、事件与历史。
  模型 API key（auth.json）与服务凭据（credentials.json）分开管理。
- 后台未运行时进入有限的离线模式（`--offline` 强制）：只初始化/修复模型
  目录、默认模型与 API key；同一 agentDir 被后台或其他配置进程占用（按
  配置锁判定）时拒绝写入。

## 开发实例（npm run dev）

```bash
npm run dev                 # 隔离开发后台，监听源码变更并重启
npm run dev -- --tui        # 加可重载的任务界面（--tui 与 --config 互斥）
npm run dev -- --config     # 加可重载的配置界面；无有效模型时先离线初始化
npm run dev -- --import-models ~/.ruukoto/agent   # 显式导入模型配置到开发目录
```

开发实例使用仓库外的稳定 profile（`~/.ruukoto-dev/<仓库>-<哈希>/` 下的
data/agent/control/pending/logs），与日常实例的数据、凭据、控制面、待确认
提交完全隔离；不继承生产 owner token、执行账户配置或消息平台凭据（QQ 默认
停用），真实模型须显式配置。退出界面或 Ctrl+C 统一清理本组进程；任务界面
重载恢复当前会话、未提交草稿与继续任务意图（秘密表单值不落重载文件）。

## 数据与环境变量

```
~/.ruukoto/data/            0700  元数据库（node:sqlite）、会话 JSONL、实例锁、产物
~/.ruukoto/control/         0770  控制面 socket（0660）与拥有者令牌（0600）
~/.ruukoto/agent/           0700  models.json、auth.json、credentials.json、
                                  default-model.json、config.lock/
~/.ruukoto/pending/         0600  待核实提交记录
~/.ruukoto-dev/<仓库>-<哈希>/ 0700  开发实例 profile（npm run dev）
```

消息历史的唯一权威副本是 pi JSONL 会话文件；SQLite 只存元数据、事件与可重建的位置
索引；产物正文在产物文件，SQLite 只存元数据。三者没有跨文件事务。

| 变量 | 用途 |
| --- | --- |
| `RUUKOTO_DATA_DIR` | 数据目录（默认 `~/.ruukoto/data`） |
| `RUUKOTO_AGENT_DIR` | 模型配置与凭据目录（默认 `~/.ruukoto/agent`） |
| `RUUKOTO_CONTROL_DIR` | 控制面目录（默认数据目录的兄弟目录 `control/`；客户端与 `server` 都读取） |
| `RUUKOTO_OWNER_TOKEN` / `RUUKOTO_OWNER_TOKEN_FILE` | 拥有者令牌或其文件路径 |
| `RUUKOTO_PENDING_DIR` | 待核实提交记录目录（默认 `~/.ruukoto/pending`） |
| `RUUKOTO_DISABLE_QQ` | `=1` 时后台不启动 QQ 适配器（开发实例默认注入） |
| `RUUKOTO_EXECUTION_BACKEND` | 执行后端 `local` / `container` |
| `RUUKOTO_EXEC_UID` / `RUUKOTO_EXEC_GID` | 完全访问任务的执行账户 |
| `RUUKOTO_CONTAINER_UID` / `RUUKOTO_CONTAINER_GID` | 容器内进程 uid/gid（原生 Linux 的 bind mount 不做 uid 映射） |
| `RUUKOTO_WORKER_IMAGE` / `RUUKOTO_WORKER_IMAGE_TAG` | 工具工作进程镜像 |

## 异常恢复

后台或服务器异常重启后，恢复逻辑自动执行（单事务）：

1. 原 `running` / `awaiting_confirmation` 任务标记为 `interrupted`，未决审批失效，
   已批准未消费的操作记为"已知未执行"；执行已开始但结果缺失的记为 `effect_unknown`，
   不自动重放模型调用或工具操作。
2. 有排队任务的会话暂停自动调度，拥有者核实后用 `ruukoto resume-queue <会话 id>`
   显式恢复。
3. 崩溃时遗留的目录占用无法确认旧执行是否停止时，保留占用并暂停会话；核实容器/
   子进程确已停止后再 `resume-queue` 释放。
4. 继续中断任务用 `ruukoto continue <任务 id> <request-id> "..."`：创建带来源标记的
   新任务，默认回到请求确认模式（旧批准不继承），不补造工具结果。

## 已知限制

- 同一工作目录同时只允许一个会话执行可写任务；不同目录可并行。已有独立 Git worktree
  视为不同工作目录，自动创建与整合 worktree 尚未实现。
- 达到上下文预算或 provider 返回 `context_overflow` 时任务中断并暂停队列，不做静默
  摘要、不丢弃历史；需要人工继续。
- 目标机为原生 Linux 时，容器 uid/gid 必须与拥有者工作区写权限匹配（见部署文档
  第 5 步）；Docker Desktop 的 uid 映射会掩盖这个问题。
- 发布形态目前是 PR 评审摘要与普通 issue/PR 评论，不做逐行评审评论。
- Jev 实验需在 `ruukoto config` 的项目配置中选择专用凭据并启用；真实筛选质量、延迟与净费用收益尚未验证。
