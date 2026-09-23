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
- **执行边界**：请求确认与自动审查模式 → 按任务建立的 Linux 容器（固定镜像
  `ruukoto-worker`，非 root、cap-drop ALL、no-new-privileges、只读根文件
  系统、tmpfs /tmp、默认无网络、只挂载授权工作区与任务级授予路径），任务
  结束回收容器；完全访问 → 容器外由 systemd 以固定执行 UID 启动
  （生产经 root 拥有的 sudo 包装入口，见 `deploy/systemd/`）。缺少执行
  后端或身份配置时明确失败，不回退到后台账户执行。
- **模式绑定任务**：任务携带 accessMode（默认请求确认）、权限版本与
  授予路径；模式/范围进入提交幂等比较；切换只在无执行中工具的边界生效，
  递增权限版本并使等待中的审批失效。
- **自动审查（auto-review，ADR 0005）**：与请求确认同一受限执行环境；
  越界的外部文件读取与无凭据 HTTP GET/HEAD 先经一次独立的无工具审查调用
  裁决（approve/reject/ask_owner，30s 时限、输入上限 8KB、策略版本
  auto-review-v1），失败或无法确认一律转拥有者；审查结论、理由、模型与
  策略版本随审批记录落盘（decision_source 区分自动审查与拥有者）。
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
- **QQ 群聊入口（issue 07）**：NapCat OneBot v11 正向 WebSocket 窄入口
  （`src/qq/`），按"登录账号+群"映射独立 qq_group 会话：空工具集合、
  宿主约束资料范围（排除开发历史/个人共享记忆/项目指令/跨项目授权）、
  专用空工作目录、收件去重与排队过期、宿主固定回复目标、发送结果
  区分 sent/failed/unknown（effect_unknown 不重发）。详见下文「QQ 群聊」。

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
  [--mode confirm|full_access|auto-review] [--grant <path>:<read|read_write>[:用途];...]
npm start -- switch-mode <taskId> confirm|full_access|auto-review [--grant ...]
npm start -- status [taskId]          # 快照或单任务（工具操作、审批、产物引用）
npm start -- events                   # 订阅持久事件流（seq 单调递增）
npm start -- interrupt <taskId>       # 显式中断运行中/等待确认的任务
npm start -- cancel <taskId>          # 取消排队或活动任务
npm start -- continue <taskId> <newRequestId> "继续输入" [--mode ...]
npm start -- resume-queue <sessionId> # 拥有者确认后恢复队列（并释放遗留占用）
npm start -- confirm <confirmationId> approve|reject
npm start -- read-artifact <taskId> <artifactId> [--offset N] [--length N]
npm start -- credentials list | add --name N --host H --header H --purpose P --secret-env VAR | remove <name>
npm start -- project web-search <项目id> on|off   # 按项目启用/禁用 Web Search（默认启用）
# QQ 群聊入口（issue 07；token 先经 credentials add --purpose qq_onebot 登记）
npm start -- qq configure --endpoint ws://127.0.0.1:3001 --self-id <QQ号> [--credential <名称>]
npm start -- qq group add <群号>          # 允许该群 @ 触发（可多次）
npm start -- qq enable                    # 启用（qq status / disable / inbox / outbox 可查）
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
├── ruukoto.db                 # node:sqlite 元数据（WAL，schema v10）
│                              #   项目（含项目指令文件与 Web Search 开关）、会话
│                              #   （含 kind：dev/qq_group）、任务
│                              #   （accessMode/权限版本/授予路径）、确认请求
│                              #   （结构化范围/消费时间）、工具操作（宿主操作
│                              #   id + SDK 调用 id）、产物元数据、目录占用、
│                              #   幂等键、持久事件、跨项目资料授权、长期记忆
│                              #   当前版本与修订、历史条目位置索引、选择记录、
│                              #   MCP 服务配置、QQ 入口配置/群会话映射/收件登记/
│                              #   发送记录（qq_config/qq_sessions/qq_inbox/qq_outbox）
├── ruukoto.db-wal / -shm
├── sessions/                  # pi JSONL 会话文件（消息历史唯一权威副本）
└── runtime.lock/              # 实例锁（mkdir 原子创建；owner.json 记录 pid）

<dataDir>/../qq-work/           # QQ 群会话专用空工作目录（每 账号_群 一个，0700）

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

## GitHub（专用模块已退役，issue 17）

专用 GitHub 模块（REST 采集、草稿与发布状态机，issue 06）已退役并删除；
GitHub 操作一律经通用 MCP 服务接入（见「MCP 服务」节，含 GitHub MCP 配置
步骤），运行时不再有 GitHub 专属业务分支。首版只读：写工具不注册、不执行
（通用写工具见 issue 18）。旧模块的专用工作流保证（固定修订复核、草稿状态机、
发布意图）不逐项复刻；需要时由 Agent 在普通任务中组合 MCP 工具完成。

### 历史资料与迁移

- 升级后首次启动自动执行退役迁移（`src/runtime/github-retirement.ts`，
  一次性、可重复执行；中断后下次启动继续，未完成不标记成功）：
  - 旧 `github_publish` 审批（pending / approved 未消费）一律失效（stale）；
  - 未决发布操作按证据定终态：批准已消费或无审批记录（完全访问路径可能
    无审批）→ `effect_unknown`（是否已发送无法确认，绝不重发）；审批未消费
    → `canceled`（可证明未发送）。每个被终结的操作落 `github.publish_settled`
    事件并记录核对依据；终态操作不改写；
  - 草稿各版本正文、证据引用与本版本发布记录导出为原任务/会话的产物
    （`github-draft-archive-<草稿 id>-v<版本>`，经 `read-artifact` 查看）；
  - 导出清单（来源 ID/版本/产物对应、绑定无秘密配置、全部发布记录）写入
    `<数据目录>/github-archive-manifest.json`；
  - 旧表（`github_repo_bindings` / `github_drafts` / `github_publish_ops`）
    保留为只读归档，不 DROP；全新数据库不再创建这些表。
- 旧凭据的 host/scope/秘密值不被迁移改变：带 scope 的凭据继续拒绝不匹配
  用途，同名轮换保留 scope。旧仓库绑定不自动转为 MCP 授权；新访问范围以
  通用服务配置、工具允许列表与远端凭据权限为准（通用层无参数级仓库限制时，
  由令牌权限约束可访问仓库）。
- 旧 CLI `ruukoto github …` 与 TUI `/github …` 只返回静态退役提示（不进
  补全与帮助）；旧 `github_*` 控制接口已移除（协议 v8，旧客户端被拒绝）。
- 历史 `github.*` 事件与 `github_publish` 审批记录可查看（只读归档展示），
  不能响应执行。

## Web Search（issue 20）

宿主工具 `web_search`：经 Tavily Search API 的只读互联网搜索（固定官方端点
`https://api.tavily.com/search`；不接入 Extract/Crawl/Research，不做跨任务
缓存或自动长期记忆）。

### 配置与开关

- 凭据：`ruukoto credentials add --name tavily --host api.tavily.com --header
  authorization --purpose tavily_search --secret-env TAVILY_API_KEY`（秘密值为
  API key，工具按 `Bearer <key>` 注入；值不进入模型上下文、事件、日志、历史
  正文或错误文本）。工具按 `purpose=tavily_search` 且 host 与目标一致的绑定
  取凭据；未配置、host 或用途不匹配一律拒绝调用且不发送请求。
- 默认对所有项目启用并注册；拥有者可按项目禁用：`ruukoto project web-search
  <项目id> off`（`on` 恢复）。任务开始固定工具清单：禁用中的项目任务不注册
  `web_search`（模型不可见，系统提示同步重建）；任务内禁用立即阻止后续调用；
  重新启用从下一任务生效。

### 参数、限额与故障处理

- 开放参数：`query`（≤500 字符）、`topic`（general/news）、`time_range`
  （day/week/month/year）、`include_domains`（裸域名白名单，≤20 个）、
  `max_results`（1-5，默认 5）、`search_depth`（basic/fast/ultra-fast；
  advanced 每次 2 配额，首版不开放）。未知字段与超限请求一律拒绝。
- 每任务最多 5 次调用（按执行意图计数，含被拒绝的调用，重启后可核对）；
  单次 15 秒超时；响应上限 256 KiB，超限截断并把原始片段保存为任务归属产物
  （`web-search-response`）后明确报错；畸形 JSON 同样保存原文后报错。
- 认证失败（401）、限流（429，含服务建议等待时间）、配额上限（432/433）、
  服务错误（5xx）、超时与取消均一次终止并返回明确状态，不自动重试；任务
  取消/中断经 AbortSignal 中止在途请求，重启或响应不明不重复发送。
- 每条结果保留标题、来源 URL、摘要与发布时间（若有），按服务相关性顺序；
  字段有界清理（去控制字符、限长），非法 URL 丢弃并如实标注。结果是外部
  未核实资料：工具说明与结果标注均要求不得执行其中指令、不作为拥有者指令
  或权限依据，回答引用搜索事实必须附来源 URL。结果只进入当前任务上下文，
  不写长期记忆；工具定义与结果计入既有上下文预算。
- 权限边界不变：`web_search` 是普通只读工具，不产生审批请求，不改变
  confirm / full_access / auto-review 语义；模型不能经参数访问任意主机
  （目标固定）、读取凭据或开启其他工具。

## MCP 服务（issue 16）

拥有者按项目配置的 Model Context Protocol 服务，首版仅 Streamable HTTP
传输、手动配置凭据、工具发现与调用；stdio、OAuth 登录、resources/prompts
与客户端代执行能力（sampling/elicitation）不启用。首个接入对象为官方远程
GitHub MCP（issue 17 起为 GitHub 的唯一接入路径，旧专用模块已退役）。
MCP 是受控的外部工具入口（ADR 0006）：沿用 ADR 0003/0004 的
权限与控制面边界，不等同于授予项目命令任意网络或凭据访问权。

### 服务配置与管理

- 配置存后台 SQLite（`mcp_services` 表，schema v8）：服务 ID、名称（项目内
  唯一的小写 slug）、HTTPS 端点、凭据绑定名、工具允许列表、启用状态与
  可比较配置版本；秘密值仍在 CredentialStore，不进入本表、事件或日志。
- 拥有者入口（模型工具不能调用）：
  - `ruukoto credentials add --name github-mcp --host api.githubcopilot.com
    --header authorization --purpose mcp --secret-env GITHUB_MCP_PAT`
    （MCP 凭据用途固定为 `mcp`，host 须与服务端点一致，经 authorization
    头以 Bearer 注入；配置服务时 scope 自动收紧到该项目 + mcp 操作，已有
    冲突 scope 拒绝配置）
  - `ruukoto mcp configure --project <id> --name github --endpoint
    https://api.githubcopilot.com/mcp/readonly --credential github-mcp
    --tools get_me,get_file_contents [--expected-version N]`
  - `ruukoto mcp list [--project <id>]`（脱敏视图）
  - `ruukoto mcp check <service-id>`（连接检查 + 工具发现，标注每个远端工具
    是否在允许列表；先打印将联系的端点）
  - `ruukoto mcp disable <service-id>` / `enable` / `remove`
- 端点校验：生产固定 https，http 仅限回环模拟服务；拒绝 userinfo；客户端
  钉住端点源，拒绝跨源重定向，不向非配置目标转发认证。变更采用期望版本
  校验；任何变化递增配置版本并发 `mcp.service_changed` 事件。

### 任务内行为

- 任务开始重读项目配置并逐个连接启用的服务做工具发现，钉版本任务工具
  清单；清单签名（服务配置版本 + 工具名/描述/schema 摘要）变化时从同一
  历史文件重建 SDK 会话。新增工具与扩大范围只在下一任务生效；任务内禁用、
  撤销或版本变化立即阻止后续调用（不发送网络请求）。
- 暴露给模型的工具名带稳定命名空间 `mcp_<服务名>_<远端工具名>`（≤64 字符，
  截断带哈希后缀；转义后冲突的工具禁用并记录）。只注册允许列表内的工具：
  远端 JSON Schema 须为普通对象、根类型 object、≤16 KiB 并经 TypeBox 预检；
  远端 readOnly 等注解不可信，副作用类别以允许列表条目的本地声明为准
  （`name` = 只读；`name:write` / `name:unknown` = 有副作用/副作用不明）。
- 结果区分传输错误与工具执行错误（isError 保留）；文本与结构化结果保留，
  图片/音频/资源链接等内容类型明确说明且不自动打开或下载；超过 32 KiB 的
  结果正文入 ArtifactStore（硬上限 1 MiB，超限明确标记截断），模型只收
  预览与产物引用。工具定义计入既有上下文预算。
- 初始化/发现/调用各有有界超时（默认 15s/15s/60s）；连接失效由下一任务
  重新初始化，不自动重放已发出的调用；任务取消只表示本地停止等待，不承诺
  远端操作已停止。显式启用但初始化失败的服务发 `mcp.service_unavailable`
  事件并列为不可用，任务不带其工具继续；无 MCP 配置的项目保持可启动。

### 写工具与统一审批（issue 18，ADR 0008）

- 副作用类别是拥有者在允许列表条目上的本地声明（远端注解不作权限依据）：
  只读工具各模式直接执行；写与副作用不明工具在 confirm/auto-review 模式
  逐次进入统一审批桥（与文件/HTTP 审批同一 `ConfirmationRequest`、
  `tool_ops` 与单次消费路径），full_access 跳过逐次审批但仍须通过服务
  启用、允许列表与凭据范围校验；auto-review 对 MCP 工具一律转拥有者，
  不扩大自动批准范围。
- 审批范围（`mcp_tool`）绑定服务 ID、配置版本、远端工具名、工具定义版本
  （任务钉版签名）、规范化参数摘要、凭据引用名与操作类别；凭据值不进入
  审批视图或事件。批准后、真正发送前原子消费（同事务重读服务配置与凭据
  绑定）：配置版本变化、禁用、凭据撤销、权限版本变化或任务结束都使旧批准
  失效（不消费、不发送，按已知未执行记录）；执行参数取自审批保存的不可变
  快照，修改参数必须重新申请。
- 写调用的超时、取消、断线与后台重启沿用 effect_unknown：未消费批准的
  操作记录已知未执行；已消费或结果无法确认的操作标 effect_unknown，重连
  与重启不自动重发。
- 本轮只交付通用框架并以模拟服务验证，不启用真实写工具。首次启用真实写
  工具时，凭据必须按服务、项目和操作类别独立绑定（禁止复用 Tavily、旧
  GitHub 或无 scope 的通用凭据），由拥有者明确指定目标与范围后单独验收。

### GitHub MCP 首次配置

- 端点 `https://api.githubcopilot.com/mcp/readonly`（URL 路径 `/readonly`
  为服务端只读开关，见官方 remote-server 文档）；凭据为独立只读 PAT
  （purpose=mcp，host=api.githubcopilot.com），不复用旧 REST 模块凭据。
- 允许列表按 `mcp check` 实际发现的工具名精确填写（服务端工具集随版本
  变化，以发现结果为准）；建议只开放身份查询、仓库文件、PR、Issue、
  Actions 与 Checks 的读取类别。仓库可访问范围由 PAT 权限约束：通用客户端
  未实现参数级仓库限制，项目级启用不等于令牌内的单仓库隔离。
- 验收记录：真实只读连通验证（SDK 版本、协商协议、工具清单与结果）在配置
  具备时进行；缺少凭据或网络条件时如实列为未验证，不以模拟测试冒充。

### 故障排查

- 认证失败（401/403）：凭据无效、已撤销或权限不足 —— 核对
  `credentials list` 中 host/用途/scope 与 PAT 权限。
- 服务不可用事件：按事件中的 reason 区分连接失败、超时、协议不兼容
  （SDK 结果校验失败说明服务端违反 MCP 规范）与工具数/分页超限。
- 工具缺失：`mcp check` 对比远端实际工具与允许列表；远端改名须更新配置
  （下一任务生效）。
- 限流（429）与超时：一次终止并明确报错，不自动重试；由拥有者决定重试
  时机。任务取消/中断后迟到结果被忽略，终态与操作记录保持一致。

## QQ 群聊（issue 07）

NapCat OneBot v11 正向 WebSocket 接入 QQ 群聊：ruukoto 主动连接 NapCat
（不增加公网入站接口），群成员 @机器人 触发纯文本聊天任务。模块在
`src/qq/`（`onebot.ts` 薄客户端 / `adapter.ts` 适配器 / `store.ts` 持久化）。

### 配置与启停（拥有者可信入口）

```bash
# 1. 登记 OneBot token（值不进入命令行/工单/日志；purpose 固定 qq_onebot）
ruukoto credentials add --name qq-onebot --host 127.0.0.1:3001 \
  --header authorization --purpose qq_onebot --secret-env QQ_ONEBOT_TOKEN
# 2. 配置连接（ws 仅限回环/受控私网，跨主机须 wss；非回环必须配置 token）
ruukoto qq configure --endpoint ws://127.0.0.1:3001 --self-id <登录QQ号> --credential qq-onebot
# 3. 允许群并启用
ruukoto qq group add <群号>
ruukoto qq enable
# 查看：qq status / qq inbox / qq outbox；TUI：/qq [status|enable|disable|groups|inbox|outbox]
```

配置存 `qq_config`（单行，含端点、凭据绑定名、预期登录账号、群允许列表、
`max_reply_chars`），任何变化递增 `config_version` 并发
`qq.config_changed` 事件；凭据配置后 scope 收紧到 `qq_onebot` 操作，通用
`http_request` 不得借用。未配置/未启用时适配器保持禁用，不猜测端点与群号。
`max_reply_chars` 默认 1500（未经真实平台核实，部署时按实测调整）；
排队过期固定 5 分钟（已确认规则，不设配置项）。

### 运行行为

- **触发**：群消息含结构化 `at` 段且目标为登录账号（不按显示名或正文 @
  字符匹配）；仅文本段（可含引用段）；图片/语音/附件/转发等整条忽略；
  自身消息与 `message_sent` 回声不触发。无频率限制、冷却或安静时段。
- **身份核对**：连接后经 `get_login_info` 核实账号，事件 `self_id` 逐条
  比对；账号离线或身份不匹配时停止接收新任务与发送（排队任务等待，超过
  5 分钟由启动门过期跳过）。
- **会话映射**：登录账号+群 → 独立项目/会话/专用空工作目录
  （`<dataDir>/../qq-work/<账号>_<群>/`）；同群 FIFO（一次一个任务），
  跨群并行且历史互不可见。
- **收件纪律**：先登记 `qq_inbox`（`dedup_key = account:group:message_id`）
  再入队；事件大小（正文 >8192 字符）与有效期（消息时间超过排队过期时长，
  如离线 backlog 重投）在收件时分别校验，不满足的记录 skipped。登记与入队间
  的崩溃由启动恢复按原请求键核实重提（幂等，不换新键）；入队失败保持
  registered 待恢复，不因瞬时故障丢消息。重复事件不产生新任务。WebSocket
  收事件不等于平台持久投递确认；断线重连成功时发 `qq.receive_gap` 事件
  标记接收缺口，缺失不补抓。
- **隔离**：qq_group 会话任务为空工具集合（装配侧不注册编码/宿主数据/
  Web Search/MCP 工具，发送前最终检查按实际载荷再核对，tool_call 门兜底）；
  不注入个人共享记忆、项目记忆与项目指令；资料身份 `qq_group` 只读本群
  项目，不适用 data_grants 与 owner_note 默认放行。QQ 身份不能审批开发
  任务、修改权限或开启完全访问（任务固定 confirm 模式、无授予路径）。
- **回复**：任务完成后由宿主固定目标（原群 + 引用原消息段）发送一条最终
  文本；超过 `max_reply_chars` 缩短（加省略标记），不自动拆分、不转发中间
  过程/错误栈。任务失败/取消/中断不发送（如实登记 inbox 状态）。
- **发送纪律**：先落 `qq_outbox`（pending，含固定目标/正文/本地操作 id）
  再调 `send_group_msg`；平台明确失败（retcode≠0）= `failed`，超时/断线/
  崩溃 = `unknown`（effect_unknown，不自动换键重发，由拥有者核实）；动作
  echo 只用于匹配请求与应答，不作幂等键。断线重连不补发失效回复。
- **撤回**：收到 `group_recall` 后标记原消息（不再进入后续模型上下文——
  Driver 在每轮调用前移出该交互的视图，不改写历史原文），取消未完成任务
  与未发送回复；已发送回复不自动撤回。撤回事件丢失时不宣称已知撤回。
- **停用/撤群**：一键停用即断连、取消该范围排队与运行中任务（既有取消
  机制）、未发送回复标记 canceled；群移出允许列表同理作用于该群。
- **恢复**：后台重启后，QQ 会话的队列暂停由适配器自动恢复（QQ 任务无工具
  执行与外部副作用，发送走 outbox 纪律）；已登记未入队的消息按原请求键
  重提；遗留 pending 发送一律定 `unknown`（effect_unknown，不自动重发）。

### 验证

`test/26-qq.test.ts`（20 项，进程内模拟 OneBot WebSocket 服务 + 真实适配器
/Runtime/发送控制路径；不向真实群发送消息）：token 错误、登录账号不匹配、
掉线重连与接收缺口标记、白名单、结构化 @ 判定、非文本忽略、自身回声、重复
消息去重、同群 FIFO 与跨群并行/隔离、排队过期、一键停用、撤群、发送失败与
结果未知不重发、响应乱序 echo 关联、撤回（取消未完成/不撤回已发送/后续上下
文排除）、个人共享记忆与项目指令隔离、空工具集合（发送前快照核对）、拥有者
QQ 发言不获控制面能力、qq_group 资料身份、登记-入队与遗留发送的崩溃恢复。

真实 NapCat 接入与 Linux 部署未验证（需拥有者指定账号/测试群并明确授权后
按工单 §5 执行一次真实闭环；模拟测试不代表真实部署已通过）。



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
| issue 06 GitHub 集成（19 项） | — | 已随 issue 17 退役删除（专用模块移除，通用保障迁移至 08/17/24） |
| issue 17 GitHub 模块退役（4 项：全新库不建旧表、v8 样本库升级的审批失效与发布操作终态、草稿归档产物与无秘密清单、重跑幂等、旧控制入口不可达、旧凭据不变、历史事件重放） | macOS 本机（v8 样本库 + 真实运行时/控制面路径） | 通过 |
| 全部离线集成验证（125 项，逐文件顺序执行） | tx（Ubuntu 24.04，Node 24.21.0） | 通过（2026-09-21，17/17 文件 0 失败；修复 15-tui-pty 的 npx 孙进程持有管道导致文件级挂起——detached 进程组 + 整组回收，macOS 回归同过） |
| 真实 GitHub MCP 只读连通（一次已授权仓库的只读调用，记录工具/权限/结果） | 需拥有者配置独立只读 PAT | 未验证（issue 16 遗留；配置具备时按「MCP 服务」节步骤验收，不以模拟测试冒充） |
| issue 20 Web Search（9 项：默认启用与来源/查询时间保留、参数校验与限额、每任务 5 次上限可核对、项目禁用/任务清单冻结/任务内禁用立即生效、401/429/500/畸形/超大响应与产物归属、超时与取消不重发、提示注入有界处理、凭据脱敏与 host/用途限制、schema v6→v7 迁移） | macOS 本机（本地模拟 Tavily API，经真实宿主工具与运行时路径） | 通过（184 项总计含既有回归，0 失败，1 项真实模型门控跳过） |
| issue 07 QQ 群聊入口（20 项：连接鉴权/身份核对/掉线重连与接收缺口、白名单与结构化 @ 触发、收件去重、登记-入队与遗留发送的崩溃恢复、同群 FIFO 与跨群隔离、排队过期、停用/撤群、发送失败与结果未知不重发、响应乱序、撤回处理、记忆/指令/工具隔离、拥有者 QQ 发言不获控制面能力、qq_group 资料身份） | macOS 本机（进程内模拟 OneBot WebSocket + mock 模型，经真实适配器/Runtime/发送控制路径） | 通过；真实 NapCat 接入与 Linux 部署未验证（需拥有者授权的真实群闭环） |
| 真实 Tavily 连通性（一次受控查询，记录端点/调用次数/限制与来源） | 需拥有者配置 tavily_search 凭据 | 未验证（未配置凭据；不以模拟结果宣称真实接入完成） |

### 按会话选择模型

后台启动可传 `--model provider/model --thinking off`；模型 ID 中后续斜杠会保留。未指定思考强度时默认为 `off`，具体合法档位由该模型能力校验。

TUI 使用 `/model` 选择后台已配置的提供方和模型，再选择合法思考强度；`/thinking` 只列出当前模型支持的档位。Esc 取消，后台确认后才更新显示。状态栏区分后续任务选择和活动任务实际配置。选择持久化到会话，新会话继承启动默认值；切换只影响之后提交的新任务，运行中和已排队任务保留提交时的配置。继续中断任务创建新任务，采用本次提交选择。

CLI 可用 `models [--provider provider] [--offset 0] [--limit 100]` 分页查询安全目录，用 `set-model <session> <provider/model> --thinking <level>` 保存选择。`submit/continue` 自动取得当前会话完整选择，也可用 `--model provider/model --thinking level` 显式指定。同一请求键重试先核实原任务，保留原任务模型选择；接收结果不明确时应核实原请求键，不能换键重复提交。

后台重启后队列仍暂停。旧排队任务若未记录模型，TUI 恢复时显示数量和待补选择，确认后补齐；CLI 需 `resume-queue <session> --model provider/model --thinking level` 显式确认。旧终态任务显示“模型配置未记录”。缺模型、凭据或不支持的档位会拒绝整次变更；目录中认证材料可用不代表远程连通性或额度已验证。模型设置应答丢失时查询会话状态，不自动重发覆盖其他客户端。

旧版待确认输入先核实是否已接收；明确未接收但缺少模型字段时保留原文，需拥有者重新选择后提交。明确拒绝的新请求恢复输入；断线和超时则保留完整参数用于核实。
