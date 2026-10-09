# 工作委托、SubAgent 与执行任务分开保存（首版只读通用委派）

日期：2026-10-03

状态：已接受（agent-direction issue 11 实施记录；衔接 ADR 0017 的一层 SubAgent 目标模型与工作委托/任务领域关系）。

## 背景

ADR 0017 确认两个产品支持一层 SubAgent：身份与上下文跨任务保留，工作委托可跨多轮对话、含多次执行任务。实施前代码只有固定 coding 委派：共享角色会话承接全部子任务，Agent 身份与一次任务没有分离，普通开发会话没有委派工具。

## 决定

1. **三个领域对象分三张（组）记录。** `work_delegations` 保存工作（所属父用户会话、发起任务、首次委派键与参数摘要）；`sub_agents` 保存动态身份（独立 ID、父用户会话、独立 Session、宿主生成的独立工作目录、当前工作指针与运行/空闲/待核实状态）；`tasks` 保存每次执行并新增可空关联列 `work_id`、`sub_agent_id`、限定资料范围 `read_scope` 与结果注入标记 `result_delivered_at`。一次任务终态不等于工作关闭或 Agent 关闭。
2. **动态身份不进旧角色列。** 保留 `AgentRoleId`、`agent_roles` 与 `tasks.agent_id` 的 main/coding/chat 固定角色语义与 CHECK 约束；SubAgent 身份由宿主经 `sub_agents` 表按会话绑定识别（`getSubAgentBySession`），区分工作/Agent/每次执行，不落入无角色的默认 dev 工具类别。
3. **幂等键分两级。** 首次委派以（父用户会话，键）唯一查工作；工作内以（子会话，`sdelegate:<workId>:<key>`）查任务。工作参数摘要不包含本次调用的直接父任务 id 与模型选择——跨对话轮次重放核实同一逻辑委派，返回首次记录；同键异参明确冲突。
4. **登记与调度分开。** 准备（模型门闩预检、受限执行入口预检、宿主生成的独立目录、路径与资料核实、快照落盘）在事务外完成；工作/Agent/Session/排队任务/审计事件在一个同步事务内提交，提交后才 kick 子会话。不串行调用两个各自提交的入口留下半成品；文件准备与 SQLite 无跨系统事务，失败只清理本次新建且无已提交引用的目录。
5. **首版只读。** SubAgent 任务只有 read / read_artifact（装配、发送前与调用门同一静态白名单），confirm 模式固定、不继承父模式与长期授权；读范围由宿主钉定传入 worker（路径与目录身份），main 的资料经来源解析为快照正文、来源引用随任务保存并在每次发送上下文前重新 verify。同级通信、worktree 复用、显式关闭与整项取消、恢复状态机分别由 12–15 实现，本决定不提前引入。

## 补充：继续、复用与关闭（agent-direction issue 12，2026-10-04）

1. **关闭用独立列，不改状态值。** `sub_agents` 增加 `closed_at`、`closed_by`（`owner` 或 `agent:<任务ID>`；schema v25 只补列，旧行两列为空）。`state` 继续只表示执行状态（running/idle/unverified），不重建 CHECK；待核实的 Agent 也能关闭，占用核实仍由 15 处理。
2. **有活动任务时拒绝关闭。** 活动任务指 queued/running/awaiting_confirmation；提示等待任务结束，或由拥有者 `ruukoto cancel <taskId>` 后再关闭。不引入「已关闭但仍在跑当前任务」的中间态；整项取消属于 14。关闭与新委派在同一同步事务内定胜负：先关闭则委派报「已关闭」（零新任务），先登记则关闭报「有活动任务」。关闭保持同步，在关闭事务内经管理器 `pendingMessageContext` 统一判定并清理发给该 Agent 的待投递消息；不异步冲刷其他 Agent，关闭前无活动任务也无释放名额的需要。
3. **继续与复用都要求可用。** 可用指同一父会话、未关闭、`idle` 且无活动任务、工作目录 realpath 与 dev/ino 和子会话记录一致；忙碌明确拒绝不排队（同时修复 11 遗留的 `current_task_id` 覆盖后状态虚置问题）。复用（`sub_agent_id`，与 `work_id` 互斥）登记一条新 `work_delegations` 行指向既有 Agent，上下文即该 Agent 同一子会话的全部历史；参数摘要只在提供 `sub_agent_id` 时纳入该字段，旧重放摘要不变。快照按 `materials-<workId>-<key>.txt` 命名，复用不覆写旧工作快照。准备或登记失败只清理本次内容——首次委派删新建目录，沿用目录只删本次写入的快照文件，正文超限检查纳入同一清理范围（同时修复 visual-docs-review 工单 03 的两处残留）。
4. **来源复核取并集。** 登记事务内与每次发送上下文前的 verify 对象是该 Agent 全部历史任务的来源引用与本次的并集：复用保留的上下文含旧工作资料，任一撤销即拒绝登记或阻断发送（`task_sources_revoked`）。
5. **查看。** `subagent_result` 省略 `work_id` 列出本会话 SubAgent 总览（供跨轮次挑选复用对象），按工作读取标明是否已关闭；`work_list`/`work_get` 的 agent 对象自然带上关闭两列；TUI 经 `subagent.closed` 事件与快照展示「已关闭」，不新增 TUI 命令。任务终态、TUI 退出与空闲不自动关闭，也无需空闲超时配置。
6. **结果与当前身份状态同事务登记。** 结果沿用 `setTaskResult` 一次写入；编排器在结果事务内调用 `SubAgentManager.resultRecorded(task)`，仅 `currentTaskId === task.id` 时按子会话占用记空闲或待核实，并清空当前任务。旧任务首次补记仍保存结果与事件，不倒写当前新工作与任务。这是对历史补记和不一致记录的防御；播种历史组合的验证不代表该组合已被证明可由正常流程自然形成。dev 父会话经持久事件 + 下一次模型调用的宿主资料注入送达（注入标记 `result_delivered_at`，崩溃窗口不丢记录）；main 沿用稳定 `wake:<childId>` 回报键。main 的 `coding_delegate(mode=analyze)` 转入本链路（硬只读、不自动重试），`coding_result` 经同一归属窄口兼容读取；draft 修改委派保留旧 coding 路径。

## 补充：整项取消（agent-direction issue 14，2026-10-04）

1. **取消用独立列，一次写入。** `work_delegations` 增加 `canceled_at`、`canceled_by`（`owner` 或 `agent:<任务ID>`）、`cancel_reason`（schema v26 只补列，旧行三列为空），条件 `canceled_at IS NULL`，重复取消幂等返回原记录与当前任务状态。工作状态由字段与任务状态派生（已取消/进行中/空闲），不新建状态机，不改写已结束任务的 completed/failed/canceled 结果。
2. **发起者：拥有者与主 Agent。** 拥有者走控制面 `work_cancel`（协议 v13）与 `ruukoto work cancel <工作ID> [--reason R]`；主 Agent 用 `subagent_cancel(work_id, reason?)`（普通 dev 会话与 main 都装配，回报唤醒轮次也允许——取消只收窄能力，与 12 的关闭同一口径）。SubAgent 自身（无此工具，verifyHost 拒绝）和其他父会话的工作一律拒绝。
3. **一个事务登记，停止在事务外完成。** 事务内写取消字段、该工作的 queued 任务直接转为 canceled（`errorMessage` 记 `work_canceled`）、running/awaiting 任务写 `cancel_requested=1`，并追加 `work_delegation.canceled` 事件（区分 `canceledTaskIds` 与 `stoppingTaskIds`）；提交后对每个活动任务调用现有 `cancelTask` 停止路径（`Promise.allSettled`）。登记事务与委派登记同为同步事务、天然串行：先登记的任务必然在取消清单内，后登记的字段已写入即被委派检查拒绝；同键同参重放仍返回原记录。无法回收的执行按现有逻辑保留占用，SubAgent 记 unverified。
4. **单任务取消窗口修复（根因，所有取消调用方共享）。** 取消落在「任务已转 running、`currentTask` 尚未设置」的窗口时旧代码会被吞掉：`cancelTask` 先在事务内写 `cancel_requested=1` 再 `requestStop`，`Driver.runInner` 开头读到该标记直接 `finalize(canceled)`、不调用模型。已知上限：超时取消若正好落在该窗口，终态记 canceled 而非 timeout，不另外存原因（ponytail 注释）。
5. **迟到结果保存为事实，不送达父模型。** 终态结果照常经 `setTaskResult` 登记（`subagent_task.*` 事件、`subagent_result` 与 `work show` 可查）；取消提交后不再自动送进任何父模型：编排器唤醒前重读工作、队列循环对 `wake:<childId>` 启动前检查所属工作（直接取消该 wake，覆盖排队中、后插入与巡检补发的全部唤醒）、dev 注入查询加 `canceled_at IS NULL`、启动巡检待唤醒清单排除已取消工作。选「不注入」而非「以迟到结果名义注入」，用一条规则排除主 Agent 据此重启工作的可能；需要时由主 Agent 主动 `subagent_result` 读取。main 正在运行的唤醒轮次不级联取消。
6. **身份与成果保持。** 取消不关闭 SubAgent（任务结束后按占用核实记 idle 或 unverified，之后仍可按 12 复用于其他工作）；工作目录、会话 JSONL、产物、resultRef 与工作记录都不删除。旧 coding draft 没有 `work_id`，不纳入工作取消，仍用 `ruukoto cancel <taskId>`；效果未知的已有操作只标记、不重放，沿用账本既有停止口径。

## 补充：工作内消息与协作加入（agent-direction issue 13，2026-10-05）

1. **协作加入**：`work_id` 与 `sub_agent_id` 同现的委派把一个既有空闲 SubAgent 拉入既有只读工作登记一次执行任务（任务关联列指向协作方；工作行保持首次承接者，参与者集合经 `tasks.sub_agent_id` 判定）。复用/继续/加入的可用性、竞争仲裁与来源并集复核与 issue 12 同一口径；加入的幂等键按目标 Agent 会话核实（不同协作方同键独立）。修改工作同一份文件单一写入者，宿主评审是固定单 Agent 流程，都不接受协作加入。
2. **发送方身份由发起任务核实**，模型参数不提供身份：工作父会话的任务 = 主 Agent（必须指定接收方），本工作的 SubAgent 任务 = 该 SubAgent（只能从本工作的任务中发送）；其他会话、其他工作、宿主评审 SubAgent 一律拒绝。接收方必须当前承接本工作（`active_work_id` 正是本工作）且未关闭——复用转做其他工作后旧协作者与迟到旧消息都失去资格（不进入新工作上下文）；不把关闭当作重新创建 Agent 的理由；已取消的工作不能投递。
3. **存储与幂等**：`subagent_messages` 表（schema v29 只建表，旧库表为空不回填）。按（工作, 发送方, 键）查重先于执行预检：同键同参的重放即使此后已取消/关闭也返回原记录，异参冲突。`message` 异步准备后，在同步登记事务内再次查重、执行预检返回的 `check` 并重核当前资格与模型选择；消息行带来源（发送方、发起任务）、投递与未投递结果，可追溯。发给 SubAgent 或 main 唤醒都须在事务外核实模型配置与受限执行入口；新消息遇 `model_config_busy` 等预检失败或模型选择变动，零新增消息、任务与事件。纯 dev 父会话注入不创建新执行，无需这道执行预检。`ParentDelivery.messageRecorded(msg, work, selection)` 只使用管理器已核实的模型选择插入 main 消息唤醒。
4. **投递不扩大权限**：发给 SubAgent 的投递为它在本工作的一次 `confirm` 执行任务（请求键 `smsg:<消息ID>`，`readScope` 沿用其在本工作最近任务的钉定，工具清单仍按工作内容钉版、另加 `subagent_message`）；发给主 Agent 的经 dev 注入（`[工作内消息]` 参考块，与结果注入同一收集与标记事务）或 main 唤醒任务（`agentId=main`、confirm、无截止时间）。正文上限 4096。
5. **待投递与冲刷**：接收方忙碌或父会话活动任务名额已满（3，与委派限额同一计数）时登记为待投递；宿主机在 SubAgent 任务终态（编排器结果登记后）、启动恢复、整项取消、resume-queue 核实完成与模型配置应用结束后异步冲刷。关闭仅在自身同步事务内清理目标 Agent 的待投递消息。冲刷先核资格，忙碌/名额满保持待投递且不做执行预检；具备投递条件时才预检，任意预检失败均保留已登记消息并输出诊断。Runtime 在模型配置应用的 `finally` 中等待冲刷，成功与回滚都按当前配置再投；资格已失（`moved_work`/`closed:<时刻>` 等）或工作已取消记明确未投递结果并发 `subagent_message.dropped`。异步等待期间可能登记新委派，因此投递事务必须重核当前工作、资格与模型选择，按原 `smsg:<消息ID>` 键与一次写入标记仲裁；旧消息不能进入新工作，同一条消息不能投递两次。不依赖终态后的同步续段优先于新委派，也不增加锁。消息补建统一由管理器 `flushPendingMessages` 完成，父级送达 `sweep` 只补建结果唤醒。
6. **工具与可见性**：`subagent_message` 属 `subagent` 类别，dev 与 main 装配并经同一工厂对 SubAgent 子会话装配（宿主评审任务不激活），装配、发送前与调用门同一结论；工具操作账本按（工作, 发送方, 键）核实。主 Agent 经 `subagent_result` 的 `part=messages` 读取本工作消息；拥有者经控制面 `work_get` 的 `messages` 列表读取（控制协议 v15）；跨实例导入随所属工作的账本条目折叠。

## 补充：后台重启恢复（agent-direction issue 15，2026-10-05）

1. **排队的委派任务定 interrupted，不自动继续。** 恢复事务（`runtime.ts recover`）调用 `SubAgentManager.recoverQueuedTasks()`，把仍未启动的 SubAgent 排队执行任务（拥有者或主 Agent 委派，无 `source_event_id`）定 `interrupted(backend_restart)`；运行中任务仍由 Runtime 的通用恢复处理。排队的从未启动，无效果未知问题。不自动继续、不当作成功也不当作新委派：结果由启动巡检按 `setTaskResult` 补记一次（重复启动不重复登记），归属引用（工作/Agent/父会话/父任务）不变，main 父会话按稳定键唤醒、dev 父会话经结果注入得知，继续（沿 `work_id`、`sub_agent_id` 复用）或放弃由拥有者/父 Agent 决定。结果事务内只对当前任务仍匹配的 SubAgent 按占用记 `idle` 或 `unverified`。宿主固定评审任务带来源事件，不在此列。
2. **管理器恢复子会话，编排器恢复角色会话。** 编排器补记结果后调用管理器的异步 `start()`：先冲刷待投递消息，再仅自动恢复无遗留占用且以 `backend_restart` 暂停的 SubAgent 子会话；宿主固定评审保留的排队任务由此继续执行（issue 19 既定口径：评审不经拥有者核实）。角色队列仍由编排器恢复。`occupancy_unverified` 暂停与遗留占用不自动解除，恢复任务不与旧执行并发修改同一资源。
3. **`resume-queue` 是 `unverified` 的出口。** `unverified` 记「旧执行退出未核实」的事实；拥有者核实后 `Runtime.resumeQueue` 在释放遗留占用、解除暂停的事务内调用 `SubAgentManager.executionVerified(sessionId)`（活动任务持有的占用仍拒绝释放）。该会话无活动任务且当前终态任务结果已登记时，才可在占用释放后回到 `idle`；当前终态结果缺失报 `invalid_state`，恢复事务回滚，须先补记结果，不能宣称空闲。管理器返回父会话 ID，Runtime 在提交后 `await flushPendingMessages`。已取消工作不因启动巡检重新运行、不补发唤醒（issue 14 规则不变）。

2026-10-06 修订（架构工单 12）：在线 SubAgent 状态、当前工作与当前任务指针统一由 `SubAgentManager` 写入，Store 仍提供 SQL 原语；离线导入的收尾不在此约束内。继续、复用、协作加入、消息登记与冲刷共用管理器私有资格判断；关闭、跨父会话、宿主固定评审、工作取消与当前工作不符明确拒绝或记未投递，忙碌/名额满的消息保留待投递。管理器从父 Task 与 `resumesTaskId` 链自行判定计划模式，删除 `planMode` 入参；既拒绝显式 `modify`，也拒绝继续已有 `writeTarget` 的工作。`PLAN_TOOL_NAMES` 保持现状，未开放 `subagent_delegate`，该宿主校验不意味着计划模式模型可发起分析委派。本次修订不新增 schema、控制协议或事件名。

## 与既有决策的关系

- ADR 0017 的通用 SubAgent 目标模型经本决定落地首版；固定 coding/chat 角色继续存在至后续迁移，新旧委派机制兼容共存。
- ADR 0003 的访问模式边界不变：SubAgent 任务一律 confirm，快照与读范围是授权边界的收窄而非扩大。
- ADR 0016 的上下文分类新增 `subagentResults` 宿主参考块（dev 父会话结果注入），与会话历史分开；issue 13 再增 `subagentMessages` 参考块（dev 父会话工作内消息注入），同一性质。

2026-10-05 补充（agent-direction issue 23）：`coding_delegate`（含 analyze 转接与 draft 旧路径）删除，main 的分析与修改委派只经 `subagent_delegate`；`coding_result` 保留为旧 coding 子任务与本会话 SubAgent 结果的只读窄口。`AgentRoleId`/`agent_roles`/`tasks.agent_id` 的 CHECK 仍保留旧取值（旧行实值），新任务只会以 main 或 SubAgent 身份登记。
