# Agent Note: 后台重启恢复 SubAgent 并保留执行核实边界

Status: implemented

部分取代：[个人正式入口与旧装配退出](../simplification/2026-10-18-personal-product-entry.md)让个人安全工作按 durable 恢复，未知效果与停止未核实继续暂停；Coding 与旧格式实现仍遵守本篇原恢复规则。

个人恢复的具体来源与核实规则由[durable 迁移总方案](../../proposed/architecture/2026-10-17-personal-pi-durable.md)及各能力笔记持有；完整迁移验收仍待完成。

原出处：ADR 0020「补充：后台重启恢复」

## 问题

后台重启后必须保留[工作、SubAgent 和任务](2026-10-03-work-delegation-subagent-task.md)的归属关系，说明被中断执行，允许拥有者决定继续。早期子会话 queued 任务停在暂停队列、Agent 永久 running，unverified 也没有返回 idle 的路径；恢复还必须避免与未退出的旧执行并发写同一资源。

## 决定

1. **排队的委派任务定 interrupted，不自动继续。** 恢复事务（`runtime.ts recover`）调用 `SubAgentManager.recoverQueuedTasks()`，把仍未启动的 SubAgent 排队执行任务（拥有者或主 Agent 委派，无 `source_event_id`）定 `interrupted(backend_restart)`；运行中任务仍由 Runtime 的通用恢复处理。排队的从未启动，无效果未知问题。不自动继续、不当作成功也不当作新委派：结果由启动巡检按 `setTaskResult` 补记一次（重复启动不重复登记），归属引用（工作/Agent/父会话/父任务）不变，main 父会话按稳定键唤醒、dev 父会话经结果注入得知，继续（按[继续与复用规则](../feature/2026-10-04-subagent-reuse-close.md)沿 `work_id`、`sub_agent_id` 承接）或放弃由拥有者/父 Agent 决定。结果事务内只对当前任务仍匹配的 SubAgent 按占用记 `idle` 或 `unverified`。宿主固定评审任务带来源事件，不在此列。
2. **管理器恢复子会话，编排器恢复角色会话。** 编排器补记结果后调用管理器的异步 `start()`：先冲刷待投递消息，再仅自动恢复无遗留占用且以 `backend_restart` 暂停的 SubAgent 子会话；宿主固定评审保留的排队任务由此继续执行（issue 19 既定口径：评审不经拥有者核实）。角色队列仍由编排器恢复。`occupancy_unverified` 暂停与遗留占用不自动解除，恢复任务不与旧执行并发修改同一资源。
3. **`resume-queue` 是 `unverified` 的出口。** `unverified` 记「旧执行退出未核实」的事实；拥有者核实后 `Runtime.resumeQueue` 在释放遗留占用、解除暂停的事务内调用 `SubAgentManager.executionVerified(sessionId)`（活动任务持有的占用仍拒绝释放）。该会话无活动任务且当前终态任务结果已登记时，才可在占用释放后回到 `idle`；当前终态结果缺失报 `invalid_state`，恢复事务回滚，须先补记结果，不能宣称空闲。管理器返回父会话 ID，Runtime 在提交后 `await flushPendingMessages`。已取消工作不因启动巡检重新运行、不补发唤醒（[工作取消规则](../feature/2026-10-04-cancel-work.md)不变）。

<!-- agent-note-format: alternatives-not-recorded (pre-format Agent Note) -->

## 后果

拥有者/主 Agent 委派的排队任务收尾并回报一次，普通委派不会重放；宿主固定评审按来源事件自动恢复。代价是所有恢复步骤都须依赖结果已登记和占用已核实，缺结果时 resume-queue 必须整体回滚，旧占用不能自动释放。已取消工作不运行也不补发唤醒；待投递消息由[消息管理器](../feature/2026-10-05-subagent-messaging.md)在核实后冲刷。

## 验证

[工单 15](../../../../.scratch/agent-direction/issues/15-recover-subagents.md)记录 test/86-subagent-recovery 3/3，mock 模型、realTools local worker 与进程内 Runtime 重启；相关回归 75/75，typecheck 和图解 4/4 通过。全量 npm test 889/892，失败项按原记录归于 DNS 和 worktree 目录名环境问题。smoke-15-recover-subagents.mts 在 macOS Docker 8/8，真实容器、控制面 socket、CLI 和数据库；模型/平台模拟，崩溃状态由数据库置位而非真实杀进程。Linux --remote 本次原实施未执行。

## 适用范围

通用调度的独立执行、运行归属、审批来源与整项取消采用[本决定](../feature/2026-10-12-generic-scheduled-tasks.md)；本篇其他独立规则继续适用。

工作流绑定步骤与短期宿主操作采用[运行执行基础](2026-10-13-workflow-runtime-and-store.md)，由协调器持有独立授权、指针、结果与恢复；本篇普通路径继续适用。
