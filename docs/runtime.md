# 后台任务运行时（issue 02/03/04/05）

任务生命周期独立于交互终端的实现：单个后台进程负责调度、状态与事件，
每个会话使用独立 pi SDK 实例驱动；TUI 断开不影响任务执行（[ADR 0002](../adr/0002-detach-terminal-from-task-runtime.md)）。
issue 03 接入真实编码工具与两种权限模式（[ADR 0003](../adr/0003-enforce-explicit-access-modes.md)、
[ADR 0004](../adr/0004-tool-worker-per-task-container-exec-account.md)）。
issue 04 接入 TUI：只连接已运行后台的独立客户端，含历史读取、断开重连与
输入去重（协议 v3）。

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
npm start -- tui [--session <id>]     # 交互终端（见下文"TUI"）
```

## TUI（issue 04）

`ruukoto tui` 启动全屏交互终端：顶部为项目/会话/工作目录/连接状态/任务权限
模式/执行后端，中间滚动显示消息与工具记录，底部为多行输入与任务/队列状态。
TUI 只连接已运行的后台（本机 Unix socket + 拥有者令牌），不创建 SDK 会话、
不加载模型凭据、不直接读取后台数据库或 JSONL；后台不可达时显示连接状态并
按有上限的退避重连，不会悄悄另起同一任务。

- **输入**：`Enter` 提交，`Alt+Enter`（或 `Shift+Enter` / `Ctrl+J`）换行；
  支持中文与 bracketed paste，大段粘贴在编辑器内折叠显示，草稿与提交保留
  展开后的原文。补全仅覆盖 `/` 固定命令，不扫描本地文件。
- **命令**：`/sessions` 切换会话；`/new-project`、`/new-session <目录>` 创建；
  `/older` 向前翻页历史；`/expand <id 前缀>` 展开完整消息/工具参数；
  `/artifact <id 前缀>` 按字节分页查看产物正文；`/approvals` 待处理审批
  （详情内 `a` 批准 / `r` 拒绝，Esc 关闭不等于拒绝）；`/interrupt`、
  `/cancel <taskId>`、`/continue [taskId]`、`/resume-queue` 为明确的任务
  操作；`/mode full_access` 经显式确认覆盖层按任务切换；`/quit` 或
  `Ctrl+C`（空草稿时）退出客户端。
- **断开与重连**：退出/断开只关闭客户端，后台任务继续执行；重连后从后台
  重建快照、历史与最新输出预览（生成中/中断前已捕获部分分别标注），不自动
  新建任务、不恢复暂停队列。事件序号缺口或游标过旧时自动重新同步。
- **输入去重**：提交前生成 `request_id` 并把完整请求原子保存到拥有者私有
  目录（默认 `~/.ruukoto/pending/`，`RUUKOTO_PENDING_DIR` 可覆盖，0600）；
  应答丢失时显示"接收结果待核实"，重连后按 `session_id + request_id` 核实：
  已接收则关联原任务，明确未接收才以原键原参数重试；记录绑定数据实例标识，
  换新数据库后不会向空后台重发。
- **终端安全**：消息、工具日志与审批参数渲染前剥离终端控制序列（CSI/OSC/
  APC，含 OSC 52 剪贴板写入与擦屏/光标控制），不可见控制字符显示为转义
  形式；只改变展示，不改动历史与执行参数。
- **退出与终端恢复**：正常退出、`SIGTERM`、`SIGHUP` 与可处理异常都会关闭
  socket、恢复 raw mode/光标/屏幕，不发送 `stop` 或取消任务。进程被强杀
  （SIGKILL）时无法执行清理回调：如终端显示异常，执行 `reset` 或
  `stty sane` 恢复。
- 非 TTY 环境不启动交互页面，改用 `status`/`events`/`submit` 等 CLI 命令；
  远程使用沿用登录服务器后启动 TUI 的方式，不新增远程协议。

协议 v3 新增接口：`read_history` / `read_history_entry`（按会话分页与分段
读取消息历史，唯一权威历史的投影）、`list_tasks`（已结束任务按会话分页）、
`find_task`（按 `session_id + request_id` 核实已接收请求）、
`get_confirmation_params` / `get_tool_op_params`（大参数按 ID 分段读取）。
握手返回数据实例标识与执行后端说明；快照有界（活动任务 + 每会话近期结束
任务）；事件中的大参数与累计输出片段以有界预览传输。拥有者令牌文件路径可
经 `RUUKOTO_OWNER_TOKEN_FILE` 指定（拥有者与后台不同 UID 的部署）。
`respond_confirmation` 可携带 `permission_version` 绑定审批时的权限版本
（不匹配返回 `permission_version_mismatch`）；`read_artifact` 单次上限
720 KiB（base64 开销后仍在 1 MiB 帧上限内）。


`request_id` 由客户端保存、唯一范围为会话：提交落盘但应答丢失时，同键同
参数（含模式与授权范围）重试返回原任务，同键异参返回 `request_conflict`。

## 数据布局

```
<dataDir>/                     # 0700（RUUKOTO_DATA_DIR，默认 ~/.ruukoto/data）
├── ruukoto.db                 # node:sqlite 元数据（WAL，schema v3）
│                              #   项目（含项目指令文件配置）、会话、任务
│                              #   （accessMode/权限版本/授予路径）、确认请求
│                              #   （结构化范围/消费时间）、工具操作（宿主操作
│                              #   id + SDK 调用 id）、产物元数据、目录占用、
│                              #   幂等键、持久事件、跨项目资料授权、长期记忆
│                              #   当前版本与修订、历史条目位置索引、选择记录
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

## 上下文、历史检索与长期记忆（issue 05）

### 统一资料访问范围（§1）

- 代理身份（项目/会话/任务）由宿主注入，工具参数中的任何 id 都不改变身份；
  `granted_paths` 与完全访问模式只作用于文件/命令执行，不扩大资料 API 范围。
- 默认范围：本项目历史/产物/记忆 + 个人共享记忆；跨项目读取只来自拥有者
  在控制面创建的 `data_grants` 授权（from/to 项目 + 类别），可查看、可撤销，
  撤销自后续查询与上下文注入起生效。
- 拥有者入口：`ruukoto grant create --from <项目> --to <项目> --category history|artifact|memory`、
  `ruukoto grant list [--all]`、`ruukoto grant revoke <id>`。
- QQ 等未识别入口没有项目身份：默认拒绝（本工单不开放）。

### 历史检索（§2）

- pi JSONL 仍是消息历史的唯一权威副本；SQLite 中的 `history_index` 只是
  可重建的位置索引（会话/条目 id/角色/时间戳/字节偏移），不含消息正文。
- 索引增量更新（完整换行结尾的记录）；文件替换/截断/索引缺失时重建派生
  索引，绝不改写源文件；完整行损坏明确报错。
- 搜索是字面关键词匹配（中文按原文匹配），支持角色/时间/会话/任务过滤、
  命中数与扫描上限、游标继续；达到扫描上限时如实返回"结果不完整"。
  任务过滤按任务边界标记（`ruukoto_task_start/end` custom 条目）推导字节
  范围；任务没有结束标记（崩溃/中断）时范围延伸到文件尾。
- 代理工具：`history_search`（限定在授权范围内的会话）、`history_read`
  （按条目 id + 字节范围读取原文分段）。
- 拥有者入口：`ruukoto history-search <关键词> [--project P] [--session S]
  [--task T] [--role R] [--since T] [--until T] [--limit N] [--scan-limit N]
  [--cursor base64]`；TUI `/search <关键词>`。

### 上下文选择（§3/§4）

- 策略 `deterministic-v1`（`src/agent/context-selector.ts`）：必须项 = 宿主系统
  指令、项目指令、继续来源任务要求（如有）、当前任务输入、最新完成的工具
  批次；历史按完整交互（一轮用户+助手+工具消息）为单元由近及远纳入，
  toolCall/toolResult 不可拆分。
- 项目指令：拥有者显式配置的工作区相对路径（`ruukoto project
  set-instructions <项目id> <文件...>`），任务开始时经受限读取钉版
  （realpath 后必须仍在工作区内；缺失/不可读/超大分别说明，不取祖先目录
  文件）；内容捕获为任务产物，版本 = 内容哈希 + 产物 id，任务内固定，
  下一任务重新读取即为刷新入口。指令作为带标记的参考消息注入一次，
  不能变更控制面身份、审批规则或权限模式。
- 当前任务的工具循环按已完成批次取最近部分：任务输入与最新批次必留，
  更早批次由近及远在预算内纳入；连必留项都装不下时才以
  `context_budget_exceeded` 中断。
- 人工继续已中断任务（`continue`）时，原任务要求作为带任务 id 的必留
  参考消息注入，不会只发一句"继续"就丢失原要求。
- 崩溃恢复可能留下缺配对的消息（工具已产生副作用、结果未落盘时进程被杀）：
  选择器先把这类孤儿 toolCall/toolResult 从模型视图剔除（历史原文不动，
  选择记录以 `unpaired_tool_call:<id>` 记为排除原因），最终检查对剔除的
  id 豁免配对核对；其余配对残缺仍拒绝发送。
- 超长工具结果只在模型视图中替换为有界节选（首尾保留 + 中间省略计数 +
  `history_read`/`read_artifact` 引用），历史与产物原文不变；被替换的
  片段范围记入选择记录 `capped_tool_results`。
- 预算 = 模型 contextWindow − maxTokens（输出）− thinking 预算 − 下一批
  工具结果预留 − 估算安全边际；估算用 pi `estimateTokens`（chars/4）加
  CJK 校准（每 CJK 字符按 1 token 计）× 校准系数 1.5。选择记录的配置
  版本 = 生效预算配置的 FNV-1a 哈希，配置变化即变化。
- 硬性发送前检查：pi 0.85.1 的 `context` 钩子异常被捕获后继续运行，因此
  选择结果不落库为"待发送"就拒绝发送——宿主包装 `streamFunction`，在委托
  前校验选择记录存在、toolCall/toolResult 配对、预算充足，然后先落
  选择记录再发请求；必须项超过预算时任务以 `interrupted`
  （`context_budget_exceeded`）结束并暂停队列，不做静默摘要或丢弃。
- provider 返回 `context_overflow` 的兜底保留：任务中断并暂停队列，不自动
  压缩或重试。

### 长期记忆（§5）

- SQLite 当前版本 + 追加式修订；类别限于 preference/convention/decision/
  experience；每条必须关联来源（历史条目/产物/拥有者说明），来源必须存在
  且当前可访问。
- 修改经预期版本号条件更新：并发冲突明确报错，不静默覆盖；撤销 = 停用
  （不删除）；恢复旧版本 = 创建一条新修订。已撤销/旧版本不自动注入。
- 代理创建的内容标记 author=agent，不能冒充拥有者确认；代理只能写当前
  项目的记忆，个人共享与跨项目写入只有拥有者能做。
- 引用受限来源的派生记忆在后续读取与注入时仍重校来源范围：授权撤销后
  不再自动注入（选择记录记 `source_scope_revoked`），`memory_read` 明确
  拒绝；拥有者明确开放新的适用范围后恢复可读。
- 代理工具：`memory_list` / `memory_read` / `memory_save` / `memory_revoke`。
- 拥有者入口：`ruukoto memory list|show|save|revoke|restore`；TUI `/memory`。
- 记忆注入有独立预算（默认 2000 估算 token）与单条 32KiB 上限；v1 不做
  自动摘要或清理。

### 选择记录（§6）

- 每次模型调用前落一条 `selection_records`：任务/会话、调用序号、策略与
  配置版本（预算配置哈希）、模型、项目指令来源版本、纳入/排除的消息索引
  与原因、纳入/排除的记忆 id+版本、被有界替换的工具结果片段范围、各项
  估算与预算；发送后回填实际 provider usage。记录失败即阻断发送。
- 排除原因只记录索引与类别，不含其他项目的标题/片段。
- 拥有者入口：`ruukoto selection-records --task <id> | --session <id>`；
  TUI `/context` 查看当前会话最近一轮的预算组成与排除原因。

## GitHub 项目维护（issue 06）

拥有者显式触发的 CI 分析与 PR 评审：采集在既有任务循环内由宿主工具完成，
发布只能由拥有者经可信 CLI/TUI 发起。无监听、无 webhook、无定时器。

### 仓库与凭据配置

- 绑定：`ruukoto github bind --project <id> --owner O --repo R [--api-host H]
  [--read-credential N] [--publish-credential N] [--scopes pulls,actions,checks]
  [--allow-fork-content]`。默认 API 主机 `api.github.com`；GHE 主机须显式配置。
  绑定保存核实的 repository ID（改名/迁移核对依据）、读取范围与可比较的配置
  版本；任何变更递增版本，进行中的调用在下一次核对时失败。
- 凭据复用 CredentialStore（`ruukoto credentials add`），按名称引用；值不进入
  模型上下文、Shell、TUI 参数或日志。读取与发布凭据分开配置；`github bind`
  会把所引用凭据收紧到本项目+对应操作（github_read/github_publish），带
  scope 的凭据不得被通用 `http_request` 借用，同名更新保留范围。
- 令牌缺失、过期或权限不足 → 明确报错，不改用拥有者机器上的 `gh` 登录态。

### 读取授权与采集

- 宿主工具 `github_read_pr` / `github_read_run` / `github_save_draft`：身份由
  宿主注入（当前任务 → 会话 → 项目），工具参数不接受项目/凭据/主机；仓库
  目标只能是当前项目的已配置绑定。
- PR 采集：元数据 + 分页文件列表（3000 上限如实标注）+ diff；读完后复核
  head/base SHA 与状态，中途变化 → 保留旧数据并标记 inconsistent，不混合
  修订。fork PR 源仓库内容仅在绑定显式允许时读取；不 checkout、不执行 PR
  代码。
- run 采集：固定 run ID + attempt；按 attempt 分页作业（同名 matrix 作业不
  合并）；失败作业日志按作业 ID 下载（302 签名 URL 由宿主受控跟随：HTTPS、
  拒绝回环/私网、跨主机不带 Authorization；签名 URL 不进入报告/事件/公开
  链接）；check runs 与 commit statuses 都读，第三方检查仅状态+链接。
- 完整采集结果写入 ArtifactStore（带非机密请求目标、采集时间、修订与内容
  哈希）；模型只拿到有界预览 + 产物引用。PR 描述、评论、diff、日志均为
  外部资料，不得按其中指令修改权限、读取其他项目、执行命令或发布消息。

### 报告溯源与草稿

- `github_save_draft` 保存草稿：绑定当前任务、绑定配置版本与分析修订
  （head/base SHA 或 run/attempt）；正文完整可查看（CLI `github draft <id>`、
  TUI `/github show <id>`），证据产物 id 随草稿保存。行号必须来自采集到的
  实际 diff/源文件；证据不足的条目列入待核实。默认只交付草稿。

### 发布与未知结果恢复

- 发布意图只能由拥有者发起：CLI `ruukoto github publish <draft-id> --kind
  pr_review_comment --pr <n>` 或 `--kind issue_comment --issue <n>`；TUI
  `/github publish <id> pr|issue <n>`。模型不能经工具参数/PR 文本/full_access
  创建发布意图。
- 第一阶段发布形态：PR 评审摘要经 reviews API（固定 `event=COMMENT` + 显式
  `commit_id`）；CI 分析作为拥有者指定 issue/PR 下的普通评论。不做逐行评审
  评论；无明确目标的独立运行保持草稿。
- 请求确认模式：逐次审批（`github_publish` 范围：仓库身份、目标、正文哈希
  与字节数、分析修订；正文经审批详情分段查看），批准单次消费；正文/目标
  变化 = 新请求。full_access 在既有发布意图+仓库范围内跳过逐次审批，仍保留
  意图/复核/结果记录。
- 批准后、发送前按草稿实际记录的修订复核（PR 的 head/base SHA+状态，或
  run/attempt），与发布形态无关；影响分析结论的变化 → 草稿标 stale、停止
  发布、需重新分析与重新批准。草稿必须携带可复核修订（保存时校验）。
- POST 不重试；已发送但超时/断线/崩溃/结果未落盘 → `effect_unknown`，不自动
  重发；拥有者经 `github publish-ops` 查看状态后人工核实远端再决定。同一
  草稿版本 + 相同 kind/target 的重复发布请求复用已有待发布操作（本地幂等）；
  不同 kind/target 视为新发布意图，新建操作（审计与实际发送一致）。
- 只能发布草稿的最新版本（旧版本拒绝，避免过期分析流出）。
- 草稿任务已结束时发布：请求确认模式的逐次审批只在存活任务内进行（已结束
  任务的 confirm 发布被拒绝，提示改用 full_access 或在存活任务中触发）；
  full_access 发布先在发布者上下文完成修订复核（失败即拒绝，不产生新任务），
  再经既有调度创建新任务承载（不复活旧终态任务、不继承旧批准；输入幂等/
  目录占用/范围检查照常）。

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
| issue 04 离线验证（37 项：历史读取×11、连接恢复与待确认×13、TUI 状态与终端安全×7、TUI 应用集成×5、PTY 端到端×1） | macOS 本机（mock 模型 + 假终端 + pty） | 通过（81 项总计含 issue 02/03 回归） |
| TUI 真实终端人工检查（80×24 布局、中文输入法、缩放、滚动） | macOS 终端 | 部分：PTY 自动化覆盖输入/流式/退出/终端恢复；人工交互细节（IME 候选窗、缩放重排）未逐项人工核对 |
| Linux 真实工具后端的"提交—查看—退出—重连—检查"全流程 | 目标 Linux 服务器 | 部分通过（tx 2026-09-21：CLI 提交—容器执行—产物落盘—status 查看 经真实模型完成；TUI 断开重连交互未在目标机人工跑） |
| 真实模型连通性（经完整运行时路径，一次短往返） | macOS 本机 | 未在本次运行（凭据缺失时跳过） |
| node:sqlite v1→v2 事务迁移 + 崩溃后重开 | macOS 本机 | 通过（08 的迁移用例：旧任务默认请求确认、旧未决审批失效、历史与事件保留） |
| Linux 容器边界探针（32 项：文件/子进程/网络/凭据/控制面/身份） | Docker Desktop Linux VM | 32/32 通过（`npm run linux:probes`，含就绪与完整性判定） |
| 任务容器端到端：镜像构建 + 经真实容器启动器的 bash 路由、网络拒绝、宿主路径不可见、非 root、只读根、cap 清零、容器回收 | Docker Desktop Linux VM | 9/9 通过（`npx tsx verification/foundation/scripts/linux-isolation/container-worker-smoke.mts`；镜像 `ruukoto-worker:0.85.1`） |
| 同一容器镜像内的真实模型短编码任务（容器后端跑 07 场景） | tx（Ubuntu 24.04，容器后端 + deepseek-flash） | 通过（2026-09-21：confirm 任务经容器写文件，产物归属拥有者 uid 1003；RUUKOTO_CONTAINER_UID/GID=1003） |
| systemd 执行账户入口（提权包装、固定身份、cgroup 回收） | tx（Ubuntu 24.04，systemd 255） | 通过（2026-09-21：sudo 链路与 uid 986 env_keep 传递、worker 以 ruukoto-exec 运行、参数注入/非授权调用拒绝、stop 幂等；修复 exec-stop 包装退出码与启动器约定相反的问题） |
| Git worktree 外部元数据显式授予路径挂载 | 未实测 | 授予路径校验/幂等已覆盖；容器挂载路径（/granted/N）未端到端实测 |
| 目标服务器宿主前提（发行版、内核、rootless、docker/systemd） | tx（Ubuntu 24.04，内核 6.8，Docker 29.5.2） | 通过（2026-09-21：`npm run linux:probes` 32/32 + 容器冒烟 9/9；原生 Linux bind mount 无 uid 映射，容器 uid 与工作区写权限按 README 第 5 步处理） |
| 真实模型短编码任务（真实凭据） | tx（经部署控制面，deepseek-flash） | 通过（2026-09-21，confirm 模式容器执行；`RUN_MODEL_CHECK=1 npm run test:model` 形式未单独跑） |
| issue 06 GitHub 集成（19 项：绑定/凭据范围、PR/run 采集与分页、inconsistent、302 重定向防护（含 IPv6/映射地址）、草稿与发布、stale 复核、effect_unknown、配置撤销、请求确认发布、凭据范围收紧、pending 操作幂等边界、发布目标校验、已结束任务 confirm 拒绝） | macOS 本机（本地模拟 GitHub API，经真实宿主工具与审批路径） | 通过（125 项总计含既有回归，0 失败） |
| 全部离线集成验证（125 项，逐文件顺序执行） | tx（Ubuntu 24.04，Node 24.21.0） | 通过（2026-09-21，17/17 文件 0 失败；修复 15-tui-pty 的 npx 孙进程持有管道导致文件级挂起——detached 进程组 + 整组回收，macOS 回归同过） |
| 真实仓库只读连通性（显式触发一次读取） | 需真实仓库 + 读取凭据 | 未验证（未配置；不申请写权限完成只读验收） |

### 按会话选择模型

后台启动可传 `--model provider/model --thinking off`；模型 ID 中后续斜杠会保留。未指定思考强度时默认为 `off`，具体合法档位由该模型能力校验。

TUI 使用 `/model` 选择后台已配置的提供方和模型，再选择合法思考强度；`/thinking` 只列出当前模型支持的档位。Esc 取消，后台确认后才更新显示。状态栏区分后续任务选择和活动任务实际配置。选择持久化到会话，新会话继承启动默认值；切换只影响之后提交的新任务，运行中和已排队任务保留提交时的配置。继续中断任务创建新任务，采用本次提交选择。

CLI 可用 `models [--provider provider] [--offset 0] [--limit 100]` 分页查询安全目录，用 `set-model <session> <provider/model> --thinking <level>` 保存选择。`submit/continue` 自动取得当前会话完整选择，也可用 `--model provider/model --thinking level` 显式指定。同一请求键重试先核实原任务，保留原任务模型选择；接收结果不明确时应核实原请求键，不能换键重复提交。

后台重启后队列仍暂停。旧排队任务若未记录模型，TUI 恢复时显示数量和待补选择，确认后补齐；CLI 需 `resume-queue <session> --model provider/model --thinking level` 显式确认。旧终态任务显示“模型配置未记录”。缺模型、凭据或不支持的档位会拒绝整次变更；目录中认证材料可用不代表远程连通性或额度已验证。模型设置应答丢失时查询会话状态，不自动重发覆盖其他客户端。

旧版待确认输入先核实是否已接收；明确未接收但缺少模型字段时保留原文，需拥有者重新选择后提交。明确拒绝的新请求恢复输入；断线和超时则保留完整参数用于核实。
