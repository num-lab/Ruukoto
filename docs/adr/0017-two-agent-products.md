# 将 Ruukoto Agent 划分为两个工具，取消固定 coding 与 chat 角色

日期：2026-10-02

状态：已接受。拥有者通过三轮访谈确认全部 19 项方向决定；本记录描述目标架构，代码迁移与具体技术验证尚待实施。

Ruukoto Agent 包括两个工具：`ruukoto-code` 是运行在开发机器上、以 TUI 为主要入口的 Coding Agent，重心是 Agentic coding，首期支持 macOS 与 Linux；`ruukoto` 是运行在专用 Linux 服务器上、以 QQ 私聊和 Telegram 等 IM 为主要入口的 Personal Agent，面向多样化任务，也允许通过邮件、GitHub comment 等渠道交流。两端独立安装、运行和升级，在同一仓库复用适用代码；一端停止或两端失联时，另一端仍能执行本地任务。共享范围先限于明确选定的个人偏好与通用经验，项目约定保留所属范围，不默认同步完整历史、日程或任务进度；共享信息不可用时只影响其新鲜度，发布与交换机制另行确定。

取消旧架构中的固定 `coding` 角色，原因是它与开发工具的能力重复。取消内建 `chat` 角色，QQ 群聊改为独立可选程序，自行管理群会话、历史和发送状态，通过有限接口向 ruukoto 提供结果，停用不影响主会话；代码可以留在同一仓库。这样避免将通用个人助手限定为群聊用途，也使群聊扩展可以独立演进。

`main` 继续与拥有者交互，可向若干 SubAgent 派发任务；两个产品均支持相同的一层 SubAgent 模型。SubAgent 不直接与拥有者交互，不能创建下一层 SubAgent；同级通信限于同一主 Agent 下当前参与同一项工作的协作者，消息不扩大接收者的权限，跨会话、工作区和机器的直接 Agent 通信暂不加入。具体工具、工作目录与资料范围按任务确定。通用 SubAgent 尚待实现，不能将现有固定 coding 子任务视为已具备该能力。

拥有者明确要求 SubAgent 在任务完成后默认转为空闲，保留身份与上下文；同一主 Agent 可以在同一用户会话内继续委托原工作，也可以将其用于另一项独立工作。复用时按当前工作重新确定同级通信资格，不延续旧工作的协作关系。主 Agent 在不再需要后续协作时可以显式关闭，拥有者也可以关闭；任务完成、退出 TUI 或空闲超时均不自动关闭，关闭后保留历史和产物。

工作委托可以跨越多轮对话和多个任务；每次委派执行都有独立任务记录和有效权限，之前的单次批准不延续。保留 SubAgent 身份不要求空闲时持续运行模型或工具进程。取消整项委托会停止其活动与排队子任务，不影响其他委托；迟到结果保留供查阅，不重启已取消的工作，未汇总的改动与产物保留。

`ruukoto-code` 的用户界面采用工作区 → 会话：工作区对应拥有者选择的开发根目录，可包含多个仓库；SubAgent 的临时 worktree 是该工作区的执行副本，旧项目关系在迁移时映射。首次启动时按需拉起本机后台，退出 TUI 后任务继续，显式停止才结束后台；崩溃后保留记录并提示恢复，不自动重放结果未知的操作。

同一份工作文件只允许一个 Agent 写入；并行编码使用独立 Git worktree，由主 Agent 汇总改动并验证，非 Git 目录的写任务串行。上下文独立不等于文件改动隔离，现有目录占用机制需要按此行为调整。

`ruukoto` 只有一个面向拥有者的持续主会话，SubAgent 可以有独立工作上下文，main 委派长任务后继续响应新消息。完成或失败后的最终结果由 main 汇总，自动发回原入口和原拥有者，需要审批时及时通知；普通进度按需提供，不广播到其他入口。单会话不要求所有实际工作串行，完整历史与有界模型上下文仍分别管理。

`ruukoto` 通过专用账户按明确授权管理服务器，绑定的拥有者私聊应能完成审批。拥有者可为具体操作和目标保存可查看、可撤销的长期授权，例如重启指定服务；范围外仍需审批，不默认长期授予任意 root 权限。`ruukoto-code` 在 macOS/Linux 上均须提供有技术约束的受限执行模式，并另设拥有者显式选择的完全访问模式；所需执行边界缺失时拒绝启动受限任务，不静默降级，具体隔离实现先验证再选择。

共享记忆由 Agent 提出候选，经拥有者确认发布或修改跨端偏好；本端记忆的正常积累不依赖另一端在线。具体同步机制在共享功能实施阶段决定。

第一阶段按顺序验证本地仓库修改与测试、通过 IM 完成服务器管理事务、后台长任务期间持续响应新消息。跨端记忆、更多渠道及正式 QQ 群聊外挂交付随后按实际需要安排。

## 与既有决策的关系

- `.scratch/daily-agent/spec.md` 中 main/coding/chat 同后台的目标架构与固定 coding 委派方向由本决策替代；其中已交付功能仍是迁移依据。
- ADR 0002 将运行位置固定为 Linux 服务器的前提不再适用于所有产品；任务与交互终端分离的原则保留，并扩展到按需拉起的开发机后台。
- ADR 0003 的技术权限边界继续保留；ADR 0004 中依赖 Linux 的实现不能直接作为 macOS 受限模式的依据。
- ADR 0011 将 IM 审批留在 TUI 的阶段性安排由本方向取代；绑定的拥有者私聊应能完成审批，身份校验与批准范围仍须由宿主验证。
- ADR 0011/0012 中子任务唤醒不自动回复的限制，为已接收拥有者委托的最终汇报增加明确例外：由 main 汇总、固定原入口和拥有者发送。该例外不授权任意主动外发。
- ADR 0013 对 GitHub 事件的固定 main → coding 路径，以及 ADR 0014 对 QQ 群聊深度接入 chat 的安排，需要随新边界修订；其余外发与身份规则不因角色删除自动放宽。
- ADR 0012 的 QQ 私聊与 Telegram 共享 main，以及 ADR 0016 区分完整历史和有界模型上下文的机制，是可复用的现有基础。旧文档中的 coding/chat 适用范围须在迁移时重新映射。

完整产品规格、首期验收场景与决策确认记录见 [方向调整规格](../../.scratch/agent-direction/spec.md)。

## 补充：ruukoto 保留普通开发会话（2026-10-05）

ruukoto 产品不拒绝普通开发会话的创建与提交。开发本项目的开发实例（`npm run dev`）运行的就是 ruukoto 产品，并以普通开发会话工作；按产品拒绝会直接打断它，而把开发实例改为 ruukoto-code 又要迁移现有开发档案（数据目录的产品归属拒绝直接切换）。两个产品的定位不变：Coding Agent 仍是编码的主要入口，ruukoto 中的普通开发会话是保留的能力，不是新的产品方向。旧项目的新建入口只在 ruukoto-code 改为工作区提示（agent-direction issue 23），不扩展到 ruukoto。

## 补充：Coding Agent 入口改名（2026-10-08）

Coding Agent 的产品入口由 `ruukoto-dev` 改为 `ruukoto-code`。同步更新了 bin 入口、产品身份、默认档案根（`~/.ruukoto-code`）和路径环境变量前缀（`RUUKOTO_CODE_*_DIR`）。用于开发本项目的隔离开发实例仍使用 `npm run dev` 与 `~/.ruukoto-dev/`，两者概念不同。

## 补充：两个产品的开发启动入口（2026-10-09）

`npm run dev` 继续启动 ruukoto 开发后台，保留 `npm run dev -- --config` 配置入口；`npm run code` 启动 ruukoto-code 开发后台并默认打开 TUI，`npm run code -- --config` 打开其配置中心。开发启动器不再接受 `--tui`。

两个开发入口复用源码监听、重载与进程管理能力，但分别保存档案：ruukoto 沿用 `~/.ruukoto-dev/<仓库>-<哈希>/`，ruukoto-code 新建 `~/.ruukoto-code-dev/<仓库>-<哈希>/`。现有开发数据库已有 ruukoto 产品归属，直接切换产品会被拒绝，因此本次不自动迁移历史；模型配置经已有 `--import-models` 显式复制。两个档案与日常产品档案分别持有数据、配置、凭据、锁与控制面，可以同时运行。

开发入口固定产品身份，不继承日常实例的路径、拥有者令牌或受保护执行账户配置，并继续停用真实 QQ / Telegram 通道。执行后端沿用 CLI 的产品默认值：ruukoto 使用 local，ruukoto-code 使用 container；container 环境不可用时任务明确失败，不回退到 local。完全访问所需的执行账户配置不在本次扩展。

两个入口均由开发启动器管理后台，退出 TUI 或配置中心、Ctrl+C 或关闭终端时停止本次启动的开发进程。开发前端不自行拉起后台，避免源码重载失败时派生未受启动器管理的进程。日常 ruukoto-code 关闭 TUI 后后台继续运行的规则仍适用于日常入口。

## 实施记录

- agent-direction issue 26（2026-10-08，第一阶段未通过）：建立 Seatbelt / bubblewrap 原生候选的真实边界探针；更正旧 macOS `/tmp` 路径别名导致的文件规则否决依据。尚未接入产品、未切换 container 默认值；macOS 脱离进程组的后代回收与 tx 的 namespace 能力仍未满足前置验收。见 ADR 0004 的验证门槛与工单 26。

- agent-direction issue 11（2026-10-03）：通用只读委派首版——工作委托/SubAgent/执行任务分开保存、普通开发会话与 main 的非阻塞只读委派、结果回传与空闲保留、main 分析委派转通用链路，决定见 [ADR 0020](0020-work-delegation-subagent-task.md)。继续委派复用、同级通信、显式关闭与整项取消、恢复分别由 issue 12–15 实施。
- agent-direction issue 12（2026-10-04）：继续、复用与显式关闭——同一父会话内沿 `work_id` 补充原工作、用 `sub_agent_id` 复用空闲 Agent 承接新工作（重新确定读范围/资料/目录/权限）、主 Agent 工具与拥有者控制面/CLI 显式关闭（独立 `closed_at`/`closed_by` 列，不自动关闭，含活动任务拒绝），决定见 ADR 0020 补充段。同级通信、整项取消与恢复分别由 issue 13–15 实施。
- agent-direction issue 14（2026-10-04）：整项工作取消——拥有者控制面 `work_cancel`（CLI `ruukoto work cancel`）与主 Agent 工具 `subagent_cancel`，取消为 `work_delegations` 独立三列（一次写入、幂等），登记事务内取消排队任务并给活动任务写取消意图、提交后按现有停止路径处理；已取消的工作拒绝继续委派，迟到结果保存为事实但不送达父模型，取消不关闭 SubAgent、不删历史与产物；并作根因修复：单任务取消落在「已转 running、未进 Driver」窗口不再被吞（`cancel_requested` 先持久化 + `runInner` 启动检查）。决定见 ADR 0020 补充段。同级通信与恢复由 issue 13、15 后续实施。
- agent-direction issue 13（2026-10-05）：同项工作内 SubAgent 相互通信——协作加入（`work_id` 与 `sub_agent_id` 同现把空闲 Agent 拉入既有只读工作，参与者经任务关联列记录，修改工作与宿主评审不接受加入）；`subagent_message` 交换有来源的消息（发送方身份由发起任务核实，按（工作, 发送方, 键）幂等，消息不扩大权限；发给 SubAgent 的投递为其本工作的 confirm 任务、发给主 Agent 的经 dev 注入或 main 唤醒送达；忙/名额满待投递并在终态、启动、取消与关闭时冲刷，资格已失记明确未投递结果；复用后旧协作关系不延续，关闭不当成重建理由），决定见 ADR 0020 补充段。恢复由 issue 15 后续实施。
- agent-direction issue 16（2026-10-04）：可写 SubAgent 与按工作隔离的 Git worktree——普通开发会话经 `subagent_delegate(mode=modify, target)` 发起修改委派；Git 目标每项工作一个宿主在受限容器内生成的 worktree（`<dataDir>/../agent-work/worktrees/<workId>`，分支 `ruukoto/work-<workId>`，基线为委派时 HEAD，子任务不提交、共享 Git 目录只读），非 Git 目标直接写入并与父会话串行；目录占用升级为祖先/子孙判定、释放按 `taskId`，写入目标钉定于 `work_delegations.write_target`（v27）；宿主永不执行 git，副本一律保留、不提供删除入口。决定见 [ADR 0021](0021-subagent-worktrees.md)。main 的修改委派、改动汇总与提交由 issue 17 后续实施。
- agent-direction issue 17（2026-10-05）：改动汇总与 main 修改委派——主 Agent 工具 `subagent_integrate(work_id)`（dev/main 均装配、回报唤醒轮次也允许）把工作 id 钉定副本相对基线的完整差异经容器内 git 预检后套用到父工作区待提交区（不代提交、`apply --check` 通过才写入）：冲突零写入、双方成果保留并点名文件；完整差异已在工作区按幂等返回（already）；空差异如实告知（empty）；非 Git 直接写入无副本如实告知。套用成功登记 `work_delegation.integrated` 事件关联原工作（分支/基线/父 HEAD/文件清单/统计），账本按事件核实、登记缺失报无法核实；套用前核实 busy/副本身份/仓库根归属；只按工作 id 取首次钉定目标，Agent 复用不把旧工作改动带进新工作；取消/关闭不拦汇总（成果可找回）。main 的修改委派开放（普通分析与修改职责均有通用替代路径），旧 `coding_delegate mode=draft` 仅迁移期兼容；协议 v15。决定见 [ADR 0021](0021-subagent-worktrees.md) 补充段。
- agent-direction issue 18（2026-10-04）：异步工作最终结果送回原 IM 入口——IM 来源任务发起的通用工作，由宿主在收尾的 main 唤醒结果事务内经 `owner_reply` 槽登记一次最终汇报（键 `<发起事件 id>#work:<workId>:<收尾执行任务 id>`、正文为唤醒轮次最终回答加固定首行、目标沿用发起事件钉版目标；重复/补记幂等，已取消工作不汇报，离线等待与效果未知不重发沿用 outbox）；ADR 0011/0012「子任务唤醒不产生 owner 回复」的例外仅限该收尾轮次，授权不扩大（不新增工具、唤醒轮次外发请求仍按原规则核实）。旧 draft 链与 GitHub 来源不纳入（17/19 迁移后自动适用规则已定）。
- agent-direction issue 19（2026-10-04）：GitHub PR 评审迁移到通用 SubAgent——每个修订由编排器直接登记一项新工作、一个新 SubAgent（hostReview 不经模型工具、不占 main 名额、带来源事件复用出队门与通知回写），只读 MCP 按任务开放且只给评审任务（GitHub MCP 改配 main 角色项目），main 结果唤醒开放 `subagent_result`；升级前在途的旧 coding 评审子任务沿原路径接管，不再新建；决定见 [ADR 0013](0013-github-event-review.md) 修订段。评审工作不适用 issue 18 的最终汇报（固定通知沿用 ADR 0013）。
- agent-direction issue 20（2026-10-04）：核心群聊退役与旧群资料保全——执行本决策对 ADR 0014 的修订：chat 角色不再引导，群消息直接忽略，允许群写入口删除（控制协议 v14），旧群资料原地保留为只读归档（inbox 附接收账本与当前复核结论），升级收尾按状态幂等只定终态不重放；`chat_result_*` 与发送前复核不变，撤回观测上限不变（断连/退群后无法得知）。旧类型、工具类别与角色行的收缩由 issue 23 实施，跨实例迁移由 issue 22 实施，正式群聊外挂在后续阶段交付（本单不依赖外挂接口）。
- agent-direction issue 21（2026-10-04）：旧实例开发资料迁入 Coding Agent——目标侧离线 `ruukoto-code legacy-import`（preview/apply/revert/list），源全程只读（文件级快照），行 ID 原样保留、allow-list 导入单位、未终态收尾不重放、个人记忆仅显式选中、凭据不迁移（缺绑定以停用导入）、回执与条目账本（v28）支持幂等续跑与回退，决定见 [ADR 0022](0022-legacy-instance-import.md)。
- agent-direction issue 15（2026-10-05）：后台重启后恢复 SubAgent 与工作记录——排队的委派执行任务定 interrupted(backend_restart)、不自动继续也不当作新委派，巡检补记一次结果后按占用核实记 idle/unverified，继续与否由拥有者/父 Agent 决定；宿主固定评审排队任务由编排器启动恢复自动继续；`resume-queue` 是 unverified 回 idle 的出口，决定见 ADR 0020 补充段。
- agent-direction issue 22（2026-10-05）：旧主会话与服务状态迁入全新 Personal Agent——镜像方向 `ruukoto legacy-import`：角色会话与群归档、应用数据、调度、平台绑定（config_version 与 telegram 偏移原样）、长期授权、GitHub 归档与必要凭据（平台/webhook 绑定，同名异值拒绝）整体迁入，目标须为全新实例；不重放收尾扩到交接面（运行关闭、pending 发送取消、sending 置效果未知、入站落定），执行归属随导入切换（逾期调度在目标触发一次、入站按偏移续消费），易变行按回执 manifest 逐行 sha 核对、目标启动后活动为回退阻挡项（v30 账本扩五类），决定见 [ADR 0023](0023-personal-instance-import.md)。
- agent-direction issue 23（2026-10-05）：固定角色退役收尾——编排器只引导 main，`coding_delegate` 与旧 coding 委派/自动重试/GitHub 旧评审接管分支删除，coding 角色会话与 chat/群会话同为只读归档（提交拒绝、启动收尾取消排队任务，在途旧子任务补记一次结果与唤醒、不重放），`coding_result` 保留只读查阅；chat 工具类别与提示、Driver/上下文的 qq_group 分支与撤回过滤、QqStore 群写方法删除。存储 CHECK、`AgentRoleId` 与 `qq_group` 会话类别对应旧行实值，保留不收缩；ruukoto-code 的用户入口不再提供旧项目新建路径。ruukoto 产品中普通开发会话的写入口保留，见上文补充段。
