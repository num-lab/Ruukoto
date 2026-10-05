# 后台任务运行时（issue 02/03/04/05）

任务生命周期独立于交互终端的实现：单个后台进程负责调度、状态与事件，
每个会话使用独立 pi SDK 实例驱动；TUI 断开不影响任务执行（[ADR 0002](../adr/0002-detach-terminal-from-task-runtime.md)）。
issue 03 接入真实编码工具与两种权限模式（[ADR 0003](../adr/0003-enforce-explicit-access-modes.md)、
[ADR 0004](../adr/0004-tool-worker-per-task-container-exec-account.md)）。
issue 04 接入 TUI：只连接已运行后台的独立客户端，含历史读取、断开重连与
输入去重；当前控制协议为 v10，包含事件流恢复接口。

## 架构要点

- **工具工作进程**：read/edit/write/bash 的完整执行（含路径解析与 Shell
  子进程）在独立工作进程内完成；SDK、模型调用、审批与持久化留在后台。
  进程间为换行分帧 JSON 协议（单帧 4MB 上限、数据分块 512KB、背压）。
- **执行边界**：请求确认与自动审查模式 → 按任务建立的 Linux 容器（固定镜像
  `ruukoto-worker`，非 root、cap-drop ALL、no-new-privileges、只读根文件
  系统、tmpfs /tmp、默认无网络、只挂载授权工作区与任务级授予路径），任务
  结束回收容器。工作区与授予路径按宿主原路径挂载（`-v <p>:<p>`，工作区
  同时是工作目录，只读授予加 `:ro`），系统提示里的 cwd、拥有者给出的绝对
  路径与 `request_file_access` 的宿主路径在容器内外一致；挂载点以外的父
  目录在容器内为空。完全访问 → 容器外由 systemd 以固定执行 UID 启动
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
  时解析的地址；凭据按预配置的目标绑定注入，值不进入审批与事件。消费后的
  失败定性（架构工单 05）：GET/HEAD 失败一律是已知错误；其他方法以请求交给操作
  系统发出为界，之前失败（连接被拒、TLS、凭据）是已知错误，之后失败（等响应
  超时、连接重置、任务停止中止）标 `effect_unknown`，不自动重发。任务停止即中止
  在途请求，不等超时。
- **会话身份与执行画像（架构工单 08）**：「这个会话是什么」由
  `src/core/session-identity.ts` 一次判定：`Store.getSessionIdentity` 读出会话、
  角色行与 SubAgent 行，纯函数 `classifySession` 分为普通开发会话、main 会话、
  SubAgent 会话（SubAgent 行优先，会话类别也是 dev）与已退役归档（QQ 群、chat/coding
  角色，附退役原因）。Runtime 各入口按身份一行判定（提交：SubAgent 拒绝、计划模式只限
  普通开发会话、归档按原因拒绝；改默认模式与切换模式：SubAgent 拒绝；队列兜底：归档
  按原因取消；resume-queue 从身份取 Agent 行），错误码与文案留在各入口；每次调用的
  宿主身份重核（main 绑定、委派资格、群结果工具、IM 长期授权）用同一解析，但每次
  新鲜读取。委派登记的父会话必须是普通开发会话或 main 会话，两种 mode 同一口径。
  给定任务，`tool-availability.ts` 的 `executionProfile` 由身份、任务所属工作是否有
  写入目标与是否宿主评审算出执行画像：会话类别（工具类别表与系统提示键）、SubAgent
  工具集（只读 / 写入 / 宿主评审：另开只读 MCP、关 `subagent_message`）、是否规划
  MCP、资料受限（SubAgent）、计划资格（只普通开发会话）。任务开始算一次、钉到任务
  结束；装配过滤、任务收窄与 SDK 会话签名同用这一份，工具集变化时重建 SDK 会话，
  不依赖 Runtime 每任务释放 SubAgent 的 Driver（那只是资源回收）。工作区不进画像，
  占用键与 LaunchSpec 都取 `core/worktree.ts` 的 `taskWorkspaceFor`。
- **工具可用性（架构工单 03）**：`src/agent/tool-availability.ts` 回答「这个会话、
  这个任务允许哪些工具」。会话类别（普通开发会话、main、SubAgent 子身份 subagent；已退役的 QQ 群会话与
  chat/coding 角色会话是只读归档、不归任何类别，算执行画像即拒绝）各有一份工具类别
  清单，是唯一来源：普通
  开发会话为编码
  工具（含工作清单）、资料与记忆、Web Search、MCP、技能、SubAgent 委派；main 为
  资料与记忆、Web Search、应用数据、调度与通知、旧 coding 结果只读、群结果、技能、
  SubAgent 委派；subagent
  为空（SubAgent 的工具按执行画像的 SubAgent 工具集单独装配，静态白名单）。
  新工具族写进哪份清单才出现。任务开始时算一次本任务允许的工具（已装配的工具减去计划模式、GitHub
  评审等宿主按任务收窄与项目关闭的 Web Search），激活、发送前检查
  （`task_tools_forbidden`）与调用门共用这一集合。获批后的复核属于审批闸门（下条）；
  Web Search 开关的现场检查与委派只限拥有者发起的任务由各工具执行时自行完成，都不
  属于可用性。
- **审批闸门（架构工单 04）**：`src/agent/approval-gate.ts` 负责审批请求全程：登记
  并把任务转入等待确认、auto-review 任务先经一次自动审查、等待拥有者决定、未批准时
  记录已知未执行、获批后在同一核心事务内复核并单次消费（`task.approval_consumed`），
  需要时同事务提交本地效果（通知登记）。文件、HTTP、MCP、应用数据、通知与模拟测试的
  confirmTools 门都经它；工具族只提供审批范围、获批后复核（MCP 服务配置与凭据、main
  身份与应用库版本、通知的身份、目标与资料）和同事务提交。未批准、复核失败与消费
  失败交回同一句已知未执行文案（落库与返回给模型一致）。执行参数取自审批前构造、与
  审批记录同源的请求（MCP 与应用数据用审批记录的快照；固定解析地址、目标文件身份
  只在内存）。是否需要审批（完全访问模式下只有 MCP 跳过）与自动审查策略仍在各族与
  `review.ts`。
- **工具操作账本（架构工单 05）**：`src/agent/tool-op-ledger.ts` 负责工具操作的
  已知结果与效果未知：结果与 `task.tool_result` 事件成对写入（落库与事件同一句，
  重复补记不重复发布），效果未知写操作标记、`task.tool_effect_unknown` 与任务标记
  （幂等）。停止与重启按同一个分类器补记结果缺失的操作：**审批未消费 → 无写入效果
  → 工具族核实 → 效果未知**。规则表按静态工具名穷尽登记（漏登记即编译错误）：
  只读工具（`read`、`read_artifact`、`history_*`、`memory_list/read`、`web_search`、
  `skill`、`todo_write`、应用数据/调度/群结果的查询、`http_request` 的 GET/HEAD、
  读取文件）中止记「未完成：只读操作中止，无写入效果」；写操作由工具族按宿主操作
  编号核实（应用库回执、调度账本、子任务、群结果接收账本）；其余（`bash`、`edit`、
  `write`、记忆写入、MCP、未登记名字）记效果未知，不重放。编排器的重试门也用这张
  表的「无写入效果」判定。MCP 读工具的副作用类别不在操作记录里，沿用效果未知。
- **正文产物**：工具输出在上游截断之前捕获为受保护的产物文件（先落盘再
  生成限长模型视图）；中断/写失败保留已捕获部分并标 partial；按任务归属
  经工具或控制接口按 id/偏移/长度查询，跨重启可读。
- **拥有者认证**：控制面 socket 位于受控目录（数据目录兄弟目录
  `control/`），任何连接须先以拥有者令牌（`owner.token`，0600）auth，
  认证成功前不返回快照、不执行请求；令牌不进命令行、工具环境或日志。
- **QQ 群聊已退役（agent-direction issue 20）**：核心不再创建或执行群聊
  任务（群消息直接忽略），旧群历史、收发账本与接收记录保留为只读归档
  并可核查；QQ 拥有者私聊继续可用（NapCat OneBot v11 窄入口，`src/qq/`）。
  正式 QQ 群聊外挂（独立可选程序）在后续阶段交付。详见下文「QQ 群聊」。

## 运行命令

```bash
npm install
npm run typecheck        # 类型检查
npm test                 # 全部离线集成验证（mock 模型，不联网、不需要凭据）
RUN_MODEL_CHECK=1 npm run test:model   # 真实模型连通性（逐 provider 一次短往返）

# 启动后台（生产：--execution container + 完成 deploy/systemd 配置；
# server 为推荐命令，start 是同一实现的兼容别名）
npm start -- server --data-dir ~/.ruukoto/data --agent-dir ~/.ruukoto/agent \
  --execution container --model provider/model

# 交互入口（需 TTY；旧拼法 tui 给出迁移指引）
npm start --                 # 任务界面：选择既有会话（不隐式新建）
npm start -- /path/to/dir    # 以该目录为工作区创建新会话并进入
npm start -- config          # 配置中心（见下文「配置中心（issue 21）」）

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
# QQ 入口（token 先经 credentials add --purpose qq_onebot 登记）
npm start -- qq configure --endpoint ws://127.0.0.1:3001 --self-id <QQ号> [--credential <名称>]
npm start -- qq enable                    # 启用（qq status / disable / inbox / outbox 可查；inbox/outbox 为旧群归档）
# 核心群聊已退役（issue 20）：qq group add|remove 已删除，旧命令只打印退役提示
npm start -- stop                     # 优雅停止（SIGTERM/SIGINT 走同一路径）
```

两个产品入口（ADR 0017；本文件其余部分描述默认产品 ruukoto）：

```bash
ruukoto ...                 # 个人 Agent（bin 入口）
ruukoto-dev ...             # Coding Agent（bin 入口）：同一 CLI，产品身份经
                            # RUUKOTO_PRODUCT=ruukoto-dev 固定注入（仓库内等价于
                            # RUUKOTO_PRODUCT=ruukoto-dev npm start -- ...）
```

ruukoto-dev 的行为差别：

- 独立档案根 `~/.ruukoto-dev-agent/{data,agent,control,pending}`；路径环境变量
  只读 `RUUKOTO_DEV_DATA_DIR` / `RUUKOTO_DEV_AGENT_DIR` / `RUUKOTO_DEV_CONTROL_DIR`
  / `RUUKOTO_DEV_PENDING_DIR`，不读对方产品的 `RUUKOTO_*_DIR`；同机并存时目录、
  实例锁、配置锁、socket 与 owner token 文件各自独立，升级与互停互不牵连。
  注意：`RUUKOTO_OWNER_TOKEN` / `RUUKOTO_OWNER_TOKEN_FILE` 两产品共用（令牌是
  控制面身份，不是路径归属）；导出了这两个变量的 shell 对两个产品都有认证能力。
- 不启动 QQ/Telegram 连接与个人调度（调度器不创建；状态视图按 ruukoto-dev
  标注停用原因）；其余命令、控制面与审批机制相同。
- 不提供旧项目写入路径（agent-direction issue 23）：TUI `/new-project`、在无
  根目录的旧项目里 `/new` / `/new-session`，以及 CLI `create-project` /
  `create-session` 只提示改用 `ruukoto-dev <目录>` 打开工作区；旧项目保留查看，
  需要时经 `project migration-preview` 映射到工作区。控制面 op 不变。
- 数据目录归属登记在核心库 meta（`product.type`，首次启动补记）；用另一产品的
  入口打开已归属的数据目录直接拒绝。
- 开发机执行权限的边界已在工单 03 验证、工单 04 接入产品：受限模式的执行边界
  是经本机容器运行时复用的每任务容器（macOS 为 Docker Desktop 的 Linux VM，
  原生 Linux 直接运行；sandbox-exec 的文件规则在本机静默不执行、不作为边界）。
  **ruukoto-dev 的默认执行后端为 container**（工单 04）：受限任务在容器边界内
  执行；`--execution local` / `RUUKOTO_EXECUTION_BACKEND=local` 仍可显式选择；
  两产品以 local 生效时都打印同一条无隔离警告。后端缺失或失效（docker 不可
  用、镜像缺失）在执行前明确拒绝、不静默回退到普通账户。完全访问需要专用执行
  账户（Linux：ruukoto-exec 经 systemd 包装入口，经既有部署验证；macOS 的本机
  独立账户与 sudo 包装属部署前置、尚未验证）——未配置入口时完全访问提交在执
  行前以 `execution_unavailable` 拒绝，不静默降级。产品级冒烟
  `.scratch/agent-direction/smoke-04-desktop-execution.mts`（真实容器、镜像、
  文件、网络与审批路径，模型打桩；0 全过、2 基础设施缺失）在本机与原生 Linux
  各 6/6：容器内完成代码修改与检查、子进程不再见宿主文件与外网、只读根、越
  界读取审批单次消费、中断回收执行单元（含工作进程启动窗口）。
- 打开 TUI 时按需拉起本机后台（issue 02，见下文「按需拉起后台」）：首次打开
  `ruukoto-dev` 不必先 `server`；关闭 TUI 不停止后台或取消任务，显式
  `ruukoto-dev stop` 才结束后台。

按需拉起后台（issue 02，仅 ruukoto-dev 的 TUI 入口）：

- 打开任务界面（`ruukoto-dev`、`ruukoto-dev <路径>`、`--session`）时先探测控制面
  （socket 可连且令牌认证握手通过）：已在运行直接复用，不启动第二个实例；不在运行
  才拉起 detached 后台进程（标准输出/错误追加到 `<controlDir>/spawn.log`），就绪后
  打印一行提示并进入界面。拉起的后台与 TUI 生命周期无关：退出 TUI、终端断开都
  不停止后台或取消任务，显式 `ruukoto-dev stop` 才结束。
- 两个终端同时打开时并发拉起由后台实例锁（`<dataDir>/runtime.lock`）收敛为单个实例，
  不另设客户端锁：败于锁竞争的进程退出，TUI 侧不误判为启动失败，继续探测到胜者
  就绪后按复用进入（不算本进程拉起）。
- 状态明确（拉起失败均打印错误并非零退出，不进入连接状态机）：socket 可连而令牌
  认证不通过 → 后台其实在运行，给出令牌核对指引（不再拉起）；服务进程以非实例锁
  原因提前退出且宽限窗口后探测仍不通过 → 「后台启动失败」并附 spawn.log 尾部
  （常见原因：未配置可用模型 → 先 `ruukoto-dev config`）；到期限仍未就绪 → 等待超时，
  单独标注且不杀进程。运行中断线仍按既有规则显示重连中，**重连只恢复观察，不会
  再次拉起后台**；后台不可用要再拉起时重开 TUI 即可。后台明确拒绝（令牌无效、协议
  版本不符）照旧终止重连并给出修复指引（不兼容版本不属于可拉起解决的问题）。
- 拉起即是正常后台启动：异常中断后的恢复沿用既有规则（标记 interrupted、暂停队列、
  效果未知不重放——见文末「崩溃恢复」），拉起与重连都不构成重新执行授权。
  拉起的后台沿用产品默认执行后端（ruukoto-dev = container）；需要 local 时在环境显式设置
  `RUUKOTO_EXECUTION_BACKEND=local`（生效时打印无隔离警告）。
- `ruukoto`（个人 Agent）不按需拉起：后台由显式 `server` 或 systemd 管理，TUI 打开
  时仍只连接已运行的后台。
- 手动后台照旧：`ruukoto-dev server --data-dir … --agent-dir …` 前台运行，与按需
  拉起共用同一实例锁（谁在运行谁生效，重复启动被拒绝）。

开发调试（issue 21，详见下文「开发实例」）：

```bash
npm run dev [-- --tui | --config] [--import-models <目录>]
```

## TUI（issue 04）

`ruukoto` 启动全屏交互终端（旧拼法 `ruukoto tui` 给出迁移指引后沿用原行为；
`ruukoto --session <id>` / `--demo` 对应原 `tui --session/--demo`）：顶部为项目/会话/工作目录/连接状态/任务权限
模式/执行后端，中间滚动显示消息与工具记录，输入框上横线右侧显示工作区目录名，底栏显示权限模式、token 用量及模型选择；工作清单经 `/todo` 悬浮层查看。
TUI 只连接本机后台（Unix socket + 拥有者令牌），不创建 SDK 会话、
不加载模型凭据、不直接读取后台数据库或 JSONL；ruukoto-dev 在连接前按需拉起
本机后台（见上文「按需拉起后台」），ruukoto 只连接已运行的后台。后台不可达
（含启动时后台尚未就绪）、认证或同步超时、断线时显示连接状态并按有上限的
退避重连，不会悄悄另起同一任务；只有后台明确拒绝（令牌无效、协议版本不符）
才停止重连并给出修复指引。
`--demo` 打开合成调试会话：不连后台，只应答展示所需的读操作，其余操作明确
拒绝（提交恢复草稿），待核实记录写到临时目录。

**工作区入口（issue 21；agent-direction issue 05）**：`ruukoto <路径>` 以该目录
为工作区创建新会话并直接进入（`./config`、`-- <路径>` 处理与命令同名的目录）。
相对路径按客户端调用时工作目录解析；后台继续校验目录存在性、realpath、
dev/ino、保护根与权限，只接受已有目录。工作区实例上是带根目录归属的
项目（projects 表 root_cwd/root_real/root_dev/root_ino 四列，v19 补列，同一
真实目录至多一个工作区，部分唯一索引兜底）；根目录可以是普通目录，也可以
含多个 Git 仓库。归属判定按真实目录身份（realpath，或 dev+ino 覆盖符号链接
与挂载别名），同名不同目录各自成工作区（项目名仅展示层去重，重名追加序号，
绝不合并）。打开目录经 `open_workspace` op：已确认归属的工作区直接复用；尚未
归属的旧项目可作为候选经选择列表确认后认领根目录（多个候选先选择，取消则
不创建任何记录；`project.root_attached` 事件留痕）；从未使用的目录自动创建
工作区项目。认领/建项目与建会话同一事务，失败不留空项目。认领限制与后台
防御一致：角色或群聊会话所在的项目（含混合旧项目），以及会话分布在多个
真实目录的旧项目，都不可经目录入口认领——多目录旧项目按下文「旧数据组织
迁移」处理。每次独立启动创建一个
新会话；创建请求带稳定启动请求标识（open_workspace / create_project /
create_session 幂等键，同键重发返回原记录、同键异参报 request_conflict），
断线重连后按标识在新快照中核实，不重复创建；连接仍在的应答丢失（超时等）
当场核实一次，仍未确认则回到正常启动并提示用 `/project` 查看。
`create_project` / `create_session` 旧 op 行为不变（不写根目录归属），旧项目、
旧会话照常可读。

**旧数据组织迁移（agent-direction issue 07，ADR 0018）**：旧项目可包含不同
目录的会话。`sessions.workspace_project_id`（v21 加列）是会话的工作区
**组织归属**：只决定组织查询与普通列表的展示归属（显示归属 =
`workspace_project_id ?? project_id`）；历史、产物、记忆、指令、MCP/Jev、
授权与凭据继续按原 `project_id`、会话/任务 ID、pi 会话 ID 与文件路径定位，
组织映射不复制、不合并配置，也不改变运行中任务身份。拥有者经 CLI 显式迁移：

1. `ruukoto project migration-preview <项目id> [--limit N]`：只读预览（零写入），
   按源项目列出目录分组（登记 realpath/dev/ino 先核实再用 sameDirIdentity 去重；
   失效/被替换/无权核实分列，不把同路径新目录当旧目录）、逐会话归属（角色/群聊
   明确排除、指令基准、历史缺失/未落盘/损坏单独报告）、同目录其他旧项目、
   混合项目、已认领根外会话、嵌套根、worktree 等歧义与异常、安全认领条件与
   建议计划；会话数可限制，截断如实报告且不可用于认领或生成修订。
2. 按建议编写计划文件（`action: map_sessions` 的会话 → 目标分配，或
   `claim_source` 的安全认领），`migration-preview <项目id> --plan <文件>`
   校验选择并把绑定最终选择的修订（相关元数据的规范化内容哈希，无关任务
   输出不过期）写回计划文件。映射目标必须是根目录含所选会话真实目录的
   工作区（existing_workspace）或通过目录与保护根校验的新根
   （new_workspace，同一真实目录已有工作区时必须复用其 ID）；安全认领仅在
   来源项目无根、会话集合非空且全为普通 dev、目录全部有效且为同一真实目录、
   目标即该目录、无占用、无已映射会话时成立（混合/部分/祖先认领拒绝）。
3. `ruukoto project migration-apply --plan <文件> [--request-id <id>]`：缺省
   请求键按计划文件内容派生（同一文件重发即原键核实）。应用先查成功回执
   （meta 中的 `migration_receipt:<request_id>`，同键重放返回原成果、
   同键异参 request_conflict），再核对修订并单事务提交目标创建/根认领/
   组织字段更新/事件/回执；任一失败整体回滚。成功后 `action: "revert"` 的
   计划文件（`revert_request_id` 指原请求）按回执校验当前值后只恢复显式
   组织字段；已认领根目录、新工作区与迁移后的任务、配置修改、授权撤销
   事实全部保留。

工作区查阅与新建（步骤 4）：`list_session_summaries` 增加与 `project_id`
互斥的 `workspace_id` 参数（组织归属查询，活动时间算法不变，映射事件不算
任务活跃）；ruukoto-dev 的选择面板计数与会话列表、恢复旧会话后的当前
选择状态、`/resume` 默认项都按组织归属（ruukoto 产品与旧 API 恒按原
身份）。会话标题对 mapped 会话标注「工作区（配置与资料来源：来源项目）」；
从已映射旧会话 `/new` 或 `/new-session` 创建的新会话落到目标工作区
（目标 Project ID 与配置），无映射旧会话保持旧行为。配置中心工作区详情
经已映射会话派生列出「关联旧资料来源」（来源 ID、会话数、MCP/Jev、
授权出入向、设置版本、指令基准；并列显示不合并，来源设置各按来源项目
ID 与自身版本访问）。
**选择面板（agent-direction issue 05）**：ruukoto-dev 的 `/project` 与工作区→会话
选择中，带根目录归属的工作区列在前、旧项目列在后，逻辑角色（main/coding/chat）
与 QQ 群聊会话所在的项目不进入普通列表，会话列表同样过滤；ruukoto 产品沿用
旧行为（主会话等原样列出）。内部子任务是任务而非会话，本就不出现在会话列表。

- **输入**：`Enter` 提交，`Alt+Enter`（或 `Shift+Enter` / `Ctrl+J`）换行；
  支持中文与 bracketed paste，大段粘贴在编辑器内折叠显示，草稿与提交保留
  展开后的原文。补全仅覆盖 `/` 固定命令，不扫描本地文件。
  输入框随显示内容自动增高，事件流让出相应空间，保留上下横线；超过编辑器
  可见行上限后在框内滚动，光标所在行保持可见，清空后恢复最小高度。
  上横线右侧显示工作区目录名，宽度不足时截断；底栏不再显示工作区路径。
  普通消息与斜杠命令统一进入输入历史，可用上下键调出；重新进入会话时按
  时间顺序恢复已保存的用户消息和命令，调出历史不会执行命令。
  输入框下方的底栏在模型名左侧以灰体显示当前会话累计实际用量，如
  `↑114K ↓514 · Provider/Model · Effort`。输入包含缓存读取、写入的 token；
  输出取 provider 实际输出，用量缺失的调用不计入，不使用估算。数量按千进制
  转换为 K、M、B，最多一位小数；宽度不足以显示统计和完整模型信息时，整段
  统计隐藏。每次实际用量保存后更新，切换会话及重连时从后台恢复累计值。
- **命令**：`/resume` 切换当前项目中的会话，`/project` 切换项目（ruukoto-dev 为工作区/旧项目列表，见上文「选择面板」）；`/new-project`、`/new-session <目录>` 创建；
  滚动到顶部自动加载更早历史，保留当前查看位置；加载中不重复请求，已加载的更早历史不会被初始 300 条限制裁掉。
  点击工具返回结果行在事件流中展开，再次点击收起；
  `/artifact <id 前缀>` 按字节分页查看产物正文；`/approvals` 待处理审批
  （详情内 `a` 批准 / `r` 拒绝，Esc/q 关闭不等于拒绝）；`/interrupt`、
  `/cancel <taskId>`、`/continue [taskId]`、`/resume-queue` 为明确的任务
  操作；`/mode` 通过列表设置会话默认权限模式，作用于后续任务；`/model`
  选择后续任务的模型和思考档位；`/skill <名称>
  [参数]` 显式调用技能、`/skills` 查看技能库与诊断（见「技能」）；`/plan <内容>`
  以计划模式提交任务（见「计划模式」）；`/quit` 或 `Ctrl+C`（空草稿时）退出客户端。
  命令以 `src/tui/commands.ts` 的条目表为准（架构工单 06）：补全、`/help`、派发、
  回显、是否作为任务输入与是否保留成功结果都由条目推出。
  会话选择列表每项两行：首行使用最早用户输入作为名称（无输入时显示未命名会话），
  次行显示距最后任务活跃时间的间隔，例如 `2 hours ago`；没有任务时从创建时间计算。
  会话之间留一行空白。名称过长时截断，选中任意一行都进入对应会话。
  项目选择列表采用相同布局：首行显示 `项目名 · 会话数`，次行显示会话的工作区路径；
  多个工作区去重后在同一行展示，没有会话时显示“尚无工作区”，项目之间空一行。
  切换会话时沿用切换前选择的权限模式、模型和思考档位，保存为目标会话的默认设置；
  提交新任务会等待设置保存完成，已有任务继续使用创建时的设置。
  输入框获得焦点时，`Shift+Tab` 按 Ask for approval → Full access → Auto review
  循环切换后续任务的默认权限模式，保留草稿；连续按键依次保存，后台确认后
  更新显示。窗口与选择悬浮层打开时不触发此快捷键。
- **悬浮层**：简单覆盖下层内容，打开时保留主界面可见。`/mode`、`/model`
  的选择内容与斜杠补全以悬浮层展示。`/todo` 在右上角显示带完整
  边框的工作清单悬浮层，保留输入焦点；再次输入 `/todo` 或按 Esc 关闭。
- **窗口**：四周有完整边框，打开时隐藏主界面的顶部、事件流、工作清单、
  输入框与底栏。`/help`、`/resume`、`/project`、`/prompt` 的内容以及其他需要隐藏
  主界面的详情、查询结果、提示与确认均以窗口展示；多层窗口只显示最上层，
  关闭后逐级恢复。选择和查看的悬浮层与窗口均可用 `q` 或 `Esc` 关闭。
- **事件流**：用户输入、工具、模型正文、思考段和任务状态按发生顺序展示，
  独立事件之间空一行，工具或命令与其结果紧贴。用户消息与命令消息使用
  铺满内容行的灰色背景，命令结果单独显示。首列保留给 `❯`、`●`
  等图标；工具图标为 `●`，成功为绿色、失败为红色。Markdown 正文、列表、代码块与续行统一缩进。工具只展示
  名称和主要目标，Read、Write、Edit 的文件目标按会话工作区显示相对路径，错误另行提示；Edit 与 Write 的真实成功增删行数分别显示为绿色
  和红色，缺失统计时省略；长 Bash 命令从尾部截断并以 `...` 结尾。
  `todo_write` 只显示完成数/总数（如 `⎿ 3/7`），不展开清单。事件流末尾
  保留一行空位。
  工具返回结果行支持点击展开代码，再次点击收起，保持输入焦点；Write 显示
  带行号的写入原文和语法高亮，不显示 diff 标记；Edit 显示带实际行号的修改，
  保留语法高亮，删除用红色背景、新增用绿色背景，不显示补丁头或代码围栏。
  其他工具显示保存的结果正文。展开内容最多 8 KiB、80 行；Write 省略内容时
  在末尾显示 `...n more lines`，行数根据完整写入原文计算。
  不创建悬浮层或窗口。结果和 Edit 补丁来自 JSONL，Write 原文来自对应工具调用。
  向上或向下滚动查看历史时，顶部事件所属任务的用户消息完整滚出视野后，
  固定显示在事件流顶部；跨任务时切换，恢复跟随末尾时隐藏。置顶消息保留
  灰底，最多显示三行，超出部分用省略号标记。置顶内容在滚动区域内覆盖显示，
  切换时不改变视口高度；窄小视口至少保留一行用于显示历史事件。
- **Mermaid**：助手消息中的 `mermaid` 代码块在生成完成后转换为 Unicode
  字符图（beautiful-mermaid），支持中文标签。流式生成期间显示源码；解析失败、
  图形超过可用宽度、超过 8192 字符或 100 行、无法对齐的组合字符，以及当前
  渲染库方向不正确的 `RL` 图保留源码。终端宽度变化时重新排版；支持范围以
  渲染库为准，不保证完整 Mermaid 语法兼容。
- **工作清单悬浮层**：经 `/todo` 查看当前会话的完整清单（`▶` 进行中、
  `⏸` 待做、`✓` 已完成，暗色），保留所有条目，长任务名单行截断，超出高度时
  可在悬浮层内用鼠标滚轮查看。清单更新后实时刷新；没有清单时显示说明，
  全部完成时仍可查看。内容取已加载工具记录中最近一次成功 `todo_write` 的
  参数，重连后按同一来源恢复；窗口打开时暂时隐藏，关闭窗口后恢复。
- **思考与正文**：每段思考显示点状旋转图标与 `Thinking...`，公开思考内容
  多行滚动展示最新四行，使用灰体，点击后在事件流展开完整内容，再次点击收起。
  结束后标题原位显示 `Thought for Ns` 并保留内容；有明确思考阶段
  事件时按该阶段计时。没有公开思考时，
  从每轮请求发出到正文或工具调用开始计时，包含网络等待。正文完整流式
  保留，可向上滚动，不受原有 8 KiB 尾部预览限制。
- **命令结果**：命令在当前客户端回显（`/plan <内容>`、`/skill <名称> [参数]`
  作为任务输入提交，只显示任务输入一行）；`/mode` 和 `/model` 追加
  `⎿ Switched to ...`，`/context` 在命令下保留 `⎿ Context Usage`、分色上下文长条
  与分类数据。`/prompt`、`/search`、`/memory`、
  `/qq` 等命令的正常内容在可关闭的窗口中展示，关闭后只留下命令行；错误
  和必要警示仍明确提示。
  `/prompt` 详情完整读取快照并解析为文本，按系统提示、消息角色与工具定义分区，
  多行正文直接显示；工具参数按层级展示，图片只显示类型。使用方向键或翻页键
  滚动查看，Esc/q 返回请求列表；快照损坏时显示解析错误，不显示 JSON 原文。
  当前会话的命令行及其结果立即保存到客户端私有的 `tui/commands.sqlite`
  （位于待确认请求目录的同级目录，默认 `~/.ruukoto/tui/commands.sqlite`；
  dev 沿用独立 profile）。记录按数据实例和会话隔离，退出后重新进入会话
  仍按原时间显示，恢复记录不会再次执行命令；`/quit` 不记录。
  上下文长条按当前终端可用宽度重新分配各颜色段，缩窄时保持单行；分类、预留
  与余量的 token 数统一使用小写 k/m（最小 k、最大 m），百分比保持原口径。
- **任务状态**：执行期间同时显示底部 `● Sweeping · Elapsed Ns`，`Sweeping`
  文字有从绿到白再回绿的移动流光；审批
  等待另加文字标注；总耗时从实际开始执行算起，包含审批等待、不含排队。
  存在非空工作清单时，在 Elapsed 耗时后追加 `[完成数/总数]`，如 `Elapsed 42s [1/5]`。
  成功为灰体 `  Done in Ns · At Tue 09:16 PM`，失败为红色 `✗ Failed`，
  取消或中断为黄色 `Canceled`、`Interrupted` 并附必要原因。完成时间
  按运行客户端的本地时区显示，旧记录没有可信开始时间时省略耗时。
  耗时按天、时、分、秒组合显示（如 `1d 2h 3m 4s`），省略值为零的单位；
  不足一秒显示 `0s`。任务耗时与思考耗时使用相同格式。
- **断开与重连**：退出/断开只关闭客户端，后台任务继续执行；重连后从后台
  重建快照、历史及任务事件，恢复思考、工具、完整正文和完成状态的顺序，
  按事件和消息身份去重。旧历史只展示已有可靠信息，缺少的思考耗时和
  Edit 统计不补造。命令回显从客户端私有记录恢复；不自动新建任务、不恢复暂停队列。
  事件序号缺口或游标过旧时自动重新同步。
- **输入去重**：提交前生成 `request_id` 并把完整请求原子保存到拥有者私有
  目录（默认 `~/.ruukoto/pending/`，`RUUKOTO_PENDING_DIR` 可覆盖，0600）；
  应答丢失时显示"接收结果待核实"，按 `session_id + request_id` 核实（断线的
  等重连后，连接仍在的当场核实这一条）：已接收则关联原任务，明确未接收才以
  原键原参数重试；记录绑定数据实例标识，换新数据库后不会向空后台重发。未发送
  或后台明确拒绝时清除记录并恢复输入。
- **请求结果分类**（架构工单 07）：控制面请求失败时由产生错误的地方写定
  四类之一：未发送（连接不可用、客户端已关闭、参数无法序列化）、明确拒绝
  （后台错误应答）、应答丢失且连接仍在（超时；`internal_error`、
  `response_too_large`、`mode_switch_unverified` 应答）、应答丢失且已断线
  （在途请求遇到断开、坏帧、超长帧、未换行残留）。后台把系统错误码
  （ENOENT、ERR_SQLITE_* 等）收口为 `internal_error`、原码写进消息。
  `/mode`、`/model`、审批应答丢失时：连接仍在立即查询后台状态，已断线则提示
  结果未知、以重连快照为准，都不自动重发；其余写操作（中断、取消、恢复队列、
  创建会话或项目、记忆撤销与恢复、QQ 启停）按「未发送 / 失败 / 结果未知」提示，
  结果未知时指明核实入口。
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
协议 v9 新增 `read_task_events`（`task_id`、`after_seq`、`limit`），按
任务和持久事件序号分页恢复，返回 `events` 与 `nextAfter`。输出片段
`task.output_fragment` 携带消息 ID、正文段 `contentIndex`、UTF-8 字节
偏移 `offset` 与该段 `startedAt`，单片有界，接收端按偏移拼接完整正文；
缺少偏移的旧片段仍按累计尾部解释。`task.thinking` 携带思考段 ID、开始
与结束时间及单行展示所需的最新内容，`task.tool_result` 可携带真实
`editStats`。消息完成后仍以 `task.output_entry` 关联的 JSONL 正文为准，
事件投影不替代会话历史。`get_task` 返回快照对应的事件序号 `seq`，客户端
据此协调实时事件与详情恢复；协议版本不同的客户端和后台在握手时明确拒绝，
持久事件中的旧格式兼容不代表线上协议向后兼容。

握手返回数据实例标识与执行后端说明；快照有界（活动任务 + 每会话近期结束
任务）；工具大参数、快照输出预览和事件分页均有载荷上限。拥有者令牌文件路径可
经 `RUUKOTO_OWNER_TOKEN_FILE` 指定（拥有者与后台不同 UID 的部署）。
`respond_confirmation` 可携带 `permission_version` 绑定审批时的权限版本
（不匹配返回 `permission_version_mismatch`）；`read_artifact` 单次上限
720 KiB（base64 开销后仍在 1 MiB 帧上限内）。


`request_id` 由客户端保存、唯一范围为会话：提交落盘但应答丢失时，同键同
参数（含模式与授权范围）重试返回原任务，同键异参返回 `request_conflict`。

## 配置中心（issue 21）

`ruukoto config` 打开独立配置界面：复用控制面拥有者认证与 TUI 组件，不直接
打开核心数据库，也不成为绕过任务审批的入口（任务执行审批仍在任务界面）。
在线管理范围：provider 与模型目录（显式端点、SDK 已支持协议、模型列表及
上下文/输出参数）、模型 API key、后台默认模型、摘要模型、项目指令/Web Search/资料
授权、会话默认模型/思考档位/权限模式、MCP 服务、QQ 配置、服务凭据。
服务凭据的同名修改或删除（`add_credential` / `remove_credential`）在写入前单调
推进引用它的 QQ/Telegram 配置 `config_version`（详见下文「IM 审批」失效规则）：
旧连接、旧入站与旧批准失效，A→B→A 轮换不恢复旧代次；写入失败不恢复旧版本。

- **并发与修订**：模型配置以 `expected_revision`（models.json + auth.json +
  default-model.json + summary-model.json 的内容指纹）做条件更新；项目/会话/MCP/QQ 沿用各自的
  expected_version。冲突时要求重新加载，不静默覆盖。项目指令与 Web Search 共用
  `projects.settings_version`（v20 加列，旧项目初始版本 1，只保护这两项，不与
  MCP/Jev/会话默认各自的版本列合并）：保存经 `Store.updateProjectSettings` 在同一事务
  核对可选期望版本、更新同一行、递增同一版本并追加 `project.settings_changed` 事件
  （携带配置字段，不含指令正文或秘密）；不符 = `version_conflict`，不改配置、无事件；
  省略版本 = 旧入口兼容写入（同样递增并发事件——带版本客户端的随后保存会冲突，旧入口
  不能绕过冲突检测）；同值保存幂等（不递增、无事件）。`set_project_instructions` /
  `set_project_web_search` 接受可选 `expected_version`（v1 起正整数；0/负数/非整数
  = invalid_params）。任务 TUI 与配置中心都投影该事件刷新项目展示；配置中心冲突后先
  实际重读后台数据（不刷旧缓存）、再刷新当前分区。
- **项目分区（agent-direction issue 06）**：ruukoto-dev 的「项目」分区把工作区列在前
  （标注「工作区」并展示根目录），旧项目列在后（标注「旧项目」）；ruukoto 产品不分类。
  项目详情显示分类与根目录，指令、Web Search、Jev、MCP 与资料授权都在已选项目内完成：
  指令与 Web Search 保存携带读取时的设置版本；「MCP 服务」入口只列本项目服务、新增固定
  归属跳过项目选择（全局 MCP 分区复用同一页面与表单，新增仍按工作区/旧项目选择项目；
  进入归属不符的服务详情会提示并返回）。资料授权页标注出向/入向；新建方向固定为本
  项目 → 目标（目标按工作区/旧项目选择）；撤销按单条授权 ID，同范围（同来源/目标/类别）还有
  其他有效授权时，确认与结果都明示「不关闭该类访问」；「查看已撤销」为只读记录（含
  撤销时间）。
- **模型配置应用时机（§4）**：provider、模型目录与 API key 的修改只在没
  有受影响的 `running` / `awaiting_confirmation` / `queued` 任务时应用；
  检查到应用完成之间，受影响 provider 的新提交与会话模型设置被拒绝
  （`model_config_busy`，核实期间目录被重建同样拒绝，可重试）；后台内部
  提交（编排器唤醒/委派、入站事件、QQ）等本次应用结束后自动重试。
  占用时返回 `model_config_blocked` 与任务数，不先改文件、不部分应用、不
  自动取消任务。应用 = 校验 → 写文件（原子、0600）→ 重建 ModelRuntime /
  模型目录 / 审查器并同步到各会话驱动；任一步失败回滚文件并保持原配置。
  应用成功后持久配置与内存一致，重启后仍有效。删除 provider 或模型前核对后台
  默认、摘要模型、会话与 agent_roles 引用（`provider_in_use`）；后台默认模型保存为
  `<agentDir>/default-model.json`，显式启动参数 `--model` 优先于它。
- **摘要模型（issue 30）**：上下文压缩的滚动摘要所用模型，保存为
  `<agentDir>/summary-model.json`（`{provider, modelId}`，不存思考档位）；控制面
  `set_summary_model`（`provider`/`model_id`，同为 null 即清除，带
  `expected_revision`），`get_model_config` 返回 `summaryModel`；保存时核对模型
  在目录中。「模型与提供方」页头显示「摘要模型：未设置（用会话当前模型）」或所选
  模型，列表项「设置摘要模型」首项为「不设置」。设置后，main 与开发会话较早
  的对话（含工具结果）会发给该模型的提供方做摘要。每次摘要读取当前配置，不按任务
  钉版；已配置但无法解析时本次摘要按失败处理，不改用会话模型。
  `test_model_connection` 是显式网络探测，本地校验不代表模型服务可用。
- **秘密**：API key 输入遮蔽；响应只展示是否配置与必要元数据；秘密不进入
  日志、事件、命令行参数或重载状态文件。模型 API key（auth.json）与服务
  凭据（credentials.json）分开管理。
- **离线模式**：后台不可达时（或 `--offline`）进入有限离线配置：只做模型
  目录、默认模型、摘要模型与 API key 的初始化/修复，直接写 `<agentDir>` 下文件。
  互斥按规范化 agentDir 的配置锁（`<agentDir>/config.lock/`）判定：后台
  运行时持有该锁（不同 dataDir 共用 agentDir 也被覆盖），socket 不可达或
  认证失败不证明后台已停；无法取得独占时明确失败，不放宽权限、不改属主。

## 开发实例（issue 21）

`npm run dev [-- --tui | --config] [--import-models <目录>]` 启动隔离的
开发后台与可选界面，监听源码变更自动重启。开发实例是开发本项目的隔离环境，
运行的是默认产品 ruukoto，不是 ruukoto-dev 产品（新产品档案根为
`~/.ruukoto-dev-agent`，两者目录、锁与控制面互不相同）：

- **隔离 profile**：`~/.ruukoto-dev/<仓库名>-<路径哈希>/{data,agent,control,
  pending,logs}`，稳定复用、保留开发历史，位于代码目录外（QQ 等工作目录
  不落入保护根）。不继承生产 owner token、执行账户配置或消息平台凭据；
  QQ 适配器在 dev 下默认停用（`RUUKOTO_DISABLE_QQ=1`，每次启动生效）；
  真实模型须显式配置（`dev --config` 离线初始化，或 `--import-models` 从
  指定目录复制 models.json/auth.json，不共享可写的生产 agentDir）。
- **进程与重载**：dev 管理自己启动的整组进程；退出界面或 Ctrl+C、关闭
  终端都统一清理后台/界面/监听。同一开发实例已有后台时报错，不附加或
  停止外部进程。监听仅限 `src/` 源码：后台代码变更优雅重启后台（活动
  任务保留中断事实，不自动重放），任务界面自动重连，配置界面不重连、随
  后台一并重载并恢复所在分区；只改任务/配置界面代码时不重启后台；
  共享模块变更两者都重启。连续变更合并处理，旧进程退出并释放锁后才
  启动替代进程。
- **界面状态恢复**：dev 启动的任务界面把当前会话、未提交草稿与继续任务
  意图原子保存到 profile 的重载状态文件（0600；秘密表单值不写入，重载后
  重新输入）；重载后按数据实例标识核实恢复，记录无效时给出提示并按正常
  入口继续，不把继续任务草稿静默改为新任务提交。该记录只在本次 dev 启动
  内使用，新的一次独立 dev 命令遵循正常入口规则。
- **日志与终端**：后台日志写 `<profile>/logs/backend.log`，监听诊断写
  `dev.log`（无界面时打印到终端），不与界面输入/绘制串写。
- `dev --config` 缺少有效模型时先打开离线配置界面；保存有效配置并释放
  配置锁后启动开发后台，再切换为在线配置；放弃或保存失败不启动后台。

## 数据布局

档案根按产品分开：ruukoto 默认 `~/.ruukoto`（环境变量 `RUUKOTO_*_DIR`），
ruukoto-dev 默认 `~/.ruukoto-dev-agent`（环境变量 `RUUKOTO_DEV_*_DIR`），内容
结构一致；开发实例 `~/.ruukoto-dev/<仓库>-<哈希>/` 不属于任一产品。以下为单个
产品实例的布局（以 ruukoto 默认路径为例）：

```
<dataDir>/                     # 0700（RUUKOTO_DATA_DIR，默认 ~/.ruukoto/data）
├── ruukoto.db                 # node:sqlite 元数据（WAL，schema v21；
│                              #   meta 含实例标识、应用数据绑定、产品归属
│                              #   product.type——跨产品复用被拒绝）
│                              #   项目（含项目指令文件与 Web Search 开关、
│                              #   settings_version 并发保护）、会话
│                              #   （含 kind：dev/qq_group；workspace_project_id
│                              #   组织归属仅展示，资料身份仍是 project_id）、任务
│                              #   （accessMode/权限版本/授予路径）、确认请求
│                              #   （结构化范围/消费时间）、工具操作（宿主操作
│                              #   id + SDK 调用 id）、产物元数据、目录占用、
│                              #   幂等键、持久事件、跨项目资料授权、长期记忆
│                              #   当前版本与修订、历史条目位置索引、选择记录、
│                              #   MCP 服务配置、QQ 入口配置/群会话映射/收件登记/
│                              #   发送记录（qq_config/qq_sessions/qq_inbox/qq_outbox）、
│                              #   跨实例导入回执与条目账本（issue 21，
│                              #   instance_imports/instance_import_items）
├── ruukoto.db-wal / -shm
├── agent-data/main.db         # main 应用数据空间（issue 02，ADR 0009；独立库，
│                              #   实例 ID 登记在核心库 meta；丢失/身份不符即停止能力）
├── sessions/                  # pi JSONL 会话文件（消息历史唯一权威副本）
├── migration/<导入ID>/        # 跨实例导入记录（issue 21，0700）：
│                              #   target-before.db = 导入前目标库备份（整库恢复路径）
└── runtime.lock/              # 实例锁（mkdir 原子创建；owner.json 记录 pid）

<dataDir>/../qq-work/           # QQ 群会话专用空工作目录（每 账号_群 一个，0700）

<dataDir>/../control/          # 0770（RUUKOTO_CONTROL_DIR 可覆盖）
├── control.sock               # 控制面 Unix socket（0660）
└── owner.token                # 拥有者令牌（0600；部署时复制给拥有者 0400）

<dataDir>/artifacts/           # 0700；工具正文产物（<artifactId>.bin）

<agentDir>/                    # 0700（RUUKOTO_AGENT_DIR，默认 ~/.ruukoto/agent）
├── models.json                # 模型配置（显式指定，不读 ~/.pi/agent）
├── auth.json                  # 模型凭据（同上；配置中心在线/离线维护，0600）
├── default-model.json         # 后台默认模型（issue 21，0600；--model 启动参数优先）
├── credentials.json           # 服务凭据绑定（0600；审批注入用，值不展示）
├── skills/                    # 全局技能库（issue 22；拥有者维护，见「技能」）
└── config.lock/               # 配置独占锁（issue 21；后台运行期间持有，
                               #   离线配置据以互斥，语义同实例锁）

~/.ruukoto-dev-agent/          # ruukoto-dev 产品档案根（ADR 0017，0700）：
                               #   data/ agent/ control/ pending/

~/.ruukoto-dev/<仓库>-<哈希>/   # 开发实例 profile（npm run dev，0700）：
                               #   data/ agent/ control/ pending/ logs/
                               #   与日常实例完全隔离，不继承生产凭据与配置；
                               #   不是 ruukoto-dev 产品，新产品不会读写它
```

职责边界：pi JSONL 是消息历史的唯一权威副本；SQLite 只存元数据与事件；
产物正文在产物文件，SQLite 只存其元数据。三者没有跨文件事务，不得声称
原子提交。

任务状态机：`queued → running → awaiting_confirmation → running`；结束进入
`completed / failed / canceled / interrupted`。中断原因、取消意图与外部
效果是否确定分别记录。停止、崩溃或重启时，结果缺失的操作按工具操作账本
（架构工单 05）分三类：审批未消费（pending/stale/rejected，或 approved 未消费）
→ 已知未执行；只读工具 → 未完成且无写入效果；其余已开始、效果无法从已提交的
记录核实的操作 → `effect_unknown`，不重放。获批后复核或消费失败的批准标 stale，
不能再用，操作同样按已知未执行。效果以停止瞬间为准：中止期间才落下的结果不改
结论。

### 旧实例开发资料迁入（agent-direction issue 21，ADR 0022）

`ruukoto-dev legacy-import` 只在 **ruukoto-dev** 产品下可用（bin/ruukoto-dev.mjs），
把旧 ruukoto 实例（如 `~/.ruukoto/data` 或服务器实例的副本）中的开发资料迁入
Coding Agent 档案。目标侧离线执行：preview/apply/revert/list 都要求目标后台
已停止（CLI 持目标实例锁运行，不走控制面）；源实例全程只读——源后台存活
（或持锁身份无法核实）时拒绝，快照 = 把 `ruukoto.db` 及 WAL 侧车逐文件复制
到临时目录后在副本上迁移，源目录逐文件 sha256 不变。

```bash
ruukoto-dev legacy-import preview --from <源数据目录> [--plan 计划文件]
ruukoto-dev legacy-import apply --plan 计划文件 [--request-id <id>]
ruukoto-dev legacy-import revert <导入ID>
ruukoto-dev legacy-import list
```

流程：preview 列出源/目标实例、每个项目的会话归属（普通 dev/角色/群/子会话）、
根目录在本机的核实结果、历史状态、未终态任务及收尾方式、待处理审批、记忆
（可导入/待处理）、授权（导入/跨实例）、凭据绑定缺口、重名与 ID 冲突、
agentDir 差异（只列名称）与修订值；`--plan` 把修订与源实例写回计划文件。
拥有者在计划文件中修改 `renames`（重名项目改名）与 `personal_memories`
（显式选中发布的个人记忆），apply 先查回执/核修订（源或目标变化即
`revision_conflict`），再备份目标库 `<dataDir>/migration/<导入ID>/target-before.db`
（VACUUM INTO，回执记录 sha256），复制文件后单事务入库并写回执与条目账本；
中断后用同一计划重跑即可，同键重放返回原回执。

导入范围（allow-list，行 ID 原样保留）：源项目内的普通 dev 会话及其任务、
工具操作、审批、产物、选择记录、压缩点、事件与 SubAgent 一层（子会话以
关闭状态登记）；项目配置（指令/Web Search）、范围内记忆、双端都在导入
范围的资料授权、MCP 与 Jev 配置（缺凭据绑定时以停用导入，由拥有者重新
绑定）。不导入：角色绑定会话、QQ 群会话与 main 资料、inbound/调度/通知/
长期授权/平台配置、历史索引（派生，重建）、目录占用、agentDir 全部配置
与凭据。未终态任务收尾为 canceled/interrupted（migration），结果未登记且
可能已开始执行的工具操作与任务置 effect_unknown（审批未消费挡住的操作属
已知未执行）；未消费审批 stale；`full_access` 会话默认降为 confirm；queued
会话不在目标入队——导入不调用模型、不重放外发。

恢复与回退：`revert` 按账本删除导入的行、事件区间与经 sha256 核对的复制
文件（导入后目标侧的自有活动——导入的会话/项目/记忆有新任务、新事件、
新会话、新授权、组织引用或新版本——逐项列出并拒绝回退）。回执永久保留
（applied/reverted），`list` 可核实。整库恢复为手工路径：停止 ruukoto-dev
后台，用备份替换数据库后重启：

```bash
ruukoto-dev stop  # 确认后台已停止
cp <dataDir>/migration/<导入ID>/target-before.db <dataDir>/ruukoto.db
rm -f <dataDir>/ruukoto.db-wal <dataDir>/ruukoto.db-shm
# 复制的 JSONL 与产物正文如需一并移除，按回执 report.files 逐项删除
```

任何路径都不删除或修改源资料；导入不做增量同步（源侧新增只在报告列出，
可再次导入）。

### 旧实例个人资料迁入（agent-direction issue 22，ADR 0023）

`ruukoto legacy-import` 只在 **ruukoto** 产品下可用（bin/ruukoto.mjs），把旧
ruukoto 实例（如 `~/.ruukoto/data` 或 tx 服务器实例的副本）中的个人资料迁入
**全新** ruukoto 实例——main 会话、应用数据、调度、平台绑定与必要凭据；旧
coding/chat 档案与发送事实随迁为只读归档。离线语义与开发方向相同：preview/
apply/revert/list 都要求目标后台已停止（CLI 持目标实例锁），源全程只读
（`ruukoto.db` 与 `agent-data/main.db` 均逐文件复制到快照后读取）。目标必须
未初始化：目标后台启动过（有自有角色行与 main 会话）即拒绝；源或目标后台
存活、同一路径、同一实例 ID 也都拒绝。

```bash
ruukoto legacy-import preview --from <源数据目录> [--plan 计划文件]
ruukoto legacy-import apply --plan 计划文件 [--request-id <id>]
ruukoto legacy-import revert <导入ID>
ruukoto legacy-import list
```

preview 列出**交接清单**（平台配置含 config_version 与 telegram 偏移、活动
调度、生效中的长期授权）、应用数据与绑定核对、会话归属（main/coding/chat/
群/SubAgent/dev 排除）、各项收尾计数（任务、审批、发送、入站、运行）、
记忆与授权分类、MCP/Jev 停用项、凭据动作（copy/skip/conflict）、归档计数、
冲突与修订值；`--plan` 写回绑定字段后由 apply 核验（`revision_conflict` 时
重新 preview）。

导入范围（allow-list，行 ID 原样保留）：main/coding/chat 角色行及其项目与
会话（角色工作目录在目标 `<dataDir>/../agent-work/<角色>` 重建并取目标身份，
角色会话 cwd 随之改写）、QQ 群会话与群归档四表（`qq_sessions`/`qq_inbox`/
`qq_outbox`/`chat_result_acceptances`）、这些会话的任务/工具操作/审批/产物/
选择记录/压缩点/事件、main 的一层 SubAgent 与工作委托（以关闭状态登记）、
内全部 `inbound_events`、`schedules`/`schedule_runs`、`notification_ops`、
`standing_permissions`、`qq_config`/`telegram_config`（含 `last_update_id`）、
GitHub 归档三表与 `github-archive-manifest.json`（v9 前遗留表在全新目标按快照
DDL 重建）、`agent-data/main.db`（+WAL，经 sha256 核对复制）与 meta
`app_data.main_instance_id`/`github_retirement_done`、可核验来源的 main 项目与
personal 记忆（同产品延续，不做计划选中；引用 dev 会话的记忆列待处理，正文
留源实例）、两端都导入的资料授权、导入项目的 MCP 与 Jev 配置（缺凭据以停用
导入）。**必要凭据**：平台配置引用的绑定与 purpose `github_webhook` 的绑定从
源 credentials.json 合并进目标（同名同值跳过、异值拒绝，报告只记 sha256）；
MCP/Jev 凭据不复制。排除：普通 dev 会话及其 SubAgent 与项目（经 issue 21 迁入
Coding Agent）、历史索引两表（派生重建）、目录占用、导入账本自身、模型目录
与 API key（配置中心负责）；普通 dev 项目的记忆与授权按来源规则不进目标。

不重放收尾（与运行时恢复同口径）：queued 任务 canceled、running/
awaiting_confirmation interrupted（结果未登记且可能已开始的操作与任务置
effect_unknown）、未消费审批 stale；未关闭调度运行置 `closed_at`；发送账本
pending→canceled（error_kind=migration，已知未发送不当作新请求重发）、
sending→effect_unknown；入站 registered/queued→failed；SubAgent 关闭登记；
main 会话访问模式原样保留（同产品延续，不降级）。

**执行归属交接与旧实例停用**：apply 完成后，平台连接与调度的执行归属移到
目标——目标以导入的 telegram `last_update_id` 继续消费（入站去重表随行，
不看旧事件）、活动调度在目标按恢复语义各触发一次（旧 pending 发送已取消，
不产生双发）、长期授权在同机同入口身份下继续有效（不符即在使用侧 fail-
closed）。**拥有者务必在 apply 后停止并退役旧实例：不得再启动旧后台消费
平台入站或调度**，否则两端会各自轮询同一 bot、独立触发同一批通知——这是
一次性切换，导入工具不改源实例一字。GitHub webhook 监听地址为启动参数
（`--github-webhook-config`），需要在目标启动时重新给出（凭据绑定已随迁）；
GitHub 侧 webhook URL 指向新地址属拥有者的平台外操作。

恢复与回退：幂等与备份机制与开发方向一致。`revert` 按账本删除导入行、
事件区间与经 sha256 核对的复制文件（含 `agent-data/main.db`），并按回执摘除
导入的凭据绑定。回退阻挡项逐项列出：导入的会话/项目/记忆有新任务、新事件、
新会话、新授权或新版本；目标启动后有新入站事件、新发送操作、新调度/运行、
新长期授权；导入行被目标运行时改写（已发送、已 advance、已消费偏移、撤回
标记更新，经回执 manifest 逐行 sha256 核对）；应用数据文件被写；导入凭据被
轮换。即：切换期间新增的执行及发送事实是目标侧事实，不能抹掉，回退只在一
切未发生时整体移除。导入写入的产品归属（meta `product.type`）与目标备份
不随回退移除——回退回到"已登记 ruukoto 的空实例"，与开发方向一致。整库
恢复为手工路径（替换 `target-before.db`），仅在回退路径不可用且确认无切换
后事实时使用——恢复出的旧库不重演备份后的任何发送与调度（备份时刻全部
未定终态已按迁移规则落定）。

```bash
ruukoto stop  # 确认后台已停止
cp <dataDir>/migration/<导入ID>/target-before.db <dataDir>/ruukoto.db
rm -f <dataDir>/ruukoto.db-wal <dataDir>/ruukoto.db-shm <dataDir>/agent-data/main.db*
# 复制的 JSONL/产物/归档文件需一并移除时，按回执 report.files 逐项删除；
# 凭据摘除按回执 report.credentials 逐项核对
```

演练参见 `.scratch/agent-direction/smoke-22-migrate-personal-instance.mts`
（真实 bin 双实例 + telegram stub 证实偏移连续与一次触发）；验证记录区分
模拟模型与真实进程，见工单 22。

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
  指令、参考块（项目指令、技能目录、继续来源任务要求、计划说明）、按记忆预算选入的
  长期记忆、当前任务输入、最新完成的工具批次；历史按完整交互（一轮用户+助手+工具消息）
  为单元由近及远纳入，toolCall/toolResult 不可拆分。
- 参考块（架构工单 02）：块文本由各自来源产出——技能目录在 `skills.ts`、计划说明在
  `plan-mode.ts`，项目指令与继续来源在组装（`src/agent/context-assembly.ts`）紧挨钉版
  读取；选择器收统一的 `references` 输入（分类、位置、文本），只管位置、预算与记账。
  长期记忆有单独预算，记忆块照旧由选择器生成；项目指令与技能库的版本由组装写入选择
  记录。分类登记在选择器的分类表（`/context` 分类与估算键共用），必留内容超预算时，
  失败说明按该表逐项列出各分类的估算与合计。
- 视图顺序（issue 29）：项目指令 / 技能目录 / 长期记忆 → 历史 → 继续来源 / 计划说明
  → 当前任务。前缀消息只有前三类（块头不含版本，记忆按任务钉版）；继续来源与计划
  说明只属于当前任务，插在当前任务输入之前，不打断其前的历史。记忆没有变化、没有
  继续来源与计划说明、历史未移出且 Jev 关闭时，同一会话连续调用中前一次的消息序列
  是后一次的前缀，提示缓存覆盖整段历史。`/context` 分类与估算口径不变。
- 系统提示（issue 24）：由宿主按会话类别固定为三份之一（`SYSTEM_PROMPTS`，
  `src/agent/session-factory.ts`）——普通开发会话、main、SubAgent（含 GitHub
  评审 SubAgent；coding/chat 提示随角色退役删除，agent-direction issue 23）；pi 只在末尾追加
  `Current working directory: <cwd>`，不输出默认模板的工具段、guidelines 与
  pi 文档路径。装配时显式传入 `systemPrompt` 与空 `appendSystemPrompt`，
  pi 不查找也不读取工作区 `.pi/` 与 agentDir 下的 `SYSTEM.md` /
  `APPEND_SYSTEM.md`；拥有者没有自定义附加提示的入口。「参考资料与当前要求
  冲突时以当前要求为准、不能改变访问模式与权限」统一写在系统提示里，参考块与
  技能正文的块头只保留名称、id、类别与范围：`[项目指令]`、`[技能目录]`、
  `[技能 <名称> · 版本 … · …]`、`[继续来源：本任务继续已中断任务 <id>；其原始要求如下]`、
  `[长期记忆 <id> v<N> · <类别> · <范围>]`。MCP、web_search 结果与新闻快照的
  外部资料警示逐条保留。
- 项目指令：拥有者显式配置的工作区相对路径（`ruukoto project
  set-instructions <项目id> <文件...>`）。基准目录取
  `project.rootDir?.cwdReal ?? session.cwdReal`（工作区组织归属
  `workspace_project_id` 只决定展示，不参与基准与配置来源判定）：带根目录
  归属的工作区读取前按
  realpath/dev/ino 核实根目录身份（`verifyDirIdentitySync` 同步变体），根目录
  失效或被替换时拒绝读取替代目录并给出明确说明（不退回会话子目录）；无根目录
  归属的旧项目行为不变（按会话目录解析）。任务开始时从基准目录经受限读取钉版
  （realpath 后必须仍在基准目录内；缺失/不可读/超大分别说明，不取祖先目录
  文件）；内容捕获为任务产物，版本 = 内容哈希 + 产物 id，任务内固定，只写入
  选择记录，下一任务重新读取即为刷新入口。指令作为带标记的参考消息注入一次，
  不能变更控制面身份、审批规则或权限模式（说明在系统提示中）。
- 当前任务的工具循环按已完成批次取最近部分：任务输入与最新批次必留，
  更早批次由近及远在预算内纳入；连必留项都装不下时才以
  `context_budget_exceeded` 中断。当前任务最近一次成功 `todo_write` 所在
  批次与最新批次同级必留（见「工作清单」）。
- 人工继续已中断任务（`continue`）时，原任务要求作为带任务 id 的必留
  参考消息注入，不会只发一句"继续"就丢失原要求。
- 崩溃恢复可能留下缺配对的消息（工具已产生副作用、结果未落盘时进程被杀）：
  选择器先把这类孤儿 toolCall/toolResult 从模型视图剔除（历史原文不动，
  选择记录以 `unpaired_tool_call:<id>` 记为排除原因），最终检查对剔除的
  id 豁免配对核对；其余配对残缺仍拒绝发送。
- 超长工具结果只在模型视图中替换为有界节选（首尾保留 + 中间省略计数 +
  `history_read`/`read_artifact` 引用），历史与产物原文不变；被替换的
  片段范围记入选择记录 `capped_tool_results`。单个文本段上限 80,000 字符，
  能容纳 pi read/bash 的 50KB 输出与 64KB 单页（`read_artifact` 单次上限
  64KB、`history_read` 单页）加头部，只兜底 `http_request`、
  `request_file_access` 等真正超大的结果。上限只取决于消息本身、不按位置
  区分：同一条消息的视图不随后续调用变化，不破坏提示缓存。
- 预算 = 模型 contextWindow − maxTokens（输出）− thinking 预算 − 下一批
  工具结果预留 − 估算安全边际；估算用 pi `estimateTokens`（chars/4）加
  CJK 校准（每 CJK 字符按 1 token 计）× 校准系数 1.5。选择记录的配置
  版本 = 生效预算配置的 FNV-1a 哈希，配置变化即变化。
- 硬性发送前检查：pi 0.85.1 的 `context` 钩子异常被捕获后继续运行，因此
  选择结果不落库为"待发送"就拒绝发送——宿主包装 `streamFunction`，在委托
  前校验选择记录存在、toolCall/toolResult 配对、预算充足，然后先落
  选择记录再发请求；必须项超过预算时任务以 `interrupted`
  （`context_budget_exceeded`）结束并暂停队列，不做静默摘要或丢弃。选择
  过程中的其他失败（记忆读取、压缩点落盘等）记为 `context_selection_failed`，
  同样中断并暂停队列，只是原因分开显示。
- provider 返回 `context_overflow` 的兜底保留：任务中断并暂停队列，不自动
  压缩或重试。

### 上下文压缩（issue 30，ADR 0016）

- **适用范围**：普通开发会话、main 与 coding（含 GitHub 评审子任务）。资料受限会话
  （qq_group 与 chat 角色）不压缩，维持现状（也不加移出标记）。会话历史（JSONL）
  不变，有损处理只作用于模型上下文；不启用 pi 的 compaction。
- **压缩点**：表 `context_checkpoints`，每个会话至多一行 `active`（部分唯一索引），
  新建时旧行在同一事务里改为 `superseded`。S（`summarized_count`）= 分支前 S 条
  由摘要替代；C（`cleared_count`，≥ S）= [S, C) 的大工具结果换成占位说明；二者
  只落在单元边界（完整交互开头或当前任务已完成批次的开头）。另存摘要正文与
  `summary_until`（第 S 条消息的 UTC 时间）、`cleared_refs`（toolCallId → 条目
  id）、摘要模型与状态（`ok | failed | none`）及原因、提示版本 `compaction-v1`、
  usage、估算前后与建立它的任务及调用序号。
- **指纹**：`fingerprint` = 前 C 条消息的角色、时间戳与工具调用 id 的 SHA-256。
  每次调用读取生效压缩点并核对；消息少于 C 条或指纹不符时改为 `invalidated`，
  按无压缩点处理。选择器把压缩点当作输入：同一压缩点加同一组消息得到同一视图，
  两次压缩之间视图前缀不变，提示缓存只在每次压缩时失效一次。后台重启后压缩点
  继续生效，不重新摘要。
- **水位**：H' = min(高水位, 输入预算)，高水位 200,000 估算 token
  （`SelectorBudgetConfig.compactionHighWater`，计入配置版本）；低水位 0.5 H'、
  保护尾部 0.15 H'、最小收益 0.2 H'，都用选择器的估算口径。按生效压缩点选择后，
  不做预算移出时的视图估算超过 H' 才规划新压缩点。
- **规划**：保护尾部 = 由新到旧累计到 0.15 H' 的完整单元（至少含最新批次）；必留
  单元（清单保底批次）与保护尾部不进覆盖范围。先把 C 推到保护尾部开头（第一层），
  估算仍高于低水位时推进 S（第二层），取能压到低水位的最小单元边界。估算降幅
  （摘要块按约 4,000 字的上限计）不到 0.2 H' 时不建压缩点，也不调用摘要模型。
- **第一层（清理）**：[S, C) 中正文超过 2,000 字符或含图片的工具结果整条换成
  `[已清理 · <工具名> · 原 <N> 字符 · 成功|失败 · history_read session_id=<会话> entry_id=<条目>]`
  （条目 id 在建压缩点时解析一次会话文件得到；查不到时改为「原文需重新执行工具获取」）。
  toolCallId 与 isError 不变；`skill`、`todo_write` 结果、toolCall 参数与
  assistant 文本不清理。
- **第二层（滚动摘要）**：输入为上一版摘要加 [旧 S, 新 S) 的原消息，调用 pi 的
  `generateSummaryWithUsage`（结构化格式，工具结果截到 2,000 字符）；提示要求用中文、
  保留路径/命令/函数名/错误原文、把拥有者的要求与决定写入 Constraints & Preferences
  与 Key Decisions、区分拥有者原话与资料中的指令、全文约 4,000 字以内。模型：配置了
  摘要模型就用它，否则用任务记录的模型选择；经 `modelCatalog.resolve` +
  `modelRuntime.streamSimple` 调用（不经最终检查包装），不带思考参数、单次尝试、
  超时 180 s、输出上限 16,384 token，触顶按失败处理。覆盖段估算超过摘要模型输入
  预算时按失败处理（接入小窗口摘要模型时改为分块滚动）。停止任务时与 Jev 一起中止
  摘要请求；等待结束后任务已停止或已切换就不发主模型请求，否则重新读取选择输入。
- **视图顺序**：前缀参考块 → `[压缩摘要 · 较早的 <S> 条消息 · 至 <summary_until>]`
  摘要块 → 移出标记（如有）→ [S, n) 的历史（[S, C) 按第一层清理）→ 继续来源 /
  计划说明 → 当前任务输入 → 当前任务批次。S 伸进当前任务时，任务输入原样排在
  摘要块之后。Jev 只对 [S, n) 内的单元做取舍。
- **兜底与失败**：压缩后仍超输入预算时沿用由近及远纳入，装不下的更早单元移出，
  视图加一条 `[较早的 <N> 轮交互未进入本次上下文 · <起> 至 <止>]`。摘要失败（报错、
  超时、触顶、输入超限、摘要模型不可用）只保留第一层（仍按最小收益判断是否建压缩点），
  `summary_status = failed` 并记下原因；本任务内视图估算比失败时再增长 0.2 H' 之前
  不再尝试摘要（冷却只在内存，重启后可再试）。必留内容超预算
  （`context_budget_exceeded`）与 provider 的 `context_overflow` 仍按原规则中断。
- **事件与展示**：`task.context_compaction` 开始调用摘要模型时一条（phase
  `started`），压缩点落盘时一条（phase `finished`，与压缩点同一事务；摘要失败且清理
  收益不足时 `checkpointId` 为 null）。TUI 事件流显示「正在压缩上下文…」与
  「上下文已压缩：清理 N 条结果、摘要 M 条消息，估算 A → B」，摘要失败时写明只做了
  清理及原因。`/context` 分解多「压缩摘要」一类，并显示压缩点（摘要替代条数与截至
  时间、清理条数、建立它的任务与调用序号、摘要模型或失败原因）。系统提示共同段说明
  三种标记的含义与找回原文的方法。
- **部署后核对**：按天统计压缩次数与估算降幅（issue 30 的 SQL）；若模型频繁用
  `history_read` 读回被清理的结果，说明清理过狠，调高清理阈值或保护尾部。

### 技能（issue 22）

- 技能库固定为 `<agentDir>/skills/`（本机 `~/.ruukoto/agent/skills/`，服务器
  `/var/lib/ruukoto/agent/skills/`），无配置项；开发实例使用自身 profile 下的
  `agent/skills/`，不继承日常实例。格式为 Agent Skills：含 `SKILL.md` 的目录即
  一个技能，整包复制的嵌套目录照常扫描，跟随符号链接；只使用 `name`、
  `description`、`disable-model-invocation`，`allowed-tools` 等其他字段不生效。
- 服务器维护：`sudo cp -r <技能目录> /var/lib/ruukoto/agent/skills/`，并保持
  后台账户可读；修改从下一任务生效，无需重启。
- 钉版：任务开始时（与项目指令同一时点）读取技能库，目录与全部 `SKILL.md`
  正文钉在内存，本任务内的 `skill` 加载与 `/skill` 展开都用这份；版本 = 钉版
  内容的 sha256，写入选择记录 `skillVersion`。
- 上下文：main 与普通开发会话注入「技能目录」参考消息（只含名称与
  描述，不含主机路径与 `disable-model-invocation` 技能），计入固定预算，超
  预算按 `context_budget_exceeded` 中断，不截断；`/context` 显示「技能」类别。
  SubAgent（含 GitHub 评审）不注入目录、不装配 `skill`。
- `skill` 宿主工具（只读，任何访问模式都不产生审批）：只传 `name` 返回钉版
  正文与版本（仅显式调用的技能被拒绝）；再传 `path` 读取该技能目录内的引用
  文件——相对路径、不含 `..`、realpath 仍在技能目录内、普通 UTF-8 文本，调用
  时读取（不钉版）并附文件 sha256。`skill` 结果不做视图上限截取。
- 单个 `SKILL.md` 或引用文件上限 64 KiB；超限的技能不进入技能库。缺少描述、
  YAML 错误、同名冲突（按路径排序先到先得）等诊断经 `/skills` 查看。
- 显式调用：TUI `/skill <名称> [参数]` 提交输入为 `/skill:<名称> [参数]` 的任务，
  不回显命令行（CLI `ruukoto submit … "/skill:<名称> …"` 同一路径，沿用 `request_id` 去重）；
  任务开始时展开为带技能名与版本的正文块加参数，作为用户消息进入历史。不受
  `disable-model-invocation` 限制；未知名称使任务失败并列出可用技能。
  Telegram/QQ 私聊不识别 `/skill:`。
- 技能是拥有者提供的参考内容，不增加工具或权限；其中的脚本只作为文本返回，
  不原地执行（工具镜像无 Python，默认无网络）。

### 工作清单（issue 25）

- `todo_write` 宿主工具：参数 `todos` 为 `{ content, status }` 数组，`status` 取
  `pending | in_progress | completed`，不设 ID 或其他字段。每次调用提交整张
  清单并整体替换，空数组清空；结果只返回一句摘要（如「已更新：完成 3/7」）。
- 校验：最多 20 项；`content` 去除首尾空白后非空，原文不超过 120 字符；
  `status` 只能取上述三值。不满足时返回明确错误，不截断，当前清单不变。
  不接受额外字段。上限低于控制面参数下发的截取阈值（8 KiB 内联；超出时
  预览仍保留 32 项、每串 256 字符），TUI 总能拿到完整清单。
- 用法写在工具描述中（3 步以上的工作才使用、同时只标一项进行中、完成一项
  立即更新），不改系统提示、不做定期提醒；「只有一项进行中」不校验。
- 适用会话：与编码工具同一条件装配——普通开发会话；main 与 SubAgent 不装配。
  无副作用：任何访问模式都不产生审批。
- 清单跟随会话：会话中最近一次成功调用的参数即当前清单，跨任务延续；校验
  失败的调用不改变清单；新会话没有清单。不建表、不另存文件，会话历史与
  工具记录是唯一来源。
- 上下文保底：当前任务最近一次成功 `todo_write` 所在的工具批次与最新批次
  同级必留，不作 Jev 候选，token 计入 `/context` 的「当前任务」。以往任务
  仍按整轮保留或移出，不单独保底：上一任务整轮被移出时模型看不到旧清单，
  需要时自行重写。不做每次调用注入（清单一改就会让其后整段历史的提示缓存
  失效）。

### 计划模式（issue 26）

- 提交：TUI `/plan <内容>` 把整行作为任务输入提交（CLI `ruukoto submit … "/plan …"`
  同一路径，沿用 `request_id` 去重）；不带内容只显示用法。标记规则：任务输入以
  `/plan` 加空白开头且其后有内容。不加会话状态，不改控制协议与表结构。
- 适用会话：只限普通开发会话。角色会话（main，以及已退役的 coding/chat 归档）与 QQ 群会话提交
  带标记的输入返回 `invalid_params`，不创建任务；Telegram/QQ 私聊正文经编排器
  包装为 `[入站事件]…`，不会被识别。
- 判定：任务开始时钉版——输入带标记，或经 `continue` 逐级继续的原任务带标记。
  以计划模式运行的任务中断后，继续时仍按计划模式运行。
- 上下文：任务输入照原样保存、显示与发给模型；计划说明（只调研、不修改；bash 只
  运行只读命令；最终回答给出计划）作为宿主固定的参考消息，与继续来源一起插在
  当前任务输入之前（不是前缀消息），只在计划模式中出现，`/context` 显示「计划
  模式」类别。回答格式自由，宿主
  不解析步骤；进度交给工作清单。
- 工具白名单（与 GitHub 评审的按任务收窄组合，在激活、发送前与调用时三处检查）：
  `read`、`bash`、`request_file_access`、`http_request`、`read_artifact`、
  `history_search`、`history_read`、`memory_list`、`memory_read`、`web_search`、
  `todo_write`、`skill` 与类别为只读的 MCP 工具。`edit`、`write`、`memory_save`、
  `memory_revoke` 与非只读 MCP 工具不可用；今后新增的工具默认不可用。
- 不是安全边界：bash 保留，只靠计划说明约束，仍可能写入工作区（需要硬保证时改为
  容器只读挂载或去掉 bash）。`request_file_access`、`http_request` 的审批与普通任务
  一致，逐次审批不变。访问模式不变（提交时的会话默认或显式模式），计划模式只
  收窄工具，不扩大授权。
- 执行：计划完成后拥有者的下一条普通消息即按计划执行，工具集恢复、没有计划说明。
  批准计划不等于审批其中的操作：执行任务仍按访问模式逐次审批。
- TUI：以计划模式运行的任务在底栏访问模式旁显示「计划」（继续的任务按原任务输入
  判定）。输入或原任务不在本地时不标注：其他客户端（如 CLI）提交的任务在重新同步
  或 `/status` 前不标注。

### Jev 上下文筛选实验（issue 08）

实验按项目配置，默认关闭。先通过服务凭据入口登记 TypeSafe API key，再在
`ruukoto config` → 项目 → 选择项目 → Jev 上下文筛选实验中选择凭据引用并启用：

```sh
ruukoto credentials add --name jev-myproject --host api.typesafe.ai \
  --header authorization --purpose jev_context --secret-env JEV_API_KEY
```

`JEV_API_KEY` 由拥有者的可信环境提供，值为原始 key，宿主发送时添加 `Bearer`。
每个 Jev 凭据只绑定一个项目，普通 `http_request` 不可借用。缺少有效凭据时
不发送请求；QQ 群聊和 chat 角色项目不开放本实验。配置控制面为
`get_project_jev` / `set_project_jev`；写入需提供 `project_id`、完整的
`enabled` / `credential` 和 `expected_version`，并发旧版本保存会失败。

启用从下一任务生效；停用阻止后续 Jev 请求并丢弃迟到结果，已经发送的内容
无法撤回。启用后，当前任务及有界的候选历史文本会发送给 TypeSafe。普通账号
没有已确认的零保留保证；拥有者应先核实账户访问资格、credits 与自身的数据处理
要求。公开 API 与条款的核实记录见
[Jev 接入前核实](../.scratch/personal-agent/jev-research.md)。

首版固定使用 `jev-1.13.0`，筛选只影响当次模型上下文。宿主仍保留当前任务、
项目指令、继续来源和最新工具批次，按完整交互及预算组装输入；不修改或删除
会话历史和长期记忆。无效回答、超时或服务失败回退 `deterministic-v1`，不自动
重试；基础规则也无法满足预算时仍中断任务。拥有者取消任务会中止在途请求，
不会在回退后继续发送主模型请求。

当前阈值为 0.5，单次超时 2 秒；最多评估 24 个候选，当前任务和每个候选文本
分别限 8 KiB，整个请求限 24 KiB，响应限 64 KiB。不能完整表示为允许文本或
超过限额的候选沿用基础规则。这些是保守请求界限，不是官方 tokenizer 的精确计数。

离线回放与真实效果测量分别记录在
[Jev 固定历史对比](../.scratch/personal-agent/jev-comparison.md)。预设响应只验证
接入行为；真实质量、延迟、费用及主模型缓存影响须在拥有者实际启用后测量，
本实验不会自动切换为所有项目的默认策略。

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
- 按任务钉版（issue 29）：任务开始时钉住当时生效记忆的 id 与顺序（项目优先 →
  更新时间倒序；资料受限会话为空），每次调用只对这些 id 重读当前内容并按钉住的
  顺序排列：已撤销或来源失效的下一次调用即剔除，拥有者中途修订的按新版本注入，
  任务中新建的记忆（含 `memory_save`）从下一任务起注入。钉版读取失败时每次调用
  都阻断发送。

### 选择记录（§6）

- 每次模型调用前落一条 `selection_records`：任务/会话、调用序号、策略与
  配置版本（预算配置哈希）、模型、项目指令来源版本、纳入/排除的消息索引
  与原因、纳入/排除的记忆 id+版本、被有界替换的工具结果片段范围、各项
  估算与预算、本次视图使用的压缩点 `checkpoint_id`（issue 30；旧记录为空，被摘要
  与清理的消息序号不逐条记入，估算明细含 `compactionSummary`）；发送后回填实际
  provider usage。记录失败即阻断发送。
- 排除原因只记录索引与类别，不含其他项目的标题/片段。
- 拥有者入口：`ruukoto selection-records --task <id> | --session <id>`；
  TUI `/context` 查看当前会话最近一轮的预算组成与排除原因。
- Jev 实验在同条记录的 `experiment` 中保存状态、请求与响应模型、配置版本、
  阈值、候选索引及概率、基础规则的选入索引、耗时、是否发出请求、Jev 用量、
  估算费用和回退原因，不保存候选正文或凭据。旧记录和默认关闭的调用为 null。
  `/context` 展示当前调用的实验结果；主模型尚未发送的尝试通过
  `task.context_experiment` 事件保留任务及会话归属。
- 主模型 usage 可保留 provider 提供的缓存读写用量及费用。Jev 费用按记录中的
  单价和日期估算，单独列出；缺失用量表示未知，不能解释为零费用，也不能仅按
  输入 token 的变化声称净成本下降。

## main 应用数据空间（issue 02，ADR 0009）

main 角色按需声明的个人结构化数据（待办、提醒、习惯等）保存在独立的
`<dataDir>/agent-data/main.db`，与核心 `ruukoto.db` 分离；核心任务、审批、
事件与凭据表不对应用数据工具开放。

- **工具**：`app_data_define_table / migrate / query / insert / update / delete`，
  仅 main 角色会话装配（只有 main 的工具类别清单含 `app_data`，装配、发送前检查
  与调用门共用同一结论，见「架构要点」的工具可用性；执行入口每次重新核实宿主
  任务/会话/项目与 main 绑定）。
  coding/chat/QQ 会话与普通开发会话不获得这些工具；资料授权、grantedPaths
  与完全访问模式不扩大应用数据 API 范围。
- **校验在存储边界**：名称限 `[a-z][a-z0-9_]{0,47}`（拒绝 `sqlite_`/`app_`
  前缀与 `_id`/`_version` 保留名）；字段类型限 text/integer/real/boolean/
  json/datetime；整数限安全整数、浮点须有限、datetime 统一 UTC ISO、JSON
  受字节与嵌套限制。每表固定宿主维护的 `_id`（单调不复用）与 `_version`；
  关系只能指向同空间已登记表的 `_id`，外键固定 RESTRICT。上限：64 表、
  每表 32 字段/8 索引/10,000 行、单字段 16 KiB、单行 32 KiB、单次写入
  64 KiB/100 行/16 迁移步、理由 1 KiB（宿主常量，模型不可调大）。
- **版本与审计**：存储格式版本（宿主）独立于 main 管理的 `schema_version`
  与每次变更递增的 `revision`。所有写入在单事务内提交业务变更、版本递增
  与追加审计回执（`hostOpId` 唯一：同参重放返回原结果，异参冲突）；审计/
  约束/磁盘失败回滚业务变更。版本不一致返回可识别冲突与当前版本，不自动
  覆盖。
- **破坏性确认**：删表、删字段、删唯一索引、多行写与批量重写进入统一审批
  （`ApprovalScope.kind = app_data_change` 固定应用库身份、任务与操作 ID、
  表与类别、schema/revision、参数摘要、行 ID 与行版本）；批准后重核身份与
  版本、单次消费、按不可变快照执行。完全访问模式不免除此确认（ADR 0003 的
  特定例外）；auto-review 对此范围直接转拥有者。
- **有界查询**：主键游标分页，不开放任意 SQL/JOIN/聚合；AND 条件限标量
  比较/空值检查/有限集合匹配。默认 50 行/硬上限 100 行/64 KiB 结果，单次
  最多扫描 1,000 候选行/1 MiB；游标绑定表、参数摘要与版本，跨页变化返回
  游标冲突。每次查询启动固定入口的只读子进程（总时限 2 秒，超时 SIGKILL
  并等待退出）；写事务全部留在宿主。
- **恢复**：启动恢复在通用未知效果判断之前按应用库回执核实未落结果的
  应用数据写操作——有回执补记已提交、可核实无回执记未提交、应用库丢失/
  损坏/身份不符保留 `effect_unknown` 并停止能力（`app_data.unavailable`
  事件，不自动重建、不覆盖既有实例绑定）。重启与停止只补记结果与事件，不自动
  重放修改；应用库无法核实时保留效果未知（审批未消费的写操作仍记已知未执行）。拒绝与超时留 `app_data.rejected` 事件（只记来源/类别/错误码）。
- **分工**：偏好、约定、决策、经验仍进入长期记忆（MemoryStore）；应用记录
  不自动提升为长期记忆或控制指令。

## 调度器与通知 outbox（issue 03，ADR 0010）

单进程 SQLite 调度器，核心 `ruukoto.db` 新增三张运行时基础设施表（schema
v13）：`schedules`（计划）、`schedule_runs`（调度运行）、`notification_ops`
（发送操作账本）。它们不是 main 的业务表，应用数据工具不可达；内存定时器
只负责唤醒扫描，规则、下次时间、运行与发送状态以数据库为准。

- **规则**：一次性（必须带 `Z` 或显式偏移）/ 每日 `HH:mm` / 每周 ISO 星期
  1–7，IANA 时区，按当地日期 + 原定钟点重新构造（不做 24h/7d 相加）。DST
  固定 `compatible`：不存在的当地时间顺延（纽约 02:30 → 03:30，次日回到
  02:30），重复时间只取较早一次。时区/DST 算法由 `@js-temporal/polyfill`
  （锁定 0.5.1，只在 `src/scheduler/time.ts` 使用）提供；计划记录计算时的
  Node/ICU/tz 版本，已登记运行的时刻与键不改写。
- **动作**：`wake_main` 登记 `source=scheduler`、`external_id=<运行 ID>` 的
  入站事件，经编排器建 main 任务（宿主固定 `confirm` 模式，正文不能设权限，
  唤醒任务不继承外发授权）；`notify` 把已批准的固定正文登记为发送操作，
  不为每次提醒启动模型。
- **到期**：扫描间隔 1s、每批 50、每轮最多 20 批、活跃计划上限 1,000。
  一次短事务内核对计划、创建或合并运行、推进下次时间并登记事件/操作；
  `(schedule_id, version, scheduled_for)` 唯一、每计划最多一个未关闭运行，
  重复/并发唤醒不重复建任务。提交后经 `Orchestrator.dispatchRegisteredEvents()`
  派发；派发失败的事件保持 `registered`，每 30s 按原键补派。
- **漏过周期**：每计划只补一次。无未完成运行 → 取截点前最近一次，保存合并
  区间并标延迟；已有未完成运行（registered/queued/running 任务、pending/
  sending 通知）→ 并入原运行（原键、原正文），不建第二个。时钟回拨不回退
  已持久化的下次时间。失败或结果未知的运行不自动重试。
- **发送**：一次只有一个在途操作；`pending`（未领取）→ 条件更新 `sending`
  → 事务提交后调用宿主注入的渠道一次（15s 时限）：成功 `sent`（保存平台
  消息 ID），可证明未发送（`NotSentError`）`failed`，超时/断线/中止/模糊错误
  `effect_unknown`；平台限流（`RetryLaterError`，如 Telegram 429）可证明未发送，
  退回 `pending` 并写 `not_before`，到时同一操作（原目标、原正文）再领取一次
  （ADR 0011）。迟到回执保存在原操作上，不改状态、不重发。发送前重核
  目标（配置版本变化或停用 → `canceled`，不改发新目标）、计划状态与来源
  授权；渠道离线或发送器未加载 → 保持 `pending` 并写等待原因。
- **授权**：目标只来自可信宿主渠道（测试注入 `RuntimeConfig.scheduler.channel`，
  否则为 Telegram 适配器，见下节）；未配置即拒绝创建外发。`notify` 计划与
  `notification_enqueue` 一次发送都进入统一审批（`ApprovalScope.kind =
  notification` 固定完整正文、目标与配置版本、规则/时区/DST、持续范围），
  full_access 与 auto-review 也须拥有者确认；获批后同一核心事务内重核并
  `consumeApproval()`、写入计划/操作。已批准计划后续触发不重复消费批准。
  GitHub webhook 的一次固定 owner 摘要在启用入口时授权，使用独立的
  `inbound_event` 来源（schema v16，ADR 0013），不经过模型通知工具。
- **工具**（仅 main，`ToolCategory` 含 `scheduler`）：`schedule_create /
  schedule_query / schedule_cancel / notification_enqueue / notification_query /
  notification_cancel`。创建键 main 范围内唯一（同键同参返回原计划，异参
  冲突）；每任务一个一次通知槽（重复调用返回原操作，改正文冲突）。正文来源
  `text / task_result（已完成且有结果）/ artifact（UTF-8 片段）/ app_data
  （行字段）`，登记前解析为最终文本并记录版本与摘要；限 2,000 字符与 8 KiB、
  来源 ≤8、触发说明 ≤4 KiB、参数 ≤32 KiB，超限拒绝不截断不拆分。
- **取消**：在编排器串行链上执行，立即停止未来触发；pending 操作 → canceled，
  sending 只记取消意图；未派发的入站事件作废（恢复与派发都不再建任务），
  已排队的关联任务经现有取消入口处理；已运行的任务与在途发送保留真实结果。
- **查看**：`ruukoto schedule list|show|cancel`、`ruukoto notify list|show|cancel`
  （控制面 `schedule_list/get/cancel`、`notification_list/get/cancel`，每页 ≤50，
  列表不带正文）；审批在 TUI。控制面不获得发送或改目标能力。
- **停止**：先停止扫描与领取并中止在途发送（结果按事实收尾，通常
  `effect_unknown`），再等待编排器派发链，最后关库；关闭屏障后迟到回调不写库。

## 新闻推送（daily-agent issue 07，ADR 0015）

main 使用已有 `schedule_create` 创建 `action=news` 计划，例如：

```json
{
  "create_key": "daily-tech-news",
  "action": "news",
  "rule": { "kind": "daily", "time_zone": "Asia/Shanghai", "time": "09:00" },
  "news": { "keywords": ["人工智能", "开源软件"], "domains": ["example.com"], "time_range": "day" },
  "reason": "每天汇总已确认来源的科技新闻"
}
```

`domains` 应换成 owner 认可的真实来源。TUI 显示“动态新闻推送”，确认关键词、
来源（含子域）、时间规则、窗口、固定 owner 目标及持续范围。`full_access`
同样需要确认；增加来源、修改关键词或时间都先取消后重建。计划不接受自由正文、
资料引用、接收者或额外指令。主项目的 Web Search 必须启用，已有
`purpose=tavily_search` 的凭据还须允许 main 项目使用；不新增搜索服务。

到期后宿主直接执行最多 5 个固定关键词、每次最多 5 条的 Tavily news 搜索。
`time_range=day/week` 表示原定时刻前 24 小时/7 天；缺少有效发布时间、窗口外、
来源域名不符或不合法的 HTTP(S) URL 均过滤。URL 去重忽略片段和常见跟踪参数，
保留决定文章身份的其他参数。多关键词合并为一条不超过 2,000 字符/8 KiB 的
通知，过长条目不展示，URL 不截断；不会调用模型、读取会话或写入长期记忆。

schema v18 保留旧计划、运行和发送记录，仅增加新闻动作与运行中的有界快照。
快照保存来源 URL、标题、发布时间、查询时间、查询请求 ID、摘要及
`summarySource=tavily_search.content`，每次最多 32 KiB，超限明确标记。
`schedule_query` 的 `schedule_id` 显示运行和采集状态，再带 `run_id` 可读取该次
快照；`ruukoto schedule show <id>` 也显示最近运行。

搜索失败或限流不会产生新闻正文，也不立即重试；`notification_query` 可看到
`failed` 和 `news_*` 错误。搜索超时、连接结果不明或后台重启时正在采集，运行
标记 `unknown`，同一窗口不重搜；已登记但未开始的采集可在重启后继续。
发送结果未知仍沿用 `effect_unknown`，不换键重发。取消计划阻止待发通知并
中止在途搜索；发送前还会复核目标版本、计划和 Web Search 开关。

摘要保留搜索来源，未经独立核实。首版不逐条抓取文章验证可达性，来源页面可能
后来失效；停机后补采也可能受搜索服务的相对时间范围限制而缺少旧新闻。

## Telegram owner 入口（daily-agent issue 04，ADR 0011）

main 的第一条日常链路：拥有者在 Telegram 私聊 bot，消息进入同一个 main 会话，
回答经公共 outbox 发回原聊天。代码在 `src/telegram/adapter.ts`。

### 配置与启停

```bash
TG_TOKEN=123456:ABC... ruukoto credentials add --name tg --host api.telegram.org \
  --header none --purpose telegram_bot --secret-env TG_TOKEN
ruukoto telegram configure --credential tg --user-id <owner user_id> [--chat-id <chat_id>] [--api-base https://...]
ruukoto telegram enable | disable | status
```

- bot token 只在 CredentialStore（purpose=`telegram_bot`，host 须与 API 地址一致；
  配置后 scope 收紧到 `telegram_bot`）；核心库 `telegram_config` 单行只存绑定名、
  固定 owner `user_id + chat_id`（私聊 chat_id 即 user_id，缺省相同）、启停、
  `config_version` 与轮询偏移。token 在请求 URL 中，错误信息写入日志/账本/状态
  前按该请求捕获的 token 脱敏（覆盖轮换/删除后旧请求的迟到错误）；不进入模型
  上下文与事件。
- `--api-base` 缺省官方端点，可指向受控反代（必须 https，http 仅限回环）。
  Node `fetch` 不读 `HTTP(S)_PROXY`；国内服务器需要反代或网络层代理。
- 任何配置变化递增 `config_version` 并即时重连；重新配置把轮询偏移归零（平台
  重投由外部 id 去重）。凭据的同名修改或删除也在写入前单调推进 `config_version`
  并归零偏移——旧连接、旧消息与旧批准失效，A→B→A 轮换不恢复旧代次。旧目标上
  未发送的操作因版本变化取消，不改发新目标。
- dev 开发实例固定注入 `RUUKOTO_DISABLE_TELEGRAM=1`，不创建适配器。

### 运行行为

- **接收**：long polling `getUpdates`（25s，只收 `message`）。只接纳
  `chat.type = private` 且 `from.id / chat.id` 与配置一致的文本消息；其余不登记、
  不建任务、不调用模型，只记 `telegram.rejected`（update/chat/user id 与原因
  `not_owner / not_private / non_text / unsupported_update`，不含正文）。转发
  （`forward_origin/forward_date`）消息照常登记建任务，但其内容不解释为审批命令
  （不进入 `commandText` 解析）。
- **先持久化再推进偏移**：接纳的消息经编排器登记为入站事件
  （`source = telegram`，外部 id `<botId>:<chatId>:<messageId>`，目标 main），
  登记成功后才写 `last_update_id`；推进偏移前再次核对仍是同一代次。崩溃/断线后
  平台重投命中原外部 id，不重复建任务；已登记未派发的事件由启动恢复与调度器
  每 30s 补派（所有来源）。停机积压的消息全部处理（正文带原消息时间）。
- **收件钉版与门**：收件时按该次轮询捕获的配置/凭据钉版 `reply_target`
  （平台/bot/chat/配置版本）并持久化；派发、任务启动（`runQueueLoop`）与终态回复
  都经 `gatePrivate` 复核来源、actor（配置 owner user_id，不能由 chatId 推断）与
  钉版目标。版本未变的暂时离线等待恢复；停用、重绑或目标变化明确失效（旧
  `reply_target = null` 的遗留消息也不补造，其 registered/queued 工作失效，历史
  与执行事实保留）。
- **入站正文**：固定模板 `[Telegram 私聊] chat … user … message … 时间 …`，回复
  某条消息时附 `回复关联：message <id>（本 bot / owner 发送）：<摘录 ≤500 字>`。
- **权限**：入站事件（Telegram、定时唤醒等）建任务一律固定 `confirm` 模式，不继承
  main 会话默认的 full_access；审批可由绑定拥有者在 Telegram 私聊完成，见下文
  「IM 审批」。
- **回复**：Telegram 来源任务到达终态时，在编排器结果事务内登记 `owner_reply`
  发送操作（发送键 = 入站事件 id，目标 = 该事件收件时钉版的 `reply_target`，且须
  与当前固定 owner 目标一致，配置换了 bot/chat 不改发）。正文取**本任务**历史条目
  的最终回答（不取会话最新一条），超 4000 字截短注明；失败/超时/未知只发宿主固定
  提示。重启时结果未落库的任务由编排器巡检补记并补登回复。定时唤醒与旧 coding
  子任务（已退役）的唤醒不产生 `owner_reply`（需要时 main 用 `notification_enqueue`
  另行确认）；通用 SubAgent 工作的收尾唤醒按「通用 SubAgent 委派」节的最终
  汇报规则例外发回工作发起入口（agent-direction issue 18）；
  GitHub 结果通知按 ADR 0013 单独授权。目标不可用时记 `telegram.reply_skipped`。
- **发送**：`sendMessage` 纯文本，带 `reply_parameters` 关联原消息。outbox 领取后、
  实际请求前再次核对启停、固定目标与配置版本（不一致即 `target_changed`，可证明
  未发送）。结果分类：2xx 回执 → `sent`；429 → 退回 `pending` 按 `retry_after`
  再发；其他 4xx 与连接未建立（ECONNREFUSED/ENOTFOUND 等）→ `failed`；5xx、超时、
  中途断开、回执不可解析 → `effect_unknown`。`failed/effect_unknown` 不自动重发。
  渠道可用性 = 轮询是否健康；离线时回复保持 `pending`。
- **断线**：轮询失败即标离线，指数退避 1s → 30s（429 按 `retry_after`）；重连后
  从持久偏移继续。停止时先中止长轮询并等待循环退出，之后不再写库。
- **查看**：`ruukoto telegram status`（配置视图、在线状态、最近错误、偏移，不含 token）；
  回复记录经 `ruukoto notify list|show`（`sourceKind = owner_reply`）。

## QQ owner 私聊（daily-agent issue 06，ADR 0012）

QQ 好友私聊与 Telegram 共用 main 会话。复用现有 NapCat OneBot v11 正向
WebSocket 连接；核心群聊已退役（issue 20），旧群会话与收发记录保留为
只读归档（见下文「QQ 群聊」）。

```bash
# QQ_ONEBOT_TOKEN 由可信环境提供，凭据只登记一次
ruukoto credentials add --name qq-onebot --host 127.0.0.1:3001 \
  --header authorization --purpose qq_onebot --secret-env QQ_ONEBOT_TOKEN
ruukoto qq configure --endpoint ws://127.0.0.1:3001 --self-id <登录QQ号> \
  --credential qq-onebot --owner-id <拥有者QQ号>
ruukoto qq enable
ruukoto qq status
ruukoto notify list
```

配置中心的 QQ 页面也可绑定或清除拥有者 QQ 号。`--no-owner` 清除私聊绑定；
`qq disable` 停用整个 QQ 入口。私聊必须有 token，登录号与 owner 必须不同。
schema v14 → v15 为 `qq_config` 增加可空 `owner_user_id`，并为
`inbound_events` 增加可空 `reply_target`；旧库的群配置和收发记录保留，默认不开私聊。

- **接收与身份**：仅接收固定 owner 的 `private/friend` 结构化文本消息，可含
  回复消息 ID；不读取引用原文。临时群私聊、陌生人、自身回声、图片、附件和
  CQ 字符串格式不触发任务。登录账号和事件 `self_id` 必须匹配；
  `get_status` 与 `heartbeat.status` 同时检查 QQ 在线状态，WebSocket 存活但
  账号离线时也不接收新任务。token 不进入历史、日志或模型输入。
- **持久化与恢复**：消息先登记 `source=qq_private`，按
  `<登录账号>:<owner>:<message_id>` 去重，再以原事件键进入 main 队列。
  接收时固定回复目标和配置版本，派发与任务启动前复核；连接代次含配置版本
  （配置/凭据变化即重建连接，旧连接上的事件不再接纳）。配置变化取消旧授权，
  离线保留已登记工作等待。断线期间未登记的消息没有持久投递保证；接收缺口
  经 `qq.receive_gap` 如实记录，不补抓平台历史。main 队列沿用角色的恢复规则，
  中断任务由拥有者决定继续，不套用无工具群会话的自动恢复规则。
- **权限与资料**：任务固定 `confirm`；消息不能开启完全访问、修改角色或凭据。
  拥有者可经私聊审批命令批准已有受控操作（见下文「IM 审批」平台身份不等于
  通用控制面访问权）；拥有者明确提出的编码请求可委派 coding。
  main 和 coding 不能直接查询原始 QQ 群项目的历史、产物及带群来源的记忆，
  也不能通过委派资料或旧通知正文绕过；已有主会话内容仍跨平台共享，不追溯
  清洗已复制或转述的内容。
- **回复**：只读取本任务的最终回答，在结果事务内登记公共 `notification_ops`
  的 `owner_reply`，按原平台和原 owner 发送。QQ 回复按 `max_reply_chars`
  截短后入账（默认 1500，实际平台上限待真实验收），单条纯文本，可引用原消息。
  明确失败为 `failed`，超时、断线、异步接受或缺少有效消息 ID 的回执为
  `effect_unknown`，均不自动重发。定时和旧 coding 链的子任务唤醒不自动外发；
  通用 SubAgent 工作收尾汇报的例外见「通用 SubAgent 委派」节（issue 18）。
- **通知**：QQ 入站任务申请的新通知或定时发送绑定收件时的 QQ 目标，经统一
  审批后发送；定时唤醒、子任务唤醒和直接 TUI 任务仍沿用 Telegram 默认目标。
  目标版本变化使旧操作取消，不切换到其他平台。QQ 私聊记录用 `notify list/show`
  查看；`qq inbox/outbox` 继续显示群记录。
- **开发与验证**：`RUUKOTO_DISABLE_QQ=1` 同时关闭群和私聊连接。测试使用本地
  模拟 OneBot 与模型，不向真实 QQ 账号发送；真实 NapCat 版本、消息格式与收发
  闭环须拥有者另行授权后验收。

## IM 审批（agent-direction issue 08，ADR 0017/0011/0012）

绑定拥有者在 QQ 私聊或 Telegram 私聊中查看审批详情并批准或拒绝已有受控操作，
结果继续回到原入口。模块在 `src/runtime/im-approvals.ts`；平台身份不等于通用
控制面访问权，审批身份、操作与范围仍由宿主核实。

```text
/approvals [页码]                    # 待决审批分页列表（每页 5 条）
/approval <完整审批ID> [偏移]         # 详情：工具/版本/范围概览 + 参数有界分段
/approve <完整审批ID> <权限版本>      # 批准（绑定原请求与原权限版本，不接受部分 ID）
/reject <完整审批ID> <权限版本>       # 拒绝
/approve-standing <完整审批ID> <权限版本>   # 长期批准：保存服务 restart 授权并批准本次（仅服务 restart 审批）
/service-grants [页码]               # 本入口长期授权分页列表（每页 5 条）
/service-grant <完整授权ID> [偏移]    # 授权详情：完整范围/版本/存续原因/使用记录（每页 5 条）
/revoke-service-grant <完整授权ID> <授权版本>  # 带版本撤销长期授权
```

- **命令解析**：只解析适配器提交的原始发送文本（正文模板与引用摘录之前），整条
  匹配；已识别命令但格式错误时宿主返回用法。自然语言、引用中的命令、转发内容、
  模型输出与群消息不会被解释为批准。首版为纯文本命令，没有按钮或 callback 协议。
- **控制消息**：命令以 `inbound_events.event_kind = im_approval` 持久化
  （`(source, external_id)` 幂等去重，schema v22 新增类别列，旧记录默认 `task`），
  在同步事务内直接到 `done/failed`、`task_id = null`——不建任务、不调用模型、不进入
  普通登记/派发，也不排在等待审批的普通任务后面。恢复派发显式排除控制类别；
  崩溃遗留的 registered 控制事件明确作废，不作为普通提示或新的批准重放。
- **回执与通知**：每个查询/决定回执一条公共 outbox 操作（`sourceKind =
  inbound_event`，键 = 控制事件 id，固定命令收件时钉版的目标）。回执准确区分
  「批准已接受，仍待执行前复核」「已拒绝」「已失效/已处理」，不把决定接受说成
  操作成功。审批创建时在同一事务登记初始 IM 通知（`sourceKind = confirmation`，
  键 `im-approval:<confirmationId>`，原委托收件钉版的目标）：工具/操作、范围概览、
  权限版本、完整 ID 与查询/批准/拒绝命令；通知暂时发送失败不使操作获批。
- **决定事务**：IM 决定经活动 Driver 的审批闸门，批准/拒绝、审计事件、控制事件
  终态与回执在同一事务提交，提交后才唤醒等待者；中途写失败全部回滚。重复决定、
  相反决定或 TUI/自动审查抢先时，只有 pending 的第一次合法条件更新成功。
- **身份与归属**：列表、详情和决定只作用于原平台、原账号、原 owner、原配置版本
  ——宿主从审批的任务沿 `parent_task_id` 找到原 IM 委托事件（断链、循环、无来源
  或来源不是普通 IM 委托一律拒绝，不从会话最近消息推断），并逐项核对 actor 与
  钉版目标。Telegram 的 `ownerUserId` 与 `chatId` 分别核对。另一平台、TUI 发起
  且没有 IM 来源的审批不开放；未经核实身份不收到操作详情。
- **执行前复核**：批准已接受、尚未消费期间的重新绑定、停用或凭据变化在统一的
  消费事务内再次拦截（IM 固定身份 + 配置版本），消费前的操作既有复核（目录、
  MCP 配置、凭据、应用数据）不变；消费即执行开始，此后不撤回不重放。
- **失效与恢复**：配置版本变化（含凭据同名修改/删除在写入前的单调推进）使
  受影响平台的 registered/queued 工作取消、未消费的待决与已批准请求失效并解除
  等待——暂时离线只等待；失效只影响原平台，不波及另一平台在共享主会话中的工作。
  重启恢复沿用既有收尾：未消费的待决/已批准一律失效，旧 waiter 不重建，旧平台
  批准消息不重新执行（只回执已失效）；遗留 sending 记 `effect_unknown` 不重发。
- **重投与重复**：同平台消息重投先比对原类别、actor、原目标与规范命令并读取原
  回执；同键异命令拒绝，不按新的审批状态再执行；已完成的控制事件即使后来绑定
  变化也不改目标、不换发送键。429 只按原操作延后，超时/断线/丢失回执不换键重发。
- **长期授权命令（issue 10）**：`/approve-standing` 明确表示「保存持续授权并批准
  这一次」——创建只接受当前 pending 的 service restart 审批，范围完全来自原不可变
  审批记录（本机/单元/固定动作/策略与单元修订），宿主同时核实活动 main/任务、原
  入站归属、完整 ID、当前权限版本、当前 actor 与固定目标，并同步重读部署策略；
  授权创建、当前决定与授权关联、审计事件、控制事件终态与回执在同一事务提交，
  任何一步失败全部回滚。原 `/approve` 仍只批准一次，绝不隐式保存长期授权。查看
  与撤销只核实入口稳定身份（channel/account/chat/actor，可对旧配置代次的记录
  操作并明确标注入口已失效）；使用放行的代次一致性在执行侧逐次核实。

## 服务器服务管理（agent-direction issue 09，ADR 0019）

main 可检查服务器部署白名单内的服务状态，并经拥有者逐次审批执行管理动作
（首版仅 restart）。宿主工具在 `src/agent/service-tools.ts`；审批、通知与
批准消费复用 IM 审批通道，不另建控制面。

- **装配边界**：`service_inspect` / `service_manage` 仅 main，且要求产品
  ruukoto + Linux + 显式部署配置齐备（`RUUKOTO_SERVICE_HELPER` /
  `RUUKOTO_SERVICE_POLICY` 经后台单元 drop-in 注入，只设一个拒绝启动）；
  普通 dev、SubAgent 与 ruukoto-dev 都不获得该能力，main 不因此
  获得 bash。模型只提供白名单服务名与固定动作；主机身份、taskId、hostOpId、
  执行身份与策略由宿主注入。
- **helper 边界**（`deploy/systemd/ruukoto-service.mjs`，root 0700，仅后台
  账户经 sudoers 固定路径调用；执行账户无新增 sudo/Polkit 权限）：固定
  inspect / restart / stop-op 协议，绝对路径结构化 argv，清理环境，应答为
  stderr 上 `RUUKOTO_SERVICE_REPLY` 前缀单行 JSON。策略 `/etc/ruukoto/
  services.json`（root 0644）固定本机身份、执行 UID/GID、精确单元与允许
  动作；拒绝别名、模板实例、通配符、选项注入与额外参数，固定拒绝后台、
  Docker、执行工作进程与自身操作单元。检查以策略执行账户运行；修订指纹
  覆盖策略与 unit/drop-in 内容及已加载配置（`NeedDaemonReload=yes` 拒绝）。
- **审批**：`service_manage` 在任何访问模式（含 full_access）逐次审批——
  root 分支是后台经 sudoers 的新提权能力，不属于执行账户已有权限。范围
  `service_operation` 固定本机、规范单元、动作、策略与单元定义修订及任务
  和宿主操作 ID；批准单次消费，消费事务内复核 main 身份与策略修订，helper
  在请求 systemd 前再次核实全部修订。修订或 IM 固定身份变化即失效；已消费
  但 helper 证明未请求 systemd 记为已知未执行，重新操作需要新审批。
- **执行与回收**：每个宿主操作派生短命命令单元 `ruukoto-service-op-
  <hostOpId>.service`（`systemd-run --pipe --wait`，KillMode=control-group，
  RuntimeMaxSec=120），同一 ID 以 root 目录原子 mkdir 持久认领一次执行权
  （跨进程与瞬态单元回收后的重复保护；标记只证明已认领）。停止协议只停派生
  命令单元：先阻断后续启动（认领/stop-requested），再核实整个单元退出
  （LoadState/ActiveState/MainPID/ControlPID 全部确认），查询失败不释放占用；
  已提交 PID 1 的重启作业不撤回。原始 stdout/stderr 先入 ArtifactStore，
  模型收有界视图，产物引用接到 `task.tool_result` 事件（中断保持 partial）。
- **结果与恢复**：正常重启分述「管理命令结果」（退出码）与「随后观察到的
  服务状态」（InvocationID 对照）；退出码 0 ≠ active ≠ 业务健康；后状态查询
  失败保留已知命令结果。非零退出可能含部分效果（如已停止未能启动），不描述
  为零执行。消费后的结果分类只认可信结论（issue 10 统一的边界）：确定的请求
  前拒绝（`launched:false`）为已知未执行，确定的管理命令结果如实记录（含非零
  退出）；其余消费后无可信结果的（协议错误/应答 ID 不符/原始输出未保全/派发后
  失败/超时/中止）一律效果未知，不自动重发。helper 侧同样如实：`systemd-run`
  spawn 只有可证明未启动（ENOENT 等）才报 `launched:false`，启动后的错误与
  被信号杀死一律报「可能已派发」（不猜退出码）。账本规则
  `service_inspect=no_effect`、`service_manage=approval`：未消费中断/重启=已知
  未执行，已消费在途=效果未知；效果未知另使同目标有效长期授权失效（下节）。

## 长期操作授权（agent-direction issue 10，ADR 0017/0019）

拥有者经原 IM 平台的待审批把某次 service restart 审批保存为可查看、可撤销的
限定长期授权：之后独立任务命中完全相同范围（同一 main、同一入口稳定身份与原
目标代次、同一本机/单元/固定 restart、同一策略与单元修订）时自动放行，范围外
仍逐次审批。存储在后台保护的核心库 `standing_permissions` 表（schema v23），
不进入应用数据、记忆、项目指令、grantedPaths 或部署策略文件。

- **范围与版本**：授权范围创建后不修改（修改经撤销后新建）。行级版本：创建为 1，
  撤销/失效递增并保留记录；撤销与失效用授权 ID + 期望版本条件更新，重复撤销
  幂等（不再次变更）。数据库部分唯一索引保证同一 main 会话、同一稳定入口身份
  （channel/account/chat/actor）与同一目标最多一条未撤销授权，来源审批
  `approval_id` 唯一（旧命令重投不能重新建授权）。配置代次与策略/单元修订
  不进唯一键，只在使用资格核实中比对。
- **使用（每次执行重新授权、单次消费）**：`service_manage` 先经 helper 取得本次
  真实修订，宿主按当前 main、任务来源入口身份、钉版目标代次、本机/单元/动作与
  两项修订查找候选（候选不是执行依据；观察到失配的旧授权同事务明确失效）。命中
  时在单个同步事务内重读授权版本与未撤销状态、对执行快照逐项核实完整范围、核实
  活动任务与取消状态，创建独立的初始已批准记录（不发布等待事件、任务保持
  running、不启动自动审查）并经公共消费边界单次消费；许可源记为
  `standing_permission` + 授权 ID/版本（事件、TUI 详情与工具结果如实标注）。候选
  读取后撤销/取消/版本变化即整笔回滚并回落人工审批。模型、子任务消息、TUI 提交、
  调度与 GitHub 来源不能指定或继承授权；共享主会话不使另一平台继承。
- **撤销与失效**：`/revoke-service-grant`、已认证控制面 `service_grant_*` 与
  `ruukoto service-grant list/show/revoke`（入口停用后仍可管理遗留记录；创建首版
  只经原 IM 待审批，不增加配置页面或自由范围创建）。失效：`entry_changed`
  （IM 重绑/停用再启用/拥有者或账号或凭据代次变化，暂时离线与后台正常重启不失效）、
  `revision_changed`（策略或单元修订不符）、`effect_unknown`（目标效果未知，同一
  main、本机、单元与动作的所有入口授权一并失效，阻止换 ID 自动重试；重新建立
  需要拥有者显式决定）。单次批准不因此机制跨任务复用；`/approve-standing` 的
  当前批准也关联授权 ID/版本并在公共消费处重读，撤销先提交则本次放行失效。
- **协议**：控制协议 v10——批准新增可空的授权关联与新决定来源，新增
  `standing_permission.created/revoked` 事件与 `service_grant_list/get/revoke`
  操作；旧客户端明确拒绝升级提示，持久历史中的旧来源与事件保持可读。

## 固定 coding 角色退役（agent-direction issue 23）

固定 `coding` 角色（daily-agent issue 05 的 main → coding 委派）已退役，委派与
GitHub 评审统一走「通用 SubAgent 委派」节。退役只停新任务，不删数据：

- **不再引导、不再接受新任务**：编排器只引导 main；新实例没有 `agent-coding`
  项目与 coding 角色行。旧安装保留的 coding 角色行、项目与会话是归档标识，
  旧任务、历史、产物与 `result_ref` 原样保留；向 coding 角色会话提交（含继续、
  计划模式）一律 `invalid_state`。`coding_delegate` 已删除，入站登记只接受
  目标 `main`。
- **升级收尾，不重放**：启动时（与群聊退役收尾同一事务）coding 角色会话里
  排队的任务定 `canceled`（原因 `coding_role_retired:…`），运行中的照常由恢复
  定 `interrupted`；编排器启动巡检为这些旧子任务各补记一次结果
  （`child_task.*` 事件）并以 `wake:<子任务>` 唤醒 main 一次，结果已落库而
  唤醒缺失的旧子任务同样按原键补发。旧子任务正文不再交给模型执行。
- **只读查阅**：main 保留 `coding_result`（`delegation` 类别，只读），读取本
  会话旧 coding 子任务与本会话委派的 SubAgent 执行任务：`part=result`（默认）
  展示状态与旧结构化结果（模式、测试自报、需要拥有者、效果、产物），
  `part=reply` 按 UTF-8 字节分页读最终回答（256–16384 字节），`part=artifact`
  分页读该子任务的交付产物（4–65536 字节，不含 `prompt-snapshot:*`）。其他
  任务一律拒绝，不扩大跨项目资料授权。新工作用 `subagent_result`。
- **恢复兼容**：升级前在途、尚未落结果的 `coding_delegate` 工具操作仍按原
  请求键核实子任务是否存在（工具账本保留该规则）。
- **存储不收缩**：`tasks.agent_id`、`agent_roles.id`、`inbound_events.target_role`
  的 CHECK 仍含 `coding`/`chat`，`sessions.kind` 仍含 `qq_group`——旧行就是这些
  取值，收缩约束等于改写历史。群项目的资料边界（main/coding 角色项目不能借授权
  读原始群项目）照旧。

## 通用 SubAgent 委派（agent-direction issue 11–17/19，ADR 0020/0021）

主 Agent（拥有者的普通开发会话或 main）经宿主工具 `subagent_delegate` 登记
工作委托、创建动态 SubAgent 与独立子会话并派出一次执行任务（只读分析，
或 issue 16 的修改）；结果经
`subagent_result` 读取（省略 `work_id` 时列出本会话 SubAgent 总览），不再
需要的工作用 `subagent_cancel` 整项取消，不再需要后续协作时用
`subagent_close` 显式关闭；同项工作的参与者之间用 `subagent_message`
交换有来源的消息（issue 13，见下节）。五个工具属于 `subagent` 类别，
仅普通开发会话与 main 装配（`subagent_message` 另行对 SubAgent 子会话装配），
每次调用重新核实宿主任务、会话与身份绑定；
群、固定 coding/chat、动态 SubAgent、调度与回报唤醒任务不能委派下级
（`subagent_close`/`subagent_cancel` 例外：回报唤醒轮次也允许，关闭与取消
只收窄能力；`subagent_message` 同样允许——主 Agent 在回报唤醒轮次可继续
向工作内协作方补充，作用范围仍是本会话名下工作，不新建身份、不扩大权限）。

### 登记与执行范围

- **触发来源**：只有拥有者在父会话直接提交的任务，或经 Telegram/QQ owner
  入口核实身份的入站任务可以委派；定时唤醒、子任务回报及其他来源拒绝。
- **输入与固定参数**：模型只提供 `request / key / work_id? | sub_agent_id?
  （两者互斥）/ mode? / target?（issue 16，见下节）/ read_paths?（dev）|
  materials?（main）`。分析委派能力固定
  为只读（`read` 与 `read_artifact`），权限模式固定 `confirm`，不继承父
  任务/会话默认模式、单次批准与长期授权；不提供模型自选角色、执行账户、
  访问模式、父会话、任意 cwd 或自由工具列表。截止时间固定为父任务开始
  时刻 + 60 分钟；同一父用户会话最多 3 个活动（queued/running/
  awaiting_confirmation）执行任务。
- **幂等**：首次委派与复用委派以（父会话, key）唯一查工作（`sub_agent_id`
  只在提供时纳入参数摘要，保持旧重放摘要不变）；工作内以
  `sdelegate:<workId>:<key>` 查任务。参数摘要不包含本次调用的直接父任务 id
  与模型选择——跨对话轮次重放核实同一逻辑委派，返回首次记录；同键异参明确
  冲突；查重先于限额与资料解析，同键同参的重放即使目标已关闭或忙碌也返回
  原记录。修改委派把 `mode/target` 纳入摘要（旧分析重放摘要不变）。
- **登记事务**：先异步准备（模型门闩预检、受限执行入口预检、宿主生成的独立
  工作目录 `<dataDir>/../agent-work/sub-agents/<agentId>`、路径核实与资料快照），
  再在一个同步事务内重核后登记工作/Agent/Session/排队任务与审计事件
  （`work_delegation.created`），提交后才 kick 子会话；工具在子任务入队后
  立即返回，不等待子模型结束。准备或落库失败只清理本次产物：新建目录整删，
  沿用目录时只删本次写入的快照文件。
- **资料与读范围**：main 的 `materials`（1–8 个来源，复用来源解析器）解析为
  文本快照写入子工作目录 `materials-<workId>-<key>.txt`（按工作 + 执行键命名，
  复用承接新工作不覆写旧工作的快照），
  来源引用随任务保存，登记事务与每次向
  模型发送上下文前按该 Agent 全部历史任务来源引用与本次的并集重新 verify
  （任一撤销即拒绝登记或阻断发送 `task_sources_revoked`，快照正文不重新解析）；
  dev 的 `read_paths` 限父工作区内或父任务已授予范围（交集后的只读钉定），
  保存 realpath 与目录身份，路径经 LaunchSpec/init 传入 worker，模型参数
  不能替换；绝对系统路径、保护根、符号链接越界与目录身份变化明确拒绝。
- **上下文**：SubAgent 的模型上下文只含固定任务说明、选定快照与自己的
  JSONL——不注入父项目指令、个人共享记忆、技能目录、父完整历史或继续
  来源；产物只读本次自产（不含 `prompt-snapshot:*`）。

### 继续、复用与关闭（issue 12）

- **继续**（`work_id`）：沿原工作增加新的分析执行；**复用**（`sub_agent_id`）：
  同一父会话内把相关的另一项工作交给同一个空闲 SubAgent，登记一条新
  `work_delegations` 行指向既有 Agent（同一子会话，保留上下文），任务输入
  带宿主说明「此前的范围不延续」。两者各自登记独立任务记录（id/工作/
  readScope/结果互不改写），每次执行重新固定读范围、资料、confirm 与
  截止时间，前次批准不延续。
- **可用性**：继续与复用要求目标 Agent 同一父会话、未关闭、`idle` 且无活动
  任务（忙碌明确拒绝，不排队），工作目录 realpath 与 dev/ino 和子会话记录
  一致（目录被删除/替换时报「请新建 SubAgent」）；准备前与登记事务内各核
  一次。复用另复核该 Agent 历史任务来源引用与本次的并集，任一撤销即拒绝。
- **关闭**：`sub_agents.closed_at`/`closed_by` 独立两列（`owner` 或
  `agent:<任务ID>`），不改 `state` 语义（v25 迁移只补列，旧行两列为空）。
  主 Agent 用 `subagent_close` 工具关闭本会话名下的 Agent；拥有者经控制面
  `subagent_close`（CLI `ruukoto work close`）关闭；已关闭幂等返回；有活动
  任务拒绝并给出任务 id（先 `ruukoto cancel` 再关闭）。关闭不删除工作目录、
  会话、JSONL、产物与工作记录；关闭后新委派报「已关闭」，同键同参重放仍
  返回原记录；发 `subagent.closed` 事件（refs 指向父会话）。
- **竞争**：关闭与新委派在同一个同步事务内定胜负——先关闭则委派报「已关闭」
  且零新任务，先登记则关闭报「有活动任务」；不存在「已关闭且有活动任务」
  的中间态。
- **不自动关闭**：任务终态、TUI 退出（控制面断开）与等待都不关闭；空闲零
  模型/worker 进程；重启后关闭状态与空闲 Agent 的可复用性原样保持。

### 工作内消息与协作加入（issue 13）

同项工作的参与者——主 Agent 与当前承接本工作的各 SubAgent——经
`subagent_message` 交换有来源的消息（`subagent_messages` 表；控制协议 v15）。

- **协作加入**：`work_id` 与 `sub_agent_id` 同现的委派把一个既有空闲
  SubAgent 拉入既有工作登记一次执行任务（任务关联列指向协作方；工作行保持
  首次承接者，参与者集合经 `tasks.sub_agent_id` 判定）。只读工作才接受协作
  方——修改工作同一份文件单一写入者；宿主固定评审工作（入站来源）不接受
  加入；继续/复用/加入的可用性、竞争仲裁与来源并集复核与 issue 12 同口径。
  协作加入的幂等键按目标 Agent 的会话核实（不同协作方的同键互相独立）。
- **发送方身份**：完全由发起任务核实，模型参数不提供身份——工作父会话的
  任务 = 主 Agent（此时必须指定 `to_sub_agent_id`），本工作的 SubAgent
  任务 = 该 SubAgent（必须从本工作的任务中发送；省略 `to_sub_agent_id`
  即发给主 Agent）；其他会话、其他工作的任务一律拒绝。宿主评审 SubAgent
  不参与工作内通信。
- **接收方资格**：当前承接本工作（`active_work_id` 正是本工作）且未关闭——
  复用转做其他工作后旧协作者与迟到的旧消息都失去资格，不把关闭当作
  重新创建 Agent 的理由；已取消的工作不能投递。登记时同住一同步事务内
  完成资格核实与幂等查重（（工作, 发送方, 键）；同键同参的重放即使此后
  已取消/关闭也返回原记录，异参冲突）。
- **投递渠道**：发给 SubAgent 的投递为它在本工作的一次 `confirm` 执行
  任务（请求键 `smsg:<消息ID>` 幂等，输入为宿主固定来源首行 + 正文，
  读范围沿用其在本工作最近任务的钉定——消息不扩大任何一方的工具与
  资料范围；工具清单仍按工作内容钉版，另加 `subagent_message`）；发给
  主 Agent 的，dev 父会话经下一次模型调用的宿主参考块 `[工作内消息]`
  注入（收集与标记送达同事务，取消的工作不注入），main 父会话经唤醒
  任务（`agentId=main`、confirm、无截止时间）送达。
- **待投递与冲刷**：接收方忙碌或父会话活动任务名额已满时登记为待投递；
  宿主机在 SubAgent 任务终态（编排器结果登记后）、启动恢复、整项取消与
  关闭后冲刷：可投递则投递（同一同步事务仲裁，重入不重复），资格已失
  （`moved_work`/`closed:<时刻>`/`agent_missing`）或工作已取消记明确
  未投递结果并发 `subagent_message.dropped` 事件；登记与投递事件为
  `subagent_message.sent`（含投递渠道）。
- **可见性**：主 Agent 用 `subagent_result` 的 `part=messages` 查看本工作
  消息的来源、投递状态与正文预览；拥有者经控制面 `work_get` 的 `messages`
  列表（CLI `work show`）查看；发送调用按工具操作账本以（工作, 发送方, 键）
  核实 committed/not_committed；跨实例导入随所属工作的账本条目折叠。

### 整项取消（issue 14）

- **入口与状态**：拥有者经控制面 `work_cancel`（CLI
  `ruukoto work cancel <工作ID> [--reason R]`，停止中拒绝）；主 Agent 用
  `subagent_cancel(work_id, reason?)`（回报唤醒轮次也允许，取消只收窄能力）。
  SubAgent 自身与其他父会话的旧工作一律拒绝。取消用 `work_delegations` 的
  独立三列 `canceled_at`/`canceled_by`（`owner` 或 `agent:<任务ID>`）/
  `cancel_reason`（v26 迁移只补列，旧行三列为空），条件 `canceled_at IS NULL`
  一次写入，重复取消幂等返回原记录与当前任务状态；工作状态由列与任务状态
  派生，不新建状态机，不改写已结束任务的结果。取消 SubAgent 名下的其他工作
  不受影响。
- **一个事务登记，停止在事务外完成**：事务内写取消字段；该工作的 queued
  任务直接转为 `canceled`（`errorMessage` 记 `work_canceled`);
  running/awaiting_confirmation 任务写 `cancel_requested=1`；追加
  `work_delegation.canceled` 事件（`canceledTaskIds` 与 `stoppingTaskIds`
  分开记录）。提交后对每个活动任务调用现有 `cancelTask` 停止路径（账本
  快照、解除审批等待、abort、回收进程组、终态补记），`Promise.allSettled`
  等待完成；效果未知的已有操作只标记、不重放；无法回收的执行按现有逻辑
  保留占用，SubAgent 记 `unverified`。
- **竞争口径**：登记事务与委派登记都是同步事务、天然串行——先登记的任务
  必然在取消清单内，后登记的字段已写入即被拒。委派在准备前与登记事务内
  各核一次 `canceled_at`，命中报 `invalid_state: 工作已取消`（零新任务）；
  同键同参重放的查重仍最先执行，返回原记录不新建任务。新工作与其他工作
  不受影响；已取消的工作不能再登记新执行。
- **单任务取消窗口修复（根因）**：`Runtime.cancelTask` 的 running 分支先在
  事务内写 `cancel_requested=1` 再 `requestStop`；`Driver.runInner` 开头读到
  该标记直接定态 `canceled`、不调用模型——取消要么被启动检查拦下，要么
  `requestStop` 已能找到 `currentTask`，「已转 running、未进 Driver」的窗口
  不再吞取消。已知上限：超时取消若正好落在该窗口，终态记 `canceled`（不知
  原因）而非 `timeout`（`ponytail:` 注释）。
- **迟到结果不送达父模型**：终态结果照常经 `setTaskResult` 保存为事实
  （`subagent_task.*` 事件、`subagent_result` 与 `work show` 可查，头部标明
  取消时间、发起者与原因），但取消提交后这项工作的结果不再自动送进任何
  父模型——编排器在唤醒前重读工作（已取消不建 wake）；队列循环对
  `wake:<childId>` 任务启动前检查所属工作（已取消则直接取消该 wake，覆盖
  取消前已排队、检查后插入与巡检补发的所有唤醒，不调用模型）；dev 的注入
  查询加 `canceled_at IS NULL`；启动巡检的待唤醒清单排除已取消工作。选择
  「不注入」而不是「以迟到结果名义注入」，用一条规则排除主 Agent 据此重启
  工作的可能；需要时由主 Agent 主动 `subagent_result` 读取。main 正在运行
  的唤醒轮次不级联取消（取消所在轮次已有回复）。
- **身份与成果保持**：取消不关闭 SubAgent（任务结束后按占用核实记 `idle`
  或 `unverified`，之后仍可按 12 的规则复用于其他工作）；工作目录、会话
  JSONL、产物、resultRef 与工作记录都不删除。
- **展示**：`work list/show` 的工作对象自然带上取消三列与当前任务状态；
  TUI 经 `work_delegation.canceled` 事件更新工作字段并追加说明（不新增
  TUI 命令）；dev/main 系统提示说明「不再需要的工作用 `subagent_cancel`，
  已取消的工作不能继续委派」。

### 修改委派（issue 16/17，ADR 0021）

- **模式与入口**：`subagent_delegate` 增加 `mode`（`analyze` 默认 /
  `modify`）与 `target`（modify 必填，父工作区内的目录）。普通开发会话
  与 main（issue 17 开放，承接旧固定 coding draft 的修改职责）
  都能发起；计划模式、SubAgent 自身一律拒绝（已退役的 coding/chat 角色会话
  本就不接受任务）；
  modify 不带 `read_paths`/`materials`。修改工作固定 `confirm`、在
  容器中运行，不继承父任务的完全访问；工具只有 `read / edit / write /
  bash / read_artifact`（无 `request_file_access`、`http_request`、MCP，
  不能委派下级），装配、发送前与调用门按本任务所属工作是否有写入目标选
  同一白名单（执行画像；工具集在 SDK 会话签名里，同一 SubAgent 从只读工作
  复用到修改工作时重建会话）。
- **写入目标钉定**：`work_delegations.write_target`（v27 补列，可为空，
  旧行恒空 = 只读分析工作）在首次修改委派时确定、继续委派沿用；只读
  工作不能升级为写入，继续委派（`work_id`）不接受 `mode`；复用
  （`sub_agent_id`）承接新工作时另建副本。直接写入目标记
  `{kind:"direct", path, dev, ino}`；worktree 目标记
  `{kind:"worktree", repoRoot, commonGitDir, gitdir, path, dev, ino,
  branch, baseCommit}`。
- **Git 目标：每项工作一个宿主生成的 worktree**。位置
  `<dataDir>/../agent-work/worktrees/<workId>`（保护根与父工作区之外），
  分支 `ruukoto/work-<workId>`，基线为委派时仓库 HEAD 指向的提交——父
  工作区未提交的改动不进副本。仓库根从目标向上纯文件系统查找（不运行
  git，不越出父工作区）；共享 Git 目录必须位于父工作区内，否则拒绝。
  副本在受限 confirm 容器内创建（复用 `ToolWorkerHost`，宿主固定的
  bash：`git -c core.fsmonitor=false rev-parse --verify HEAD` +
  `git -c core.fsmonitor=false -c core.hooksPath=/dev/null worktree add`，
  基线提交按 40 位十六进制从容器输出提取），宿主永不执行 git——
  仓库的 hooks/config 可能被父任务的容器写入，宿主以后台账户运行 git
  会执行其中植入的 fsmonitor/filter（hooks 用 /dev/null 跳过、fsmonitor
  显式关）。宿主在容器启动前预建空副本目录（0700）：挂载源不存在时
  Docker 会以 root 自动创建、容器内 uid 写 `.git` 被拒；非空目录 = 失败
  残留，不自动认领或覆盖。子任务的 LaunchSpec 把工作区指向
  副本、共享 Git 目录只读挂载（`readRoots`，可 status/diff/log，不能
  add/commit/写 refs/hooks/config），并注入
  `GIT_CONFIG_COUNT/KEY_0/VALUE_0=safe.directory=*`（容器 uid 与仓库
  owner 不一致时绕过 dubious ownership 检查）。worker init 的数值目录
  身份（readRoots dev/ino、workspaceIdentity）只在 Linux 下发——
  原生 bind mount 按宿主原样呈现目录身份；macOS Docker Desktop 经 VM
  重新编号 inode（已实测：容器侧 dev/ino 与宿主恒不一致），darwin 不
  下发数值身份、worker init 只按路径钉定，目录身份复核由宿主队列回路
  在任务启动前按 `taskWorkspaceFor` 承担（runtime.ts）。git 会把副本
  路径字串写进共享 Git 目录的 `worktrees/<name>/gitdir` 并据此回核，
  macOS TMPDIR 的 `/var → /private/var` 符号链接会让字串与 realpath
  不一致（实测报 "not a git repository"）：创建命令、挂载与
  `write_target.path` 一律用 `copyDirReal = fs.realpathSync(copyDir)`。
- **不提交规则**：任务首行写明工作目录、分支、基线与「不要 git
  add/commit，改动留在工作树由主 Agent 汇总」；副本、分支与写入根的
  改动一律保留——创建失败保留现场（错误信息含路径与分支），任务取消/
  退出不删除，本版不提供任何删除副本的入口。
- **非 Git 目标：直接写入父工作区内目录并串行**（写预检按实际执行身份
  核实写位：Linux 容器按执行 uid 的 POSIX 权限位；macOS 上 Docker
  Desktop 的 VM 以宿主身份执行容器内文件访问，darwin 按后台账户核实）。
  子任务的执行目录与占用键都是写入根（`taskWorkspaceFor`：有写入目标用
  钉定的 path/dev/ino，否则用会话目录身份）；队列启动前复核目录身份，
  被替换或消失即失败、不自动重建。首次钉定写入目标后，该 SubAgent 的
  子会话 cwd 对齐到写入根。
- **目录占用升级为祖先/子孙判定**：冲突 = dev/ino 相等（符号链接、挂载
  别名同命中）、realpath 相等，或按分隔符边界互为前缀；释放统一按
  `taskId`（`releaseOccupancy(taskId)`），占用键是任务写入目标而非会话
  cwd。效果：非 Git 子任务与父会话串行——父任务本轮结束才释放占用，
  父任务没有阻塞等待子任务的接口，不会持锁空等；排队中的非 Git 子任务
  被本会话占用挡住时，`subagent_result` 提示「等待本会话释放目录，请
  结束本轮」。**行为变化**：已有的嵌套 cwd 会话从此也串行（`/ws` 与
  `/ws/sub` 之前互不阻塞）。已知上限：挂载别名的祖先关系识别不出
  （`ponytail:` 注释）。
- **副本防旁路**：覆盖 `agent-work/worktrees` 或其下位置的读写授予被拒
  （`validateGrantedPaths`；只读授予仍允许）；worktree 被删除或 `.git`
  指向变化后继续委派明确失败（`worktree_gone`），不自动重建。
- **展示**：`work list/show` 与快照自然带上 `writeTarget`；TUI 工作摘要
  标「worktree 分支 X」或「直接写入」。只加可选字段，协议版本不变。

### 改动汇总（issue 17，ADR 0021 补充）

- **入口与范围**：主 Agent 工具 `subagent_integrate(work_id)`（dev 与 main
  均装配，回报唤醒轮次也允许；SubAgent、群与固定角色会话经宿主身份重核
  拒绝）把本会话登记的 worktree 副本相对基线的完整差异套用到父工作区的
  待提交区——不代提交、`git apply --check` 预检通过才写入（预检失败零
  写入）。非 Git 直接写入工作没有副本（改动本就就地落盘），调用只如实
  告知；只读分析工作明确拒绝。拥有者没有专用控制面操作：待处理内容经
  工具回报与持久事件可知。
- **套用前核实**：工作有活动任务拒绝（busy，副本可能仍在被改写）；副本
  目录 realpath/dev/ino 与 `.git` 指向的 gitdir 逐项复核（被替换/消失
  明确失败，不自动重建、不凭钉定记录套用）；仓库根仍在父会话工作区内
  且 `.git` 可读。汇总只按工作 id 取首次钉定的写入目标——Agent 复用
  承接新工作（另建副本）后，汇总旧工作仍只落旧工作自己的副本。
- **容器命令与边界**：复用 issue 16 的宿主容器入口（宿主永不执行 git）：
  副本内 `git add -N --all` 把未跟踪文件纳入索引 → 对基线取完整二进制
  diff 与 numstat → 父仓库 apply 预检/套用；fsmonitor 显式关、hooks 走
  /dev/null（仓库 config 可被父任务的容器写入）；共享 Git 目录超出父仓库
  目录树时（父仓库本身是 worktree）按钉定记录补一枚读写挂载。
- **冲突与幂等**：三套结论——applied（套用成功并登记事件）/ already
  （完整差异已在工作区，`apply --check --reverse` 命中：幂等返回，不重
  复写入、不重复登记）/ conflict（两向预检都失败：零写入，父工作区原
  改动与副本成果都保留，错误点名冲突文件与待处理说明）。已知上限：汇总
  后对同一副本又继续委派产生新改动时，再次汇总会命中冲突（已套用的
  hunks 挡路），按冲突如实报告——不引入增量汇总状态；busy 检查与容器
  套用之间登记的新执行可能让副本继续变化，副本原样保留、事件钉定基线
  与文件清单使现场可核对。
- **记录与关联**：套用成功在一个事务内追加 `work_delegation.integrated`
  事件（工作/SubAgent/发起汇总的主任务/分支/基线/父 HEAD/文件清单 ≤64 条
  与 numstat 统计/patch 字节数）；TUI 经该事件在会话展示汇总规模与来源。
  工具操作账本按事件存在与否核实；套用落字节与登记是两个步骤，登记缺失
  时如实报无法核实而不是「未生效」。空差异为 empty、不登记。新增
  `work_delegation.integrated` 事件与工具进 v15 协议。
- **取消/关闭与汇总**：整项取消与显式关闭本就保留副本与成果，汇总不按
  取消/关闭状态拦截——取消后、关闭后的成果仍可按工作找回汇总。

### 结果、通知与空闲

- 终态沿用 `setTaskResult` 一次写入与结果提取；结果引用
  （`resultRef` JSON）明确 `workId / subAgentId / taskId / 原直接父任务 /
  所属父会话 / outcome / artifactIds`，与子身份空闲状态同事务登记
  （占用未回收记 `unverified`，否则 `idle`）。完成/失败/超时/结果未知如实
  保存，重复终态只记一份；不自动重试。
- dev 父会话：持久 `subagent_task.*` 事件指向父会话（TUI 可见归属），不产生
  唤醒任务；下一次父模型调用注入有界的宿主结果摘要与引用（`[SubAgent 结果]`
  参考块，注入后标记 `result_delivered_at`，崩溃窗口不丢记录）；main 沿用
  稳定 `wake:<childId>` 回报键（固定 confirm，不复制原 IM 来源事件）。
  已取消的工作不再注入、不唤醒（见上节「整项取消」）。
- **工作最终汇报（issue 18）**：IM（QQ 私聊/Telegram 私聊）来源任务发起的
  工作，在其 main 唤醒轮次到达终态时由宿主判定收尾并登记一次最终汇报——
  判定 = 该工作没有 queued/running/awaiting_confirmation 的执行任务，且每条已
  终态执行任务的 `wake:<id>` 都已存在并记录结果（本轮除外，因此并发或
  补充委派时由后一个收尾的唤醒汇报；唤醒轮次本身不能委派，见上文入口
  限制）。唤醒输入附宿主固定说明，告知本轮最终回答会成为汇报。汇报经
  `owner_reply` 槽登记，发送键 = `<发起事件 id>#work:<workId>:<收尾执行
  任务 id>`（同键幂等，重复终态与补记只产生一份；补充原工作再次收尾键不同
  即新的一份），任务引用 = 收尾唤醒任务。目标 = 发起任务来源事件钉版的
  `reply_target`（与当前固定目标核对；不从会话最新回答或当前入口推断；
  续派来自另一入口仍发回发起入口；登记时目标不一致按 `work_report:` 前缀
  记 `*.reply_skipped`，发送前再核对一次，停用或变化即取消不改发）。正文
  = 首行 `[工作 <workId> 最终汇报]` + 该唤醒任务的最终回答；唤醒失败/超时/
  被重启中断时发宿主固定提示并注明详情见 TUI；两平台均引用原入站消息
  （来源键按 `#` 截断取原事件）。发送等待、限流重试、结果未知不重发全部
  沿用 outbox 语义；正文与来源经 `ruukoto notify show` 可查。已取消的
  工作不自动汇报（取消所在轮次已有回复）。TUI、定时、群与 GitHub 发起的
  工作一律不汇报；该路径不新增工具、不扩大 main 的外发授权（唤醒轮次的
  `notification_enqueue` 仍按原规则核实可信目标）。GitHub 来源工作继续走
  ADR 0013 的固定通知。
- 身份在完成、TUI 退出与等待后仍保留，空闲零模型/worker 进程；任务收尾后
  释放子会话的 Driver 运行对象（SDK 缓存），释放不等于删除身份。
- `coding_result` 按同一归属窄口兼容读取本会话委派的 SubAgent 执行结果
  （见「固定 coding 角色退役」）。GitHub webhook 评审经宿主固定 SubAgent
  （见「宿主固定评审（issue 19）」）。

### 宿主固定评审（issue 19）

- **入口**：PR 入站事件派发时，编排器先建（或复用）固定的 main 父任务
  （无工具，只确认接收），再**直接调用** `SubAgentManager.delegate`（
  `hostReview: {sourceEventId}` 入参只由编排器传入，工具层不会产生该字段；
  拥有者来源检查保持原样）。每个修订登记一项新工作、创建一个新 SubAgent，
  不跨修订复用（新修订用全新上下文，避免旧 diff/旧报告混入新 head 的核对）；
  幂等键 `ghreview-<事件 id>`，参数摘要只含 `{kind, eventId}`——升级前后
  提示文案变化不会误报冲突。管理器准备失败（缺执行入口、模型门闩未就绪）
  时事件保持 `registered`，下次派发重试，不降级回旧 coding 路径。
- **名额与输入**：宿主评审任务带来源事件（`source_event_id`），不计入 main
  的 3 个活动委派名额（计数 SQL 排除来源事件任务）；任务输入首行固定为
  `[SubAgent 委派 · GitHub PR 评审]`，正文沿用 `GitHubEvents.request`。
  带来源事件的任务出队时走既有入站门（修订已过期即取消）、终态在同一结果
  事务内回写入站终态并登记通知。重提命中首次
  登记（管理器不再 kick）或崩溃窗口把排队子会话按 `backend_restart` 暂停时，
  派发按角色会话同口径补 kick / 恢复子会话队列（占用未核实的
  `occupancy_unverified` 暂停不在此解除）。
- **只读 MCP 按任务开放，只给评审任务**：subagent 类会话仅在任务被
  `taskMcp` 依赖识别为评审（`subAgentId` 非空且来源事件为 GitHub）时才规划
  MCP；收窄为「静态只读白名单（`read`/`read_artifact`）∪ `effect=read` 的
  MCP」，装配、发送前检查与调用门同一结论——写与副作用不明的 MCP、bash、
  下级委派在发送前与调用门两处被拒。owner 委派的 SubAgent、main 自身
  （类别不含 MCP）与开发会话 SubAgent 均拿不到 MCP。会话项目为 main 角色
  项目，MCP 凭据按项目核对（见「PR webhook 配置」）。
- **子身份边界**：评审 SubAgent 空闲后保留（遵守规格，不自动关闭），但宿主
  不会复用它，主 Agent 也不能用 `sub_agent_id` 把它挪去做其他工作或沿其
  工作续派——继续/复用的可用性检查对「有来源事件的任务」的 SubAgent 一律
  拒绝（上下文含不可信 PR 资料）；主 Agent 或拥有者可以显式关闭。
- **结果与唤醒**：终态沿用 `setTaskResult`；`resultData` 识别 SubAgent 评审
  任务，评审正文完整保存为 `review-draft:<事件 id>` 产物并
  写入 `result_ref.review`（分页损坏保留 `partial` 与 `captureError`）。
  main 结果唤醒开放 `subagent_result` 与只读的 `coding_result`（后者查阅 issue 23 退役前在途、经收尾补记的旧 coding 评审）；唤醒输入沿用 `GitHubEvents.notice` 修订说明，
  `subagent_result` 前置同样的修订说明。评审并行运行、不设并发名额（
  `ponytail:` 上限与升级方向见 `subagents.ts`）；被新修订取代仍在运行的评审
  会跑完，结果标为过期、不发通知。评审工作不适用 issue 18 的最终汇报
  （IM 入口汇报只认 telegram/qq_private 来源），继续走 ADR 0013 的固定通知。
- 控制面只读查询：`work_list` / `work_get`（CLI `ruukoto work list/show`，
  agent 对象含 `closedAt`/`closedBy`，work 对象含取消三列）；写操作为
  `subagent_close`（CLI `ruukoto work close`）与整项取消 `work_cancel`
  （CLI `ruukoto work cancel <工作ID> [--reason R]`，停止中拒绝）。
  快照携带工作委托、SubAgent 与其内部会话 ID（普通工作区列表排除）。
  普通控制面 submit/continue/switch-mode/会话默认模式不能作用于子会话。

### 后台重启恢复（issue 15）

后台异常重启后（通用规则见文末「崩溃恢复」）：

- **排队的委派任务定 interrupted，不自动继续**：重启时仍未启动的 SubAgent
  执行任务（拥有者或主 Agent 委派，无 `source_event_id`）与运行中任务同定
  `interrupted`（`backend_restart`；排队的从未启动，`started_at` 为空）——
  不自动继续、不当作成功也不当作新委派。启动巡检按 `setTaskResult` 补记一次
  结果与 `subagent_task.result_unknown`（重复启动不重复登记），结果引用的
  工作/Agent/父会话/父任务归属不变；SubAgent 回到可用状态（占用已核实记
  `idle`），main 父会话按稳定键唤醒、dev 父会话在下一个任务开始时注入，
  继续与否（沿 `work_id` 继续、`sub_agent_id` 复用，或放弃）由拥有者或
  父 Agent 决定。
- **宿主固定评审的排队任务自动恢复**：带 `source_event_id` 的排队任务不在
  上一条之列；编排器启动恢复把 `backend_restart` 暂停的自动解除从角色会话
  扩到 SubAgent 子会话，此时能命中的只剩评审排队任务，自动解除暂停并继续
  执行（issue 19 既定口径：不经拥有者核实）。
- **未核实的旧执行保留占用**：遗留占用与 `occupancy_unverified` 暂停不自动
  解除，Agent 记 `unverified` 并拒绝新委派（恢复任务不与旧执行并发修改同一
  资源）。拥有者核实旧执行确已退出后经 `resume-queue`（CLI `ruukoto
  resume-queue <会话 id>`）释放占用、解除暂停——这同时是 `unverified` 回到
  `idle` 的出口（释放后无活动任务即记回 `idle`，可继续委派、复用或关闭）。
- 已取消工作的迟到结果不因此重新运行、不补发唤醒（issue 14 规则不变）。

## GitHub：MCP 操作与 PR webhook（ADR 0007/0013）

专用 GitHub 模块（REST 采集、草稿与发布状态机，issue 06）已退役并删除；
GitHub 操作一律经通用 MCP 服务接入（见「MCP 服务」节，含 GitHub MCP 配置
步骤）。daily-agent issue 08 新增 PR webhook 事件适配，复用入站事件、父子
任务、普通 Artifact 和通知 outbox；不恢复旧模块或 REST 回退。Webhook
评审只获得读取工具；其他拥有者任务中的通用 MCP 写工具继续遵守 issue 18
审批边界。旧模块的固定修订发布复核、草稿状态机与发布意图保证不逐项复刻。

### PR webhook 配置（daily-agent issue 08）

先通过已运行后台的凭据入口登记独立签名秘密；`GITHUB_WEBHOOK_SECRET`
由调用环境提供，值不写进启动 JSON、命令参数、任务正文或日志：

```bash
ruukoto credentials add --name github-events --host github.com \
  --header x-hub-signature-256 --purpose github_webhook --secret-env GITHUB_WEBHOOK_SECRET
```

后台启动时通过 `--github-webhook-config /path/to/github-webhook.json` 显式
启用；文件对应 `RuntimeConfig.githubWebhook`，例如：

```json
{
  "port": 8787,
  "host": "127.0.0.1",
  "credential": "github-events",
  "repositoryIds": [123456789],
  "notifyChannel": "telegram"
}
```

```bash
ruukoto server --data-dir ~/.ruukoto/data --agent-dir ~/.ruukoto/agent \
  --execution container --github-webhook-config /path/to/github-webhook.json
```

`port`、`credential` 和非空 `repositoryIds` 必填；仓库范围使用正整数 ID。
`host` 默认 `127.0.0.1`，`notifyChannel` 可选 `telegram` 或 `qq_private`，
默认 Telegram。未传文件即不开监听，开发实例不自动继承这项配置。监听路径
固定为 `POST /github/webhook`；对外提供 HTTPS 时由部署侧反向代理到该入口。
GitHub webhook 使用 JSON 与相同 secret，并订阅 Pull requests 事件。

签名凭据的 purpose 固定为 `github_webhook`、host 为 `github.com`；启用时
scope 收紧到该用途，通用 HTTP 工具不能借用。GitHub MCP 另行配置到 **main**
角色绑定的项目（issue 19 起评审 SubAgent 的会话在 main 项目下，凭据按任务
所在项目核对），使用自己的读取凭据和工具允许列表。升级步骤：先另建一份
scope 为 main 项目的只读凭据，再执行 `ruukoto mcp configure --project <main
项目>`；coding 项目的旧配置不再被新评审使用（23 随旧角色一起清理），系统
不自动迁移凭据范围——改写凭据用途属于授权变更，须拥有者显式完成。Webhook
的仓库允许列表只限制事件接纳；MCP 可访问的仓库仍由其服务配置和远端令牌
权限决定。未配置 MCP、读取失败或资料缺失须在评审结果中说明，不经 REST 补抓。

启用配置同时授权一次固定 owner 摘要，因此应先配置并启用所选 Telegram 或
QQ 私聊渠道。事件登记时保存该渠道的 owner 目标及配置版本；未配置目标时
不发送摘要，后来配置目标也不会把旧事件改发给新目标。

### 评审、修订与通知边界

- **入口与持久化**：按原始字节校验 `X-Hub-Signature-256` 的 HMAC-SHA256，
  校验 delivery ID、仓库和 PR 字段。请求正文最多 1 MiB，PR body 只保存
  前 4000 字符并标记截断。支持 `opened / reopened / synchronize /
  ready_for_review / edited / closed / converted_to_draft`；签名有效的
  `ping` 返回 200，其他合法事件或未支持 action 返回 202 并忽略。接纳事件
  先保存归一化 JSON 快照，`(github, delivery ID)` 去重；首次登记返回 202，
  重复返回 200。响应不等待模型或子任务，登记失败返回 503。
- **宿主固定委派**：入站事件异步创建 main 父任务，并由编排器为每个修订
  直接登记一个评审 SubAgent（issue 19）。main 父任务只确认接纳且无工具；评审 SubAgent 仅可使用
  `read`、`read_artifact` 和按任务开放的本地 `effect = read` MCP 工具；
  结果唤醒的 main 获得 `subagent_result` 与只读 `coding_result`。
  会话、工作目录和 `confirm` 模式由宿主决定。PR 标题、正文和工具结果按
  资料处理，不能修改权限、角色或发布策略，也不能执行 PR 代码。
- **结果归属**：事件快照记录 head/base SHA、`updatedAt` 与 PR 状态；评审
  SubAgent 的完整最终回答保存为普通报告 Artifact。`result_ref.review` 保存
  事件 ID、PR URL、仓库 ID、PR 编号、head/base SHA、`artifactId` 与
  `staleReason`，main 经 `subagent_result` 读取（issue 23 前的旧 coding 评审结果仍可经
  `coding_result` 只读查阅），
  拥有者经任务详情或 `read-artifact` 查看。
  产物保留原始分析，当前有效性以任务结果为准，不建立旧 GitHub 草稿版本表。
  历史分页缺失或写入失败时保留 `partial`，结果记录 `captureError` 并要求拥有者
  核实；只有完整读取到记录的总字节数才标记 `complete`。
- **修订边界**：已接收的签名快照按 `updatedAt` 比较；同一 PR 出现相同或
  更新时刻的不同 head/base、关闭或 draft 状态时，旧结果标记过期，尚未发送
  的通知取消。同时间戳不同 SHA 也保守失效。模型须在 MCP 采集前后核对
  head/base，不能核对、分页不完整或 patch 缺失时明确说明；本地未观察到变化
  不保证远端仍未改变，缺失 webhook 不自动补抓。
- **一次通知**：只有该事件评审 SubAgent 对应的 main 摘要终态才登记通知
  （issue 23 起旧 coding 评审子任务不再登记）；
  公共 outbox 使用 `sourceKind = inbound_event` 和事件 ID 作为逻辑键，
  独立于 `owner_reply`，模型不能换目标或另建发送槽。发送前复核事件仍有效、
  入口仍启用且固定 owner 目标未变；过期、停用或配置变化时取消未发送操作。
  已在途的操作按实际回执收尾；`failed / effect_unknown` 不自动重发，平台
  明确限流沿用原操作延迟重试。通知可经 `ruukoto notify list|show` 查看。

Webhook 链路不发表评论、合并或自动修复；这些操作须由拥有者从可信入口
发起，并遵守既有工具与审批规则。上述修订检查不替代发布前核对远端状态。
Webhook review 不自动重试模型执行；父子任务与结果唤醒都有固定的 60 分钟
时限，包含排队等待。重启沿用原事件、父子任务、产物和通知键补记，不重新评审。

schema v16 扩展公共通知的 `inbound_event` 来源，升级保留原有发送状态、目标、
正文、幂等键、限流时间与索引。实际 GitHub webhook、GitHub MCP 和 owner 渠道
部署需另行验收；本地模拟平台测试不代表真实接入已通过。

本轮本地验证（agent-direction issue 19）：`test/42` 至 `test/46` 覆盖入口、
凭据、宿主固定 SubAgent 评审到通知的闭环、修订失效与升级接管、崩溃窗口
恢复及 partial 归档；`test/80` 覆盖评审不占委派名额与复用/续派拒绝。
`npm run typecheck` 通过；`.scratch/agent-direction/smoke-19-*.mts` 在本机
（macOS）与 tx（Linux）真实 Docker 受限 worker 下各 8/8 通过（模型、MCP 与
消息平台为模拟）。全量 `npm test` 共 917 项，915 通过、0 失败、1 项真实
模型测试按默认开关跳过；test/32-dev 的档案路径断言在本 worktree（目录名非
`ruukoto`）下预置失败，与本单无关，主检出路径下通过。

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
GitHub MCP（issue 17 起为 GitHub 操作的唯一接入路径，旧专用模块已退役）。
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
  - `ruukoto mcp disable <service-id>` / `enable` / `remove <service-id>
    [--expected-version N]`（remove 可携带期望版本核对：不符 = version_conflict
    且服务保留；省略 = 旧调用兼容删除）
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
  逐次进入审批闸门（与文件/HTTP 审批同一 `ConfirmationRequest`、
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
  与重启不自动重发。远端已应答的错误是已知结果：JSON-RPC 错误应答记
  `remote_error`，HTTP 状态错误按类别记录，都不标 effect_unknown。
- 结构化结果按任务开始时钉版的 `outputSchema` 校验（与 `inputSchema` 同一套
  预检，schema 不受支持即禁用该工具）：远端成功应答但不符声明即记已知错误并
  写明"远端已执行"，不标 effect_unknown，也不自动重发（调用传钉版定义，
  SDK 不做本地输出校验，header 不符时也不刷新清单重发）。
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

## QQ 群聊（issue 07）——核心群聊已退役（agent-direction issue 20）

核心不再创建或执行 QQ 群任务：这是 ADR 0017 对 ADR 0014 的修订（取消内建
chat 角色，群聊改为后续阶段的独立可选外挂）。chat 角色不再引导，旧安装的
`agent_roles` chat 行保留为归档标识。issue 23 删除了 chat 工具类别与提示、
Driver/上下文装配的 qq_group 分支与撤回过滤、QqStore 的群写方法；
`AgentRoleId`、CHECK 约束与 `qq_group` 会话类别对应旧行实值，保留不收缩。
QQ 拥有者私聊（issue 06，共享 main 会话）与 Telegram 主会话不受影响。

### 退役后的入站行为

- **群消息直接忽略**：适配器收到群消息时不登记收件、不建会话、不建任务、
  不回复、不保存正文，也不逐条记日志（不在核心继续收集群内容）。
- **撤回通知继续处理**：`group_recall` 只给已登记的旧收件行打标记（不取消
  任务、不补发回复）——已接收群结果的撤回复核仍然有效。撤回只能在 NapCat
  连接仍在、账号仍在群里时观测到；连接中断或退群后发生的撤回无法得知
  （ADR 0014 的既有边界）。
- **启动收尾（按状态幂等，重复升级/重启不重放）**：群会话排队任务 →
  canceled（原因 `core_group_chat_retired`）；运行中任务由通用恢复定
  `interrupted`（结果未知，不重放，`continue` 被拒绝）；已登记未派发的
  `qq_group` 入站事件经入站门固定 drop 作废并写 `inbound.skipped`；未终态
  收件（含完成但未发回复的）记 `skipped`；遗留 pending 发送定 `unknown`
  （effect_unknown，不重发），对应收件记 `reply_unknown`。

### 配置与命令（写入口已删除）

`qq_config.groups` 原样保留为历史值（`qq status`、`/qq` 照常展示）；
`qq_group_update` 控制 op、CLI `qq group add|remove`、配置中心允许群界面、
TUI `/qq groups` 的增删入口已删除——旧命令只打印退役提示。
`queue_ttl_ms` 已无读取方（issue 23 移出配置类型，列保留不迁移）；
`max_reply_chars` 仍是私聊回复的字符上限。`qq_configure` / `qq_set_enabled` / `qq status` 只作用于私聊入口。
正式 QQ 群聊外挂（独立程序，自行管理群会话/历史/发送状态，经有限接口向
ruukoto 提供结果）在后续阶段交付；本单不依赖尚未确定的外挂接口。

### 旧群资料（只读归档）

- `qq_inbox`（状态、撤回标记与时间、引用关联）、`qq_outbox`（发送账本）、
  `qq_sessions` 映射、入站事件与 chat 任务行全部保留。`qq inbox` 每条记录
  附 main 的接收账本行（接收时间、接收任务、理由、摘要快照）与**当前复核
  结论**（可用，或不可用的原因——归档缺失/不一致、main 不可用、来源已
  撤回）；`qq outbox` 查账本；拥有者 `read_history` 可读群会话历史。
- 归档不能变成对话入口：`create_session` 拒绝群项目与角色项目（与
  `open_workspace` 同一判定），`submit`/`continue` 拒绝 `qq_group` 会话与
  chat/coding 角色会话；`open_workspace` 认领与工作区迁移对角色/群聊项目的排除
  不变。
- **隔离不因退役扩大**：AccessScope 按 `sessions.kind='qq_group'` 判定，
  不依赖 chat 角色行；main/coding/SubAgent 仍读不到群项目原始历史、产物
  与带群来源的记忆；`chat_result` 资料仍不能用于 SubAgent 委派；已接收快照
  只对 main 开放。

### 群聊结果（chat_result_*，复核不变）

`chat_result_list` 与 `chat_result_accept` 保留，作用于归档中已完成且
已记录结果的旧群 chat 任务：列表只给来源元数据，接收保存至多 1000 个
Unicode 字符的摘要快照及接收任务、操作和理由，不开放原始群历史或产物。
已接收摘要仍可被 `notification_enqueue` / `schedule_create` 的
`{kind:'chat_result',task_id}` 引用（仍需拥有者审批，完全访问模式也不
例外）；查询、批准提交与发送前复核撤回与宿主来源——归档行缺失/不一致、
main 不可用或来源已撤回时取消该次发送并记 `source_revoked` 原因，不会只
凭接收快照正文继续发送。撤回观测的上限同上一节（断连/退群后无法得知）。

### 验证

`test/85-retire-core-group-chat.test.ts`：全新实例不引导 chat、群消息零
新增（收件/会话/任务/回复/模型调用），同连接 QQ 私聊与 Telegram 照常回复；
归档查询（inbox 附接收与复核、outbox、read_history）、转 dev 会话与
submit/continue 全部拒绝；无 chat 角色行的隔离不变；已接收结果通知经批准
正常发送、撤回/篡改阻断并记 `source_revoked`；排队/在途/待发/未派发事件
一次性收尾与三次启动幂等。旧数据由 `test/helpers/legacy-group-archive.ts`
按退役前（核心库 v24）持久形态播种；真实旧代码产生数据的升级路径见
`.scratch/agent-direction/smoke-20-retire-group-chat.mts`（tx）。

`test/26-qq.test.ts` 保留连接鉴权/身份核对/掉线重连与接收缺口、配置校验、
qq_group 资料身份与「群消息被忽略」；`test/49-chat-result-flow.test.ts`
用播种归档数据覆盖接收/审批/撤回复核/不凭快照外发。

真实 QQ 群与 NapCat 没有入口（无真实群闭环可验），记为未实测；
模拟模型与模拟 OneBot 的验证不代表真实平台行为。



1. 后台异常退出后重新启动（systemd 自动拉起、手工 `npm start -- start`，或
   ruukoto-dev 的 TUI 按需拉起——多个终端并发拉起经同一实例锁仲裁收敛为单个
   实例，败者进程退出后 TUI 侧连到胜者）。
   启动时先取数据目录实例锁：记录的 pid 存活且确为本后台 → 拒绝启动；
   pid 已死或被无关进程复用 → 接管；无法核实 → 保留锁并要求人工处理。
2. 恢复逻辑自动执行（单事务）：
   - 原 `running / awaiting_confirmation` 任务 → `interrupted`（原因
     `backend_restart`）；其未决确认请求标记 `stale`，失效批准不得再执行。
   - 排队的 SubAgent 执行任务（拥有者/主 Agent 委派，无 `source_event_id`；
     agent-direction issue 15）→ 同定 `interrupted`（原因 `backend_restart`，
     从未启动）：不自动继续也不当作新委派，由编排器巡检补记一次结果后
     SubAgent 回到可用，继续与否由拥有者/父 Agent 决定；宿主固定评审任务
     （带 `source_event_id`）不在此列，其排队保持——因此有排队任务的
     SubAgent 子会话只剩评审会话会按下一条暂停。
   - 结果缺失的工具操作按工具操作账本的分类器补记（架构工单 05）：覆盖已终态
     任务残留的操作；审批未消费 → 记录"已知未执行"结果（批准不跨重启执行）；
     只读工具 → 未完成且无写入效果；其余 → `effect_unknown` 并发
     `task.tool_effect_unknown` 事件（终态任务同时置任务级标记，不重放任何模型
     调用或工具操作）。
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
7. 编排器（issue 01）在上述恢复之后执行：已登记未建任务的入站事件按原
   请求键（`evt:<eventId>`）核实重提；重启窗口内到达终态的角色任务补记
   结果并补发 `child_task.*` 事件与有界唤醒（interrupted 一律按结果未知，
   不自动重放外部副作用）；结果已落库而唤醒缺失的子任务按原幂等键
   （`wake:<childId>`）补发，重复恢复不重复投递；退役前在途的旧 coding
   子任务也在这里补记（见「固定 coding 角色退役」）。角色会话与 SubAgent 子
   会话的队列暂停只有 `backend_restart` 才自动恢复（SubAgent 侧此时只剩
   宿主固定评审的排队任务，其余排队委派任务已在第 2 步定 interrupted）；
   `occupancy_unverified`（旧执行未核实）保留暂停与占用，由拥有者核实后
   `resume-queue`——这同时是 SubAgent `unverified` 回到 `idle` 的出口
   （释放占用后无活动任务即记回 `idle`）。角色任务有工具执行，
   不沿用 QQ 无工具会话的无条件恢复前提。
8. 调度器（issue 03）的恢复准备在第 2 步之前执行（须读到 running 任务的
   原始状态）：关联任务/发送已终态但运行未关闭的先补关闭；到期计划按
   正常规则处理——仍未完成的运行吸收漏过区间（不新增补发），其余计划补一次
   并标记延迟；最后遗留 `sending` 一律 `effect_unknown`（含"已领取、调用前
   崩溃"窗口），不重发。调度、通知、委派、群结果与应用数据工具未落结果的操作
   由工具族按宿主操作 ID 核实账本（同库，已登记即已提交、未登记即未提交），
   不落入通用 `effect_unknown`。编排器启动后才开放调度扫描与发送。
9. Telegram 入口（issue 04）：适配器在编排器启动前创建（巡检补登回复要读固定
   目标），编排器启动后才开始轮询。结果未落库的 Telegram 来源任务由编排器巡检
   补记结果并在同一事务补登 `owner_reply`（正文按任务读取）；轮询从持久偏移继续，
   平台重投命中原外部 id 不重复建任务。

## 部署（目标 Linux 服务器）

见 `deploy/systemd/README.md`：三个系统身份（拥有者 / 后台
`ruukoto-backend` / 执行账户 `ruukoto-exec`）、固定工具镜像
（`deploy/worker-image/build.sh`）、受保护提权入口（root 拥有的 sudo
包装脚本，仅后台可调用）、`ruukoto-backend.service` 单元，以及可选的
服务器服务管理（root 拥有的服务 helper 与白名单策略、可控测试服务，见
上文「服务器服务管理」节）。

该单元只承载个人 Agent 产品 ruukoto。Coding Agent（ruukoto-dev）装在开发
机器上：同一仓库检出加 `bin/ruukoto-dev.mjs` 入口（`npm link` 或直接把 bin
目录加入 PATH），默认档案根 `~/.ruukoto-dev-agent`；首次打开 TUI 即按需拉起
本机后台（见上文「按需拉起后台」），无需预置服务单元。两端各自的安装与升级
（替换检出后按产品 `stop`/`server` 重启）互不要求对方同时升级或停止；
按需拉起的后台在升级替换检出后同样经 `ruukoto-dev stop` 停下，下次打开 TUI
自动以新代码拉起。

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
| 任务容器端到端：镜像构建 + 经真实容器启动器的 bash 路由、网络拒绝、宿主路径不可见、非 root、只读根、cap 清零、容器回收；按宿主原路径挂载（pwd、宿主绝对路径 read、只读授予路径可读不可写） | Docker Desktop Linux VM；tx | 9/9 通过（Docker Desktop，`npx tsx verification/foundation/scripts/linux-isolation/container-worker-smoke.mts`；镜像 `ruukoto-worker:0.85.1`）；13/13 通过（tx 2026-09-26，issue 28 新增同路径挂载 4 项，RUUKOTO_CONTAINER_UID/GID=1003） |
| 同一容器镜像内的真实模型短编码任务（容器后端跑 07 场景） | tx（Ubuntu 24.04，容器后端 + deepseek-flash） | 通过（2026-09-21：confirm 任务经容器写文件，产物归属拥有者 uid 1003；RUUKOTO_CONTAINER_UID/GID=1003） |
| systemd 执行账户入口（提权包装、固定身份、cgroup 回收） | tx（Ubuntu 24.04，systemd 255） | 通过（2026-09-21：sudo 链路与 uid 986 env_keep 传递、worker 以 ruukoto-exec 运行、参数注入/非授权调用拒绝、stop 幂等；修复 exec-stop 包装退出码与启动器约定相反的问题。2026-09-26 issue 23：经部署控制面的真实模型完全访问任务端到端通过——`id -un` 为 ruukoto-exec、按 ACL 写工作区且拥有者可改、git 接受拥有者仓库、HOME 可写、读拥有者令牌被拒、结束后单元 inactive） |
| Git worktree 外部元数据显式授予路径挂载 | 部分（tx） | 授予路径校验/幂等已覆盖；容器内按宿主原路径挂载的只读授予路径已经冒烟实测（tx 2026-09-26）；worktree 共享 Git 元数据场景未专门实测 |
| 目标服务器宿主前提（发行版、内核、rootless、docker/systemd） | tx（Ubuntu 24.04，内核 6.8，Docker 29.5.2） | 通过（2026-09-21：`npm run linux:probes` 32/32 + 容器冒烟 9/9；原生 Linux bind mount 无 uid 映射，容器 uid 与工作区写权限按 README 第 5 步处理） |
| 真实模型短编码任务（真实凭据） | tx（经部署控制面，deepseek-flash） | 通过（2026-09-21，confirm 模式容器执行；`RUN_MODEL_CHECK=1 npm run test:model` 形式未单独跑） |
| issue 06 GitHub 集成（19 项） | — | 已随 issue 17 退役删除（专用模块移除，通用保障迁移至 08/17/24） |
| issue 17 GitHub 模块退役（4 项：全新库不建旧表、v8 样本库升级的审批失效与发布操作终态、草稿归档产物与无秘密清单、重跑幂等、旧控制入口不可达、旧凭据不变、历史事件重放） | macOS 本机（v8 样本库 + 真实运行时/控制面路径） | 通过 |
| 全部离线集成验证（125 项，逐文件顺序执行） | tx（Ubuntu 24.04，Node 24.21.0） | 通过（2026-09-21，17/17 文件 0 失败；修复 15-tui-pty 的 npx 孙进程持有管道导致文件级挂起——detached 进程组 + 整组回收，macOS 回归同过） |
| 真实 GitHub MCP 只读连通（一次已授权仓库的只读调用，记录工具/权限/结果） | 需拥有者配置独立只读 PAT | 未验证（issue 16 遗留；配置具备时按「MCP 服务」节步骤验收，不以模拟测试冒充） |
| issue 20 Web Search（9 项：默认启用与来源/查询时间保留、参数校验与限额、每任务 5 次上限可核对、项目禁用/任务清单冻结/任务内禁用立即生效、401/429/500/畸形/超大响应与产物归属、超时与取消不重发、提示注入有界处理、凭据脱敏与 host/用途限制、schema v6→v7 迁移） | macOS 本机（本地模拟 Tavily API，经真实宿主工具与运行时路径） | 通过（184 项总计含既有回归，0 失败，1 项真实模型门控跳过） |
| issue 07 QQ 群聊入口（20 项：连接鉴权/身份核对/掉线重连与接收缺口、白名单与结构化 @ 触发、收件去重、登记-入队与遗留发送的崩溃恢复、同群 FIFO 与跨群隔离、排队过期、停用/撤群、发送失败与结果未知不重发、响应乱序、撤回处理、记忆/指令/工具隔离、拥有者 QQ 发言不获控制面能力、qq_group 资料身份） | macOS 本机（进程内模拟 OneBot WebSocket + mock 模型，经真实适配器/Runtime/发送控制路径） | 通过；真实 NapCat 接入与 Linux 部署未验证（需拥有者授权的真实群闭环）。agent-direction issue 20 起核心群聊已退役，群消息被忽略，见下行 |
| agent-direction issue 20 核心群聊退役与旧群资料保全（test/85 共 6 项验收：新核心不引导 chat、群消息零新增且私聊/Telegram 照常、归档可查与只读边界、无 chat 角色行时隔离不扩大、通知/调度复核撤回与篡改（source_revoked）、排队/在途/待发/未派发一次性收尾与三次启动幂等；test/26 保留连接与身份用例、test/49 播种归档覆盖接收/审批/撤回复核） | macOS 本机（进程内模拟 OneBot WebSocket + 模拟模型 + 播种助手按 v24 形态写归档；真实 Runtime/SQLite/socket） | 通过；旧代码真实产生数据的升级路径与真实 Linux 后台见 .scratch/agent-direction/smoke-20-retire-group-chat.mts（tx）记录；真实 QQ 群/NapCat 无入口，未实测 |
| agent-direction issue 15 后台重启恢复 SubAgent（test/86 共 3 项：排队委派任务重启定 interrupted 且不自动继续/不当作新委派（零模型请求）、补记一次重复启动不重复登记、结果归属保持、Agent 回 idle 可继续委派且 dev 父会话注入；遗留占用保留与 occupancy_unverified 暂停不被启动恢复解除、unverified 拒绝委派、拥有者 resume-queue 后回 idle 可委派；宿主固定评审排队任务不中断、启动恢复自动解除子会话暂停并继续执行） | macOS 本机（mock 模型 + 临时目录 + 进程内真实 Runtime 重启（stop→Runtime.start，含崩溃形态 SQL 置位）+ realTools local 后端） | 通过（2026-10-05，3/3；模拟环境。真实容器/CLI 证据见下行） |
| agent-direction issue 15 冒烟（.scratch/agent-direction/smoke-15-recover-subagents.mts：真实 Runtime/控制面/SQLite + 真实受限容器后端与镜像 + 真实 CLI resume-queue——排队委派任务重启中断零容器零模型请求、结果归属、dev 注入、沿 work_id 真实容器继续；遗留占用保留与暂停不被启动恢复解除、unverified 拒绝委派、CLI resume-queue 后回 idle 可继续；带来源事件的评审排队任务自动恢复真实完成；重复重启不重复登记、无残余容器） | macOS 本机 Docker Desktop（真实容器；模型为模拟，消息平台不启用；崩溃形态按库内容置位，判定输入与真实崩溃一致） | 通过（2026-10-05，8/8）；冒烟期间发现并修复：backend_restart 暂停叠加持占用会话不再被启动恢复自动释放（runtime 守卫） |
| 真实 Tavily 连通性（一次受控查询，记录端点/调用次数/限制与来源） | 需拥有者配置 tavily_search 凭据 | 未验证（未配置凭据；不以模拟结果宣称真实接入完成） |
| 双产品入口与同机并存（agent-direction issue 01；test/71 进程级用例：两 bin 分别启动真实后台、握手与查询、ruukoto-dev 无 QQ/Telegram 适配器、停一端另一端照常应答、跨产品打开数据目录被 product_mismatch 拒绝） | macOS 本机（真实 bin 进程/真实文件/真实 socket 与 SQLite，模型打桩） | 通过（2026-10-02；可复现于 test/71 进程级用例；同路径手动冒烟（10 项）亦通过，记录在工单评论；模型层为模拟，进程/存储/控制面为真实环境） |
| 双产品离线集成（test/71：产品身份与按产品的目录解析、环境变量隔离、开发实例环境清洗、Runtime gating 与归属登记、旧计划记录可读、bin 进程冒烟） | macOS 本机（mock 模型 + 临时目录） | 通过（2026-10-02，14/14；全量 npm test 含既有回归见上各行统计） |
| ruukoto-dev TUI 按需拉起后台（agent-direction issue 02；test/72 进程级用例：后台不在时拉起、并发两个终端收敛为单实例（含锁竞败者等慢胜者复用）、已运行不重复拉起、启动失败附 spawn.log 尾部、后台在运行但令牌不符的认证指引、关闭客户端不停止后台/取消任务、重开看到同一任务与幂等键核实） | macOS 本机（真实 bin 进程/真实文件/真实 socket 与 SQLite，模型打桩） | 通过（2026-10-02，8/8；模拟结果与真实环境分列：模型层为模拟，进程/存储/控制面为真实环境） |
| TUI 真实入口按需拉起冒烟（.scratch/agent-direction/smoke-02.sh：pty 下真实 runTui 生产默认路径——首次拉起、关闭 TUI 后台不停、再开复用、stop 后重开再度拉起、无模型配置时非零退出并附启动失败状态） | macOS 本机（真实 pty/bin/文件/socket/SQLite；models.json 结构合法但指向死端口，冒烟不提交任务、不发生模型调用） | 通过（2026-10-02，5/5） |
| 开发机受限执行边界产品级冒烟（agent-direction 工单 03；经真实容器启动器 + ruukoto-worker 镜像 + 宿主 ToolWorkerHost：容器内 bash、非 root 1000、工作区写入宿主可见、无外网出口、工作区外宿主真实文件不可见、只读根、CapEff 清零、nohup 逃逸孙进程实际运行（对照）且停止后心跳冻结、停止核实容器移除、宿主原路径挂载、只读授予路径可读不可写） | macOS 本机 Docker Desktop 4.x/29.8.0（Linux VM aarch64）；/var/folders 与 /Users 两种工作区各一遍 | 通过（2026-10-02，16/16 ×2；`npx tsx verification/foundation/scripts/linux-isolation/container-worker-smoke.mts`——真实 docker/镜像/文件/进程/网络路径，无模拟层） |
| macOS sandbox-exec 可行性探针（.scratch/agent-direction/macos-sbx-probe.sh：file-read literal/subpath/regex/file* 与 file-write 拒绝、孙进程继承、网络拒绝对照） | macOS 27.0 (arm64) | **否定**（2026-10-02）：文件规则 0/6 静默未执行，不构成边界；网络拒绝与孙进程继承生效，不足以覆盖文件与凭据；不作为受限执行方式 |
| SubAgent 修改委派冒烟（.scratch/agent-direction/smoke-16-parallel-worktrees.mts：真实 Runtime/控制面/SQLite + 真实容器后端与镜像 + 真实 git 仓库——容器内建副本、两子任务同一仓库并行 worktree（同时 running、不同分支）、主工作区字节与未提交改动不变、safe.directory 环境容器内 git status/diff 可用、git commit 与写 hooks/config 真实失败（共享 Git 只读挂载）、非 Git 目录与父会话串行、植入 fsmonitor 只在容器内被只读挡住（宿主不执行）、副本创建与任务容器零残余） | macOS 本机 Docker Desktop 29.8.0（真实容器；模型为模拟，消息平台不启用） | 通过（2026-10-04，9/9）；Linux 远端（tx，uid/gid 1003，经 `--remote` 自包含跑完全程）通过（2026-10-04，9/9）；流程教训：worker 代码打进镜像（deploy/worker-image 构建阶段复制 src/agent/tool-worker 与 src/core 后 esbuild 打包），改 tool-worker 必须重建镜像才进容器 |
| SubAgent 改动汇总冒烟（.scratch/agent-direction/smoke-issue17.mts：真实 Runtime/SQLite + 真实容器后端与镜像 + 真实 git 仓库——宿主容器创建 worktree 副本、子任务容器真实 edit/write、汇总容器 add -N→diff→apply --check→apply 落入父工作区待提交区、父 HEAD 不变、`work_delegation.integrated` 事件登记、already 幂等不重复登记、冲突零写入点名文件双方保留、取消+关闭后汇总不拦、父仓库本身是 worktree 时共享 Git 目录补挂读写、副本创建与汇总照常、`ruukoto-task-*` 容器零残余） | macOS 本机 Docker Desktop（真实容器边界；模型为模拟）；tx（Ubuntu 24.04 原生 Linux，Docker 29.5.2，uid/gid 1003，RUUKOTO_CONTAINER_UID/GID=1003） | 通过（2026-10-05，7/7 ×2）；离线断言在 test/84（local 后端模拟边界，git 语义为真实 git）；流程教训：副本创建与汇总在「父仓库本身是 worktree」时必须把共享 Git 目录补挂读写（issue 17 起生效），否则容器内 git 无法解析 `.git` 指针 |
| Linux 容器边界探针复核（linux:probes，当前脚本） | macOS Docker Desktop 29.8.0（Linux VM aarch64） | 通过（2026-10-02，全部预期探针，0 不一致 0 缺失） |
| Linux 原生复核与现有部署盘点（linux:probes 原生 Linux；launchers/部署/探针机制文件哈希对照 2026-09-26 验证快照；systemd 生效配置、受保护提权入口、令牌权限位盘点） | tx（Ubuntu 24.04，内核 6.8.0-117，Docker 29.5.2，systemd 255） | 通过（2026-10-02）：探针 32/32；机制文件（launchers.ts、deploy/**、宿主/探针脚本）与验证快照逐字节一致（worker.ts 仅差异一次 write 展示统计，不改边界语义）；ruukoto-backend active、RUUKOTO_EXEC_UID/GID=986 与 ruukoto-exec 账户一致、RUUKOTO_CONTAINER_UID/GID=1003、owner.token 0600 ruukoto-backend 持有、提权包装在位 |
| 开发机受限/完全访问产品级冒烟（agent-direction 工单 04；.scratch/agent-direction/smoke-04-desktop-execution.mts：容器内代码修改与检查、外网出口/未挂载宿主文件/只读根约束、越界读取审批单次消费、完全访问缺执行账户入口执行前拒绝、中断回收容器含启动窗口） | macOS 本机 Docker Desktop 29.8.0（Linux VM aarch64）；tx 原生 Linux（Ubuntu 24.04，Docker 29.5.2，uid/gid 1003） | 通过（2026-10-02，6/6 ×2）：真实容器/镜像/文件/网络与审批路径，模型打桩；`npx tsx .scratch/agent-direction/smoke-04-desktop-execution.mts`（TMPDIR 可换工作区位置） |
| ruukoto-dev 默认执行后端接入（agent-direction 工单 04；test/73 进程级用例：dev 默认 container、显式 local 打印无隔离警告、环境变量覆盖、完全访问缺入口提交即 execution_unavailable 且不回退、confirm 照常；工作进程启动窗口中断回收执行单元回归 test/07） | macOS 本机（真实 bin 进程/文件/socket/SQLite；模型打桩，无容器依赖） | 通过（2026-10-02）：test/73 4/4、test/07 5/5；全量 npm test 见本轮提交记录 |
| macOS 完全访问执行身份 | macOS 本机 | 未验证（2026-10-02 记录前置与依据）：不能以拥有者 uid 运行——同 uid 进程对 `~/.ruukoto/control/owner.token`（0600 owner，65 字节）test -r 退出 0，即完全访问任务会持有控制面拥有者身份；可行机制为独立本机执行账户 + sudo 包装（同 Linux exec 账户一类），创建账户与 sudoers 属拥有者部署动作、本单未做；未配置入口时完全访问在执行前拒绝（smoke-04/test/73 覆盖），Linux 完全访问身份仍沿用 2026-09-26 tx 实测结论 |
| 工作区与会话组织（agent-direction 工单 05；test/74：open_workspace 创建/根目录身份落库/快照可读、符号链接与路径变体复用、同名目录不合并、多仓库根目录、请求标识幂等、旧项目认领与改归属拒绝、保护根拒绝、旧 op 与 v18→v19 迁移、创建→执行→历史、TUI 选择面板 ruukoto-dev 排除角色与群聊/ruukoto 不变、角色与群聊项目拒绝认领） | macOS 本机（进程内真实 Runtime/socket/SQLite/伪终端；模型打桩） | 通过（2026-10-02，15/15；全量 npm test 见工单评论） |
| 工作区产品级冒烟（.scratch/agent-direction/smoke-05-workspace-sessions.mts：真实 bin/ruukoto-dev.mjs 后台——多仓库根目录打开、别名与变体复用、同名目录去重、请求标识幂等、旧项目认领、提交执行与历史查看） | macOS 本机（真实 bin 进程/文件/socket/SQLite，模型打桩） | 通过（2026-10-02，6/6；`npx tsx .scratch/agent-direction/smoke-05-workspace-sessions.mts`） |
| 服务器服务管理离线验证（agent-direction issue 09；test/78：QQ/Telegram 检查→逐次审批→批准恰好一次→原入口结果、拒绝/重复决定/篡改目标零执行、非 main 与错误产品/无配置/非 Linux 门、auto-review 转人工、策略与单元修订变化失效、同 ID 重复启动拒绝、取消与跨重启的效果未知不自动重发、产物引用与 partial、后状态查询失败保留命令结果） | macOS 本机（模拟 IM 平台 + mock 模型 + 受控 helper 替身，文件系统模拟 systemd，协议逐字节同生产） | 通过（2026-10-03，22/22；真实 systemd/提权证据非本项，见下行） |
| 服务器服务管理真实 Linux 冒烟（.scratch/agent-direction/smoke-09-linux-service-management.mts：模拟 IM 平台 + 真实 systemd/sudo/提权/测试服务——部署安装、主链路真实重启（InvocationID 变化、starts 恰 +1、批准消费一次、op 单元实录）、执行账户调用/写策略/读控制面令牌全拒绝、同 hostOpId already_claimed、策略篡改消费前失效、改单元不 daemon-reload 修订拒绝、基础设施目标拒绝、op 已派发时 kill -9 恢复效果未知不自动重发、拒绝零执行） | tx（Ubuntu 24.04，systemd 255） | 通过（2026-10-03，14/14 ×3 轮幂等，末轮为最终代码态复跑；发现并修复 fd3 协议在 sudo 下全断（closefrom=3）改为 stderr 前缀应答；IM/模型为桩，真实 QQ/Telegram 平台未实测） |

### 按会话选择模型

后台启动可传 `--model provider/model --thinking off`；模型 ID 中后续斜杠会保留。未指定 `--model` 时取 `default-model.json` 持久默认（含思考档位），再回退到目录首个模型；未指定 `--thinking` 时沿用持久默认的档位，没有则为 `off`。显式参数优先：带 `--model`/`--thinking` 运行期间，在线设置的默认模型只写入文件，重启去掉参数后生效。具体合法档位由该模型能力校验。

TUI 使用 `/model` 选择后台已配置的提供方和模型，再选择合法思考强度；Esc/q 取消，后台确认后才更新显示。底栏显示后续任务的模型选择。选择持久化到会话，新会话继承启动默认值；切换只影响之后提交的新任务，运行中和已排队任务保留提交时的配置。继续中断任务创建新任务，采用本次提交选择。

CLI 可用 `models [--provider provider] [--offset 0] [--limit 100]` 分页查询安全目录，用 `set-model <session> <provider/model> --thinking <level>` 保存选择。`submit/continue` 自动取得当前会话完整选择，也可用 `--model provider/model --thinking level` 显式指定。同一请求键重试先核实原任务，保留原任务模型选择；接收结果不明确时应核实原请求键，不能换键重复提交。

后台重启后队列仍暂停。旧排队任务若未记录模型，TUI 恢复时显示数量和待补选择，确认后补齐；CLI 需 `resume-queue <session> --model provider/model --thinking level` 显式确认。旧终态任务显示“模型配置未记录”。缺模型、凭据或不支持的档位会拒绝整次变更；目录中认证材料可用不代表远程连通性或额度已验证。模型设置应答丢失时，连接仍在则查询会话状态、已断线则以重连快照为准；被其他客户端修改时刷新；都不自动重发覆盖其他客户端。

旧版待确认输入先核实是否已接收；明确未接收但缺少模型字段时保留原文，需拥有者重新选择后提交。未发送或明确拒绝的新请求恢复输入；应答丢失（断线、超时、应答超限、后台内部错误）则保留完整参数用于核实。
