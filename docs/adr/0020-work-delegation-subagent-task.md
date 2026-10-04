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
2. **有活动任务时拒绝关闭。** 活动任务指 queued/running/awaiting_confirmation；提示等待任务结束，或由拥有者 `ruukoto cancel <taskId>` 后再关闭。不引入「已关闭但仍在跑当前任务」的中间态；整项取消属于 14。关闭与新委派在同一同步事务内定胜负：先关闭则委派报「已关闭」（零新任务），先登记则关闭报「有活动任务」。
3. **继续与复用都要求可用。** 可用指同一父会话、未关闭、`idle` 且无活动任务、工作目录 realpath 与 dev/ino 和子会话记录一致；忙碌明确拒绝不排队（同时修复 11 遗留的 `current_task_id` 覆盖后状态虚置问题）。复用（`sub_agent_id`，与 `work_id` 互斥）登记一条新 `work_delegations` 行指向既有 Agent，上下文即该 Agent 同一子会话的全部历史；参数摘要只在提供 `sub_agent_id` 时纳入该字段，旧重放摘要不变。快照按 `materials-<workId>-<key>.txt` 命名，复用不覆写旧工作快照。准备或登记失败只清理本次内容——首次委派删新建目录，沿用目录只删本次写入的快照文件，正文超限检查纳入同一清理范围（同时修复 visual-docs-review 工单 03 的两处残留）。
4. **来源复核取并集。** 登记事务内与每次发送上下文前的 verify 对象是该 Agent 全部历史任务的来源引用与本次的并集：复用保留的上下文含旧工作资料，任一撤销即拒绝登记或阻断发送（`task_sources_revoked`）。
5. **查看。** `subagent_result` 省略 `work_id` 列出本会话 SubAgent 总览（供跨轮次挑选复用对象），按工作读取标明是否已关闭；`work_list`/`work_get` 的 agent 对象自然带上关闭两列；TUI 经 `subagent.closed` 事件与快照展示「已关闭」，不新增 TUI 命令。任务终态、TUI 退出与空闲不自动关闭，也无需空闲超时配置。
6. **结果与空闲同事务登记。** 结果沿用 `setTaskResult` 一次写入；无占用残留记空闲，执行单元退出未核实记待核实。dev 父会话经持久事件 + 下一次模型调用的宿主资料注入送达（注入标记 `result_delivered_at`，崩溃窗口不丢记录）；main 沿用稳定 `wake:<childId>` 回报键。main 的 `coding_delegate(mode=analyze)` 转入本链路（硬只读、不自动重试），`coding_result` 经同一归属窄口兼容读取；draft 修改委派保留旧 coding 路径。

## 补充：整项取消（agent-direction issue 14，2026-10-04）

1. **取消用独立列，一次写入。** `work_delegations` 增加 `canceled_at`、`canceled_by`（`owner` 或 `agent:<任务ID>`）、`cancel_reason`（schema v26 只补列，旧行三列为空），条件 `canceled_at IS NULL`，重复取消幂等返回原记录与当前任务状态。工作状态由字段与任务状态派生（已取消/进行中/空闲），不新建状态机，不改写已结束任务的 completed/failed/canceled 结果。
2. **发起者：拥有者与主 Agent。** 拥有者走控制面 `work_cancel`（协议 v13）与 `ruukoto work cancel <工作ID> [--reason R]`；主 Agent 用 `subagent_cancel(work_id, reason?)`（普通 dev 会话与 main 都装配，回报唤醒轮次也允许——取消只收窄能力，与 12 的关闭同一口径）。SubAgent 自身（无此工具，verifyHost 拒绝）和其他父会话的工作一律拒绝。
3. **一个事务登记，停止在事务外完成。** 事务内写取消字段、该工作的 queued 任务直接转为 canceled（`errorMessage` 记 `work_canceled`）、running/awaiting 任务写 `cancel_requested=1`，并追加 `work_delegation.canceled` 事件（区分 `canceledTaskIds` 与 `stoppingTaskIds`）；提交后对每个活动任务调用现有 `cancelTask` 停止路径（`Promise.allSettled`）。登记事务与委派登记同为同步事务、天然串行：先登记的任务必然在取消清单内，后登记的字段已写入即被委派检查拒绝；同键同参重放仍返回原记录。无法回收的执行按现有逻辑保留占用，SubAgent 记 unverified。
4. **单任务取消窗口修复（根因，所有取消调用方共享）。** 取消落在「任务已转 running、`currentTask` 尚未设置」的窗口时旧代码会被吞掉：`cancelTask` 先在事务内写 `cancel_requested=1` 再 `requestStop`，`Driver.runInner` 开头读到该标记直接 `finalize(canceled)`、不调用模型。已知上限：超时取消若正好落在该窗口，终态记 canceled 而非 timeout，不另外存原因（ponytail 注释）。
5. **迟到结果保存为事实，不送达父模型。** 终态结果照常经 `setTaskResult` 登记（`subagent_task.*` 事件、`subagent_result` 与 `work show` 可查）；取消提交后不再自动送进任何父模型：编排器唤醒前重读工作、队列循环对 `wake:<childId>` 启动前检查所属工作（直接取消该 wake，覆盖排队中、后插入与巡检补发的全部唤醒）、dev 注入查询加 `canceled_at IS NULL`、启动巡检待唤醒清单排除已取消工作。选「不注入」而非「以迟到结果名义注入」，用一条规则排除主 Agent 据此重启工作的可能；需要时由主 Agent 主动 `subagent_result` 读取。main 正在运行的唤醒轮次不级联取消。
6. **身份与成果保持。** 取消不关闭 SubAgent（任务结束后按占用核实记 idle 或 unverified，之后仍可按 12 复用于其他工作）；工作目录、会话 JSONL、产物、resultRef 与工作记录都不删除。旧 coding draft 没有 `work_id`，不纳入工作取消，仍用 `ruukoto cancel <taskId>`；效果未知的已有操作只标记、不重放，沿用账本既有停止口径。

## 与既有决策的关系

- ADR 0017 的通用 SubAgent 目标模型经本决定落地首版；固定 coding/chat 角色继续存在至后续迁移，新旧委派机制兼容共存。
- ADR 0003 的访问模式边界不变：SubAgent 任务一律 confirm，快照与读范围是授权边界的收窄而非扩大。
- ADR 0016 的上下文分类新增 `subagentResults` 宿主参考块（dev 父会话结果注入），与会话历史分开。
