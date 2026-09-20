# 后台任务运行时（issue 02/03）

任务生命周期独立于交互终端的实现：单个后台进程负责调度、状态与事件，
每个会话使用独立 pi SDK 实例驱动；TUI 断开不影响任务执行（[ADR 0002](../adr/0002-detach-terminal-from-task-runtime.md)）。
issue 03 接入真实编码工具与两种权限模式（[ADR 0003](../adr/0003-enforce-explicit-access-modes.md)、
[ADR 0004](../adr/0004-tool-worker-per-task-container-exec-account.md)）。

## 架构要点

- **工具工作进程**：read/edit/write/bash 的完整执行（含路径解析与 Shell
  子进程）在独立工作进程内完成；SDK、模型调用、审批与持久化留在后台。
  进程间为换行分帧 JSON 协议（单帧 4MB 上限、数据分块 512KB、背压）。
- **执行边界**：请求确认模式 → 按任务建立的 Linux 容器（固定镜像
  `ruukoto-worker`，非 root、cap-drop ALL、no-new-privileges、只读根文件
  系统、tmpfs /tmp、默认无网络、只挂载授权工作区与任务级授予路径），任务
  结束回收容器；完全访问 → 容器外由 systemd 以固定执行 UID 启动
  （生产经 root 拥有的 sudo 包装入口，见 `deploy/systemd/`）。缺少执行
  后端或身份配置时明确失败，不回退到后台账户执行。
- **模式绑定任务**：任务携带 accessMode（默认请求确认）、权限版本与
  授予路径；模式/范围进入提交幂等比较；切换只在无执行中工具的边界生效，
  递增权限版本并使等待中的审批失效。
- **结构化审批**：越界文件读写与单次 HTTP 请求形成不可变审批（目标、内容
  指纹、方法、完整 URL、凭据名称与用途）；批准经 SQLite 条件更新单次消费，
  其他 URL/方法/正文/任务不能复用；HTTP 不自动跟随重定向，连接固定到批准
  时解析的地址；凭据按预配置的目标绑定注入，值不进入审批与事件。
- **正文产物**：工具输出在上游截断之前捕获为受保护的产物文件（先落盘再
  生成限长模型视图）；中断/写失败保留已捕获部分并标 partial；按任务归属
  经工具或控制接口按 id/偏移/长度查询，跨重启可读。
- **拥有者认证**：控制面 socket 位于受控目录（数据目录兄弟目录
  `control/`），任何连接须先以拥有者令牌（`owner.token`，0600）auth，
  认证成功前不返回快照、不执行请求；令牌不进命令行、工具环境或日志。

## 运行命令

```bash
npm install
npm run typecheck        # 类型检查
npm test                 # 全部离线集成验证（mock 模型，不联网、不需要凭据）
RUN_MODEL_CHECK=1 npm run test:model   # 真实模型连通性（逐 provider 一次短往返）

# 启动后台（生产：--execution container + 完成 deploy/systemd 配置）
npm start -- start --data-dir ~/.ruukoto/data --agent-dir ~/.ruukoto/agent \
  --execution container --model provider/model

# 另一个终端连接控制面（socket：~/.ruukoto/control/control.sock；
# 认证：RUUKOTO_OWNER_TOKEN 或 control/owner.token）
export RUUKOTO_DATA_DIR=~/.ruukoto/data
npm start -- create-project my-project
npm start -- create-session my-project /path/to/workdir
npm start -- submit <sessionId> <requestId> "任务输入" \
  [--mode confirm|full_access] [--grant <path>:<read|read_write>[:用途];...]
npm start -- switch-mode <taskId> confirm|full_access [--grant ...]
npm start -- status [taskId]          # 快照或单任务（工具操作、审批、产物引用）
npm start -- events                   # 订阅持久事件流（seq 单调递增）
npm start -- interrupt <taskId>       # 显式中断运行中/等待确认的任务
npm start -- cancel <taskId>          # 取消排队或活动任务
npm start -- continue <taskId> <newRequestId> "继续输入" [--mode ...]
npm start -- resume-queue <sessionId> # 拥有者确认后恢复队列（并释放遗留占用）
npm start -- confirm <confirmationId> approve|reject
npm start -- read-artifact <taskId> <artifactId> [--offset N] [--length N]
npm start -- credentials list | add --name N --host H --header H --purpose P --secret-env VAR | remove <name>
npm start -- stop                     # 优雅停止（SIGTERM/SIGINT 走同一路径）
```

`request_id` 由客户端保存、唯一范围为会话：提交落盘但应答丢失时，同键同
参数（含模式与授权范围）重试返回原任务，同键异参返回 `request_conflict`。

## 数据布局

```
<dataDir>/                     # 0700（RUUKOTO_DATA_DIR，默认 ~/.ruukoto/data）
├── ruukoto.db                 # node:sqlite 元数据（WAL，schema v2）
│                              #   项目、会话、任务（accessMode/权限版本/授予
│                              #   路径）、确认请求（结构化范围/消费时间）、
│                              #   工具操作（宿主操作 id + SDK 调用 id）、
│                              #   产物元数据、目录占用、幂等键、持久事件
├── ruukoto.db-wal / -shm
├── sessions/                  # pi JSONL 会话文件（消息历史唯一权威副本）
└── runtime.lock/              # 实例锁（mkdir 原子创建；owner.json 记录 pid）

<dataDir>/../control/          # 0770（RUUKOTO_CONTROL_DIR 可覆盖）
├── control.sock               # 控制面 Unix socket（0660）
└── owner.token                # 拥有者令牌（0600；部署时复制给拥有者 0400）

<dataDir>/artifacts/           # 0700；工具正文产物（<artifactId>.bin）

<agentDir>/                    # 0700（RUUKOTO_AGENT_DIR，默认 ~/.ruukoto/agent）
├── models.json                # 模型配置（显式指定，不读 ~/.pi/agent）
├── auth.json                  # 模型凭据（同上）
└── credentials.json           # 服务凭据绑定（0600；审批注入用，值不展示）
```

职责边界：pi JSONL 是消息历史的唯一权威副本；SQLite 只存元数据与事件；
产物正文在产物文件，SQLite 只存其元数据。三者没有跨文件事务，不得声称
原子提交。

任务状态机：`queued → running → awaiting_confirmation → running`；结束进入
`completed / failed / canceled / interrupted`。中断原因、取消意图与外部
效果是否确定分别记录。审批区分"已提出但尚未执行"（pending/stale/rejected、
approved 未消费 → 已知未执行）与"已开始但结果未知"（批准已消费或无审批的
直接执行在停止/崩溃前未落盘结果 → `effect_unknown`，不重放）。

## 恢复步骤

1. 后台异常退出后重新启动（systemd 自动拉起或手工 `npm start -- start`）。
   启动时先取数据目录实例锁：记录的 pid 存活且确为本后台 → 拒绝启动；
   pid 已死或被无关进程复用 → 接管；无法核实 → 保留锁并要求人工处理。
2. 恢复逻辑自动执行（单事务）：
   - 原 `running / awaiting_confirmation` 任务 → `interrupted`（原因
     `backend_restart`）；其未决确认请求标记 `stale`，失效批准不得再执行。
   - 审批未消费的工具操作 → 记录"已知未执行"结果（批准不跨重启执行）；
     批准已消费或无审批的直接执行且结果缺失 → `effect_unknown` 并发
     `task.tool_effect_unknown` 事件；不自动重放任何模型调用或工具操作。
   - 有排队任务的会话暂停自动调度（`backend_restart`），拥有者用
     `resume-queue` 显式恢复。
3. 遗留目录占用（崩溃时旧后台的子进程/容器状态无法确认）→ 保留占用并
   暂停会话（`occupancy_unverified`）。拥有者核实旧执行（容器/cgroup）确
   已停止后 `resume-queue` 释放占用。systemd `KillMode=control-group` +
   按任务容器回收的部署下此窗口通常不出现；容器残留由启动器按任务名
   `rm -f` 清理同名遗留后再核实。
4. 会话登记的 JSONL 缺失而同 pi session id 的文件存在 → 自动改用最新一份
   （发 `session.history_unreadable` 事件说明）；损坏的 JSONL 不覆盖、不
   静默跳过，要求人工处理。
5. 人工继续：`continue` 创建带 `resumes_task_id` 的新任务，默认请求确认
   （旧批准不继承；拥有者可显式重新选择完全访问），不补造工具结果、不
   原样重放旧输入。
6. 产物与审批记录跨重启保留：产物按 id 可读；批准的 `consumed_at` 决定
   恢复时按"已知未执行"还是"效果未知"处理。

## 部署（目标 Linux 服务器）

见 `deploy/systemd/README.md`：三个系统身份（拥有者 / 后台
`ruukoto-backend` / 执行账户 `ruukoto-exec`）、固定工具镜像
（`deploy/worker-image/build.sh`）、受保护提权入口（root 拥有的 sudo
包装脚本，仅后台可调用）、`ruukoto-backend.service` 单元。

## 验证状态（诚实清单）

| 检查 | 环境 | 结果 |
| --- | --- | --- |
| 全部离线集成验证（43 项：issue 02 的 16 项 + 真实工具路由×3、审批×11（含崩溃恢复区分、DNS 前置、v1→v2 迁移）、产物×5、模式与认证×8） | macOS 本机（Node 24.15.0，local 执行后端） | 通过 |
| 真实模型连通性（经完整运行时路径，一次短往返） | macOS 本机 | 未在本次运行（凭据缺失时跳过） |
| node:sqlite v1→v2 事务迁移 + 崩溃后重开 | macOS 本机 | 通过（08 的迁移用例：旧任务默认请求确认、旧未决审批失效、历史与事件保留） |
| Linux 容器边界探针（32 项：文件/子进程/网络/凭据/控制面/身份） | Docker Desktop Linux VM | 32/32 通过（`npm run linux:probes`，含就绪与完整性判定） |
| 任务容器端到端：镜像构建 + 经真实容器启动器的 bash 路由、网络拒绝、宿主路径不可见、非 root、只读根、cap 清零、容器回收 | Docker Desktop Linux VM | 9/9 通过（`npx tsx verification/foundation/scripts/linux-isolation/container-worker-smoke.mts`；镜像 `ruukoto-worker:0.85.1`） |
| 同一容器镜像内的真实模型短编码任务（容器后端跑 07 场景） | 未运行 | local 后端已覆盖工具路由；容器后端需目标机 systemd/镜像确认后再跑 |
| systemd 执行账户入口（提权包装、固定身份、cgroup 回收） | 目标 Linux 服务器 | 未验证（代码与配置已交付，部署时按 deploy/systemd/README.md 验证） |
| Git worktree 外部元数据显式授予路径挂载 | 未实测 | 授予路径校验/幂等已覆盖；容器挂载路径（/granted/N）未端到端实测 |
| 目标服务器宿主前提（发行版、内核、rootless、docker/systemd） | 未验证 | 部署时需重跑 `verification/foundation` 的 `npm run linux:probes` 与容器冒烟 |
| 真实模型短编码任务（真实凭据） | 未运行 | 有凭据时执行 `RUN_MODEL_CHECK=1 npm run test:model` |
