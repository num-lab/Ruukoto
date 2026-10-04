# Telegram owner 入口：入站固定 confirm、owner 回复自动发送、限流退回重试

日期：2026-09-24

2026-10-02 修订：[ADR 0017](0017-two-agent-products.md) 确定绑定拥有者私聊可以完成审批，并允许已接收委托的异步最终结果由 main 汇总后发回原入口。下文“审批仅在 TUI”和子任务唤醒一律不回复的范围据此调整；身份校验、固定目标和未知结果不重发等规则保留，代码迁移尚待实施。

2026-10-03 实施修订（agent-direction issue 08）：绑定拥有者的 Telegram 私聊审批已由 IM 审批命令实现（`/approvals`、`/approval`、`/approve`、`/reject`），控制消息以 `inbound_events.event_kind = im_approval` 直接处理、回信经公共 outbox；入站事件在收件时按捕获配置钉版 `reply_target` 与配置版本，派发/任务启动/发送前复核。旧 Telegram 私聊通知与“需要审批的操作仍在 TUI 确认”的阶段性描述被本条取代；固定目标、权限模式与未知结果不重发的规则保持不变。异步最终汇报的范围由 issue 18 单独实施。

2026-10-04 实施修订（agent-direction issue 18）：最终汇报已实施——IM 来源任务发起的通用 SubAgent 工作收尾时，宿主在收尾的 main 唤醒结果事务内经 `owner_reply` 槽登记一次最终汇报（键 `<发起事件 id>#work:<workId>:<收尾执行任务 id>`，正文为唤醒轮次最终回答加固定首行，目标沿用发起事件钉版目标）；第 2 条“子任务唤醒不产生 owner 回复”的例外仅限该收尾轮次，旧 coding draft 链唤醒仍不外发。

## 背景

daily-agent issue 04 让拥有者经 Telegram 私聊使用 main。消息来自外部平台，任务不能借用 main 会话默认的完全访问；回复需要自动发回，但不能扩展成模型可控的外发能力；Telegram 对发送频率有平台限流（429 + `retry_after`）。

## 决策

1. **入站事件一律 confirm**：编排器为入站事件（Telegram、定时唤醒及以后的外部来源）建任务时固定 `confirm` 模式，不继承会话默认模式。此前只有 `scheduler` 来源固定；改为按"入站事件"整体处理，外部来源的新接入不再需要各自记得加例外。拥有者确认只改变被审批的那一次操作，不改变任务权限模式；Telegram 私聊审批已由 agent-direction issue 08 实施（见上方 2026-10-03 修订），此前的“Telegram 内审批另开工单，本期审批仍在 TUI”不再适用。
2. **owner 回复属于明确的自动发送范围**（ADR 0010 已预留）：只有 `source = telegram` 的入站任务在终态时由宿主登记一次 `owner_reply` 发送操作，发送键 = 入站事件 ID，目标 = 登记该消息的同一 bot + owner chat，正文 = 该任务历史条目中的最终回答。登记在编排器结果事务内，与结果/入站终态同时提交，重启巡检补记时一并补登，不会重复。定时唤醒与子任务唤醒不产生 owner 回复。
3. **限流退回重试（修订 ADR 0010 第 4 条）**：渠道抛 `RetryLaterError`（平台明确限流拒绝，可证明未发送）时，操作从 `sending` 退回 `pending` 并写 `not_before`，到时同一操作（原目标、原正文、原键）再领取一次；领取期间已有取消意图的直接 `canceled`。其他明确拒绝仍为 `failed`，超时/5xx/中途断开仍为 `effect_unknown`，均不自动重发。
4. **token 只在凭据存储**：bot token 经 `purpose = telegram_bot` 的凭据绑定引用并收紧 scope；核心库只存绑定名与固定 owner 身份。token 位于请求 URL 中，错误信息写入日志、账本与状态前脱敏。

## 与既有 ADR 的关系

- ADR 0010 第 4 条规定"可证明未发送 → failed、不自动重发"，"首版不引入自动重试框架"。本 ADR 为平台明确限流单独开例外：退回的只是可证明未发出的请求，按平台给出的等待时间再试同一操作，不是通用重试框架，也不改变 `failed/effect_unknown` 不重发的规则。
- ADR 0003 的完全访问语义不变；本 ADR 只规定入站事件任务不选择完全访问。

## 后果

- 拥有者把 main 会话默认设为 full_access 后，Telegram 触发的任务仍会在需要审批的操作处停下等待 TUI 确认。
- 持续限流时回复会延迟但不丢失、不重复；停用或换目标时未发送的回复按 ADR 0010 取消，不改发。
- 连接未建立（ECONNREFUSED 等）的发送记 `failed`；由于渠道可用性取轮询健康状态，网络断开时回复通常停在 `pending` 等待而非失败。
