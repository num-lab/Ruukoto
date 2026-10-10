# Agent Note: 继续、复用与显式关闭 SubAgent

Status: implemented

原出处：ADR 0020「补充：继续、复用与关闭」

## 问题

[通用工作委派](../architecture/2026-10-03-work-delegation-subagent-task.md)保留身份和上下文，但早期只有继续同一工作，缺少跨工作复用与显式关闭。忙碌时继续委派还会覆盖 current_task_id，使前一任务终态把正在执行新任务的 Agent 错记为空闲；快照仅按执行键命名会覆盖旧工作资料，发送前仅复核本次来源会漏掉保留上下文中的撤销资料。

## 决定

1. **关闭用独立列，不改状态值。** `sub_agents` 增加 `closed_at`、`closed_by`（`owner` 或 `agent:<任务ID>`；schema v25 只补列，旧行两列为空）。`state` 继续只表示执行状态（running/idle/unverified），不重建 CHECK；待核实的 Agent 也能关闭，占用核实见[后台重启恢复](../architecture/2026-10-05-subagent-restart-recovery.md)。
2. **有活动任务时拒绝关闭。** 活动任务指 queued/running/awaiting_confirmation；提示等待任务结束，或由拥有者 `ruukoto cancel <taskId>` 后再关闭。不引入「已关闭但仍在跑当前任务」的中间态；整项取消见[工作取消](2026-10-04-cancel-work.md)。关闭与新委派在同一同步事务内定胜负：先关闭则委派报「已关闭」（零新任务），先登记则关闭报「有活动任务」。关闭保持同步，在关闭事务内经管理器 `pendingMessageContext` 统一判定并清理发给该 Agent 的待投递消息；不异步冲刷其他 Agent，关闭前无活动任务也无释放名额的需要。
3. **继续与复用都要求可用。** 可用指同一父会话、未关闭、`idle` 且无活动任务、工作目录 realpath 与 dev/ino 和子会话记录一致；忙碌明确拒绝不排队（同时修复 11 遗留的 `current_task_id` 覆盖后状态虚置问题）。复用（仅提供 `sub_agent_id`；同时提供 `work_id` 时属于[协作加入](2026-10-05-subagent-messaging.md)）登记一条新 `work_delegations` 行指向既有 Agent，上下文即该 Agent 同一子会话的全部历史；参数摘要只在提供 `sub_agent_id` 时纳入该字段，旧重放摘要不变。快照按 `materials-<workId>-<key>.txt` 命名，复用不覆写旧工作快照。准备或登记失败只清理本次内容——首次委派删新建目录，沿用目录只删本次写入的快照文件，正文超限检查纳入同一清理范围（同时修复 visual-docs-review 工单 03 的两处残留）。
4. **来源复核取并集。** 登记事务内与每次发送上下文前的 verify 对象是该 Agent 全部历史任务的来源引用与本次的并集：复用保留的上下文含旧工作资料，任一撤销即拒绝登记或阻断发送（`task_sources_revoked`）。
5. **查看。** `subagent_result` 省略 `work_id` 列出本会话 SubAgent 总览（供跨轮次挑选复用对象），按工作读取标明是否已关闭；`work_list`/`work_get` 的 agent 对象自然带上关闭两列；TUI 经 `subagent.closed` 事件与快照展示「已关闭」，不新增 TUI 命令。任务终态、TUI 退出与空闲不自动关闭，也无需空闲超时配置。
6. **结果与当前身份状态同事务登记。** 结果沿用 `setTaskResult` 一次写入；编排器在结果事务内调用 `SubAgentManager.resultRecorded(task)`，仅 `currentTaskId === task.id` 时按子会话占用记空闲或待核实，并清空当前任务。旧任务首次补记仍保存结果与事件，不倒写当前新工作与任务。这是对历史补记和不一致记录的防御；播种历史组合的验证不代表该组合已被证明可由正常流程自然形成。dev 父会话经持久事件 + 下一次模型调用的宿主资料注入送达（注入标记 `result_delivered_at`，崩溃窗口不丢记录）；main 沿用稳定 `wake:<childId>` 回报键。`coding_result` 经同一归属窄口兼容读取；新委派统一经 `subagent_delegate`。

## 备选方案

把 closed 合入 running/idle/unverified 状态能在一列查看生命周期；但关闭与执行是两个独立维度，重建 CHECK 增加迁移成本，也无法直接保留待核实的执行状态。因此关闭用独立 closed_at/closed_by。允许关闭后当前任务继续可减少一次用户取消操作；但会引入「已关闭仍在跑」中间态和委派竞争规则，因此有活动任务时拒绝关闭，先结束或取消任务再关。取舍见[工单 12](../../../../.scratch/agent-direction/issues/12-subagent-reuse-close.md)「默认取舍」。

忙碌时沿用早期排队能立即接受后续工作；但登记会覆盖 current_task_id，终态补记易虚置当前身份。继续与复用都要求 idle 且无活动任务，忙碌明确拒绝，另一次提交由父 Agent 决定。

## 后果

同一父会话可复用完整上下文，关闭后仍可查历史、产物与目录。完整历史要求每次登记和发送复核全部历史来源；任一撤销阻断整次复用，需新建 SubAgent。读路径和权限按本次重新钉定，历史中已读正文不追溯删除。关闭与委派同步事务仲裁，无自动关闭、空闲超时或 TUI 专门关闭命令。

## 验证

[工单 12](../../../../.scratch/agent-direction/issues/12-subagent-reuse-close.md)记录 test/81 9/9、npm run typecheck 通过，全量 npm test 883 项中 882 通过、0 失败、1 跳过；smoke-12-subagent-reuse-close.mts 在 macOS 与 ssh tx Linux Docker 各 6/6，真实 Runtime、CLI、数据库与受限 worker 验证旧路径拒读、关闭后拒绝及成果保留。模型和平台均模拟，真实 QQ/Telegram 未实测。历史组合播种覆盖旧任务补记守卫，不代表该组合由正常流程自然形成。
