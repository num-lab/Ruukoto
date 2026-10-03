Status: ready-for-agent

# 20 — 退出核心群聊并保全旧群资料

**What to build:** 核心停止创建和执行 chat 群任务，QQ 拥有者私聊继续工作，旧群历史与发送事实仍可核查。

**Blocked by:** 无，可立即开始

依据：[已确认规格](../spec.md) 与 [ADR 0017](../../../docs/adr/0017-two-agent-products.md)。

## 验收标准

- [ ] 新核心不再创建群聊角色或接收新的群任务；QQ 拥有者私聊与 Telegram 主会话继续可用。
- [ ] 旧群历史、结果接收记录、撤回标记、来源关系和发送账本可归档查询，不能把旧群会话转成普通开发会话来绕过限制。
- [ ] 原始群资料隔离与已接收结果快照的授权边界保持，不能通过删除角色而扩大读取范围。
- [ ] 已有个人通知和调度中的群结果引用仍能复核来源及撤回；归档后无法核实时阻断外发并说明原因，不能仅凭复制的摘要继续发送。
- [ ] 排队或在途群任务、待发或未知发送得到明确收尾；重复升级和重启不重放群任务或消息。
- [ ] 发布说明明确正式外挂在后续阶段交付；本单交付核心退役及资料保全，不依赖尚未确定的外挂接口。
- [ ] 完成相关端到端检查、类型检查及仓库要求的验证；同步本次行为涉及的运行说明和图解，验证记录区分模拟结果与真实环境结果。

## Comments

### 2026-10-03：实施计划

基于 HEAD `e542261` 制定：核心库 v24、控制协议 v11。12 的计划尚未实施，下文提到的协议版本号均在实施时核实。本单只做两件事：核心退出群聊入口，旧群资料原地保全。旧类型、工具类别和角色行的收缩留给 23；跨实例迁移留给 22。

#### 现状核实

- **chat 角色引导**：`ROLE_DEFINITIONS` 含 chat（`src/runtime/orchestrator.ts:83`），`ensureRoles` 每次启动补建缺失角色（`:254`）。chat 角色会话本身不承接任务；群任务跑在各群的 `qq_group` 会话中，`getAgentRoleBySession` 经 `qq_sessions` JOIN `agent_roles.id='chat'` 取得角色（`src/core/store.ts:1081`）。
- **群入站整条写链路**：
  - 适配器 `handleGroupMessage`（`src/qq/adapter.ts:416`）：登记 `qq_inbox`，经 `ensureGroupSession`（`:505`）按需建项目、会话和目录，再调 `registerGroup`；
  - 编排器 `registerQqGroup`（`orchestrator.ts:277`）登记 `qq_group` 入站事件；
  - `dispatchEvent` 的群分支（`:477`）建 chat 任务，并回写 `agent_id='chat'`（`:529`）；
  - Runtime 的 `runQueueLoop` 对 `qq_group` 会话调用适配器 `gate`（`src/runtime/runtime.ts:2549`）；
  - 终态时适配器 `onRuntimeEvents` / `sendReply`（`adapter.ts:556`、`:578`）发出群回复；重连后 `recoverCompletedInbox`（`:667`）补发。
- **群配置写入口**：`qq_group_update`（`src/control/server.ts:775`、`runtime.ts:3828`）；CLI `ruukoto qq group add|remove`；配置中心的允许群界面（`src/config-tui/app.ts:1612`）；TUI `/qq groups`（`src/tui/commands.ts:259`）。
- **建会话缺口**：`Runtime.createSession` 接受 `kind`（`runtime.ts:1323`），且带 `projectId` 时只检查项目是否存在。拥有者经 `create_session` 指定群项目 id，就能在群项目里建一个普通 dev 会话，获得 dev 工具，并以本项目身份读取群原始历史。`openWorkspace`（`:1400`）、`control/workspace.ts:92,153` 和工作区迁移（`workspace-migration.ts:287`）都已排除群项目。
- **续跑缺口**：`submit` / `continueTask`（`runtime.ts:1934`、`:2078`）不拦 `qq_group` 会话。升级后被中断的群任务可以被 continue，重新运行。
- **隔离不依赖 chat 角色行**：
  - `AccessScope.canAccess` 对 main/coding 的群项目拒绝，依据是 `sessions.kind='qq_group'`（`src/core/access.ts:110-126`）；
  - Driver 对 qq_group 会话的资料身份和工具类别（`driver.ts:344`、`tool-availability.ts:41`）按会话类别判定；
  - SubAgent 与 coding 委派都拒绝 `chat_result` 资料（`subagent-tools.ts:129`、`delegation-tools.ts:127`）。
- **群结果复核只依赖归档行**：`sourceOf` / `resolveAcceptedChatResult`（`src/agent/chat-result-tools.ts:27-60`）核对任务、收件、入站事件和群映射，并按时间窗查撤回；通知、计划在批准、查询和发送前经 `SourceResolver.verify` 复核（`scheduler-tools.ts:161`、`scheduler/runtime.ts:389`）。失败时取消该次发送，记录 `source_revoked：原因`。撤回标记来自 `handleRecall`（`adapter.ts:529`），它只更新已登记的收件行。
- **已有归档查询**：`qq inbox` / `qq outbox`（`server.ts:781`）可查收件状态、撤回标记和发送账本；群会话历史可用拥有者 `read_history` 读取。接收账本 `chat_result_acceptances` 没有拥有者查询入口，只有 `chat_result.accepted` 持久事件。
- **启动顺序**（`runtime.ts:572-672`）：`recover()` 把运行中任务改为 interrupted 并暂停队列 → 退役迁移类的步骤 → `orchestrator.start()`（`recoverInbound` 与 `sweepPendingResults` 补记结果并收尾入站事件）→ `qqAdapter.start()`。适配器启动时把遗留的 pending 发送定为 unknown，并自动恢复群队列（`adapter.ts:120-130`）。

#### 实际缺口

1. 核心仍引导 chat 角色，并接收、执行、回复群消息。
2. 群会话可以经 create_session、submit 或 continue 重新用作对话入口。
3. 升级时排队或中断的群任务、已登记未派发的事件、待发回复，没有“只收尾、不重放”的统一处理。现有路径会恢复群队列，并在重连后补发回复。
4. 接收账本没有拥有者可查的归档视图。

#### 默认取舍（推荐即规格）

- **直接删除入口，不加开关。** 删除群收件、建群会话、群派发、群回复与补发，以及允许群配置的写入口。新安装不再引导 chat。旧安装保留 `agent_roles` 中的 chat 行，作为归档标识；`AgentRoleId`、tasks/agent_roles/inbound_events 的 CHECK 约束、`qq_group` 会话类别、chat 工具类别与 Driver 中的 qq_group 分支都不动，留给 23。本单不改 schema，核心库维持 v24。
- **群消息直接忽略。** 适配器收到群消息时不登记收件、不建任务、不回复、不保存正文，也不逐条记日志，避免在核心继续收集群内容。撤回通知继续处理：只给已登记的旧收件打标记，不再取消或补发。这样已接收摘要的撤回复核仍然有效。
- **一次性收尾放在启动时，按状态幂等，不加升级标记。** 只改未终态的行，重复升级或重启不会再改动任何东西：
  - 群会话中排队的任务取消，原因 `core_group_chat_retired`；
  - 运行中的任务由已有 `recover()` 改为 interrupted，结果未知、不重放；
  - 待发群回复定为 unknown；
  - 未完成的收件定为 skipped。完成但未发回复的收件不再补发，也记 skipped；
  - 已登记的 `qq_group` 入站事件由入站门统一丢弃，复用现有分支：作废事件、写 `inbound.skipped`、收件 skipped、取消未终态任务。
- **群会话只读归档。**
  - submit 与 continue 拒绝 `qq_group` 会话和 chat 角色会话；
  - `createSession` 删除 `kind` 参数，拒绝群项目和 chat 角色项目；
  - 归档查询沿用 `qq inbox` / `qq outbox` / `read_history`。`qq inbox` 的每条记录附上对应的接收记录（接收时间、接收任务、理由、摘要）和当前复核结论（可用，或不可用的原因）。不新增 op。
- **群结果复核不改代码。**
  - `chat_result_list` 和 `chat_result_accept` 保留，只作用于归档中已完成的群任务；
  - 归档行缺失或不一致、main 不可用、来源已撤回时，现有 verify 会阻断外发并写明原因。
  - 撤回只能在 NapCat 连接仍在、账号仍在群里时观测到；连接中断或退群后发生的撤回无法得知，沿用 ADR 0014 的既有边界。
- **允许群配置**：`qq_group_update` op、CLI `qq group`、配置中心允许群界面、TUI `/qq groups` 一并删除。旧命令只打印退役提示。`qq_config.groups` 数据原样保留，`qq status` 中照常显示为历史值。按 v8 删除 op 的先例，控制协议版本加一（具体值实施时核实）。`max_reply_chars` 与 `queue_ttl_ms` 从此不再起作用，入口留给 23 清理。
- **与 ADR 的关系**：本单执行 ADR 0017 对 ADR 0014 的修订；ADR 0012 的群资料隔离不变。不新建 ADR，只在 ADR 0014 头部追加实施修订（包括撤回观测的上限），在 ADR 0017 实施记录中加一行。

#### 实施步骤

1. **删除群入口**（`src/qq/adapter.ts`、`src/runtime/orchestrator.ts`、`src/runtime/runtime.ts`）。
   - **适配器删除**：`handleGroupMessage` 的登记部分（群消息直接 return）、`enqueueInbox`、`ensureGroupSession`、`recoverInbox`、`sendReply`、`recoverCompletedInbox`、`cancelInvalidGroupWork`、`cancelQqWork`、`onGroupRemoved`、`gate`、`gateGroup`，以及 `onRuntimeEvents` 中的群回复。
   - **适配器保留与收窄**：`handleRecall` 只保留 `markRecalled`；`kickAllQqSessions` 只踢 main；`QqRuntimeBridge` 删除 `registerGroup`、`createSession`、`findProjectByName`、`createProject`、`readTaskReplyText`；启动时不再恢复群队列。
   - **编排器**：删除 `registerQqGroup`、`dispatchEvent` 的群分支与 `agent_id='chat'` 回写；`ROLE_DEFINITIONS` 去掉 chat。
   - **Runtime**：
     - `inboundGate` 对 `QQ_GROUP_SOURCE` 恒返回 `{drop: "core_group_chat_retired:核心群聊已退役（正式外挂后续交付）"}`；
     - `runQueueLoop` 中 qq_group 会话的决策改为同一个固定 drop，复用现有取消事务；
     - 删除 `qqRecalledFilter` 注入（之后不再有 qq_group 任务运行），Driver 和上下文装配中的参数在 23 一并清理。
   - 每个被删函数先用 grep 核实调用方，测试中的调用方同步处理。

2. **启动收尾**（`runtime.ts` 中约十余行的私有方法，紧接 `retireGitHubModule` 之后、`orchestrator.start()` 之前调用；不依赖适配器是否创建）。
   - 把 `reconcilePendingOutboxOnBoot` 从适配器移到这里：pending 发送定为 unknown，收件记 reply_unknown，错误说明中写明退役。
   - 对各 `qq_group` 会话的排队任务，在事务内执行 queued→canceled 并写 `task.canceled`。
   - 剩余 registered/queued 收件改为 skipped。
   - 结果补记与入站事件终态交给 `orchestrator.start()` 已有的 `sweepPendingResults` 与 `recoverInbound`，不另写逻辑。

3. **归档只读与查询**（`runtime.ts`、`src/qq/store.ts`）。
   - submit 开头拒绝 `qq_group` 会话与 chat 角色会话，写法同 SubAgent 会话的拒绝方式；continue 经 submit，一并覆盖。
   - `createSession` 删除 `kind`，带 `projectId` 时复用 `openWorkspace` 中“角色或群聊项目不能作为工作区认领”的判定。
   - `qqListInbox` 为每行附加 `acceptance` 与 `sourceProblem`：调用 `resolveAcceptedChatResult`，main 的项目取当前 main 角色。

4. **删除配置写入口**（`src/control/server.ts`、`src/cli.ts`、`src/config-tui/app.ts`、`src/tui/commands.ts`、`src/core/types.ts`、`src/control/protocol.ts`）。
   - 删除 `qq_group_update` 与 `qqGroupUpdate`；CLI `qq group`、TUI `/qq groups` 改为一行退役提示；删除配置中心的允许群界面与菜单项。
   - `PROTOCOL_VERSION` 加一，在头注释中写明本次删除的 op 和 inbox 附加字段。
   - `session-factory.ts` 中 chat 的群聊提示随之不再使用，删除留给 23。

5. **文档与发布说明**。
   - `docs/runtime.md` 的「QQ 群聊（issue 07）」与「群聊与 chat 编排」两节改写为“已退役（agent-direction issue 20）”：保留的归档与复核、收尾口径、已删除的命令，并写明正式 QQ 群聊外挂在后续阶段交付、本单不依赖外挂接口。顶部配置示例删除 `qq group add`。
   - README 的 `/qq` 行与第 7 行“QQ 群聊是后续用途”的表述同步更新。
   - `CONTEXT.md` 的“QQ 群聊入口（旧架构）”和“群聊结果”补当前实现说明。
   - ADR 0014 与 ADR 0017 按上面的取舍更新。
   - docs/visual 预计命中 orchestrator、inbound-events、once-only、outbox、task-lifecycle、index、control-protocol、deployment，逐页改图和表。

不做：
- 正式外挂及其接口；
- 删除 `AgentRoleId` 中的 chat、chat 工具类别、Driver/上下文中的 qq_group 分支、chat 角色行或 `chat_result_*` 工具（23）；
- 跨实例迁移群档案（22）；
- 断连或退群后的撤回补偿；
- 撤销拥有者已建的群→开发项目资料授权（ADR 0012 认可的拥有者决定）。

#### 验证与验收

新增 `test/<NN>-retire-core-group-chat.test.ts`（编号实施时核实，避开 12 计划的 81 与同批其他工单）。在 `test/helpers` 增加一个旧数据播种助手，按 v24 形态直接写入：`qq_group` 会话与 `qq_sessions`、收件、入站事件、chat 任务与结果、接收记录、`qq_outbox`。逐条对应验收：

1. **新核心不再接收群任务**：
   - 全新实例只有 main/coding，没有 agent-chat 项目；
   - 模拟 OneBot 推送群 @ 消息后，收件、会话、任务与 `send_group_msg` 均零新增；
   - 同一连接上 QQ 拥有者私聊照常回复（沿用 test/40 的桩），Telegram 主会话照常回复。
2. **归档可查、不能转为开发会话**：
   - 播种后，`qq inbox` 能看到状态、撤回标记、接收记录与复核结论；`qq outbox` 能看到账本；`read_history` 能读群会话；
   - 以下均被拒绝：`create_session(project_id=群项目或 chat 项目)`；对群会话或 chat 角色会话 submit；continue 被中断的群任务；
   - `open_workspace` 认领与工作区迁移的排除保持（回归）。
3. **隔离不随角色退役扩大**：
   - 去掉 chat 角色行的实例中，main、coding、main 的 SubAgent 仍不能读取群项目的历史、产物与带群来源的记忆；
   - `chat_result` 作为委派资料仍被拒；
   - 已接收快照只对 main 开放。
4. **通知和调度中的引用仍然复核**：
   - 播种一条已接收的群结果，通知经批准后在退役后正常发送；
   - 经模拟 OneBot 对归档消息发出撤回后，待发通知和计划运行被阻断，记录 `source_revoked` 及原因；
   - 篡改或删除归档的收件、事件或映射后，同样阻断并说明原因；
   - 不会只凭接收快照正文继续发送。
5. **收尾明确且幂等**：
   - 播种以下状态后重启：排队群任务、运行中群任务、已登记未派发的事件、完成但未回复的收件、pending 发送；
   - 结果应为：排队任务 canceled（原因 `core_group_chat_retired`）；运行中任务 interrupted 且 continue 被拒；事件作废并写 `inbound.skipped`；收件 skipped；发送 unknown，收件 reply_unknown；
   - `send_group_msg` 与模型调用均为零；
   - 再重启两次，任务、收件、发送与事件计数不变。
6. **发布说明**：runtime.md 与 README 的退役说明、外挂后续交付的表述，人工核对后记入验收记录。
7. **改写既有测试**：
   - test/47 的群桥接整份删除，其恢复语义已被第 5 条取代；
   - test/26 保留连接、配置、token、账号、掉线与私聊相关用例，删除群触发、排队、回复与撤群用例，保留一条“群消息被忽略”；
   - test/48/49 改用播种助手生成旧群结果；
   - test/40/59/78 中的群触发改为断言零任务；
   - test/30/58/61/62/74/76/79/53 中依赖 `createSession({kind:"qq_group"})` 的夹具改为播种助手。

```bash
npx tsx --test test/<NN>-retire-core-group-chat.test.ts test/26-qq.test.ts test/40-qq-private.test.ts test/41-qq-private-scope.test.ts test/48-chat-results.test.ts test/49-chat-result-flow.test.ts test/27-orchestration.test.ts test/77-im-approvals.test.ts
npx tsx --test test/30-workspace-entry.test.ts test/53-jev-config.test.ts test/58-plan-mode.test.ts test/59-system-prompt.test.ts test/61-context-compaction.test.ts test/62-tool-availability.test.ts test/66-control-seam.test.ts test/74-workspace-sessions.test.ts test/76-legacy-workspace-data.test.ts test/78-linux-service-management.test.ts test/79-standing-permissions.test.ts test/80-subagent-delegation.test.ts
npx tsx --test test/13-tui-state.test.ts test/14-tui-app.test.ts test/29-cli-entry.test.ts
npm run typecheck
npx tsx --test test/67-visual-docs.test.ts
npm test   # nohup + 退出码文件，跑时不改 src/test
```

新增 `.scratch/agent-direction/smoke-20-retire-group-chat.mts`，沿用 smoke-11 的 `--remote` 结构，在 `ssh tx` 上用真实 Linux、SQLite、后台进程、重启和容器后端运行。

旧数据不用播种助手伪造，而由旧代码真实产生：
1. 在 tx 上以 `e542261` 的工作副本启动隔离 profile 的后台；
2. 通过模拟 OneBot 与模拟模型依次产生：一条完成并被 main 接收的群结果及一条已批准待发的通知、一条排队群任务、一条模型挂起的运行中任务；
3. 在发送回执前 SIGKILL 后台，留下一条 pending 发送；
4. 换新代码在同一数据目录启动。

检查第 1、2、4、5 条在真实升级路径上成立，并在第二次重启后核对幂等。

模型与 OneBot 为模拟，分别记录；真实 QQ 群与 NapCat 没有入口，记为未实测。用 tx 生产库副本做升级演练需要 `ruukoto-backend` 权限，未经拥有者授权不做，验收记录写明未做。

完成时逐条登记七项验收证据，区分离线逻辑测试、真实后台与升级路径、模拟模型/平台和真实平台。本次只保存计划，工单状态与验收勾选保持不变。
