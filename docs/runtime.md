# 后台任务运行时（issue 02）

任务生命周期独立于交互终端的实现：单个后台进程负责调度、状态与事件，
每个会话使用独立 pi SDK 实例驱动；TUI 断开不影响任务执行（[ADR 0002](../adr/0002-detach-terminal-from-task-runtime.md)）。
本阶段仅接入模拟模型与模拟工具，真实编码工具与权限边界由 issue 03 接入。

## 运行命令

```bash
npm install
npm run typecheck        # 类型检查
npm test                 # 全部离线集成验证（mock 模型，不联网、不需要凭据）
RUN_MODEL_CHECK=1 npm run test:model   # 真实模型连通性（逐 provider 一次短往返）

# 启动后台（前台进程；数据目录与凭据目录可省略，默认 ~/.ruukoto/{data,agent}）
npm start -- start --data-dir ~/.ruukoto/data --agent-dir ~/.ruukoto/agent --model provider/model

# 另一个终端连接控制面（Unix socket：$RUUKOTO_DATA_DIR/control.sock）
export RUUKOTO_DATA_DIR=~/.ruukoto/data
npm start -- create-project my-project
npm start -- create-session my-project /path/to/workdir --confirm-tools mock_gate
npm start -- submit <sessionId> <requestId> "任务输入"
npm start -- status [taskId]          # 快照或单个任务（含工具操作、确认请求）
npm start -- events                   # 订阅持久事件流（seq 单调递增）
npm start -- interrupt <taskId>       # 显式中断运行中/等待确认的任务
npm start -- cancel <taskId>          # 取消排队或活动任务
npm start -- continue <taskId> <newRequestId> "继续输入"   # 人工继续已中断任务
npm start -- resume-queue <sessionId> # 拥有者确认后恢复队列（并释放遗留占用）
npm start -- confirm <confirmationId> approve|reject
npm start -- stop                     # 优雅停止（SIGTERM/SIGINT 走同一路径）
```

`request_id` 由客户端保存、唯一范围为会话：提交落盘但应答丢失时，同键同
参数重试返回原任务，同键不同输入返回 `request_conflict`。

## 数据布局

```
<dataDir>/                     # 0700（RUUKOTO_DATA_DIR，默认 ~/.ruukoto/data）
├── ruukoto.db                 # node:sqlite 元数据（WAL）
│                              #   项目、会话、任务、确认请求、目录占用、
│                              #   幂等键、持久事件（单调 seq）
├── ruukoto.db-wal / -shm
├── sessions/                  # pi JSONL 会话文件（消息历史唯一权威副本）
│   └── <时间戳>_<piSessionId>.jsonl
├── control.sock               # 控制面 Unix socket（0600，仅本机）
└── runtime.lock/              # 实例锁（mkdir 原子创建；owner.json 记录 pid）

<agentDir>/                    # 0700（RUUKOTO_AGENT_DIR，默认 ~/.ruukoto/agent）
├── models.json                # 模型配置（显式指定，不读 ~/.pi/agent）
└── auth.json                  # 模型凭据（同上）
```

职责边界：pi JSONL 是消息历史的唯一权威副本，历史查询直接读它；SQLite 只
存元数据与事件，不重复保存消息正文。两者没有跨文件事务：任务状态与占用、
事件在同一 SQLite 事务内提交后才应答与广播，但不得声称与 JSONL 原子提交。

任务状态机：`queued → running → awaiting_confirmation → running`；结束进入
`completed / failed / canceled / interrupted`。中断原因、取消意图
（cancelRequested）与外部效果是否确定（effectUnknown）分别记录在任务上。

## 恢复步骤

1. 后台异常退出后重新启动（systemd 自动拉起或手工 `npm start -- start`）。
   启动时先取数据目录实例锁：记录的 pid 存活且确为本后台 → 拒绝启动；
   pid 已死或被无关进程复用 → 接管；无法核实 → 保留锁并要求人工处理。
2. 恢复逻辑自动执行：
   - 原 `running / awaiting_confirmation` 任务 → `interrupted`（原因
     `backend_restart`）；其未决确认请求标记 `stale`，失效批准不得再执行。
   - 工具操作有执行意图但结果缺失 → 标记 `effect_unknown` 并发出
     `task.tool_effect_unknown` 事件；停止/重启不撤销外部效果，继续前必须
     先看到这些事实，本实现不会自动重放任何模型调用或工具操作。
   - 有排队任务的会话暂停自动调度（`backend_restart`），拥有者用
     `resume-queue` 显式恢复。
3. 遗留目录占用（崩溃时旧后台的子进程状态无法确认）→ 保留占用并暂停会话
   （`occupancy_unverified`）。拥有者核实旧执行确已停止后 `resume-queue`
   释放占用。systemd 部署下子进程随服务终止，此窗口通常不会出现。
4. 会话登记的 JSONL 缺失而同 pi session id 的文件存在 → 自动改用最新一份
   （发 `session.history_unreadable` 事件说明）；损坏的 JSONL 不覆盖、不静默
   跳过，要求人工处理。首次 assistant 消息前崩溃的会话没有任何文件，任务
   输入仍保留在任务记录里，不宣布"消息已持久化"。
5. 人工继续：`continue` 创建带 `resumes_task_id` 的新任务，不补造工具结果、
   不原样重放旧输入；结果不明的操作由拥有者核实后在继续输入中决定。

## Linux systemd 配置

`/etc/systemd/system/ruukoto-backend.service`（部署时按实际用户与路径调整）：

```ini
[Unit]
Description=ruukoto personal agent backend
After=network-online.target

[Service]
Type=simple
# 独立系统用户运行控制面并持有数据目录（0700）；拥有者通过本机 socket 访问。
# 注意：同 UID 部署不满足 ADR 0003 的"控制面与项目命令分开"不变量。
User=ruukoto-backend
Group=ruukoto-backend
Environment=RUUKOTO_DATA_DIR=/var/lib/ruukoto/data
Environment=RUUKOTO_AGENT_DIR=/var/lib/ruukoto/agent
ExecStart=/usr/bin/node /opt/ruukoto/node_modules/.bin/tsx /opt/ruukoto/src/cli.ts start
Restart=on-failure
RestartSec=3
# 子进程随服务终止：崩溃后不会有残留执行进程继续写工作目录，
# 新实例的占用核验因此不会遇到无法确认的遗留执行
KillMode=control-group
TimeoutStopSec=30

[Install]
WantedBy=multi-user.target
```

安装：`sudo systemctl daemon-reload && sudo systemctl enable --now ruukoto-backend`。
`Restart=on-failure` 覆盖异常退出后的自动恢复；`SIGTERM`（systemd stop）与
控制面 `stop` 走同一条优雅停止路径：拒绝新任务 → 中断活动任务 → 回收工具
进程组 → 落盘 → 关闭。

## 验证状态（诚实清单）

| 检查 | 环境 | 结果 |
| --- | --- | --- |
| 全部离线集成验证（16 项：FIFO/并行/符号链接别名互斥/占用/实例锁/幂等/重连补发/中断/取消竞争/等待确认时中断/确认拒绝/进程回收/崩溃恢复×2/超限/DB 失败） | macOS 本机（Node 24.15.0） | 通过 |
| 真实模型连通性（经完整运行时路径，一次短往返） | macOS 本机，deepseek/deepseek-flash | 通过 |
| node:sqlite 文件数据库 + 事务 + 崩溃后重开 | macOS 本机（24.15.0） | 通过（集成验证内覆盖） |
| 挂载别名（bind mount，dev+ino 碰撞键）互斥 | 未实测 | macOS 无 root 无法做 bind mount；dev+ino 路径与 realpath 路径互为冗余，其中 realpath 互斥已有测试，部署时需在 Linux 上补测 |
| 独立 Git worktree 并行 | 未单独实测 | 与"不同目录并行"同一机制（worktree 即不同工作目录），未建真实仓库场景 |
| Linux 容器受限执行边界探针 | Docker Desktop 的 Linux VM | 31/31（issue 01，见 foundation-findings.md） |
| 目标 Linux 服务器宿主前提 | 未验证 | 部署时需重跑 `verification/foundation` 的 `npm run linux:probes` |
| systemd 单元 | 未实测 | 上线前需在目标机验证单元文件与独立系统用户部署 |
| 控制面身份隔离（ADR 0003） | 未实施 | issue 02 仅同 UID socket + 0600；客户端授权凭据与执行账户隔离由 issue 03 完成并验证 |

实现策略说明（超出"记录并人工处理"字面的自选恢复动作）：恢复时若会话登记的
JSONL 缺失但同 pi session id 的历史文件存在，自动改用最新一份并发
`session.history_unreadable` 事件说明，以保证重启后继续写入同一份权威历史；
除此之外不做任何自动修复。
