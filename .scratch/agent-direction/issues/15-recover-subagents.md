Status: ready-for-agent

# 15 — 后台重启后恢复 SubAgent 与工作记录

**What to build:** 后台异常重启后，拥有者能看到原工作、SubAgent 身份与上下文，安全处理被中断的任务。

**Blocked by:** [12 — 继续委派、跨工作复用并显式关闭 SubAgent](12-subagent-reuse-close.md)；[14 — 取消整项工作而不影响其他委托](14-cancel-work.md)

依据：[已确认规格](../spec.md) 与 [ADR 0017](../../../docs/adr/0017-two-agent-products.md)。

## 验收标准

- [ ] 空闲 SubAgent 重启后仍可继续委托，活动任务标明中断并由拥有者决定继续，不自动当作成功或新委派。
- [ ] 任务、Agent、取消意图、结果及其归属关系保持一致；已取消工作不因恢复巡检重新运行。
- [ ] 重启窗口内的内部结果可补记且不重复登记，已批准但未完成的操作按现有账本核实效果。
- [ ] 无法确认旧执行已退出时保留占用与待核实状态，不能让恢复任务与旧执行并发修改同一资源。
- [ ] 完成相关端到端检查、类型检查及仓库要求的验证；同步本次行为涉及的运行说明和图解，验证记录区分模拟结果与真实环境结果。

## Comments

### 2026-10-04：可视化文档核查发现的现状缺口

核对 orchestrator.html 时按当前代码确认了两处与本工单验收直接相关的行为，供实施时一并处理：

1. **SubAgent 子会话里排队的任务重启后不会自动恢复。** 后台启动时，`src/runtime/orchestrator.ts` 的 `start` 只自动恢复以 `backend_restart` 暂停的角色会话；SubAgent 子会话同样被暂停，却不在恢复范围内。结果是排队任务一直停在 queued，`sub_agents.state` 停在 running，父工作也等不到结果。现在只能由拥有者对子会话手动执行 `resume-queue`。
2. **`unverified` 状态没有回到 idle 的路径。** 编排器在子任务以未知结局结束时把 SubAgent 定为 `unverified`（`orchestrator.ts` 的 `setSubAgentState`）。`resumeQueue` 不改动 `sub_agents.state`，委派路径（`subagents.ts`）只会把状态改成 running。所以一旦进入 unverified，这个 SubAgent 就没有任何代码路径回到 idle，对应验收第一条「空闲 SubAgent 重启后仍可继续委托」与第四条「待核实状态」的出口。

相关文档缺口（runtime.md 没有写明第 1 点）已登记在 [visual-docs-review 工单 07](../../visual-docs-review/issues/07-sync-docs-with-code.md)；本工单实施后那一条改为描述新行为即可。
