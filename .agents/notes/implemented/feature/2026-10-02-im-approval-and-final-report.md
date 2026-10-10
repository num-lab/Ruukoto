# Agent Note: 绑定拥有者的 IM 审批与原委托最终汇报

Status: implemented

原出处：ADR 0011「2026-10-02 修订」「实施修订（agent-direction issue 08、18）」；ADR 0012 的同名修订

## 问题

[两个 Agent 产品](../architecture/2026-10-02-two-agent-products.md)确定 Personal Agent 独立运行，绑定拥有者应能在私聊中完成审批，并在长任务委派期间继续对话。旧入口要求返回 TUI 批准，子任务只唤醒 main 而不向原委托发最终结果，会中断服务器侧的使用闭环。共享 main 又不能让一个平台查看或批准另一个平台的操作，异步通知也不能被模型扩大为任意主动外发。

本篇吸收[Telegram 入口](2026-09-24-telegram-owner-entry.md)与[QQ 私聊共享 main](2026-09-24-qq-private-shared-main.md)重复的 issue 08 审批与 issue 18 最终汇报修订；平台连接、普通 owner 回复与启动停用语义仍由两篇母笔记持有。

## 决定

- **拥有者绑定私聊提供窄审批命令。** 原始发送文本在平台正文模板与引用摘录之前整条匹配 `/approvals [cursor]`、`/approval <完整审批ID> [offset]`、`/approve <完整审批ID> <permissionVersion>`、`/reject <完整审批ID> <permissionVersion>`。ID 必须完整，权限版本为正整数，分页参数有界；已识别但格式错误由宿主返回用法，不交给模型。自然语言、引用、转发里的命令、模型输出、群消息和[含图片的文字](../architecture/2026-10-07-inbound-image-staging.md)不作为批准。长期授权及其扩展命令独立见[限定长期授权](2026-10-03-standing-permissions.md)。
- **审批响应直接处理，不等待 main 队列。** `inbound_events.event_kind = im_approval`（schema v22 首次引入）由宿主写定，`(source, external_id)` 仍去重。同步事务内登记并直接到 `done / failed`，不建普通任务、不调用模型、不进入普通派发；恢复显式排除控制类别，遗留控制消息不能重新解释为提示或批准。等待审批的 main 不会把批准命令排到自己后面。
- **列表、详情与决定只作用于原入口和原请求。** 宿主从审批任务沿已记录 `parentTaskId` 找原普通 IM 委托，拒绝断链、循环、无来源及非 IM task 事件，不从最近一条会话消息推断。核对原平台、原登录账号/bot、原 owner、actor、收件钉版目标和配置版本；Telegram `ownerUserId` 与 `chatId` 分别核对，不能从 chat 推断 user。另一平台、TUI/定时/GitHub 来源的审批不因共享 main 而开放。普通 IM 任务仍 `confirm`；平台身份不成为通用控制面身份、不允许切换模式或任意会话访问。
- **决定、控制事件与回执同事务提交。** 审批创建事务登记 `confirmation / im-approval:<审批ID>` 的初始通知，固定目标与宿主格式化的具体范围、完整 ID、权限版本及命令；详情按平台上限有界分页，明确下一偏移，不能把截短范围当完整详情。合法决定通过原活动 Driver 和统一审批闸门，把决定、审计事件、控制事件终态及 `inbound_event / <控制事件ID>` 回执一并提交，提交后才唤醒 waiter。SQL 中途失败全部回滚；TUI、IM、自动审查或不同消息竞争时，仅 pending 的首次合法条件更新成功。
- **批准仍绑定原参数与单次消费。** 命令只选择原请求/权限版本，不接受新参数或范围。实际执行前在统一消费事务内再次核实任务、权限版本、未消费状态、原 IM 身份/目标/配置版本及操作自身的资料、凭据与配置。回执写“批准已接受，仍待执行前复核”，不能把批准说成操作已成功。`consumedAt` 表示执行已开始，后续停用、取消或重启不撤销这个事实，不重放结果未知的效果。
- **异步最终汇报由宿主判定工作收尾。** 仅对发起任务经 `originTaskId → source_event_id → inbound_events` 找到 `telegram / qq_private`、`event_kind=task` 原委托的通用工作执行。main 结果唤醒到达终态时，工作没有 queued/running/awaiting_confirmation 执行任务，且所有其他已终态执行的 `wake:<id>` 都存在并已记结果，才把本轮最终回答作为最终汇报。宿主固定说明要求 main 汇总全部子任务；不靠模型调用工具宣告收尾。工作已取消则不自动汇报，取消所在轮次已有回复。
- **最终汇报固定原委托目标与稳定回复槽。** 收尾的 main 唤醒结果事务登记 `owner_reply`，键为 `<发起事件ID>#work:<workId>:<收尾执行任务ID>`，taskId 为收尾唤醒任务；巡检补记与重复终态按同键幂等。同一工作补充执行后再次收尾用新的执行任务 ID 形成新汇报。后续续派即使来自另一入口，仍发回最初入口；由 TUI/dev、定时、群或 GitHub 发起的工作不适用。GitHub 继续使用[固定事件通知](2026-09-24-github-event-review.md)。

## 代次失效、回执与发送边界

绑定、启停和服务凭据变化推进对应入口的单调 configVersion；凭据同名改写/删除在写入前推进引用者的代次，A→B→A 不复活旧连接、轮询、消息或批准。SQLite 与凭据文件没有跨文件事务；先保证旧授权失效，写失败也不恢复旧版本，缓存与磁盘事实保持一致，随后重连及 reconcile。旧请求错误按捕获 token 脱敏。Telegram 旧 `replyTarget=null` 无法证明当时配置，不能从当前配置补造绑定。

失效只作用于原平台的 registered/queued 工作和关联审批，不波及另一平台的共享主会话工作。未消费 pending/approved 请求失效并定向解除 waiter 或按既有取消路径收尾，不能只改状态却让等待挂起。后台恢复将未消费待决与已批准请求失效，不重建旧 waiter；已消费事实保留，工具操作和通知发送的未知效果分别记录。暂时掉线、版本不变时仅等待恢复，不等同于重绑或停用。

控制消息重投先比较原类别、actor、钉版目标与规范命令，同键异命令拒绝；已处理的原消息只返回原回执，不按新审批状态再执行或换目标。初始审批通知发送前核对请求仍有效，决定回执则核对原控制事件与目标，不能要求任务仍停在 awaiting_confirmation。通知、详情、决定回执及最终汇报都复用[公共 outbox](../architecture/2026-09-24-scheduler-outbox.md)：目标变化取消、不改发，离线保持 pending，明确限流按原操作 `not_before` 延后，failed/effect_unknown 与重启遗留 sending 不换键重发。

最终汇报首行为宿主固定的 `[工作 <workId> 最终汇报]`，正文取该收尾唤醒任务的历史回答；失败、超时或被重启中断用宿主固定提示，并引导在 TUI 查看详情。按平台回复上限截短，QQ 与 Telegram 都引用原入站消息。登记时目标失效记 `*.reply_skipped`，reason 带 `work_report:`；发送前再次核对固定目标。普通受理回复先登记，同渠道按创建顺序领取，受理在最终汇报之前发出。

原“子任务唤醒不产生 owner 回复”的例外只限 IM 发起通用工作的收尾轮次，旧 coding draft 链仍不外发。唤醒任务没有可信通知目标时，`notification_enqueue` 直接拒绝、没有审批或发送；IM 来源任务自行申请的新通知仍走独立审批。唤醒轮次不能调用拥有者来源的委派工具，后续续派发生在拥有者/IM 消息轮次，其活动执行自然推迟收尾；不把实施前“在本轮继续委派”的假设当现状。

当前实现由 [ImApprovals](../../../../src/runtime/im-approvals.ts)维护审批控制链，[父级送达](../../../../src/runtime/parent-delivery.ts)判定结果唤醒与工作收尾，[IM 入口表](../../../../src/runtime/im-entries.ts)登记固定目标回复。两条路径不新增模型汇报工具或独立发送表。

## 备选方案

- **继续只在 TUI 审批。** 它复用已有拥有者认证与完整审批界面，不需要平台控制命令；Telegram 首次交付明确采用过。未选，是因为 Personal Agent 要在独立服务器上通过绑定私聊完成管理闭环，返回开发机器 TUI 会中断使用；因此只开放宿主核实的具体审批，不扩大为通用控制面。来源：[daily-agent issue 04](../../../../.scratch/daily-agent/issues/04-telegram-owner.md)「实施前确认」及 [agent-direction spec](../../../../.scratch/agent-direction/spec.md)服务器权限边界与访谈确认。
- **把审批消息当普通 main 任务处理。** 这样可复用现有入站派发与队列，少建一条处理路径。未选，是因为 main 正在 awaiting_confirmation 时批准会排在等待任务之后，形成死锁；消息还会进入模型。宿主直接终结控制事件，保留持久去重与原回执。来源：[issue 08](../../../../.scratch/agent-direction/issues/08-im-approvals.md)验收第 3 项及严格命令/直达审批实施步骤。
- **由模型调用工具宣告工作收尾或选择不汇报。** 模型了解任务内容，可以决定何时适合汇报。未选，是因为漏调用会使拥有者一直收不到完成/失败结果，还会新增可触发外发的模型入口；宿主按工作任务与唤醒事实自动判定，main 不能选择省略收尾汇报。来源：[issue 18](../../../../.scratch/agent-direction/issues/18-im-final-delivery.md)「默认取舍」及实施完成记录。
- **给最终汇报新增 source_kind 或保存一套入口字段。** 这可以直接表示汇报类别与路由。未选，是因为发起任务、来源事件及 `reply_target` 已不可变且可派生，`owner_reply` 本来就提供入站事件加回复槽，新增存储会维护重复事实并需要 schema 修改。来源：issue 18「现状核实」「复用 owner_reply」与「不做」。

## 后果

拥有者可以在等待审批期间直接查看范围、批准或拒绝，再收到原入口任务结果；长任务委派后仍能继续对话，工作收尾的 main 汇总自动送回最初委托。批准、执行、回执、来源键与正文可分别核查，两平台共享 main 不共享审批权限。复用原闸门、事件表和 outbox，结果事务与持久来源键负责恢复幂等。

命令要求完整 ID 与版本，长详情需要分页；绑定或凭据变化会使旧批准失效，需要原入口重新申请。收尾自动汇报让 main 无法选择不发，同一工作从其他入口续派仍发回最初入口；取消后不自动汇报。图片、转发与引用不能批准，未知效果不自动重试，真实平台可达性和兼容性仍需独立验收。启动停用的 outbox 等待边界见[QQ 入口的后果](2026-09-24-qq-private-shared-main.md)，不能把入站失效扩展成所有待发操作都取消。

## 验证

[issue 08 交付记录](../../../../.scratch/agent-direction/issues/08-im-approvals.md)记录 `npx tsx --test test/77-im-approvals.test.ts test/38-telegram-owner.test.ts test/40-qq-private.test.ts test/63-approval-gate.test.ts` 及相关回归在 macOS 通过，tx Linux 关键套件 66/66，`npm run typecheck` 通过。test/77 当时 14 项逐平台覆盖完整申请→通知→详情→决定→一次真实受控数据效果→原入口，等待中命令零模型调用、身份/格式/版本/跨平台拒绝、重投与竞争、凭据 A→B→A/删除/旧目标、事务中途回滚、消费复核与重启窗口、429 原键延后及旧 token 迟到错误脱敏。旧 coding 子任务归属用例是当时验证，issue 23 退役后相关旧写用例删除，不作为现有能力。

`.scratch/agent-direction/smoke-08-im-approvals.mts` 在 macOS 与 tx Linux 各 9/9，真实部分为后台进程、控制面 socket、SQLite/main.db 受控数据、配置和凭据写入、去重与 outbox/重启；模型、OneBot 与 Bot API 模拟。该轮全量 817 项，815 通过、1 项真实模型门控跳过、test/08 DNS 超时失败；在干净基线 HEAD `8be27c5` 复现同一失败，记录为环境问题。

[issue 18 交付记录](../../../../.scratch/agent-direction/issues/18-im-final-delivery.md)记录 `test/84-im-final-delivery.test.ts` 当时 9 项及相关回归、typecheck 全通过，`npm test` 912 通过、0 失败、1 跳过。覆盖 QQ/TG 受理→续聊→汇报顺序，跨入口续派仍回原目标、按收尾任务取正文、并发/重复/巡检补记一次、补充再收尾新键、目标失效/离线/429/unknown、无任意外发授权。`.scratch/agent-direction/smoke-18-im-final-delivery.mts` 在 macOS 与 tx Linux 各 7/7，真实后台、控制面、SQLite/outbox、Docker 受限 worker 与 SIGKILL 重启，模型及两平台模拟。

以上历史证据没有实测真实 QQ/NapCat 或真实 Telegram Bot API，两个平台仍各需独立真实闭环。运行命令与说明见[操作手册](../../../../docs/usage.md)。
