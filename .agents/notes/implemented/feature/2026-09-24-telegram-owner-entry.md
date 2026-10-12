# Agent Note: Telegram 拥有者入口、固定回复与限流退回

Status: implemented

原编号：ADR 0011

## 问题

[daily-agent issue 04](../../../../.scratch/daily-agent/issues/04-telegram-owner.md)把 Telegram 私聊作为 main 的第一条日常入口。外部消息需要进入持久会话并收到回复，但不能借用会话默认的完全访问权限，也不能把回复扩展成模型自由选择目标的外发能力。Telegram 的 429 与 `retry_after` 明确表示本次未发送，需要在未知结果不重发的前提下处理。

## 决定

- **可信配置绑定固定 owner，入站任务统一为 `confirm`。** Telegram 用 long polling，只接收与固定 `user_id + chat_id` 一致的私聊；首次交付只收文本，后来按[入站图片暂存](../architecture/2026-10-07-inbound-image-staging.md)扩展为文本与图片。不匹配身份、群聊及其他不支持消息只记有界拒绝原因，不登记任务。外部消息先持久化，再按 `(source, external_id)` 去重，external ID 为 `<botId>:<chatId>:<messageId>`。登记成功后才推进轮询偏移，停机积压消息全部处理。编排器对所有入站事件（Telegram、scheduler 及其他外部来源）统一固定 `confirm`，不继承主会话的 `full_access`；批准只改变那一次具体操作，不改变任务模式。
- **owner 回复由宿主自动登记。** Telegram 来源任务到达终态时，在编排器结果事务内登记一份公共 `owner_reply`，与任务结果及入站终态同时提交。普通回复键为入站事件 ID；正文从该任务的历史条目读取最终回答，不能读取会话最新一条来猜测。重启巡检补记结果时同事务补登，同键幂等。发送目标固定为收件时的同一 bot、owner chat 和配置版本，按原消息引用回复。
- **两端身份与代次完整钉版。** 收件时保存捕获轮询配置的 `reply_target`；登记与偏移推进之前，以及派发、任务启动、登记回复和实际发送之前，核对来源、actor、目标与配置版本。绑定、启停和引用凭据的变化单调推进代次，旧轮询、消息、批准、回复不复活、不改发。旧 Telegram 事件 `replyTarget=null` 无法证明收件配置，registered/queued 工作明确失效，不能用当前目标补造。完整审批及代次语义见[IM 审批与最终汇报](2026-10-02-im-approval-and-final-report.md)。
- **平台明确限流退回同一操作。** 渠道抛 `RetryLaterError`，表示平台明确拒绝且可证明未发送时，`sending → pending` 并写 `not_before`；到时重新领取原操作，目标、正文与键不变。领取期间已取消的直接 `canceled`。其他明确拒绝及连接未建立记 `failed`；发送后的超时、5xx、中途断开或不可解析回执记 `effect_unknown`，这些终态不自动重发。这是[调度器与 outbox](../architecture/2026-09-24-scheduler-outbox.md)发送事实规则的限流例外，不是通用重试框架。
- **bot token 只通过凭据绑定使用。** 绑定用途为 `telegram_bot`，host 与 API 地址一致，scope 收紧，核心库只保存绑定名与固定 owner 身份。token 出现在 Bot API 请求 URL 中，错误进入日志、账本与状态前使用该请求捕获的 token 脱敏，覆盖凭据轮换后的旧请求迟到错误。

## 自动回复与入口失效的边界

定时唤醒及普通子任务唤醒不自动产生 owner 回复；只有 IM 发起的通用工作收尾轮次按[最终汇报规则](2026-10-02-im-approval-and-final-report.md)开例外。旧 coding draft 链唤醒仍不外发，固定角色退役后仅保留旧资料读取。GitHub 评审走[独立事件通知](2026-09-24-github-event-review.md)，不套用 owner 回复授权。

启动配置 `RUUKOTO_DISABLE_TELEGRAM` 的入口按停用处理，入站作废、排队任务以 `telegram_unavailable` 取消；QQ 私聊自架构工单 10 起采用同一入站与任务语义，见[QQ 私聊入口](2026-09-24-qq-private-shared-main.md)。暂时离线且代次不变则等待恢复；由于渠道可用性取轮询健康状态，网络断开时回复通常保持 `pending`，没有调用发送函数。配置停用或目标变化取消未发送回复，不改发。

首次交付只提供 CLI 与拥有者控制面配置，`--api-base` 可以指向受控反代；HTTPS 为常规路径，HTTP 仅限回环。token 与目标的配置校验不能借反代绕过。操作需要批准时可用[绑定私聊的 IM 审批命令](2026-10-02-im-approval-and-final-report.md)，也可继续使用原 TUI/CLI 拥有者认证。

## 备选方案

- **从会话最新回答取回复正文。** 原先的读取可以直接复用，少做任务历史定位。未选，是因为任务终态但结果事务未提交时，main 可能已经处理后续消息；恢复补登会把后续回答发给原委托。拥有者明确选择按任务读取，并用这个崩溃窗口回归。来源：[daily-agent issue 04](../../../../.scratch/daily-agent/issues/04-telegram-owner.md)「实施前确认」第 3 项与交付验证。
- **429 按原 outbox 规则记 `failed` 后停止。** 这能完全沿用原有终态不重发规则，无需退回 pending。未选，是因为平台已明确本次未发送且给出等待时间；拥有者确认按 `retry_after` 延迟重试同一条记录，既能继续回复，也不重试可能已产生效果的请求。来源：issue 04「实施前确认」第 4 项及原发送规则的修订。

## 后果

拥有者可以持续使用同一个 main 会话，回复与原任务、原消息和原固定目标可追溯。主会话默认 `full_access` 不能越过外部入站的 `confirm`；即时私聊审批的窄权限不变成通用控制面身份。限流会延迟回复，结果未知则需要拥有者核实，不能保证远端 exactly-once 或未知窗口必达。

共享历史的 QQ 与 Telegram 不是互相隔离的资料空间，边界见[QQ 私聊共享 main](2026-09-24-qq-private-shared-main.md)。国内服务器部署需要可达的 API 反代或网络层代理，历史验收时全局 `fetch` 未使用 `HTTP_PROXY`；真实部署连通性与消息平台兼容性不能由模拟结果推出。运行配置见[操作手册](../../../../docs/usage.md)。

## 验证

[daily-agent issue 04](../../../../.scratch/daily-agent/issues/04-telegram-owner.md)记录 macOS、模拟模型与本地 Bot API 下 `npm run typecheck` 通过，`npm test` 393 项中 392 通过、1 项真实模型检查按默认跳过。`npx tsx --test test/38-telegram-owner.test.ts` 当时 5 项覆盖同主会话与原消息回复、重投去重、非 owner/群聊/贴纸零模型调用、full_access 默认不继承、token 脱敏、400/502 不重发、429 原操作重试、断线恢复、按任务补登、配置校验与停用失效、重叠启停只有一个轮询及 v13→v14 迁移。

首次交付未执行真实 Telegram bot 闭环，按拥有者确认没有在国内 tx 执行 Linux 验收。后续双平台身份/审批与异步回复的 Linux 后台冒烟由[IM 审批与最终汇报](2026-10-02-im-approval-and-final-report.md)分别记录，仍不代表真实 Bot API 已实测。

## 适用范围

完全访问的账户、环境、免审批及宿主任务授权传播采用[本决定](2026-10-12-full-access-current-account.md)；本篇其他独立规则继续适用。
