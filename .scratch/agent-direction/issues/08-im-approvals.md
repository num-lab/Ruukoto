Status: resolved

# 08 — 在绑定拥有者的 IM 私聊完成审批

**What to build:** QQ 和 Telegram 中触发已有受控操作时，拥有者能查看审批详情、批准或拒绝，并继续收到任务结果。

**Blocked by:** 无，可立即开始

依据：[已确认规格](../spec.md) 与 [ADR 0017](../../../docs/adr/0017-two-agent-products.md)。

## 验收标准

- [x] 分别通过 QQ、Telegram 演示已有需审批操作的申请、详情、批准或拒绝、任务继续及原入口回复。
- [x] 核实绑定拥有者、平台目标和配置版本；其他身份、旧绑定、失效或已消费的审批均不能执行。
- [x] 审批响应直接进入审批处理路径，不排在正在等待审批的普通任务后面造成死锁。
- [x] 批准绑定具体操作及范围并单次消费；平台身份不会变成任意控制面访问权。
- [x] 处理重复消息、重新绑定和后台重启，不重复执行已获批操作；两平台分别验证入站失效边界。
- [x] 完成相关端到端检查、类型检查及仓库要求的验证；同步本次行为涉及的运行说明和图解，验证记录区分模拟结果与真实环境结果。

## Comments

### 2026-10-03：实施计划

本计划基于 HEAD `8be27c5`、工单 07 的最终交付记录、当前 IM/审批代码和两项并行只读核查制定，使用 ponytail skill。08 没有前置阻塞，可以开始；以下是待实施方案，本次没有发送平台消息、修改运行代码或运行验收。

#### 已确认的基础与缺口

现有批准链是 `Runtime.respondConfirmation → Driver.resolveConfirmation → ApprovalGate.resolve`，真正执行前再由 `ApprovalGate.consume → Store.consumeApproval` 检查批准、未消费、任务活动状态和权限版本。参数取自原审批快照。公共 outbox 已支持固定目标/正文、唯一发送键、条件领取、限流延后及效果未知不重发，可以直接复用。

QQ 私聊已经保存接收时的 `replyTarget`，派发、任务启动和回复按原账号、拥有者及配置版本核实。Telegram 当前只在收件时按轮询捕获的 owner 配置检查，没有保存 `replyTarget`，也没有对应的派发/启动失效门；最终回复使用当时的当前目标，同 bot/chat 下的版本变化无法阻止旧消息。Telegram 实际 `send` 还缺少领取之后的完整目标复核。

两平台凭据的同名修改/删除目前不推进 IM 配置版本。QQ 的连接 key 没有配置版本，Telegram 的旧轮询结果使用捕获配置；轮换或重新绑定后必须防止旧连接、旧消息和旧批准再次有效。Telegram 错误脱敏只使用当前 token，在旧 token 的请求稍后报错时可能漏掉旧秘密值。

`ApprovalGate.resolve` 当前分两次事务保存决定和事件，随后唤醒等待者。IM 响应需要把决定、控制消息记录及固定回执一起提交，避免批准已经生效而入站回执尚未落盘。

本单只增加绑定私聊的窄审批能力。普通 IM 入站继续固定 confirm；服务器管理工具、长期授权、通用 SubAgent 和异步工作最终汇报分别由 09、10、11、18 实施。08 的完整结果场景先使用主会话已有受控操作，例如应用数据的需确认变更；不以新增服务器权限作为本单前置。

#### 实施步骤

1. **先补齐两平台的身份、版本与原目标链。**

   Telegram 和 QQ 适配器在身份核实后向宿主提交原文本、平台 external ID、actor 及该次接收捕获的固定 target。Telegram 的 target 从发起该次轮询的 config/token 生成，不用后来配置重新包装旧消息；登记前及推进轮询偏移前核对当前版本、凭据和捕获状态。补保存 `InboundEvent.replyTarget`，无需另造目标表。QQ 继续核对已登录账号、事件 self_id、friend 私聊、owner、sender 及结构化文本，并把配置版本纳入连接/排队事件的代次校验。

   Telegram 增加与 QQ 对应的入站门：派发、任务启动和配置 reconcile 都核对 source、actor、固定目标及版本，暂时离线等待，停用或绑定变化明确失效。普通消息的最终回复统一使用原事件 target；Telegram 实际 fetch 前再次核对 enabled、完整 target 和当前有效凭据，覆盖 outbox 已领取但配置刚变化的窗口。旧消息和发送操作不能改发到新绑定或另一平台。

   核对所有受支持的服务凭据管理入口。按 credentialName 找到受影响的 QQ/Telegram 配置，凭据变化前持久推进其单调 configVersion；随后同步保存/删除凭据并触发重新连接、旧入站和审批 reconcile。凭据写失败不恢复旧版本或旧批准，明确报告失败并保持凭据缓存与磁盘事实一致。配置 scope 收紧等内部写入也须核查影响，避免漏掉共享引用。A → B → A 的凭据轮换不能恢复旧代次。继续核实 host、purpose、header 和 scope；不只检查 secret 是否存在。

   SQLite 与凭据文件没有跨文件事务，不宣称二者原子提交；先保证旧授权失效。发送和轮询的错误使用该请求捕获的 token 脱敏，涵盖轮换、删除及旧请求迟到错误。无需保存秘密指纹或新增凭据授权框架。

   旧 Telegram 事件 `replyTarget=null` 无法证明接收时版本，不能按当前配置补造。其 registered/queued 工作明确失效，原历史与执行事实保留；旧审批可在 TUI 查阅，不能通过 IM 获得新绑定。Coding Agent 及开发本项目的隔离实例继续遵守现有平台停用规则。

   主要落点：`src/telegram/adapter.ts`、`src/qq/adapter.ts`、`src/runtime/runtime.ts`、两平台配置 Store；凭据读写复用 `src/agent/execution/credentials.ts`。

2. **提供严格文本命令，并直接进入宿主审批路径。**

   两平台使用同一组整条匹配的命令：

   ```text
   /approvals [cursor]
   /approval <完整审批ID> [offset]
   /approve <完整审批ID> <permissionVersion>
   /reject <完整审批ID> <permissionVersion>
   ```

   在添加平台正文模板、引用摘录之前解析实际发送文本，校验完整 ID、正整数权限版本及有界分页参数。已识别命令但格式错误时由宿主返回用法，同样不交给主模型。普通正文保持现有入站路径；自然语言、引用中的命令、转发内容、模型输出和群消息不能被解释为批准。首版使用现有纯文本渠道，不增加按钮或 callback 协议。

   宿主从 confirmation 的 task 沿已记录 parentTaskId 找到原 IM 委托，拒绝断链、循环、无来源或来源不是普通 IM 委托的情况；不从主会话最近一条消息推断归属。可支持现有 main → coding 子任务的审批来源，但其异步最终汇报仍按 18 的范围处理。

   列表、详情和决定只作用于原平台、原账号、原 owner 和原配置版本。Telegram 的 ownerUserId 与 chatId 分别核对，actor 必须匹配配置及原事件，不能由 chatId 推断 userId。另一平台、其他任务来源、TUI 发起且没有 IM 来源的审批不因共享 main 而开放。拥有者控制面的既有 TUI/CLI 接口继续使用其原认证，不向 IM 暴露通用 request、任意会话访问或模式切换能力。

   为 `inbound_events` 增加宿主写定的 `event_kind` 字段（`task` / `im_approval`），区分普通任务入站与 IM 审批控制消息，旧记录默认 `task`。这个字段用于恢复时防止控制消息误派发到模型，不能由消息正文或模型参数决定。审批消息仍以 `(source, external_id)` 去重，在同步事务中直接 registered → done/failed，taskId 为 null；不调用编排器的普通登记/派发接口，不新建 main 任务，也不等待当前任务完成。

   同一平台消息重投时，先比较原类别、actor、原 target 和规范命令并读取原回执；同键异命令拒绝，不能按新的审批状态再执行。同一个已完成控制事件即使后来绑定变化也不改目标或换发送键。恢复派发显式排除控制类别；异常遗留控制记录不能作为普通提示或新的批准自动重放。

   主要落点：新增集中模块 `src/runtime/im-approvals.ts`，两适配器接线；`src/core/types.ts`、`src/core/db.ts`、`src/core/store.ts`、`src/runtime/orchestrator.ts`。仅加必要类别列，不增加审批、绑定或命令账本表。

3. **把通知、决定与回执接到原审批闸门及 outbox。**

   创建审批时，在原审批登记事务内通过宿主接线登记初始 IM 通知。使用 `notification_ops.sourceKind=confirmation`、`sourceKey=im-approval:<confirmationId>`，保存原固定 target 和宿主格式化正文；前缀避开已有一次通知的 `task:<taskId>` 槽。无需复制 params、scope 或建立新的批准状态。通知暂时发送失败不使操作获批，审批的有效性继续由原请求和宿主核实。

   初始通知包括任务/操作/工具、具体范围概览、权限版本、完整审批 ID 及查询/批准/拒绝命令。参数与范围内容明确作为数据展示，不由模型改写审批说明。列表有游标，详情在身份与归属检查后复用 `confirmationToView`、`getConfirmationParams` 的有界分段能力，按 QQ 配置上限和 Telegram 消息上限分页并给出下一页 offset。不能把截断范围当作完整详情；批准命令只选择原请求和版本，不接受新参数或修改范围。

   合并 `ApprovalGate.resolve` 的决定和事件事务，并增加最小接线，使 IM 控制事件登记、决定、审计事件、控制事件终态及响应 outbox 一并提交；提交后再唤醒 waiter。沿用 Runtime/Driver 的活动任务与等待者核实，避免嵌套 `Store.withTx`。回执使用 `sourceKind=inbound_event`、`sourceKey=<控制事件ID>`，其正文和目标固定。中途写失败全部回滚，不留下“批准成功但没有控制回执”的状态。

   回执准确区分“批准已接受，仍待执行前复核”“已拒绝”“已失效/已处理”，不能把决定接受说成操作成功。不同消息对同一请求重复批准、相反决定，或 TUI/自动审查抢先响应时，只有 pending 的第一次合法条件更新成功；其他响应不执行、不覆盖原决定。

   初始 notice 的持久 target，加原 task/来源事件及 actor，作为 IM 审批的固定身份依据。通知发送前检查请求仍有效；决定回执发送前核对其原控制事件与目标，但不能要求任务仍停在 awaiting_confirmation。现有 `GitHubEvents.verifyNotification` 会拒绝非 GitHub 的 inbound_event 发送，需在 Runtime 发送核实处明确分流已核实 IM 控制回执；其他来源保留现有严格检查。通知/回执的 `sourceRefs=[]`，审批身份由宿主核实，不扩展正文引用类型。

   最终任务回答继续使用已有 owner_reply 按原入口返回。每个 notice、详情响应、决定回执分别有稳定来源键；限流只按原操作延后，发送超时、断线、缺少回执及重启遗留 sending 沿用效果未知，不换键重发。

   主要落点：`src/agent/approval-gate.ts`、`src/agent/driver.ts`、`src/runtime/runtime.ts`、IM 审批模块、`src/core/store.ts`；发送复用 `src/scheduler/store.ts` 与 `src/scheduler/runtime.ts`。

4. **在消费及恢复路径核实失效，保证等待能够结束。**

   IM 响应必须携带原 permissionVersion，同时核对审批及任务当前版本、pending 状态、活动 Driver、原来源与当前绑定。实际执行前，在统一批准消费事务中再次核对 IM 固定身份及配置版本，覆盖已接收批准、尚未消费时的重新绑定或凭据变化；操作自身的目录、MCP 配置、凭据、应用数据等既有复核继续执行。

   配置失效时，按原平台与来源核实受影响的 registered/queued 工作和关联审批，不取消另一平台在共享主会话中的工作。未消费的 pending/approved 请求失效，取消相关任务或解除该请求的 waiter，按既有停止/失效路径记录已知未执行；不能只改状态而让等待永久挂起。跨父子任务的请求依据原委托链处理，不能用“最新会话来源”或一个全局取消代替。

   `consumedAt` 已存在即执行开始；后来的停用、取消或重启不能撤回这个事实，也不能把已发送操作当作未执行重放。后台恢复沿用活动任务 interrupted、占用待核实和工具操作账本收尾；未消费 pending/approved 明确失效，旧 waiter 不重建，旧平台批准消息不重新执行。通知未知结果与工具操作未知结果分别记录。

   暂时掉线只影响接收/发送可用性，版本未变时按原固定目标等待恢复；重新绑定、停用再启用和凭据变更则使旧代次失效。生产路径继续使用原审批参数快照、单次消费和任务权限模式，不因 IM 批准增加长期授权或切换完全访问。

   主要落点：统一审批消费接线、Runtime 的两平台 reconcile 与恢复、`src/core/store.ts`。不另建执行闸门或自动重试层。

#### 验证与验收

新增 `test/77-im-approvals.test.ts` 集中验证两平台的审批完整路径，编号在实施时核实。复用 test/38 的 FakeBotApi、`test/helpers/mock-onebot.ts`、MockModelServer 和现有审批工具；仅在跨套件复用确有需要时提取现有测试助手，不另造框架。平台身份竞态、闸门事务与发送结果分别扩展已有 test/38、40、63、37、43。

必须覆盖以下场景：

- QQ、Telegram 各自经历申请 → 原入口通知 → 列表/分页详情 → 批准 → 原操作恰好一次 → 原入口结果；分别验证拒绝时操作零次。至少使用一种主会话已有真实受控数据操作，不能只断言回复文本。
- main 正在等待审批时，命令直接处理并解除等待；普通新消息继续排队。审批、详情及错误审批命令零额外模型调用、零普通任务，不因队列造成死锁。
- 非 owner、非 private、群、QQ temporary/subtype、错误 self_id/sender、引用/转发、格式错误、版本错误、部分 ID、跨平台、无来源及无关审批都不能执行，未经核实身份不收到操作详情。
- 同平台消息重投、同 ID 异正文、不同消息重复或相反决定、TUI/IM/自动审查竞争，决定及操作均只能生效一次；控制类别在恢复派发中被排除。
- 两平台各自测试 owner/account/配置版本变化、停用再启用、同账号同 owner 重绑、凭据 A → B → A、凭据删除及元数据失效；旧 QQ 连接事件、旧 Telegram 轮询结果与旧偏移不能污染新代次。
- Telegram 原目标持久化、旧 null target 明确失效、派发与启动门、终态回复固定目标、outbox 领取与实际 fetch 之间的配置变化；QQ 同类边界分别证明，不能用一个平台的结果替代另一个。
- 批准已接受但消费前绑定/权限/操作配置变化时零执行；配置失效能解除等待；失效只影响原平台相关工作，不波及另一平台任务。
- 审批创建/notice 登记、决定/事件/控制回执事务中途故障全部回滚；测试故障在部分 SQL 已执行之后。重启覆盖未决定、已批准未消费、已消费在途，以及平台发送已接收但本地未落回执的窗口，不重放外部效果。
- 429 只以原通知操作延后重试；超时、断线、缺失回执和迟到结果不换键重发；旧 token 的迟到错误在日志、账本、详情、IM 文本及模型请求中均脱敏。
- 旧库加类别列后历史、入站、审批及发送事实保留；旧 TUI/CLI 审批继续工作，普通 IM 任务固定 confirm，Coding Agent 仍不连接消息平台。

实施后的检查顺序：

```bash
npx tsx --test test/77-im-approvals.test.ts test/38-telegram-owner.test.ts test/40-qq-private.test.ts test/63-approval-gate.test.ts
npx tsx --test test/08-approvals.test.ts test/22-auto-review.test.ts test/25-mcp-write.test.ts test/28-main-data.test.ts test/37-scheduler-outbox.test.ts test/41-qq-private-scope.test.ts test/43-inbound-notification-store.test.ts test/27-orchestration.test.ts test/39-coding-delegation.test.ts test/45-github-events.test.ts test/71-product-entry.test.ts
npm run typecheck
npx tsx --test test/67-visual-docs.test.ts
npm test
```

新增 `.scratch/agent-direction/smoke-08-im-approvals.mts`，使用真实 ruukoto 后台进程、隔离档案、socket、SQLite/历史与受控数据效果，串联两平台入站、详情、决定、原入口回复、重复投递及重启。macOS 本机与 Linux `ssh tx` 分别执行；模型、Bot API 与 OneBot 打桩部分明确记录为模拟平台，不能据此宣称真实 Telegram/QQ 已验收。

真实平台演练分别由绑定拥有者主动发起测试委托、查询详情并批准/拒绝，在隔离测试账号或测试 bot 上核对登录身份、实际消息 ID、单次消费、实际效果及原入口结果。避免测试实例与日常实例同时消费同一平台账号。真实 NapCat 在线探测、消息段及断线行为，以及 Telegram 的真实轮询/发送行为需分别登记；没有真实测试入口时保留对应未验收项，不借用日常凭据或用模拟结果替代。

同步 `docs/runtime.md`、`CONTEXT.md` 中 IM 审批命令、原入口绑定、凭据变化、控制消息与恢复规则。ADR 0017 已允许绑定私聊审批，实施时更新 ADR 0011/0012 中“审批仅在 TUI”的旧阶段描述，保留固定目标、权限模式及未知结果边界；异步最终汇报的 18 范围不要标为本单已实现。对所有实际改动的 `src/`、`deploy/` 文件按仓库约定运行 `grep -l <文件路径> docs/visual/*.html`，同步命中页面的图、表与正文，重点核查 `control-protocol.html`、`inbound-events.html`、`task-lifecycle.html`、`outbox.html`、`storage-layout.html`、`tool-call-path.html`，并完成 test/67。

完成后逐条登记六项验收证据，区分真实环境、模拟平台与真实平台结果。07 已记录 test/08 DNS 60s 超时及 test/33 并行负载抖动；本单触及审批路径，应重新核实相关失败及基线，不能直接沿用“与本单无关”的判断。本次只保存计划，工单状态与验收勾选保留。

### 2026-10-03：实施完成（步骤 1–4、测试、冒烟、文档、两轴评审与全量验证）

基于 HEAD `8be27c5` 实施，四项步骤全部落地；改动含 `src/runtime/im-approvals.ts`（新增）、`src/core/notify-target.ts`（新增）、approval-gate/driver、telegram/qq 适配器与配置 Store、core store/db/types、orchestrator、scheduler/runtime、runtime、control/server、config 凭据路径；测试新增 `test/77-im-approvals.test.ts`（14 项）与 `test/helpers/fake-bot-api.ts`，扩展 63/43/37，适配 38/39/40/47/49/59；冒烟 `.scratch/agent-direction/smoke-08-im-approvals.mts`。

**关键机制落点**

- 命令处理：`/approvals`、`/approval <ID> [偏移]`、`/approve <ID> <版本>`、`/reject <ID> <版本>` 整条匹配，命令经 `inbound_events.event_kind = im_approval`（schema v22）在同步事务内直接到终态：不建任务、不调用模型、不排队；详情经 `sliceTextByBytes` 按平台上限分段并给出下一偏移。
- 事务纪律：审批创建事务内登记初始 IM 通知（`confirmation / im-approval:<id>`，钉版目标，通知发送前核请求仍有效）；IM 决定经活动 Driver 的审批闸门把决定、审计事件、控制事件终态与回执并入一个事务（txExtra），提交后唤醒；回执经公共 outbox（`inbound_event / <控制事件id>`），发送核实处分流控制事件（原控制事件 + 钉版目标）。
- 身份与代次：Telegram 补齐收件钉版 replyTarget、转发消息内容不解释为命令、gatePrivate（来源/actor/钉版目标逐项核对）、发送前领取后复核、登记与推进偏移前再核对代次；QQ 连接代次纳入配置版本；凭据的同名修改/删除在写入前单调推进引用它的配置版本（A→B→A 不复活旧代次，Telegram 偏移归零），写入后重连与 reconcile；消费前在消费事务内复核 IM 固定身份；失效只影响原平台（`invalidateImApprovals` 未消费的待决/已批准失效并定向解除等待），reconcile 两平台各自落地；`stalePendingConfirmations` 覆盖未消费的待决与已批准（已消费不动）。

**验证（真实环境与模拟分列）**

- **离线测试**（进程内真实 Runtime/socket/SQLite/文件；模型、NapCat OneBot、Telegram Bot API 均为打桩，不宣称真实平台已验收）：新增 test/77 共 14 项（双平台各端到端申请→通知→列表/分页详情→批准→恰好一次→原入口，拒绝零执行；命令等待中直处理不死锁；身份/格式/转发/部分 ID/版本错误/跨平台/无来源；TUI 抢先与重投/同键异命令；两平台失效矩阵 owner/启停/凭据 A→B→A/删除/旧偏移与旧 null 目标；通知与决定事务中途故障回滚后平台重投成功一次；重启覆盖待决/已批准未消费/已消费在途/遗留控制事件/遗留 sending；429 原键延后、领取后目标复核、旧 token 迟到错误脱敏；main → coding 子任务链归属；列表翻页与详情参数分段）；扩展 63（通知接线回滚、消费复核、合并决定事务、定向解除）、43（控制类别存储 + v21→v22 迁移）、37（发送核实分流 + 未发出已决定通知取消）、40（IM 通知计数与波形）；**macOS `npx tsx --test` 相关套件（77/38/40/41/63/43/37/27/22/25/28/39/45/49/71/08/47/59/19/75/67）全过；Linux（ssh tx）关键套件（77/38/40/63/43/37）66/66；test/67 3/3；`npm run typecheck` 通过。**
- **产品级冒烟**（真实 bin/ruukoto.mjs 后台两次拉起、真实控制面 socket、SQLite 与 main.db 直接读取核对、控制面配置与凭据写入、入站去重、outbox 账本、重启恢复；模型与两平台打桩）：**macOS 9/9（6.5s）；Linux（ssh tx，npm ci 真实安装，Node v24）9/9（10.5s）**，运行后已把最新代码 rsync 至服务器复跑（服务器目录 `~/ruukoto` 保留供后续使用；场景 4 的重启恢复与 schema v22 核对含其中）。
- **全量 `npm test`（2026-10-03 终局）：817 项中 815 通过、1 跳过（真实模型门控既有）、1 失败**——test/08「DNS 在批准时固定」60s 超时；干净 HEAD `8be27c5`（临时 worktree）复现同一失败，确认为环境性既有失败（issue 07 已登记），本单命令按约定重新核实基线。test/33 负载抖动在本单三轮全量中未复现。

**两轴评审（code-review，2026-10-03）处置**：Standards——qq/store 格式粘连修复、IM 相关 NotifyTarget 比较统一复用 sameTarget、approval-gate 头注更新、briefParams 复用 capText；Spec——转发消息恢复按普通任务处理（仅不解释为命令）、失败回执文案改为「后台恢复后请重新发送本命令」、登记前补齐代次再核对、恢复测试补已消费在途断言、补列表翻页/详情分段用例；已决定未发出通知发送前取消（issue 计划"通知发送前检查请求仍有效"）以 test/37 加项覆盖。「批准已接受但消费前绑定变化」的端侧窗口以 test/63 消费事务钩子（复核失败即失效、零执行）+ test/77 的平台失效矩阵（批准前与决定路径的逐代次失效）组合覆盖，未单列新场景（同一事务同时覆盖两种机制，且串行主会话无法外部注入窗口）。

**与验收标准对应**

1. 双平台端到端（模拟平台 + 真实适配器进程）：test/77 第 1/2/9/14 项、smoke 场景 1–2；真实 NapCat 消息段/断线行为与真实 Bot API 轮询/发送行为**未实测**（没有真实测试入口，按工单约定保留为未验收项，不借用日常凭据）。
2. 身份逐项核实：test/77 身份矩阵（两平台）与失效矩阵；QQ 伪造控制面工具不能改权限由既有 test/40 用例继续通过。
3. 审批响应直达不死锁：test/77 第 2 项（等待中命令零模型调用、普通消息排队、零新任务）；event_kind 排除于派发与恢复重放（test/77 遗留控制事件、43/37 存储层）。
4. 批准绑定原请求/范围单次消费：test/77 各恰好一次断言 + 既有 63/08 消费纪律套件；命令只携带完整 ID 与正整数版本，不接受新参数或部分 ID。
5. 重投/重绑/重启：test/77 重投与异键拒绝、两平台失效矩阵、重启恢复（含已消费在途与遗留窗口）、smoke 场景 4。
6. 端到端/类型检查/仓库验证与文档同步：上述全量与冒烟；`docs/runtime.md`（IM 审批一节 + Telegram/QQ/凭据段更新）、`CONTEXT.md`（域词「IM 审批控制消息」）、ADR 0011/0012 阶段描述修订（保留固定目标与未知结果边界；17 号 ADR 的行为范围不动）、对所有改动 `src/` 文件按约定 grep 命中页面并同步图解（inbound-events/storage-layout/outbox/task-lifecycle/tool-call-path/once-only/control-protocol/orchestrator，测试 67 3/3）；验证记录区分模拟平台（OneBot/Bot API/模型打桩）与真实环境（macOS 本机、Linux ssh tx、真实后台进程与库）。

**遗留与说明**：异步最终汇报沿用 issue 18 范围（唤醒任务结论不外发 IM，test/77 已按此断言）；服务器管理工具（09）、长期授权（10）、通用 SubAgent（11）不在本单；真实平台演练由绑定拥有者另行授权后在测试账号上核对（消息 ID、单次消费、实际效果），避免与日常实例同账号并发。
