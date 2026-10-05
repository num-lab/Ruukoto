Status: needs-triage

# IM 拥有者入口：QQ 私聊与 Telegram 站到它们已实现的 seam 后面

## 目标

Runtime 持一张按来源索引的 IM 入口表；每个入口回答 gate、当前钉版目标、预期发送者、回复截断、externalId 前缀、启停、状态与 reconcile，owner 回复与工作汇报随之迁入。新增入口（ADR 0017 提到的邮件、GitHub comment）= 加一个 adapter。来源：2026-10-05 架构审查的候选 03。

## 背景

2026-10-05 核对（develop d109dbe）：

- 两个 adapter 已 `implements NotifyChannel`（`qq/adapter.ts:62`、`telegram/adapter.ts:156`），方法一致（gatePrivate、target、available、send、status、start、stop、onConfigChanged）；Runtime 却持两个具名字段，`QQ_PRIVATE_SOURCE`/`TELEGRAM_SOURCE` 出现 25 次，按来源分支约 17 处。
- 成对重复：`reconcileQqPrivate` / `reconcileTelegram`（`runtime.ts:4045–4084`，除常量与 gate 外逐行相同）；`qqSetEnabled` / `telegramSetEnabled`（4105–4128 / 4256–4277）；`qqStatus` / `telegramStatus`（4087–4102 / 4237–4253）；`bumpImGenerationForCredential` 与 `reconcileImAfterCredential` 的并列分支（2506–2532）；`start()` 的并列构造（646–677）。
- QQ 回复上限 `maxReplyChars ?? 1500` 写 3 次（`runtime.ts:407`、`:431`、`:894`）；`imExpectedActor`（981–992）重建了 adapter `gatePrivate` 已经核对的 actor 字符串。
- `ImApprovals` 的 `currentTarget`、`expectedActor`、`replyCapChars` 三个依赖（`im-approvals.ts:129–137`）就是入口表的隐含 interface。
- Runtime 内 IM 专属代码约 700 行；issue 08/10/18 分别给 `runtime.ts` 加了 +257 / +118 / +102 行。
- 测 Telegram 停用后的 reconcile 现在要临时目录、MockModelServer、models.json、HTTP 上的 FakeBotApi、完整 `Runtime.start` 与 `waitFor`（38、40、77、84 号）。

## 待访谈

- adapter 缺失时 QQ 返回 `"wait"`（`runtime.ts:841`）、Telegram 返回 `drop`（`:846`）：有意还是漂移？
- `qqConfigure` / `telegramConfigure` 的信任边界校验确实不同，迁入各自 adapter，不合并。
- 与候选 13（IM 审批全程）的先后。

## 相关 ADR

- ADR 0011 / 0012：按来源 reconcile，不取消共享 main 会话中另一平台的任务——保持。
- ADR 0010：`notifyChannel` 默认 Telegram，钉版目标的发送不改发——入口表须保留这两条。

## Comments
