Status: resolved

# 15 — 后台重启后恢复 SubAgent 与工作记录

**What to build:** 后台异常重启后，拥有者能看到原工作、SubAgent 身份与上下文，安全处理被中断的任务。

**Blocked by:** [12 — 继续委派、跨工作复用并显式关闭 SubAgent](12-subagent-reuse-close.md)；[14 — 取消整项工作而不影响其他委托](14-cancel-work.md)

依据：[已确认规格](../spec.md) 与 [ADR 0017](../../../docs/adr/0017-two-agent-products.md)。

## 验收标准

- [x] 空闲 SubAgent 重启后仍可继续委托，活动任务标明中断并由拥有者决定继续，不自动当作成功或新委派。
- [x] 任务、Agent、取消意图、结果及其归属关系保持一致；已取消工作不因恢复巡检重新运行。
- [x] 重启窗口内的内部结果可补记且不重复登记，已批准但未完成的操作按现有账本核实效果。
- [x] 无法确认旧执行已退出时保留占用与待核实状态，不能让恢复任务与旧执行并发修改同一资源。
- [x] 完成相关端到端检查、类型检查及仓库要求的验证；同步本次行为涉及的运行说明和图解，验证记录区分模拟结果与真实环境结果。

## Comments

### 2026-10-04：可视化文档核查发现的现状缺口

核对 orchestrator.html 时按当前代码确认了两处与本工单验收直接相关的行为，供实施时一并处理：

1. **SubAgent 子会话里排队的任务重启后不会自动恢复。** 后台启动时，`src/runtime/orchestrator.ts` 的 `start` 只自动恢复以 `backend_restart` 暂停的角色会话；SubAgent 子会话同样被暂停，却不在恢复范围内。结果是排队任务一直停在 queued，`sub_agents.state` 停在 running，父工作也等不到结果。现在只能由拥有者对子会话手动执行 `resume-queue`。
2. **`unverified` 状态没有回到 idle 的路径。** 编排器在子任务以未知结局结束时把 SubAgent 定为 `unverified`（`orchestrator.ts` 的 `setSubAgentState`）。`resumeQueue` 不改动 `sub_agents.state`，委派路径（`subagents.ts`）只会把状态改成 running。所以一旦进入 unverified，这个 SubAgent 就没有任何代码路径回到 idle，对应验收第一条「空闲 SubAgent 重启后仍可继续委托」与第四条「待核实状态」的出口。

相关文档缺口（runtime.md 没有写明第 1 点）已登记在 [visual-docs-review 工单 07](../../visual-docs-review/issues/07-sync-docs-with-code.md)；本工单实施后那一条改为描述新行为即可。

### 2026-10-05：实施完成（决定见 ADR 0020 补充段）

代码三处改动，均为既有机制的窄口延伸：

1. **排队委派任务定 interrupted**（`src/runtime/runtime.ts` `recover` + `src/core/store.ts` `listQueuedSubAgentTasks`）：恢复事务把未启动的 SubAgent 排队执行任务（拥有者/主 Agent 委派，无 `source_event_id`）与运行中任务同定 interrupted(backend_restart)。这直接消除核查发现的缺口 1：不再依赖子会话队列恢复，SubAgent 补记结果后回可用；host 固定评审（带来源事件）不在此列。
2. **启动恢复扩到 SubAgent 子会话**（`src/runtime/orchestrator.ts` `resumeRestartPausedQueue`）：backend_restart 暂停自动解除，经第 1 条后只剩评审排队任务能命中；带遗留占用的会话额外跳过（冒烟发现的边角：resumeQueue 会一并释放占用，那是拥有者核实动作，不允许自动发生）。
3. **resume-queue 是 unverified 的唯一出口**（`src/runtime/runtime.ts` `resumeQueue`）：消除缺口 2——释放占用、解除暂停后，无活动任务的 SubAgent 从 unverified 记回 idle。

验证（模拟/真实分列）：

- 模拟：`test/86-subagent-recovery.test.ts` 3/3（mock 模型 + realTools local 后端 + 进程内真实 Runtime 重启；红绿验证：撤改动 3 红、加回 3 绿）；相关回归（80–85、46、27、04 共 75 项）全过；`npm test` 889/892，两项失败均为干净树同样失败的环境性用例（`test/32` 依赖 worktree 目录名、`test/08` DNS 需可解析网络）。
- 真实：`.scratch/agent-direction/smoke-15-recover-subagents.mts` 8/8（macOS Docker：真实受限容器、控制面 socket、真实 CLI resume-queue、SQLite；模型与消息平台为模拟；崩溃形态按库内容置位，恢复判定输入与真实崩溃一致）。Linux 原生侧可用 `--remote` 在 tx 复跑，本次未执行。
- 类型检查 `npm run typecheck` 通过；`test/67-visual-docs` 4/4 通过。

文档同步：runtime.md「通用 SubAgent 委派 · 后台重启恢复」新小节、「崩溃恢复」第 2/7 条、验证状态两行；README 异常恢复第 2/3 条；CONTEXT.md SubAgent 术语；ADR 0020 补充段、ADR 0017 实施记录；docs/visual 的 orchestrator.html（SubAgent 状态机新增 unverified→idle 边与表行、停止与重启、范围边界、启动恢复步骤）与 task-lifecycle.html（暂停原因表、resumeQueue 段、SubAgent 重启行、重启恢复步骤），两张图渲染切片已核查。visual-docs-review 工单 07 的对应条目已改为描述新行为。
