Status: resolved

# IM 拥有者入口：QQ 私聊与 Telegram 站到它们已实现的 seam 后面

## 目标

Runtime 持一张按来源索引的拥有者 IM 入口表；每个入口回答 gate、当前钉版目标、预期发送者、回复截断、externalId 前缀、凭据代次、启停、状态与配置校验，跨平台的 reconcile、owner 回复与工作汇报收进一个模块。新增一个拥有者 IM 入口 = 加一个 adapter。来源：2026-10-05 架构审查的候选 03。

## 背景

2026-10-06 核对（develop 3de6697，工单 08/09 已合入）：

- 两个 adapter 已 `implements NotifyChannel`（`qq/adapter.ts`、`telegram/adapter.ts:156`），方法一致（gatePrivate、target、available、send、status、start、stop、onConfigChanged）；Runtime 却持两个可空具名字段 `qqAdapter` / `telegram`，按 `QQ_PRIVATE_SOURCE` / `TELEGRAM_SOURCE` 分支散在各处。
- 成对重复：`reconcileQqPrivate` / `reconcileTelegram`（`runtime.ts:3997` / `:4018`，除常量与 gate 外逐行相同）；`qqSetEnabled` / `telegramSetEnabled`（:4057 / :4208）；`qqStatus` / `telegramStatus`（:4039 / :4189，各带一套「适配器未创建」兜底）；`bumpImGenerationForCredential` 与 `reconcileImAfterCredential` 的并列分支（:2472–2498）；`start()` 的并列构造（:659–690）。
- QQ 回复上限 `maxReplyChars ?? 1500` 写 3 次（`runtime.ts:409` ImApprovals 依赖、`:433` GitHubEvents 的 capReply、`:905` capImReply）；`imExpectedActor`（:955）重建了 adapter `gatePrivate` 已经核对的 actor 字符串。
- `ImApprovals` 的 `currentTarget`、`expectedActor`、`replyCapChars` 三个依赖（`im-approvals.ts:129–137`，接线 `runtime.ts:407–409`）就是入口表的隐含 interface。
- owner 回复与工作汇报在 Runtime：`enqueueOwnerReply`（:873）、`imReplyTarget`（:893）、`capImReply`（:903）、`imReplySkipped`（:911）、`sendWorkReport`（:920，经 :445 接给父级送达）。
- 入站 gate 在两处用：编排器派发（`orchestrator.ts:324`，wait 留 registered）与队列循环任务启动前（`runtime.ts:2738`，**wait 即 return，整条 main 队列停住**，TUI 与 Telegram 任务一并等待）。
- adapter 缺失（启动配置停用：`RUUKOTO_DISABLE_QQ` / `RUUKOTO_DISABLE_TELEGRAM`，dev 开发实例固定注入；ruukoto-code 强制停用，`runtime.ts:556–557`）时：QQ 门返回 `"wait"`（:852，issue 06 起）、Telegram 返回 `drop: telegram_unavailable`（:857，issue 08 起）。没有 ADR 或工单说明差异。
- 通知目标：`notifyChannel`（:844）缺省 Telegram（ADR 0010），测试可经 `config.scheduler.channel` 覆盖；scheduler 工具的 `target()`（:2913–2925）对 QQ 来源任务特判（钉版目标一致才发 QQ，否则 null），其余走缺省渠道。
- 测 Telegram 停用后的 reconcile 现在要临时目录、MockModelServer、models.json、HTTP 上的 FakeBotApi、完整 `Runtime.start` 与 `waitFor`（38、40、77、84 号）；77 号经 `(rt as any).qqAdapter` 取内部字段。

## 决定（2026-10-06 访谈）

1. **adapter 缺失 / 启动配置停用的入口一律 drop**（原 QQ 为 wait，属漂移）：原因 `<来源>_unavailable:…`（Telegram 沿用 `telegram_unavailable`，QQ 新增 `qq_private_unavailable`）。「启动时停用」与「入口停用」同义：钉版目标无法证明有效，入站作废、排队任务按原因取消，不再停住 main 队列。记入 ADR 0012 修订段，ADR 0011 加一行引用。
2. **入口始终存在**：两个 adapter 始终创建；启动配置停用变成 adapter 的标志——不连接、不轮询（start 为空操作）、`target()` 为 null、gate 返回决定 1 的 drop、`status()` 自报停用原因（产品边界 / dev 开发实例两种文案沿用现状）。Runtime 去掉 `?.` 判空与 status / gate 的 `??` 兜底。
3. **入口接口（`ImEntry`，各 adapter 实现）**：来源；gate；当前钉版目标；预期发送者（取代 `imExpectedActor`）；回复截断（合并三处 `maxReplyChars ?? 1500` 与 `capImReply`；Telegram 沿用 `capReply`）；externalId 前缀；是否引用某凭据与事务内推进配置版本（含各自的 `*.config_changed` 事件）；启停；状态；`configure` 的校验——QQ 与 Telegram 的信任边界校验确实不同，迁入各自 adapter，**不合并**；`onConfigChanged`、`start`、`stop` 与 `NotifyChannel` 原样保留。
   **共享模块 `src/runtime/im-entries.ts`（`ImEntries`）**：持入口表；按来源 reconcile（合并两份）；owner 回复与工作最终汇报（`enqueueOwnerReply`、`imReplyTarget`、`imReplySkipped`、`sendWorkReport` 迁入）；凭据变化后的代次推进与重连 reconcile；缺省通知渠道与 `notificationTarget`（决定 6）。
   **不变**：控制协议（`qq_configure` / `telegram_configure` / `*_status` / `*_set_enabled` 等参数与应答不动，Runtime 公共方法变为一行委托）；持久事件名（`qq.config_changed`、`telegram.config_changed`、`qq_private.reply_skipped`、`telegram.reply_skipped` 等，由入口提供）。
4. **GitHub 不进入口表**：表只收拥有者 IM 入口（QQ 私聊、Telegram）。GitHub webhook 是事件来源，没有发送者绑定、回复截断、启停与 reconcile，其 gate 仍在 `inboundGate` 单独分派；ADR 0017 提到的邮件、GitHub comment 尚无代码，不为它们放宽接口。
5. **与工单 13 的先后**：先做 10，13 单独做。本单把 `ImApprovals` 的三个依赖换成一个按来源取入口的依赖；reconcile 经回调「撤销该来源的 IM 审批」调用仍在 Runtime 的 `invalidateImApprovals`。四个 Runtime 钩子（`imApprovalNotice`、`imApprovalConsumeRecheck`、`invalidateImApprovals`、`standingCandidate`）留给 13 迁入 `ImApprovals`。
6. **缺省渠道与 QQ 特判原样迁入**：`ImEntries` 持「缺省渠道 = Telegram，测试覆盖 `config.scheduler.channel`」，`notificationTarget(sourceEvent)` 保持现规则（QQ 来源任务：钉版目标一致才发 QQ，否则 null；其余：缺省渠道当前目标）。不泛化为「来自哪个入口就发哪个入口」（会改变 Telegram 来源任务在目标变化后的行为），等第三个入口出现再议。
7. **测试 seam**：`im-entries.ts` 一个单元测试，用临时 Store + 实现 `ImEntry` 的假入口，覆盖：按来源 reconcile（registered 作废、活动任务按 drop 原因取消、不波及另一平台，ADR 0011/0012）；adapter 缺失 / 启动停用得到决定 1 的 drop；owner 回复 / 工作汇报在目标变化时跳过、目标一致时按截断登记；凭据变化只推进并 reconcile 引用该凭据的入口。38、40、77、84 作回归不改；77 号对 `qqAdapter` 字段的内部引用随字段名更新。
8. **CONTEXT.md 收录「拥有者 IM 入口」**（访谈中已写入）。
9. **决定 1 记入 ADR 0012 修订段，ADR 0011 加一行引用**（访谈中已写入）。

### 行为变化

可达路径只有决定 1 一处：QQ 入口在启动配置停用（或将来任何 adapter 缺失）时，QQ 私聊入站由「留在 registered / 停住 main 队列」改为作废并记 `inbound.skipped`、排队任务按 `qq_private_unavailable` 取消。其余（Telegram 门、reconcile、owner 回复、工作汇报、通知目标、审批依赖）语义不变。

### 测试

- 新增 `im-entries` 单元测试（决定 7）；含一例「QQ 启动停用的排队任务被取消、main 队列中后面的任务照常运行」。
- adapter 启动停用标志：始终创建但 start 不连接（不打开 WebSocket、不轮询），可在 40 / 38 号既有替身上加断言或在单元测试中用假依赖核对。
- 38、40、77、84 号回归；`test/67` 图解页。

## 步骤

分支 `im-entries`（从 develop）。

0. 工单、CONTEXT.md「拥有者 IM 入口」、ADR 0012 修订段与 ADR 0011 引用、工单 13 的先后记录（本次访谈已写好，提交即可）。
1. `ImEntry` 接口与两个 adapter 实现（含启动停用标志与决定 1 的 drop、`configure` 校验迁入）；两个 adapter 始终创建；Runtime 去掉判空与兜底。
2. `src/runtime/im-entries.ts`：reconcile、owner 回复与工作汇报、凭据代次、缺省渠道与 `notificationTarget` 迁入；`ImApprovals` 三依赖换成按来源取入口；`GitHubEvents.capReply` 走入口截断；单元测试。
3. 文档：`docs/runtime.md`「架构要点」加拥有者 IM 入口；按 `.agents/skills/visual-docs/SKILL.md` 同步图解页（`inbound-events.html` 的门描述随决定 1 改）；本单追加交付记录并标 resolved。

每步 `npm run typecheck` 与全量 `npm test`（nohup + 退出码文件）通过后在分支本地提交，不 push；不在 tx 上跑真实模型验收；何时合入 develop 由拥有者决定。

## 相关 ADR

- ADR 0011 / 0012：按来源 reconcile，不取消共享 main 会话中另一平台的任务——保持；决定 1 记入 0012 修订段。
- ADR 0010：`notifyChannel` 缺省 Telegram、钉版目标的发送不改发——入口表保留这两条。
- ADR 0017：邮件、GitHub comment 是后续渠道；本单不为它们预留接口（决定 4）。

## Comments

### 2026-10-06：访谈中未单独提问、按推荐推导的实施细节（请拥有者复核）

- 命名：接口 `ImEntry`、模块 `ImEntries`（`src/runtime/im-entries.ts`）；Runtime 持 `imEntries`，原 `qqAdapter` / `telegram` 字段去掉或改为非空。
- QQ 启动停用的新 drop 原因文本取 `qq_private_unavailable:QQ 私聊入口未启动（启动配置停用）`，与 Telegram 的 `telegram_unavailable:Telegram 适配器未启动` 同形。
- 启动顺序不变：编排器启动后 `await` QQ 的 start、再启动 Telegram 轮询（`runtime.ts:750–752`）；停止顺序不变（Telegram 在编排器之前停、QQ 在编排器之后停，`runtime.ts:4251–4262`）。
- 分支与提交方式同工单 08：每步 typecheck + 全量测试后本地提交，不 push。

### 2026-10-06：交付记录（分支 im-entries，未 push）

提交：`2b8b0c3` 访谈决定；`5bba300` 步骤 1–2（合为一个提交）；`e3d6fcc` 步骤 3 文档；其后一个评审修正提交。

- `ImEntry`（`src/runtime/im-entries.ts`）由 `QqAdapter` / `TelegramAdapter` 实现：来源、`replySkippedEvent`、`startupDisabled`、`gatePrivate`、`expectedActor`、`replyCapChars` / `capReply`、`externalIdPrefix`、`usesCredential` / `bumpGeneration`、`onConfigChanged`，外加 `NotifyChannel`。`status`、`configure`、`setEnabled` 留在具体 adapter 上（两平台签名不同，按决定 3「不合并」），Runtime 经非空字段 `qqAdapter` / `telegram` 一行委托后调 `imEntries.applyConfig(source)`。字段名未改，77 号无需改动。
- `ImEntries`：`gate`、`reconcile`、`applyConfig`、`enqueueOwnerReply` / `sendWorkReport`、`bumpForCredential` / `reconcileAfterCredential`、`channel` / `target` / `notificationTarget`。`ImApprovals` 的三依赖换成 `entry(source)`；`GitHubEvents.capReply` 走入口截断。
- 两个 adapter 在 Runtime 构造时创建；启动停用是 `startupDisabled: "product" | "dev"` 标志（start 为空操作，target 为 null，门作废，status 沿用原文案）。`RuntimeApiError` 移到 `src/core/api-error.ts`（adapter 的 configure 要抛它），`runtime.ts` 原样再导出。
- 测试：`test/89-im-entries.test.ts`（假入口：按来源 reconcile、owner 回复/工作汇报的截断与跳过、凭据只推进引用者、缺省渠道覆盖与 QQ 特判；真 adapter + 回环探针：启动停用不连接不轮询、门 drop、reconcile 取消）。「后面的任务照常运行」需要真队列循环，放在 40 号新用例（重启为 qqDisabled 后 QQ 排队任务按 `qq_private_unavailable` 取消、TUI 任务完成；在旧 `wait` 门上该用例超时失败，已核对）。全量 906 项中 904 通过，仅 test/08 DNS 用例失败（本机基线即失败）。
- 文档：`docs/runtime.md` 架构要点加「拥有者 IM 入口」；图解页 inbound-events（门表、派发、配置变化复核、owner 回复、IM 审批身份）、outbox、orchestrator、task-lifecycle、deployment 同步；test/67 全绿，改过的门表已渲染核对。README 的 `RUUKOTO_DISABLE_QQ` 说明随决定 1 改。

请拥有者复核的取舍：

1. **outbox 在启动停用时仍等待、不取消**：`ImEntries.channel()` 对启动停用的入口返回 null，排队的发送操作保持 pending（`sender_unavailable`，37 号现状），而配置停用会让目标为 null、操作取消。决定 1 只把入站与排队任务改为同义，未提 outbox，为守「其余语义不变」保留现状。因此 CONTEXT.md「配置停用与启动配置停用同义」对 outbox 并不成立；要么在术语里限定为「入站与任务」，要么另开工单让 outbox 也取消。
2. **IM 审批不再经缺省渠道的测试覆盖**：旧 `currentTarget` 经 `notifyChannel`，在 `config.scheduler.channel`（仅测试）下会取覆盖渠道的目标。现在 `ImApprovals` 与 Runtime 的三个审批钩子统一取入口自身目标。生产无差别，现有测试未在覆盖下走 IM 审批。
3. 评审中记下、未处理的判断项：Telegram 启动停用状态未像 QQ 那样抽出 helper；`ImApprovals` 对未知来源的 `?? 4000` 仍是未命名常量（沿用旧值）；adapter 以 type-only 方式依赖 `runtime/im-entries.ts`。
