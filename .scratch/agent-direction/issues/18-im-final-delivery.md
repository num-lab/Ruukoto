Status: ready-for-agent

Status: resolved

# 18 — 把异步工作最终结果送回原 IM 入口

**What to build:** main 在初次确认委派后继续响应，工作最终完成或失败时汇总多个子任务并回复原拥有者。

**Blocked by:** [11 — 主 Agent 委派通用 SubAgent 并收到结果](11-subagent-delegation.md)

依据：[已确认规格](../spec.md) 与 [ADR 0017](../../../.agents/notes/implemented/architecture/2026-10-02-two-agent-products.md)。

## 验收标准

- [x] 拥有者先收到受理或初次回复，期间可以继续对话；工作完成或失败后收到与原委托对应的最终汇报。
- [x] 按工作委托及固定原入口确定结果和发送目标，不从会话最新回答猜测，不向其他入口广播。
- [x] 重复结果、崩溃恢复和多子任务结束不会重复产生同一次最终汇报；正文和来源可核查。
- [x] 原目标停用或绑定变化时不改发，暂时离线等待，发送效果未知不自动重发。
- [x] 此发送授权限于已接收委托的汇报，不扩大为任意主动通知；保留现有独立审批通知路径。
- [x] 完成相关端到端检查、类型检查及仓库要求的验证；同步本次行为涉及的运行说明和图解，验证记录区分模拟结果与真实环境结果。

## Comments

### 2026-10-03：实施计划

基于 HEAD `e542261` 制定：核心库 v24、控制协议 v11。12 的计划尚未实施，实施时核实版本；本单不改 schema，也不升协议。

#### 现状核实

- **受理回复已具备。** IM 入站任务（main 角色任务）到达终态时，编排器在结果事务内回调 `onInboundTerminal`（`src/runtime/orchestrator.ts:657`），由 `Runtime.enqueueOwnerReply`（`src/runtime/runtime.ts:793`）登记一份 `owner_reply`：
  - 发送键为入站事件 id；
  - 目标取收件时钉版的 `reply_target`，且须与当前固定目标一致；
  - 正文取该任务历史条目中的最终回答。
- **入口事实可以派生，不必另存。** 11 没有在 `work_delegations` 上保存入口字段（`src/core/types.ts:158`），但 `originTaskId → tasks.source_event_id → inbound_events.reply_target` 三者写入后都不变。拥有者经 IM 发起的委派，其父任务就是带来源事件的 main 任务（`src/agent/subagent-tools.ts:73`，`ownerOriginated`）。
- **唤醒只回 main，不外发。** 子任务终态后，`wakeParent`（`orchestrator.ts:876`）向 main 提交 `wake:<childId>`。唤醒任务没有来源事件；只有 GitHub 评审会带 `reviewSource`（`:884`、`:911`）。因此唤醒轮次的结论从不发回 IM，`test/40:471` 与 `test/77:866` 断言了这一点（都走 draft 旧链）。
- **已有先例。** GitHub 评审用的是同一模式：main 唤醒任务终态时，在结果事务内登记一次 `inbound_event` 通知（`src/github/events.ts:189`），正文取该唤醒任务的回答。
- **outbox 的语义可整套复用：**
  - `insertOp` 同键同参返回原记录（`src/scheduler/store.ts:294`），`(source_kind, source_key)` 唯一（`src/core/db.ts:430`）；
  - `sendOne` 发送前核对当前固定目标：停用或变化则取消、不改发，离线则写等待原因（`src/scheduler/runtime.ts:375–392`）；
  - `failed` 与 `effect_unknown` 不重发，重启时遗留的 `sending` 记为 `effect_unknown`；
  - 同一渠道按 `created_at` 顺序领取（`store.ts:341`），所以受理回复先于最终汇报发出。
- **审批通知走独立的槽**（`confirmation` / `im-approval:<id>`，`runtime.ts:740`），与本单无关。

#### 实际缺口

1. 没有“工作已收尾”的判定，也不会在收尾时登记发送。
2. 唤醒输入没有告诉 main 本轮回答会成为最终汇报。
3. 回复槽键加了后缀后，两个适配器按 `op.sourceKey` 取原消息引用时会失效（`src/qq/adapter.ts:335`、`src/telegram/adapter.ts:406`）。

#### 默认取舍（推荐即规格）

- **由宿主自动判定收尾，不靠模型宣告。** 某个 main 唤醒轮次（处理该工作某条子任务结果的那一轮）到达终态时，若同时满足以下两条，即视为收尾：
  - 该工作没有 queued/running/awaiting_confirmation 的执行任务；
  - 该工作每条已终态执行任务的 `wake:<id>` 都已存在且已终态（本轮除外）。

  满足时，本轮唤醒任务的最终回答就是汇报正文，由 main 汇总多个子任务。main 本轮若继续委派同一工作，就会产生活动任务，汇报自然推迟。

  理由：如果靠模型调用工具宣告，漏调用会让拥有者永远收不到汇报；不新增工具，模型也就无法触发外发或选择目标。第二条用来覆盖并发的情形：子任务 2 已终态但其唤醒仍在排队时，唤醒 1 不汇报，由唤醒 2 汇报。代价是 main 不能选择不汇报，这符合规格“完成或失败均汇报”。
- **目标固定为工作发起任务的来源事件。** 来源须为 `telegram` 或 `qq_private`，`event_kind = task`，目标取其钉版 `reply_target`。后续续派或复用即使来自另一个入口，也发回工作发起时的入口，不从会话最新回答或当前入口推断。由 TUI、定时任务、群或 GitHub 发起的工作一律不发。
- **复用 `owner_reply` 发送槽，不新增 source_kind。** 这正是 ADR 0010 第 4 条所说的“owner 回复 = 入站事件 + 回复槽”。
  - 键为 `<eventId>#work:<workId>:<childTaskId>`，每次收尾至多一份。之后补充原工作并再次收尾时，childTaskId 不同，生成新的一份。
  - 不需要重建 CHECK，也不升 schema。
  - 发送记录的 `taskId` 为收尾的唤醒任务；正文、哈希、目标和来源键都可经 `ruukoto notify show` 核查。
- **在编排器结果事务内登记。** 唤醒任务 `setTaskResult` 成功后，与 `onInboundTerminal` 在同一事务内调用。重启巡检补记结果时会一并补登，`insertOp` 同键幂等，重复终态和巡检都只产生一份。
- **发送语义全部沿用 outbox。**
  - 登记时目标须与当前固定目标一致，否则记 `qq_private.reply_skipped` 或 `telegram.reply_skipped`，reason 加前缀 `work_report:`，复用现有事件。
  - 发送前再核对一次：目标停用或变化则取消，不改发。
  - 离线时保持 pending 等待；限流按 `not_before` 重试同一条记录；`failed` 与 `effect_unknown` 不重发。
- **正文。**
  - 完成时：首行由宿主固定为 `[工作 <workId> 最终汇报]`，其后是唤醒轮次的最终回答。
  - 失败、超时或被重启中断时：宿主固定提示，包含工作 id，并注明详情见 TUI。
  - 长度按平台上限截短，与 `owner_reply` 同口径。两个平台都引用原入站消息。
- **告知 main。** IM 发起的工作，其唤醒输入附一段宿主固定说明：本工作没有其他进行中任务时，本轮最终回答会作为最终汇报，向原入口发送一次；请汇总全部子任务结果；如需继续，就在本轮继续委派。实现上把 `resultNotice` 组合进来（`runtime.ts:668`）。
- **授权边界。** 只有这一条宿主路径，不新增工具；唤醒任务仍固定 confirm。`notification_enqueue` 审批、`im-approval` 通知和原有 `owner_reply` 回复槽都不变。ADR 0011 第 2 条“子任务唤醒不产生 owner 回复”按 ADR 0017 开例外，且只限“IM 发起的通用工作的收尾轮次”；ADR 0012 同此。
- **范围只含通用工作委托。** 旧 coding draft 链保持不外发，test/40 与 test/77 的断言保留；17 把修改委派迁到通用链路后自动纳入。19 迁移后，GitHub 发起的工作来源不是 IM，继续走 ADR 0013 的固定通知，不会双发。
- **与 14、12 的交界。**
  - 14：已取消的工作不自动汇报，取消所在轮次已有回复。14 若先实施，本单直接在判定里加入取消状态；否则由 14 实施时补上，同时会压制迟到结果的唤醒。
  - 12：复用产生的新工作有自己的发起任务，旧工作的汇报仍归旧工作；可用性规则不影响本单的判定。

需拥有者确认：

1. 自动收尾判定意味着 main 不能选择不汇报。
2. 续派来自另一个入口时，仍发回工作发起时的入口。
3. 已取消的工作不自动汇报。

#### 实施步骤

1. **编排器挂点**（`src/runtime/orchestrator.ts`）。`OrchestratorDeps` 增加 `onWakeTerminal?(task, outcome)`，注释说明“与结果同事务，巡检补记时一并补登”。在 `handleTerminal` 的结果事务内，`requestId` 以 `wake:` 开头时调用，与 `onInboundTerminal` 并列，不改其他终态路径。
2. **宿主登记**（`src/runtime/runtime.ts`）。
   - 从 `enqueueOwnerReply` 抽出两段共用逻辑：目标核对（钉版目标、当前固定目标、externalId 前缀）与按平台截短。
   - 新增 `enqueueWorkReport(wake, outcome)`，依次执行：
     - 取 child，取工作；
     - 经发起任务取来源事件，过滤平台与 event_kind；
     - 按上面两条做收尾判定，用现有的 `listTasksByWork` 和 `findTaskByRequest`，不加 store 方法；
     - 目标核对；
     - 读本唤醒任务的回答作为正文；
     - 调用 `insertOp`，异常时记 skip 事件。
   - 新增 `workReportNotice(child)` 并与 GitHub 的 notice 组合。
   - 接到 `onWakeTerminal` 与 `resultNotice`。
3. **适配器引用原消息**（`src/qq/adapter.ts:335`、`src/telegram/adapter.ts:406`）。按 `op.sourceKey.split("#")[0]` 取入站事件，各改一行，原有键不受影响。
4. **注释与断言措辞。** 把 test/77:866 注释里的“最终汇报见 issue 18”改为说明 draft 旧链仍不外发。

不做：
- 新增 source_kind、新列或新事件；
- 新的汇报工具；
- `work_get` 里展示发送记录（`notify show` 可查）；
- 旧 draft 链的汇报（17）；
- 取消后的汇报（14）；
- 多 Agent 同工作（13，判定已按工作内全部执行任务计算，无需改动）；
- 真实平台演练入口。

#### 验证与验收

新增 `test/8x-im-final-delivery.test.ts`（编号实施时核实，避开 12 的 81 及并行计划已占编号），复用 test/40、38、77 的 MockOneBot、FakeBotApi、模型桩与 `realTools()`，逐条覆盖：

- **先受理、后汇报**（QQ 与 Telegram 各一遍）：
  - owner 消息 → main 用 `subagent_delegate`（materials）委派；
  - 子模型挂起期间，受理回复先送达，owner 的第二条消息也得到回复；
  - 子任务完成后唤醒，最终汇报送达且引用原消息；
  - 渠道内顺序为受理在前、汇报在后；记录的 taskId 为唤醒任务，正文为带首行的唤醒回答。
- **目标与正文按工作确定**：
  - QQ 发起的工作在 Telegram 轮次续派，汇报仍发 QQ，Telegram 无多余发送；
  - 正文等于收尾唤醒任务的历史条目，而不是之后会话中的最新回答；
  - TUI、定时任务发起的工作，以及 dev 会话的工作，均零记录。
- **不重复**：
  - 顺序情形：唤醒 1 内续派同一工作，唤醒 1 不汇报，唤醒 2 汇报一份；
  - 并发情形：两条执行同时在途（12 实施后改用存储直接构造两条已终态执行和两个唤醒），只有后终态的唤醒汇报，且只一份；
  - 唤醒结果落库前重启：巡检补记后仍只有一份，再跑一次巡检也不变；
  - 重复的终态事件也只有一份；
  - 补充原工作再次收尾，得到新的一份，键各不相同。
- **不改发、等待、不重发**：
  - 发送前重新配置 QQ（configVersion 推进）：记录被取消、reason 为 `target_changed`，新目标零发送；
  - 登记时目标已变化：记 `*.reply_skipped`，reason 以 `work_report:` 开头；
  - 平台离线：pending 并写等待原因，恢复后只发一次；
  - 模拟发送结果不明（ambiguous）：记 `effect_unknown`，重启后不重发；
  - 429 限流：同一记录按 `not_before` 再发。
- **授权不扩大**：
  - 未收尾的唤醒回答不外发；
  - draft 旧链保持不外发（test/40、77 原断言）；
  - main 在唤醒轮次调用 `notification_enqueue` 仍需审批；
  - `im-approval` 通知槽和 GitHub 评审通知路径的回归不变；
  - 工具列表没有新增工具。

```bash
npx tsx --test test/8x-im-final-delivery.test.ts test/40-qq-private.test.ts test/38-telegram-owner.test.ts test/77-im-approvals.test.ts test/79-standing-permissions.test.ts test/80-subagent-delegation.test.ts test/27-orchestration.test.ts
npx tsx --test test/37-scheduler-outbox.test.ts test/43-inbound-notification-store.test.ts test/42-github-webhook.test.ts test/45-github-events.test.ts test/46-github-recovery.test.ts test/59-system-prompt.test.ts
npm run typecheck
npx tsx --test test/67-visual-docs.test.ts
npm test   # nohup + 退出码文件，跑时不改 src/test
```

新增 `.scratch/agent-direction/smoke-18-im-final-delivery.mts`，结构沿用 smoke-08（真实 `bin/ruukoto.mjs` 后台进程，含重启）与 smoke-11 的 `--remote` 方式。
- 真实部分：后台、控制面、SQLite、outbox 账本、Docker 受限 worker；本机 macOS 与 `ssh tx` 各跑一轮。
- 模拟部分：模型（MockModelServer）、MockOneBot、FakeBotApi。
- 检查内容：
  - QQ 与 Telegram 的受理 → 继续对话 → 最终汇报；
  - 并发收尾只发一份；
  - 平台离线等待后恢复；
  - 重新绑定后取消、不改发；
  - 在唤醒运行中杀后台再重启，只得到一份“中断”汇报。
- 证据：notification_ops 行、发送账本、平台桩收到的消息。

验证记录中模拟平台与真实后台分开记。真实 QQ/Telegram 没有演练入口，仍记为未实测，不继承 08/10 的模拟平台结论。

文档同步：
- `docs/runtime.md`：Telegram 回复段（约 1114–1121 行）、QQ 私聊段（约 1172 行）与委派段（约 1406–1411 行）改写“唤醒不产生 owner_reply”，补充工作收尾汇报的判定、键、目标与例外边界。
- `CONTEXT.md`：“owner 回复”条目补充当前实现。
- ADR 0011、0012 文首追加“实施修订（issue 18）”各一行；ADR 0017 实施记录加一行；不另立 ADR。
- 对 `src/runtime/orchestrator.ts`、`src/runtime/runtime.ts`、`src/qq/adapter.ts`、`src/telegram/adapter.ts` 逐个执行 `grep -l <路径> docs/visual/*.html`。预计命中 outbox（`owner_reply` 来源表约 296 行与引用说明约 526 行）、orchestrator、inbound-events、once-only、task-lifecycle、index；同步后跑 test/67。

完成时逐条登记六项验收证据，区分离线逻辑测试、真实后台与执行边界、模拟模型与平台、真实平台。本次只保存计划，工单状态与验收勾选保持不变。


### 2026-10-04：实施完成（提交 87db634，基线 HEAD dedd537）

按上方计划实施，三个「需拥有者确认」项按默认取舍（推荐即规格）执行：宿主自动判定收尾 main 不能选择不汇报；续派来自另一个入口仍发回发起入口；已取消的工作不自动汇报（14 已先实施，判定直接纳入 `canceledAt`）。

**实现**（与计划步骤 1–4 逐项对应）：
- 编排器 `OrchestratorDeps.onWakeTerminal?(task, outcome)`，`handleTerminal` 结果事务内 requestId 以 `wake:` 开头时与 `onInboundTerminal` 并列调用；巡检补记走同一路径（orchestrator.ts:78、:665）。
- Runtime `enqueueWorkReport`：发起事件经 `originTaskId → source_event_id → inbound_events` 派生（仅 telegram/qq_private 且 `eventKind === "task"`）；收尾判定 = `listActiveTasksByWork` 为空 + 其余执行的 `wake:<id>` 已存在且已记结果；目标核对与截短从 `enqueueOwnerReply` 抽为共用的 `imReplyTarget` / `capImReply` / `imReplySkipped`；键 `<eventId>#work:<workId>:<childTaskId>` 复用 `owner_reply` 槽；skip 前缀 `work_report:`。`workReportNotice` 与 GitHub notice 组合进唤醒输入。
- 两个适配器按 `op.sourceKey.split("#")[0]` 取原消息引用（各一行）。
- test/77 唤醒不外发的注释改为点名 draft 旧链。

**对计划的两处澄清（实施时发现，记录备查）**：
1. 计划假设「main 本轮若继续委派同一工作」。实际 `subagent_delegate` 的 `ownerOriginated` 检查拒绝一切带 agentId 的唤醒任务——唤醒轮次本身不能委派，续派只发生在拥有者/IM 消息轮次。收尾判定不受影响（续派产生活动任务自然推迟汇报，测试已覆盖）；唤醒输入的固定说明相应删去「就在本轮继续委派」一句，只保留收尾告知。
2. 计划验收点「main 在唤醒轮次调用 notification_enqueue 仍需审批」。实际现有通知路径在唤醒轮次直接拒绝（无钉版可信目标，「未配置可信 owner 通知目标，不能外发」），不产生审批记录。测试断言拒绝且零外发；IM 来源任务的审批路径（仍需审批）已由 test/40、test/77 既有断言覆盖，本单不改。

**命令**：`npm run typecheck` 通过；`npx tsx --test test/84（9 条）…回归批次（27/38/40/77/80/81/82 共 70 条、37/43/42/45/46/59/79/83 共 77 条、67 4 条）` 全部通过；`npm test` 912 通过 / 0 失败 / 1 跳过（exit 0）。

**code-review**（双轴，基点 dedd537）：Standards 无成文标准违反（两处轻度 judgement call：适配器各一行的 `split("#")[0]` 键解析与 `work_report:` 前缀拼接，与仓库既有字符串键惯例 `wake:`/`im-approval:` 一致，保留）；Spec 无 scope creep，唤醒轮次委派与通知审批两处按上文澄清处理。

**验收证据（按工单要求分区）**：

| 验收标准 | 离线逻辑测试（模拟模型与平台） | 真实后台与执行边界 |
| --- | --- | --- |
| 1 受理先行、可续聊、后汇报 | test/84 QQ+TG 各一条：受理→第二条消息回复→（子模型挂起放行后）汇报送达，渠道内顺序与引用原消息逐条断言 | smoke-18 场景1/2（真实 bin/ruukoto.mjs + Docker 受限 worker，macOS 7/7、ssh tx Linux 7/7） |
| 2 按工作钉版目标与正文 | test/84 跨入口续派仍发 QQ、TG 零汇报、正文不随后续回答变化；op.sourceKey/taskId/target 逐项断言；TUI/dev/定时来源零记录 | smoke-18 场景2b：SQLite 直核 notification_ops 行（键前缀=发起事件、尾部=收尾执行任务）、平台桩消息 |
| 3 不重复 | test/84：并发两唤醒只后终态汇报一份、重复终态事件一份、重启补记幂等（两次巡检仍一份）、补充再收尾键不同 | smoke-18 场景5：唤醒运行中 SIGKILL 再重启，恰好一份「中断」汇报 |
| 4 不改发/等待/不重发 | test/84：登记时目标失效记 `work_report:` skip；configVersion 推进后 pending 取消 target_changed 且新目标零发送；离线等待原因+恢复一次；effect_unknown 含重启不重发；429 同一记录按 not_before 再发 | smoke-18 场景3（离线 wait_reason→恢复一次）与场景4（重绑取消、OTHER 零发送） |
| 5 授权不扩大 | test/84：未收尾唤醒回答不外发、唤醒轮次外发请求被拒零外发零审批、无新工具；test/40/77 draft 旧链与 `im-approval` 槽回归不变 | smoke-18 各场景平台收到的消息无越界外发 |
| 6 验证与文档 | test/67-visual-docs 4/4；图解页按 .agents/skills/visual-docs 流程同步并经渲染切片核查 | 冒烟记录模拟（MockModelServer/MockOneBot/FakeBotApi）与真实（后台/控制面/SQLite/outbox 账本/容器 worker）分离 |

**真实 QQ/Telegram**：无演练入口，未实测，不继承 08/10 的模拟平台结论。文档同步：runtime.md（Telegram/QQ 回复段与「通用 SubAgent 委派·结果、通知与空闲」节）、CONTEXT.md「owner 回复」、ADR 0011/0012 文首实施修订、ADR 0017 实施记录、docs/visual（inbound-events/orchestrator/outbox/once-only/index）。
