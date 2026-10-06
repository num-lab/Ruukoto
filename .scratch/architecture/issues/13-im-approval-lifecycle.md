Status: needs-triage

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

