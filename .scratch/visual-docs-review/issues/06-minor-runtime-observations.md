Status: needs-triage

# 06 — 核查中记下的较小代码问题

**What to decide:** 下面每一条都是对照代码确认过的行为，影响面较小，或者需要先判断是不是刻意设计。triage 时逐条决定：修（拆成独立工单）、写进文档说明，或 wontfix。

来源：2026-10-03 可视化文档的更新与独立核查。各条都标了证据位置；标「已复核」的由主代理重新读过当前代码。

## 条目

1. **调度循环的兜底分支可能写出第二个终态事件**（已复核）。`src/runtime/runtime.ts` 的 `runQueueLoop` 捕获 `driver.run` 异常（「驱动器异常：…」）时：
   - 不检查 `transitionTask` 的返回值，无条件追加 `task.failed` 并释放占用。
   - 后果：如果任务已被其他路径定为终态，会多出一条 `task.failed` 事件，违背 `store.ts` 头注释「只有一个终态」的纪律。
   - 改法：按返回值决定是否写事件与释放占用。
2. **切换排队任务的访问模式会停掉同会话正在运行的工作进程**（已复核调用点）。
   - `switchTaskMode` 对 queued / awaiting_confirmation 任务执行 `driver.router.stopWorker()`。
   - 会话驱动器当前的执行单元，可能属于同一会话里正在运行的另一个任务。
   - 需确认：对 queued 任务是否根本不必停 worker（它还没有执行单元）。
3. **自动审查的决定与事件分两个事务提交**。
   - `src/agent/approval-gate.ts` 的 `runAutoReview` 注释写「决定、理由、来源与事件在同一事务落盘」，实际 `respondConfirmation` 与 `task.confirmation_resolved` 是两个相邻的 `withTx`（ask_owner 分支同样）。
   - 两次提交之间崩溃，会留下有决定、没有事件的记录。
   - 二选一：合并成一个事务，或改注释。tool-call-path.html 已按代码写成「已知限制」。
4. **长期授权放行不看任务访问模式**。
   - `requestStanding` 不检查 `accessMode`：IM 来源任务被拥有者切到 full_access / auto-review 后，长期授权照样放行。
   - 找不到说明这是刻意设计的文档。需确认后写进 ADR 0019 或 runtime.md。
5. **授权撤销导致的 SubAgent 中断被说成「后台重启」**。
   - `task_sources_revoked` 让 SubAgent 任务以 interrupted 结束，编排器归为结果未知，摘要固定写「子任务被后台重启/中断，结果未知」。
   - 真实原因只记在 `subagent_task.result_unknown` 事件的 reason 里。
   - 建议摘要用实际原因。
6. **后台停止窗口里 Telegram 仍处理审批命令**（已复核：`runtime.ts` 传给 TelegramAdapter 的 `register` 只查编排器是否存在，`registerImInbound` 不查 `stopping`；QQ 的 `registerPrivate` / `registerGroup` 会查）。
   - 从 `stopping = true` 到 Telegram 适配器停下，这段时间里 Telegram 的登记入口不检查停止标志，审批命令照常生效，回执留在 pending，下次启动再发。QQ 的入口会先拒绝。
   - 需确认这是否可以接受。
7. **`QqStore.settleOutbox` 的 `"canceled"` 取值是死值**（已复核调用点）。
   - 类型允许 canceled，但所有调用方只传 sent / failed / unknown。表注释与 `qq/adapter.ts` 注释说「撤回取消未发送回复」，实际做法是撤回时在途记 unknown，未登记的回复不建记录。
   - 二选一：删掉这个取值并修正注释，或真的实现撤回取消。
8. **HTTP「已发出」的注释不准确**。
   - `src/agent/execution/approved-ops.ts` 以 `ClientRequest` 的 `finish` 事件为「已发出」，注释写「交给操作系统发送」。
   - TLS 握手协议错误可能发生在 `finish` 之后，此时非 GET 请求会被保守标为效果未知，但服务端应用其实没有收到。
   - 行为偏保守，不会重复执行；只需修正注释，或者更精细地区分。
9. **注释过时**（顺手改）：
   - `src/core/types.ts` 中 `InboundEvent.source` 的注释举了 `qq`、`internal` 两个不存在的取值；
   - `SCHEDULER_LIMITS.redispatchMs` 的注释说「所有来源」，实际只数 `event_kind = 'task'`；
   - `subagent-tools.ts` 头注释说调度与回报唤醒任务「不装配」，实际是装配了、执行时被拒；
   - `protocol.ts` 说版本不符回 `bad_request`，实际回 `protocol_version`；
   - `tui/app.ts` 中 `verifyWorkspaceEntry` 注释的理由（「异参重发会冲突」）不成立，后台重放只比对目录。

## 验收标准

- [ ] 每条都有 triage 结论：拆出的工单编号，或写进文档 / wontfix 的理由。
