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
6. **结果与空闲同事务登记。** 结果沿用 `setTaskResult` 一次写入；无占用残留记空闲，执行单元退出未核实记待核实。dev 父会话经持久事件 + 下一次模型调用的宿主资料注入送达（注入标记 `result_delivered_at`，崩溃窗口不丢记录）；main 沿用稳定 `wake:<childId>` 回报键。main 的 `coding_delegate(mode=analyze)` 转入本链路（硬只读、不自动重试），`coding_result` 经同一归属窄口兼容读取；draft 修改委派保留旧 coding 路径。

## 与既有决策的关系

- ADR 0017 的通用 SubAgent 目标模型经本决定落地首版；固定 coding/chat 角色继续存在至后续迁移，新旧委派机制兼容共存。
- ADR 0003 的访问模式边界不变：SubAgent 任务一律 confirm，快照与读范围是授权边界的收窄而非扩大。
- ADR 0016 的上下文分类新增 `subagentResults` 宿主参考块（dev 父会话结果注入），与会话历史分开。
