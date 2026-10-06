Status: resolved

# IM 审批全程收进 ImApprovals

## 目标

IM 审批的通知 → 命令 → 决定 → 获批后复核 → 长期授权候选 → 配置变化撤销由 `ImApprovals` 一个模块负责。它多收三个依赖：入站 gate、「取代等待中审批」回调（`drivers.get(..).supersedeApprovals`）、服务管理是否可用。来源：2026-10-05 架构审查的候选 06。

## 背景

2026-10-05 核对（develop d109dbe）：

- 四个钩子在 Runtime：`imApprovalNotice`（`runtime.ts:999`，含 service_operation 措辞与未知操作警告）、`imApprovalConsumeRecheck`（:1059）、`invalidateImApprovals`（:1076）、`standingCandidate`（:1114）；经 :2932–2934 接进 driver。命令处理在 `im-approvals.ts`（已有 `imSourceEvent`，:580）。
- 改一条审批规则要改两个文件：issue 08（f522cce）`im-approvals.ts` +405 / `runtime.ts` +257；issue 10（24f1ac3）+346 / +118。
- 77 号（915 行，4 次 `Runtime.start`）与 79 号大半可在临时 Store 上构造 `ImApprovals`，不需模型服务与平台替身。

## 待访谈

- 单独做，还是作为候选 10 的第一步（`currentTarget`、`expectedActor`、`replyCapChars` 改由入口表提供）。

## 相关 ADR

- ADR 0019：审批文案与 `standingCandidate` 只换位置，语义不变。
- ADR 0008：统一审批不动。

## Comments

### 2026-10-06：先后已定（工单 10 访谈决定 5）

先做工单 10，本单单独做。10 把 `currentTarget`、`expectedActor`、`replyCapChars` 三个依赖换成按来源取拥有者 IM 入口的一个依赖，reconcile 经回调调用仍在 Runtime 的 `invalidateImApprovals`；本单再把四个 Runtime 钩子（`imApprovalNotice`、`imApprovalConsumeRecheck`、`invalidateImApprovals`、`standingCandidate`）迁入 `ImApprovals`。本单「待访谈」的先后问题随之关闭，访谈时以 10 落地后的代码为准重新核对行号。


### 2026-10-07：实施范围与接口

第六条按架构候选 06 实施，基线 develop `6c16fed`（第五条已合入 PR #15），独立工作区 `im-approval-lifecycle`。主工作区的发布验收改动与 stash 不纳入本单。

四个 Runtime 钩子迁入现有 ImApprovals，分别为 notifyCreated、consumeRecheck、invalidate、standingCandidate；来源追溯改为模块私有。Runtime 仅接线，ApprovalGate 继续负责决定、单次消费及统一审批事务。已有 ImEntry 包含 gatePrivate，直接复用，减少重复注入；仅新增按 sessionId 解除指定审批等待与服务能力是否可用两个依赖。服务策略修订读取仍复用既有依赖。

本单保持通知措辞、钉版目标、命令幂等、资格与消费规则、长期授权范围、事件与 schema 不变。审批与通知仍在同一事务，配置撤销的审批和授权同事务，等待只在提交后解除。测试通过公开入口验证完整来源、跨平台隔离、run/wait 不作废、已消费不动、修订与入口失配、原事务回滚；既有 77/79 和入口集成测试保留回归。同步运行文档及所有受影响源码锚点。

### 2026-10-07：交付与验证

第六条实现完成，工单与候选清单标为 resolved，本地分支 `im-approval-lifecycle`。

- Runtime 删除四段 IM 审批规则，只保留接线；ImApprovals 统一通知、命令、消费复核、长期授权候选和按来源撤销。来源追溯已私有化，入口依赖通过 Pick 限定到实际使用的方法；没有新框架、状态或依赖包。
- 新增 `test/93-im-approval-lifecycle.test.ts` 20 项公开接口验证，采用真实 Store / ApprovalGate，无 Runtime 或模型服务。既有 77、79、89 合计 41 项通过；含图解测试的最终定向测试 65/65。`npm run typecheck`、`git diff --check` 通过。
- 完整测试 962 项：958 通过、1 跳过、3 失败。08 的 DNS `.invalid` 解析超时、32 的仓库目录名硬编码为已在上一条干净基线复现的问题；33 的 TUI 撤销提示在整套并发运行时超时，单独复跑 15/15 通过。本次未修改这三项测试；不将完整测试描述为全绿，也未把第三项断言为已证明的基线问题。完整日志 `/tmp/ruukoto-im-approval-lifecycle-full.log`，33 单独日志 `/tmp/ruukoto-im-approval-lifecycle-33.log`。
- 图解同步：inbound-events 的 dispatch、im-approval；outbox 的 keys、im；tool-call-path 的 approval、standing；task-lifecycle 的 states、stop；once-only 的 table、service-chain。原来指向 Runtime 四钩子的锚点改为 ImApprovals 的实际入口，通知微任务唤醒锚点同步。通知与审批同事务、撤销与授权同事务以及提交后解除等待仍按源码核实。
- 五页渲染共 53 张切片逐张核实：inbound-events 14、outbox 11、once-only 5、task-lifecycle 8、tool-call-path 15，未见文字重叠、截断或图表错位。切片 `/tmp/vis-<页面名>-<序号>.png`。
- 本次没有真实 QQ/Telegram、root helper 或 Linux 模型验收；端到端回归使用已有平台与 helper 替身。主工作区已有的发布验收改动与 stash 均保留。
