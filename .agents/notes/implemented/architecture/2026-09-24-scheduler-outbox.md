# Agent Note: 调度器与通知 outbox 的持久事实、固定授权与恢复边界

Status: implemented

原编号：ADR 0010

## 问题

[daily-agent 规格](../../../../.scratch/daily-agent/spec.md)要求提醒跨重启不丢失、按当地钟点跨夏令时触发，未预先授权的外部发送由拥有者确认。内存定时器无法保存到期与发送事实，发送应答丢失又不能被当成未发送，否则恢复会产生第二次外部副作用。调度是单个后台实例的基础设施，业务数据与核心运行状态需要分别管理。

## 决定

1. **数据库保存事实，内存只负责唤醒扫描。** `schedules / schedule_runs / notification_ops` 位于核心 `ruukoto.db`，由 schema v13 首次引入；应用数据工具不可访问。main 的待办、提醒、习惯等业务字段仍由[应用数据空间](2026-09-23-main-app-data-space.md)管理。计划、运行、发送状态与对应事件在核心事务内提交，网络、模型与应用库查询在事务外执行。
2. **时间规则固定为一次性、每日、每周与 IANA 时区。** 使用 ISO 日历，周期触发按当地日期和原定钟点重新构造；DST 固定 `compatible`，缺口向后顺延、重复钟点取较早的一次。IANA 偏移和 DST 计算集中在 `packages/channels/src/scheduler/time.ts`，使用锁定的 `@js-temporal/polyfill`，不自写算法、不提高 Node 版本要求。一次性时间必须带 `Z` 或明确偏移，不使用服务器时区补全；时钟回拨不回退已处理范围，时区数据更新只影响未登记的未来时刻。
3. **漏过周期只补一次。** 每个计划最多一个未完成运行，以 `(schedule_id, schedule_version, scheduled_for)` 唯一。没有未完成运行时取扫描截点前最近一次并标延迟与合并范围；已有未完成运行时保留原运行键与原正文，合并后续漏过区间，不新建第二个运行。恢复准备 MUST 在通用 `Runtime.recover()` 改写 running 任务之前读取真实状态：已终态但未关闭的运行先补关闭，真实待处理运行再合并，之后把遗留 `sending` 定为 `effect_unknown`。后续正常周期是新运行，不能称为重发旧失败操作。
4. **发送状态按事实转换。** `pending` 表示未领取，`sending` 表示已领取且可能发出；只有条件更新成功的领取者调用发送函数一次。明确成功为 `sent`，可证明未发送为 `failed`，其余为 `effect_unknown`；`sent / failed / effect_unknown / canceled` NEVER 自动重发，迟到回执只记录。平台明确限流拒绝、可证明未发送时，按[Telegram 入口的限流例外](../feature/2026-09-24-telegram-owner-entry.md)退回同一操作的 `pending`，写 `not_before` 后延迟领取；目标、正文和键都不变，领取期间已有取消意图的转 `canceled`。超时、5xx 与发送中断不适用这个例外。 **逻辑发送键由宿主决定。** 定时通知用运行 ID，一次确认用任务通知槽，owner 回复用入站事件与固定回复槽；`(source_kind, source_key)` 唯一，同键同参返回原记录，同键异参拒绝。模型不能生成新键绕过未知结果。普通 owner 回复见[Telegram 入口](../feature/2026-09-24-telegram-owner-entry.md)与[QQ 私聊入口](../feature/2026-09-24-qq-private-shared-main.md)，异步工作收尾回复见[IM 审批与最终汇报](../feature/2026-10-02-im-approval-and-final-report.md)；[GitHub 事件通知](../feature/2026-09-24-github-event-review.md)有独立的固定事件槽。
5. **发送授权固定目标、正文与持续范围。** 目标来自可信宿主渠道配置。`notify` 计划和一次 `notification_enqueue` 都经统一审批，`ApprovalScope.kind = notification` 固定完整正文、目标/账号/配置版本、时间规则、IANA 时区、DST 和持续范围。获批后在同一核心事务内重核并单次消费；目标配置变化或停用使旧授权失效，不能改发新目标。`wake_main` 只登记触发说明，不能继承外发授权；[新闻计划](../../archived/feature/2026-09-25-scheduled-news.md)单独规定固定采集范围的授权。

## 与执行权限及取消的关系

[显式访问模式](../feature/2026-09-19-explicit-access-modes.md)的一般 `full_access` 语义在通知外发上有明确例外：建立持续发送计划和未预授权的一次外发仍须拥有者确认：外发面向平台上的真实接收者，其授权独立于任务执行权限（daily-agent 规格第 6 项）。`auto-review` 的确定性策略 `classifyForReview`（`packages/agent/src/review.ts`）不覆盖 `notification`，默认直接转拥有者，不调用审查模型。已批准计划与可信 owner 回复属于宿主定义的自动发送范围，不复用 MCP 的完全访问放行分支。

计划只提供创建、查询、取消；修改时间、正文或动作须取消后重建，通知计划重新确认。取消停止未来触发，取消尚未发送的 `pending` 与排队任务；已运行任务和在途发送保留真实效果，取消只记意图，不能承诺撤回。永久失效取消，暂时离线或发送器未加载保持 `pending` 并显示等待原因。正文引用在审批前解析为有界固定快照，业务行以后变化不改变批准正文，发送前仍重核可撤销的资料授权。

## 备选方案

- **直接沿用 `qq_outbox`。** 它已有群回复账本，复用可以少建一套存储。未选，是因为其 `pending` 同时表示未发与在途，重启全部转 `unknown`，也没有业务幂等唯一键；公共通知需要证明未领取与可能已发送的区别，直接套用会混淆恢复与取消语义。旧群回复账本独立保留，不随公共 outbox 引入迁移。来源：[daily-agent issue 03](../../../../.scratch/daily-agent/issues/03-scheduler-outbox.md)实施计划第 1 节及实施边界。
- **自写 IANA/DST 计算或提高 Node 版本以用全局 Temporal。** 前者可避免依赖，后者可直接使用平台时间 API。未选，是因为当时 Node 24.15 没有全局 Temporal，项目要求 Node `>=22.19`；自行维护偏移、半小时 DST 与历史时区规则成本过高。锁定 polyfill 并集中使用，保留既有 Node 要求。来源：issue 03 实施计划第 3 节与交付记录。
- **Redis、消息中间件与多机调度。** 它们能独立持有分布式队列和触发状态。未选，是因为拥有者确认单进程 SQLite 为本阶段约束，同一实例已经持有数据库与实例锁，没有多机交付目标。来源：[daily-agent spec](../../../../.scratch/daily-agent/spec.md)第 7 项及「明确不做」。

## 后果

工作流业务问题增加 `workflow_question` 独立通知来源；原入口最终结果继续复用 owner_reply，定时工作流只由 schedule_run 最终回报。具体身份、状态与资料复核见[整项送达](../feature/2026-10-13-workflow-owner-input-and-delivery.md)。

计划、触发、授权与发送事实可恢复，并能在控制面和 `ruukoto schedule|notify list|show|cancel` 查阅。调度与发送不进入编码会话队列、不占工作目录；短事务扫描与独立单在途发送循环让慢发送不阻塞到期登记、控制面或编码任务。

本地保证一个逻辑键至多一个操作，且不重复发起可能已有副作用的发送；平台无幂等支持时不能保证远端 exactly-once，也不能同时保证未知窗口必达，`effect_unknown` 需要拥有者核实。首版不提供 cron、通用工作流、平台插件系统或通用自动重试框架；新时间规则、计划编辑或多机运行需要重新决定授权与恢复边界。

## 验证

[daily-agent issue 03 交付记录](../../../../.scratch/daily-agent/issues/03-scheduler-outbox.md)记录 macOS、Node 24.15、模拟模型与通知渠道下 `npm run typecheck` 通过，`npm test` 388 项中 387 通过、1 项真实模型检查按默认跳过。实际新增套件为 `npx tsx --test test/37-scheduler-outbox.test.ts`（16 项），覆盖纽约 gap/fold、Lord_Howe 半小时变化、Kathmandu 偏移与多年停机，重复/并发 tick、审批、固定快照、领取与恢复、迟到回执、取消竞争、慢发送不阻塞、v12→v13 迁移及 SQLite 完整性。

真实后台子进程 SIGKILL 验证平台已接收但本地未落结果时重启记 `effect_unknown`，模拟平台仅收到一次。该轮未执行真实 Telegram/QQ 发送或 Linux 回归；后续平台入口的验证各自记录，运行说明见[操作手册](../../../../docs/usage.md)。这些是历史验收证据。

## 适用范围

完全访问的账户、环境、免审批及宿主任务授权传播采用[本决定](../feature/2026-10-12-full-access-current-account.md)；本篇其他独立规则继续适用。

通用调度的独立执行、运行归属、审批来源与整项取消采用[本决定](../feature/2026-10-12-generic-scheduled-tasks.md)；本篇其他独立规则继续适用。
