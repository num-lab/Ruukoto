# Agent Note: QQ 私聊与 Telegram 共享 main，回复绑定原平台

Status: implemented

原编号：ADR 0012

## 问题

[daily-agent issue 06](../../../../.scratch/daily-agent/issues/06-qq-private.md)在 Telegram 入口之后增加拥有者 QQ 好友私聊，需要复用同一 main 身份和主会话，同时按原平台回复，不能串入群会话或把 QQ 身份变成拥有者控制面认证。共享历史还需要一个明确的群资料读取边界，入口过滤本身无法隔离已进入 main 的资料。

## 决定

- **QQ 好友私聊与 Telegram 共享 main。** 复用既有 NapCat OneBot v11 正向 WebSocket 连接，私聊经持久 `qq_private` 入站事件进入编排器，不复用群会话或群发送账本。首次交付只收固定 owner 的好友纯文本与回复 ID，后来按[入站图片暂存](../architecture/2026-10-07-inbound-image-staging.md)扩展为文本与图片；临时群私聊、其他不支持消息、陌生人、自身回声、错误 self_id/sender 不建任务。私聊必须配置 token，`get_login_info` 核对登录账号，`get_status` 与心跳核对实际在线状态；掉线不接收新任务。
- **收件固定平台身份与配置版本。** 外部消息按登录账号、owner 和消息 ID 去重，收件时持久化 `reply_target`。恢复、派发、任务启动、登记回复与发送都复核原平台、登录账号、owner、actor 和配置版本。QQ 连接代次含 configVersion，凭据引用及同名凭据修改/删除单调推进代次，A→B→A 不恢复旧连接、旧消息或旧批准；Telegram 的同类链路见[Telegram 入口](2026-09-24-telegram-owner-entry.md)。完整凭据及 IM 审批归属规则见[IM 审批与最终汇报](2026-10-02-im-approval-and-final-report.md)。
- **回复及新通知仍按原目标发送。** 普通 owner 回复使用公共 `notification_ops`，来源扩展到 `qq_private`，正文按任务读取，发送到原平台、原登录账号、原 owner 与原配置版本；配置变化使旧授权失效，不改发。QQ 来源任务申请的新通知或通知计划绑定该任务原 QQ 目标，仍经统一审批；其他任务沿用 Telegram 缺省目标，不泛化为跨平台广播。未知结果不重发，平台明确限流只重试同一操作。定时与普通子任务唤醒不自动回复，只有 IM 发起通用工作的收尾轮次按[最终汇报规则](2026-10-02-im-approval-and-final-report.md)开例外。
- **平台身份与权限分别核实。** 入站任务固定 `confirm`，QQ 正文不能选择完全访问、改变权限或执行通用控制面操作。绑定拥有者可以通过宿主解析的[IM 审批命令](2026-10-02-im-approval-and-final-report.md)回应原入口的具体待审批，批准仍只对应原请求与单次执行，共享 main 不让另一平台继承。
- **启动配置停用时入站与排队任务作废。** `RUUKOTO_DISABLE_QQ`（dev 开发实例固定注入，ruukoto-code 强制停用）使入口不连接，原入站作废并记 `inbound.skipped`，排队任务以 `qq_private_unavailable` 取消；不再让 registered 消息与 QQ 排队任务停住整条 main 队列。启动停用无法证明钉版目标有效，按入站/任务的配置停用语义处理。适配器存在、只是暂时离线且连接未确认时仍是 wait，不因连接短暂断开取消委托。来源：[架构工单 10](../../../../.scratch/architecture/issues/10-im-owner-entries.md)。

## 群资料边界与共享历史的代价

main 与旧 coding 角色统一禁止直接读取原始 `qq_group` 项目及带群来源的派生资料，即使存在跨项目授权；旧 coding 委派也不能成为群资料读取的旁路。固定角色退役后这条边界仍由资料身份核实，main 的通用 SubAgent 不获得群资料旁路，见[核心群聊退役](../simplification/2026-10-02-retire-core-group-chat.md)及[工作委托](../architecture/2026-10-03-work-delegation-subagent-task.md)。历史、产物、记忆列表与版本、自动记忆注入、委派资料、通知来源和旧计划详情统一通过资料范围校验。

拥有者控制面与普通开发项目的既有资料授权不受角色限制。隔离不追溯删除已复制进 main/coding 历史或应用数据的内容，也不承诺识别没有来源标记的转述。两个 IM 平台共享 main 历史；如需阻止一个平台看见另一平台既有内容，必须重新决定共享会话范围，单加入口过滤无法达成。

## 曾经的做法与改动原因

QQ 适配器缺失或启动配置停用时曾返回 wait，Telegram 则直接 drop。QQ 的等待会让注册消息持续未派发，排队任务启动门又会阻塞共享 main 队列，连 TUI 和 Telegram 的后续任务也不能推进。架构工单 10 将 QQ 的入站与任务口径改为作废/取消，并保留暂时离线的等待语义。

## 备选方案

- **启动停用时继续等待 QQ 入口恢复。** 这保留旧 registered/queued 委托，行为与短暂掉线相似。未选，是因为启动配置明确关闭连接，无法证明原钉版目标有效，并会阻塞其他入口的 main 任务；它与暂时离线有不同事实依据。来源：[架构工单 10](../../../../.scratch/architecture/issues/10-im-owner-entries.md)「背景」「决定」第 1 条与行为变化。初次共享会话决策的其他备选在 daily-agent spec、issue 06 与 agent-direction 的已确认规格/工单稿中没有记录，此处不补造。

## 后果

拥有者可从 QQ 或 Telegram 延续同一主会话；回复、审批与最终汇报都能追溯原入口，换绑定不把旧资料发给新目标。复用 NapCat 和公共发送账本避免增加一条独立回复状态机；每个渠道分别领取一批发送，离线 Telegram 积压不会阻塞 QQ。

共享历史没有平台资料隔离保证，群资料限制只覆盖可核实的原始来源与派生标记，已经复制的副本保留。当前还有一个明确的实现边界：架构工单 10 保持启动停用的公共 outbox 操作为 `pending`、原因 `sender_unavailable`；配置停用则取消旧目标的待发操作。因此“启动配置停用与配置停用同义”只适用于入站与任务，不能扩展到 outbox。若需统一停用后的通知语义，应另行决定是否取消这些待发操作。

## 验证

[daily-agent issue 06](../../../../.scratch/daily-agent/issues/06-qq-private.md)记录 macOS、本地模型与 OneBot 模拟下 `npm run typecheck` 通过，`npm test` 418 项中 417 通过、0 失败、1 项真实模型检查跳过；`git diff --check` 通过。`test/40-qq-private.test.ts`、`test/41-qq-private-scope.test.ts` 与 OneBot 传输验证覆盖共享 main、去重、身份/凭据、原目标、掉线/心跳、明确失败与缺回执、配置失效、重启恢复、群资料限制和 v14→v15 迁移；另覆盖 51 条离线 Telegram 积压时 QQ 可正常发送。

[架构工单 10](../../../../.scratch/architecture/issues/10-im-owner-entries.md)交付 `test/89-im-entries.test.ts`，用假入口核对 reconcile、回复/汇报截断与目标失效、凭据引用、Telegram 缺省渠道与 QQ 特判，并用真实适配器与回环探针证明启动停用不连接不轮询。test/40 新增“重启为 qqDisabled 后 QQ 排队任务取消，后面的 TUI 任务完成”，在旧 wait 门上核对会超时。该轮全量 906 项中 904 通过，仅既有 test/08 DNS 用例失败，图解页 test/67 通过。

初次 QQ 交付未执行真实 NapCat/QQ 收发或 Linux 部署；后续 IM 审批与最终汇报的 macOS/Linux 后台冒烟见[独立笔记](2026-10-02-im-approval-and-final-report.md)，真实平台仍未实测。运行配置见[操作手册](../../../../docs/usage.md)。
