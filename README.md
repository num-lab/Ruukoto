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
GitHub 项目维护、目标服务器部署）已完成。QQ 接入与 Jev 上下文筛选实验尚未开始。

## 快速开始（本机，开发用）

需要 Node ≥ 22.19。

```bash
npm install
npm run typecheck
npm test                 # 全部离线集成验证（mock 模型，不联网、不需要凭据）

# 模型配置：显式放在 agent 目录，不读取 ~/.pi/agent
mkdir -p ~/.ruukoto/agent && chmod 700 ~/.ruukoto
cp <你的 models.json> <你的 auth.json> ~/.ruukoto/agent/   # 或从 ~/.pi/agent 复制

npm start -- start --agent-dir ~/.ruukoto/agent --model deepseek/deepseek-flash
```

后台启动后，另开一个终端：

```bash
npm start -- create-project demo          # 返回项目 id
npm start -- create-session <项目 id> /path/to/workdir
npm start -- submit <会话 id> req-1 "读一下这个仓库的结构，说明它是做什么的"
npm start -- status                       # 快照：任务、审批、产物引用
npm start -- tui                          # 交互终端
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

`ruukoto tui` 打开全屏交互终端：顶部是项目/会话/工作目录/连接状态/任务权限模式/
执行后端，中间滚动显示消息与工具记录，底部是多行输入与任务/队列状态。

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
| `/github <子命令>` | drafts / show / publish |
| `/quit` | 退出客户端（后台任务继续运行） |

**断开与重连**：退出只关闭客户端，后台任务继续执行。重连后从后台重建快照、历史与
最新输出预览（生成中与中断前已捕获部分分别标注），不自动新建任务、不恢复暂停队列。
事件序号出现缺口时自动重新同步。

**输入去重**：提交前生成 `request_id`，并把完整请求原子保存到拥有者私有目录
（默认 `~/.ruukoto/pending/`，0600）。应答丢失时界面显示"接收结果待核实"，重连后
按 `会话 + request_id` 核实：已接收则关联原任务，明确未接收才以原键原参数重试。
同键不同参数返回冲突，不会换新键重发。

## CLI 参考

除 `start` 外的命令都需要拥有者令牌：`RUUKOTO_OWNER_TOKEN`、`RUUKOTO_OWNER_TOKEN_FILE`
或控制面目录的 `owner.token`。

### 任务与运行

```bash
ruukoto start [--data-dir D] [--agent-dir A] [--execution local|container] [--model provider/model]
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

### GitHub 项目维护

```bash
ruukoto github bind --project <id> --owner O --repo R [--api-host H]
                    [--read-credential N] [--publish-credential N] [--scopes pulls,actions,checks]
                    [--allow-fork-content]
ruukoto github bindings [--project <id>] | unbind <binding-id>
ruukoto github drafts [--project <id>] [--task <id>] [--status draft|stale|published]
ruukoto github draft <draft-id> [--version N] | publish-ops [--draft <id>]
ruukoto github publish <draft-id> --kind pr_review_comment --pr <n> | --kind issue_comment --issue <n>
```

CI 分析与 PR 评审由拥有者显式触发：采集在任务循环内由宿主工具完成，**发布只能由
拥有者经可信 CLI/TUI 发起**，模型不能经工具参数或 PR 文本创建发布意图。默认只交付
草稿，草稿正文完整可查看、证据产物随草稿保存。只能发布草稿的最新版本；发送前按草稿
记录的修订复核，分析依据已变化时草稿标为 `stale` 并停止发布。POST 不重试，结果未
落盘时记为 `effect_unknown`，需人工核实远端后再决定。

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

## 数据与环境变量

```
~/.ruukoto/data/            0700  元数据库（node:sqlite）、会话 JSONL、实例锁、产物
~/.ruukoto/control/         0770  控制面 socket（0660）与拥有者令牌（0600）
~/.ruukoto/agent/           0700  models.json、auth.json、credentials.json
~/.ruukoto/pending/         0600  待核实提交记录
```

消息历史的唯一权威副本是 pi JSONL 会话文件；SQLite 只存元数据、事件与可重建的位置
索引；产物正文在产物文件，SQLite 只存元数据。三者没有跨文件事务。

| 变量 | 用途 |
| --- | --- |
| `RUUKOTO_DATA_DIR` | 数据目录（默认 `~/.ruukoto/data`） |
| `RUUKOTO_AGENT_DIR` | 模型配置与凭据目录（默认 `~/.ruukoto/agent`） |
| `RUUKOTO_CONTROL_DIR` | 控制面目录（默认数据目录的兄弟目录 `control/`） |
| `RUUKOTO_OWNER_TOKEN` / `RUUKOTO_OWNER_TOKEN_FILE` | 拥有者令牌或其文件路径 |
| `RUUKOTO_PENDING_DIR` | 待核实提交记录目录（默认 `~/.ruukoto/pending`） |
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
- 群聊入口（QQ）与 Jev 上下文筛选实验尚未开始。
