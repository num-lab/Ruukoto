# Agent Note: 工作委托、SubAgent 与执行任务分开保存

Status: implemented

原编号：ADR 0020

## 问题

[两个产品](2026-10-02-two-agent-products.md) 确认两个产品支持一层 SubAgent：身份与上下文跨任务保留，工作委托可跨多轮对话、含多次执行任务。实施前代码只有固定 coding 委派：共享角色会话承接全部子任务，Agent 身份与一次任务没有分离，普通开发会话没有委派工具。

## 决定

1. **三个领域对象分三张（组）记录。** `work_delegations` 保存工作（所属父用户会话、发起任务、首次委派键与参数摘要）；`sub_agents` 保存动态身份（独立 ID、父用户会话、独立 Session、宿主生成的独立工作目录、当前工作指针与运行/空闲/待核实状态）；`tasks` 保存每次执行并新增可空关联列 `work_id`、`sub_agent_id`、限定资料范围 `read_scope` 与结果注入标记 `result_delivered_at`。一次任务终态不等于工作关闭或 Agent 关闭。
2. **动态身份不进旧角色列。** 保留 `AgentRoleId`、`agent_roles` 与 `tasks.agent_id` 的 main/coding/chat 固定角色语义与 CHECK 约束；SubAgent 身份由宿主经 `sub_agents` 表按会话绑定识别（`getSubAgentBySession`），区分工作/Agent/每次执行，不落入无角色的默认 dev 工具类别。
3. **幂等键分两级。** 首次委派以（父用户会话，键）唯一查工作；工作内以（子会话，`sdelegate:<workId>:<key>`）查任务。工作参数摘要不包含本次调用的直接父任务 id 与模型选择——跨对话轮次重放核实同一逻辑委派，返回首次记录；同键异参明确冲突。
4. **登记与调度分开。** 准备（模型门闩预检、受限执行入口预检、宿主生成的独立目录、路径与资料核实、快照落盘）在事务外完成；工作/Agent/Session/排队任务/审计事件在一个同步事务内提交，提交后才 kick 子会话。不串行调用两个各自提交的入口留下半成品；文件准备与 SQLite 无跨系统事务，失败只清理本次新建且无已提交引用的目录。
5. **能力按工作钉定，子任务固定 confirm。** 分析工作使用 read / read_artifact 静态白名单；[工作内消息](../feature/2026-10-05-subagent-messaging.md)在允许协作的任务中追加 subagent_message，装配、发送前与调用门采用同一结论。读范围由宿主钉定传入 worker（路径与目录身份），实际打开文件时复核范围和身份；只读挂载不能代替读取范围校验。main 的资料经 SourceResolver 在有效权限内解析为有界快照，来源引用随任务保存并在每次发送上下文前重新 verify，不复制完整父历史、不自动注入父指令、个人记忆或技能。read_artifact 只读本次自产，拒绝其他任务产物与 prompt-snapshot；未接收群资料和已接收群摘要都不能作为委派资料。任务不继承父 full_access、默认模式、写路径授权、单次批准或长期授权。修改工作由[独立 worktree 决定](2026-10-04-subagent-worktrees.md)扩展，分析工作不能升级为写入。
6. **在线身份与指针统一由 SubAgentManager 写入。** state、当前工作与当前任务指针均由管理器写入，Store 保留 SQL 原语，离线导入收尾除外。继续、复用、协作加入、消息登记与冲刷共用管理器私有资格判断；关闭、跨父会话、宿主固定评审、工作取消与当前工作不符明确拒绝或记未投递，忙碌/名额满的消息保留待投递。管理器自行读取父 Task 的固定 planMode，不接受调用方提供的 planMode；既拒绝显式 modify，也拒绝继续已有 writeTarget 的工作。PLAN_TOOL_NAMES 不开放 subagent_delegate，这道宿主校验不授予计划模式模型分析委派能力。统一写入者不新增 schema、控制协议或事件名。
7. **新委派只经通用链路。** coding_delegate 的 analyze 转接和 draft 旧路径均已删除，main 的分析与修改只经 subagent_delegate；coding_result 保留为旧 coding 子任务与本会话 SubAgent 结果的只读窄口。旧角色 CHECK 保留旧行实值，新角色/委派任务只以 main 或 SubAgent 身份登记，普通 dev 任务仍按用户会话身份登记。宿主 GitHub 评审由编排器直接登记，不作为 main 的普通委派，也不提供复用、协作加入或工作内消息入口。

## 与相关决定的关系

[两个 Agent 产品](2026-10-02-two-agent-products.md)的一层 SubAgent 目标模型由此落地。身份完成一次任务后保留，上下文跨任务保留；[继续、复用与关闭](../feature/2026-10-04-subagent-reuse-close.md)、[整项取消](../feature/2026-10-04-cancel-work.md)、[工作内消息](../feature/2026-10-05-subagent-messaging.md)、[后台重启恢复](2026-10-05-subagent-restart-recovery.md)分别记录可独立取代的决定。

[显式访问模式](../feature/2026-09-19-explicit-access-modes.md)的权限边界不变；[有损上下文压缩](2026-09-26-lossy-context-compaction.md)中的宿主参考块新增 subagentResults 与 subagentMessages，均与会话历史分开。

## 曾经的做法与改动原因

首版只有只读通用委派，与固定 coding/chat 角色共存；main 的 coding_delegate(analyze) 曾转入通用硬只读链路、draft 留在旧 coding 路径。迁移完成后两个入口删除，避免继续维护两套委派规则，旧结果仍可查。早期计划模式资格曾沿 resumesTaskId 链判断；[Plan 会话模式](../feature/2026-10-08-plan-session-mode.md)改由可信提交固定字段确定，不继续从历史文本或继续链推断。

## 备选方案

沿用固定 coding 角色会话可复用既有调度与角色列，无须新增动态身份记录；但所有子任务共享上下文，无法满足同一用户会话保留多个 SubAgent、工作跨任务延续的目标，所以不沿用它作为通用委派模型。原实现与改动动机见[工单 11](../../../../.scratch/agent-direction/issues/11-subagent-delegation.md)。

只靠容器只读挂载能阻止挂载资料写入、复用现成 launcher；但 worker 的 readOperations 仍直接读文件，不能限制读取指定资料或容器内部范围外路径。因此在读取边界增加宿主钉定的 readScope，不把只读挂载当作读取授权。这个被否前提见同一工单「资料与读取边界」。

## 后果

工作、身份与执行可分别查阅和恢复，主会话等待子结果期间仍可处理新消息。代价是登记、结果送达、状态与目录身份必须跨表一致，文件准备与 SQLite 无跨系统事务，必须按已提交引用清理，不能因半成品重新执行分析。动态 SDK 运行对象在执行退出、结果提交后释放，释放不删除身份、历史与产物。

## 验证

首次实施的历史证据见[工单 11](../../../../.scratch/agent-direction/issues/11-subagent-delegation.md)：test/80 11/11，npm run typecheck 通过；全量 npm test 873 项中 872 通过、0 失败、1 跳过。smoke-11-subagent-delegation.mts 在 macOS Docker Desktop 与 ssh tx Linux 原生 Docker 各 9/9，Runtime、SQLite、JSONL、文件与容器为真实环境，模型和消息平台为模拟。未实测真实 QQ/Telegram 与非默认 uid 的 ACL 行为；权限位预检和 worker 实际拒绝分别覆盖。

## 适用范围

完全访问的账户、环境、免审批及宿主任务授权传播采用[本决定](../feature/2026-10-12-full-access-current-account.md)；本篇其他独立规则继续适用。

通用调度的独立执行、运行归属、审批来源与整项取消采用[本决定](../feature/2026-10-12-generic-scheduled-tasks.md)；本篇其他独立规则继续适用。
