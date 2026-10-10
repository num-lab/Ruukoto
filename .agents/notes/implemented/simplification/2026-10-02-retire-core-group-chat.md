# Agent Note: 退役核心 QQ 群聊，旧群资料只读归档

Status: implemented

原编号：ADR 0014（核心群聊已退役，本篇取代原决定）

## 问题

QQ 群聊以内建 `chat` 角色接入核心：每个「登录账号 + 群」映射到一个独立的 `qq_group` 会话，群任务的结果要先由 main 显式接收为固定快照，才能进入通知（规则见下文「原群聊设计」与「决定」中的群结果一条）。这条内建路径让群聊与核心 Runtime、资料范围和发送状态耦合在一起。[两个 Agent 产品](../architecture/2026-10-02-two-agent-products.md)取消内建 chat 角色，QQ 群聊改为独立可选的外挂程序：外挂自行管理群会话、历史和发送状态，通过有限接口向 ruukoto 提供结果，停用外挂不影响主会话。这样通用个人助手不被限定为群聊用途，群聊扩展也可以独立演进。

核心退出群聊时，有四类东西必须处理：

- 旧群会话、收件、发送账本、入站事件与 main 的接收记录是历史事实。删掉它们，来源与撤回就无从核查。
- 升级时可能留有排队或运行中的群任务、已登记未派发的入站事件、待发或结果未知的群回复。按通常的恢复路径处理，升级后会重放群任务或补发群消息。
- 已有的个人通知和调度可能引用了已接收的群结果。这些引用必须仍能复核来源与撤回，不能只凭复制下来的摘要继续外发。
- [QQ 私聊共享 main](../feature/2026-09-24-qq-private-shared-main.md) 的群资料隔离如果依附 chat 角色行，删除角色就会放宽隔离。群会话如果还能被重新提交，或者能在群项目里新建普通会话，归档就成了读取群原始历史的旁路。

## 决定

核心群聊由 agent-direction issue 20 退役；旧类型、工具类别与角色行的收缩由 agent-direction issue 23 完成。

- **核心不承载 QQ 群聊。** 编排器只引导 main 角色（`src/runtime/orchestrator.ts` 的 `ROLE_DEFINITIONS`），新实例没有 chat 角色。旧安装的 `agent_roles` chat 行保留，作为归档标识。QQ 拥有者私聊与 Telegram 主会话不受影响。chat 工具类别与提示、Driver 与上下文装配中的 `qq_group` 分支及撤回过滤、QqStore 的群写方法已经删除。`AgentRoleId` 中的 `chat`、tasks / agent_roles / inbound_events 的存储 CHECK 约束、`qq_group` 会话类别都对应旧行的实际取值，保留不收缩。
- **正式外挂在后续阶段交付，接口尚未设计。** 正式 QQ 群聊外挂是独立可选程序，代码可以留在同一仓库，不属于 SubAgent 层级。它排在首期三个使用场景之后，具体协议与功能细节在那个阶段确认。外挂接口目前没有设计，也没有任何代码迁入外挂；核心的退役与旧资料保全不依赖外挂接口。
- **群消息直接忽略。** QQ 适配器只处理拥有者私聊消息和 `group_recall` 通知。收到群消息时，适配器不登记收件、不建会话、不建任务、不回复、不保存正文，也不逐条记日志，核心不收集群内容。`message_sent`（自身回声）、请求与元事件同样不产生任务。
- **撤回继续观测，只打标记。** `group_recall` 只给已登记的旧群收件行打撤回标记（`qq_inbox.recalled = 1` 并写 `recalled_at`），不取消任务、不补发回复、不派发。未登记的消息不宣称已知撤回；重复的撤回事件幂等。这样已接收群结果的撤回复核仍然有效。撤回只能在 NapCat 连接仍在、登录账号仍在群里时得知；连接断开或退群后发生的撤回无法观测，核心也不做补偿。
- **允许群的配置写入口删除。** 控制协议 v14 删除 `qq_group_update` 操作，旧客户端因版本不匹配被拒。CLI `ruukoto qq group add|remove` 与 TUI `/qq groups` 只打印退役提示；配置中心的允许群界面与菜单项已删除。`qq_config.groups` 原样保留为历史值，`qq status` 与 `/qq` 照常显示。`qq_configure`、`qq_set_enabled` 与 `qq status` 只作用于私聊入口。`max_reply_chars` 仍是私聊回复的字符上限；`queue_ttl_ms` 没有读取方，已移出配置类型，列保留、不迁移。
- **旧群资料原地保留为只读归档。** `qq_sessions` 映射、`qq_group` 会话及其历史、`qq_inbox`（状态、撤回标记与时间、引用关联、配置版本）、`qq_outbox`（发送账本）、`qq_group` 入站事件、chat 任务行与接收账本 `chat_result_acceptances` 全部保留，不删除、不改写正文。拥有者经以下入口查阅，不新增控制面操作：
  - `qq inbox`（控制面 `qq_inbox_list`，v14 新增两个字段）：每条记录附 `acceptance`，即 main 的接收账本行（接收时间、接收任务、理由、摘要快照）；再附 `sourceProblem`，即当前复核结论，`null` 表示可用，否则是不可用的原因（归档行缺失或不一致、main 不可用、来源已撤回）。未经 main 接收的记录两个字段都为空。main 角色缺失时，视图按任务取任一接收记录，并把 `sourceProblem` 设为「main 角色不可用，无法复核接收来源」，不会把被阻断的来源显示成「未接收」或「可用」。
  - `qq outbox`（`qq_outbox_list`）查发送账本；拥有者的 `read_history` 读群会话历史。
- **归档不能变成对话入口。** 会话身份在 `src/core/session-identity.ts` 统一判定：`sessions.kind = 'qq_group'` 的会话与 chat 角色会话都是 `retired`，原因 `core_group_chat_retired`。
  - `submit` 拒绝 retired 会话（`invalid_state`，提示历史可经 `qq inbox` / `read_history` 查阅）；`continue` 经 `submit` 提交，一并被拒，所以升级时被中断的群任务不能续跑。
  - `createSession` 没有 `kind` 参数，只建普通 dev 会话。带 `projectId` 时，角色项目和含非 dev 会话的项目都被拒绝（「角色或群聊项目不能创建普通会话」）。这和 `open_workspace`「角色或群聊项目不能作为工作区认领」是同一判定，覆盖全部角色项目，而不只是 chat 与群项目。否则拥有者可以在群项目里建一个普通 dev 会话，取得 dev 工具，并以本项目身份读取群原始历史。
  - `open_workspace` 认领和工作区迁移照旧排除角色与群聊项目。
  - 排队循环里留有兜底：任何钻过上述边界、仍在 retired 会话中排队的任务，出队时按同一原因取消，不执行。
- **升级收尾按状态幂等，只定终态，不重放。** 每次启动都执行收尾，没有升级标记；收尾只改未终态的行，因此重复升级或重启不会再改动任何东西。顺序如下：
  1. 通用 `recover()` 把运行中的任务改为 `interrupted`（结果未知，不重放，`continue` 被拒）。
  2. `retireGitHubModule` 之后、`orchestrator.start()` 之前，`Runtime.retireLegacyRoles()` 在一个事务内完成三件事：
     - 遗留的 pending 群回复定为 `unknown`（effect_unknown，不重发），对应收件记 `reply_unknown`；
     - 各群会话中排队的任务改为 `canceled`，持久化原因是 `core_group_chat_retired:核心群聊已退役（正式外挂后续交付）`；
     - 其余未终态的收件（`registered`、`queued`，包括已完成但未发回复的）记 `skipped`，不补发。
  3. `orchestrator.start()` 的启动恢复处理已登记、未派发的 `qq_group` 入站事件：入站门对 `qq_group` 来源恒返回同一个 drop，事件作废并写 `inbound.skipped`，收件记 `skipped`，未终态任务取消。结果补记由已有的 `sweepPendingResults` 完成，不另写逻辑。

  任何已有发送记录都不重新发送；迟到的回执只补记事实。
- **群结果接收与发送前复核保留。** `chat_result_list` 与 `chat_result_accept` 仍是 main 专属的宿主工具，只作用于归档中已完成且已记录结果的旧群 chat 任务。已接收摘要仍可被通知与通知计划以 `{kind:'chat_result', task_id}` 引用。规则如下：
  - `chat_result_list` 只列来源元数据（任务、来源事件、账号、群、消息 ID、完成时间、是否已接收），不读群消息或结果正文。
  - `chat_result_accept` 保存一份有界摘要快照，记录来源任务、接收任务、宿主操作与接收理由，并写持久事件 `chat_result.accepted`。摘要取自该 chat 任务自己的最终回答，最多 1000 个 Unicode 字符。核心不采集未触发的全群消息，也不复制完整历史。
  - 这是群资料隔离（main 与 coding 不得直接读取原始群资料）为 main 显式接收的结构化结果开的窄例外：接收只开放这份固定快照，原始群历史、产物与带群来源的记忆仍被拒绝。例外只给 main，coding 与 SubAgent 的资料引用都不能使用它；固定 coding 委派已删除，委派资料统一经 SubAgent 委派核对。
  - 群任务完成不唤醒 main，也不登记 owner 回复。main 主动查询并接收结果后，用通知工具的 `chat_result` 来源引用固定快照。接收本身不构成外发授权：每一次通知与每个通知计划仍按[调度器与通知 outbox](../architecture/2026-09-24-scheduler-outbox.md)经拥有者审批，完全访问模式也不例外。
  - 接收、通知批准提交、查询与发送前，都会复核宿主来源和撤回。归档行缺失或不一致、main 不可用、来源已撤回、快照与引用时的版本或哈希不符时，取消该次发送，记 `source_revoked：<原因>`；绝不只凭接收快照正文继续发送。
  - 撤回按时间窗保守失效：触发该任务的收件被撤回，或同一账号同一群中存在这样一条已撤回收件——它在源任务结束前登记，并且撤回时间未知或不早于源任务开始——摘要就不可接收，也不能继续外发。这个时间窗可能拒绝实际上没有引用被撤回消息的摘要。
  - 已经进入 main 历史或已经发送的副本不追溯删除；核心不承诺识别失去来源标记的自由文本转述。
- **群资料隔离不随退役放宽。** 群资料隔离规则来自 [QQ 私聊共享 main](../feature/2026-09-24-qq-private-shared-main.md)，退役后不变。`AccessScope.isQqGroupProject` 按 `sessions.kind = 'qq_group'` 判定群项目，不依赖 chat 角色行，也不依赖可改名的项目名称。main 与 coding 即使持有跨项目授权，也读不到群项目的原始历史、产物与带群来源的记忆；main 的 SubAgent 同样读不到。`chat_result` 不能作为 SubAgent 委派资料（「已接收群摘要仅供 main 与通知使用，不能作为委派资料」），见[工作委派与 SubAgent 任务](../architecture/2026-10-03-work-delegation-subagent-task.md)。已接收快照只对 main 开放。拥有者控制面，以及拥有者已建的群项目到普通开发项目的资料授权，不受此限制，也不被撤销。其余外发与身份规则同样不因角色删除而自动放宽。
- **跨实例迁移的归属。** 迁入全新 Personal Agent 时，chat 角色行、群会话与群归档四表（`qq_sessions`、`qq_inbox`、`qq_outbox`、`chat_result_acceptances`）随主会话整体迁入，见[旧实例迁入 Personal Agent](../architecture/2026-10-05-personal-instance-import.md)。迁入 Coding Agent 时排除角色会话、群会话与接收账本，见[旧开发资料迁入 Coding Agent](../architecture/2026-10-04-legacy-instance-import.md)。

## 原群聊设计

下面是归档中群行的产生路径。路径本身已随退役删除，但这些规则决定了归档行的含义与复核口径。

- **群按宿主映射进入 chat。** 群聊接入角色与持久事件由 daily-agent issue 09 完成，沿用 personal-agent issue 07 的指定群、结构化 @ 触发、同群 FIFO、5 分钟过期与撤回规则。所有群共用 chat 的一份角色工具策略，工具集合为空。每个「登录账号 + 群」的项目、会话与空工作目录由 `qq_sessions` 独立绑定，会话类别是 `qq_group`。
- **先登记，再派发。** 群消息先登记收件（`qq_inbox.dedup_key = account:group:message_id`，状态 `registered` → `queued` → `done` / `reply_failed` / `reply_unknown` / `skipped`），再登记 `source = qq_group` 的入站事件（`target_role = chat`，`external_id` 等于收件去重键，`actor` 是发言者）。编排器用原收件请求键派发 chat 任务，并回写 `agent_id = 'chat'`。正文保留撤回标记。升级到这条路径时，先核实旧任务并补上关联，避免换键后重复执行。入站、收件恢复与任务队列遇到同毫秒时间时，按持久登记顺序打破平局。
- **接收复核核对的正是这条映射。** `chat_result_*` 判定一个群任务可接收的条件是：
  - 任务的 `agent_id = 'chat'`，状态为 `completed`，且已记录结果；
  - 会话类别是 `qq_group`，收件、群映射与会话三者一致；
  - 入站事件状态为 `done`，来源 `qq_group`，目标角色 chat，`task_id`、`external_id` 与 `actor` 都和收件一致。

  任一条件不满足，就报「群任务的入站事件、收件与会话映射不匹配」。
- **群回复走独立账本。** 原群内的普通回复使用独立的 `qq_outbox`，不经公共通知 outbox。重启时核对已完成任务与发送记录：已有发送记录的一律不重发，遗留或取消时仍在途的发送记 `unknown`，迟到回执只补记事实。退役收尾沿用同一口径。
- **上下文的撤回过滤。** chat 任务装配上下文时排除已撤回消息。旧引用没有消息 ID，所以该群一旦发生撤回，带引用的旧交互也被保守排除。这一过滤随 Driver 的 `qq_group` 分支删除：核心不运行群任务。
- **schema v17。** 新增 `chat_result_acceptances` 表（主键 `(main_project_id, task_id)`，`accepted_by_op_id` 唯一，另有 `accepted_by_task_id`、`reason`、`summary`、`accepted_at`），以及群收件的 `config_version`、引用消息 ID `reply_to_message_id` 与撤回时间 `recalled_at`。已有群会话、请求键、历史与发送账本保留。旧撤回记录没有确切时刻，迁移时 `recalled_at` 填为迁移时间，保守地使既有摘要失效；原始历史保留。
- **真实平台。** 真实 NapCat / QQ 收发需要拥有者另行授权，模拟测试不作为部署验收。

## 备选方案

- **长期保留内建 chat 角色（群按宿主映射进入核心）** — 这条路径已经交付并验证：每群独立会话、资料隔离、显式接收与撤回复核都已在位，继续用它没有迁移成本。不选，是因为它让群聊与核心 Runtime、资料范围和发送状态耦合，把通用个人助手绑在群聊用途上，群聊扩展也无法独立演进；方向调整改为独立可选外挂。（见[两个 Agent 产品](../architecture/2026-10-02-two-agent-products.md)；[agent-direction spec](../../../../.scratch/agent-direction/spec.md)「共享与外挂边界」「现有基础与实施缺口」）
- **保留核心群入口，加一个开关** — 拥有者在外挂交付前仍可按需使用群聊。不选：开关意味着群收件、建会话、派发、回复与补发整条写链路继续留在核心并需要维护，而这正是方向调整要移出核心的耦合。因此直接删除入口，新安装不引导 chat。（见 [agent-direction issue 20](../../../../.scratch/agent-direction/issues/20-retire-core-group-chat.md) Comments「默认取舍」）
- **群消息照常登记收件，或逐条记日志** — 可以保留退役期间群内活动的记录。不选，是因为这等于核心继续收集群内容，而核心已不为群内容提供任何用途。（见 agent-direction issue 20 Comments「默认取舍」）
- **升级收尾用一次性升级标记** — 与 GitHub 模块退役的 `github_retirement_done` 做法一致，收尾只跑一次。不选：收尾只改未终态的行，按状态天然幂等，每次启动执行也不会改动已终态的行；不需要额外维护一个标记。（见 agent-direction issue 20 Comments「默认取舍」；[退役专用 GitHub 模块](2026-09-23-retire-github-module.md)）
- **为接收账本新增独立的拥有者查询操作** — 可以直接列出全部接收记录。不选：每条接收记录都对应一条群收件，附在 `qq inbox` 的记录上，就能同时给出当前复核结论，无需增加控制面操作。（见 agent-direction issue 20 Comments「默认取舍」）
- **退役时撤销拥有者已建的群项目到开发项目的资料授权** — 可以彻底封住群资料流向其他项目的所有路径。不选，是因为群资料隔离规则明确把拥有者控制面与普通开发项目的既有资料授权留给拥有者决定，角色退役不应替拥有者收回授权。（见 agent-direction issue 20 Comments「默认取舍」末尾的「不做」；[QQ 私聊共享 main](../feature/2026-09-24-qq-private-shared-main.md)）
- **按模型实际读取的消息建立逐条来源图，精确判定撤回影响** — 只让真正引用了被撤回消息的摘要失效，不会误拒。不选：首版不为每次模型上下文增加逐条来源图，改按同群时间窗保守失效，接受误拒。误拒如果影响使用，升级路径是保存模型实际读取的消息 ID。（见原决定「接收、通知批准提交、查询与发送前均复核来源及撤回」一段；[src/agent/chat-result-tools.ts](../../../../src/agent/chat-result-tools.ts) 中的 `ponytail:` 注释）

## 后果

- **收益**：核心不收集群内容、不运行群任务，收件、建会话、派发、回复、补发与允许群配置这条写链路已从核心移除，私聊与 Telegram 不受影响。旧群历史、撤回标记、来源关系、接收记录与发送账本都可核查，`qq inbox` 直接给出每条已接收结果当前能否使用及原因。升级与重复重启不重放群任务、不补发群消息，结果不明的发送保留 `unknown`。已有通知与调度中的群结果引用照常复核，归档无法核实时阻断外发并留下 `source_revoked` 原因。隔离按会话类别判定，删除 chat 角色行不会扩大 main、coding 或 SubAgent 的读取范围。
- **代价：外挂交付前没有群聊能力。** 外挂接口尚未设计；外挂提供的结果如何对接 main 的接收、复核与通知，要在外挂阶段重新决定。到时必须重访这一决定。
- **代价：撤回观测有上限。** 连接断开或退群后发生的撤回无法得知，相关的已接收摘要在核心看来仍然可用。
- **代价：时间窗误拒无法弥补。** 被时间窗保守失效的摘要没有替代来源：在撤回过滤之后执行的新群任务原本可以产生新结果，但核心不运行群任务。
- **代价：副本不回收。** 已进入 main 历史或已发送的副本不追溯删除，失去来源标记的自由文本转述不受复核。
- **代价：升级时在途的群工作直接终止。** 运行中的群任务定为 `interrupted`、结果未知、不能续跑；已完成但未回复的群消息不会得到回复。
- **代价：为旧行保留的残留。** `AgentRoleId` 的 `chat`、存储 CHECK、`qq_group` 会话类别、`chat_result_*` 工具、`qq_config.groups` 与 `queue_ttl_ms` 列、撤回观测路径，都只为归档中的旧行存在。旧群资料仍需核查期间，它们不能删。

## 验证

- `test/85-retire-core-group-chat.test.ts` 逐条覆盖六项验收：新核心不引导 chat，群消息不新增收件、会话、任务、回复或模型调用，私聊与 Telegram 照常回复；归档可查，转为 dev 会话、`submit`、`continue` 与 `open_workspace` 认领都被拒；没有 chat 角色行时隔离不扩大；通知与调度遇到撤回、篡改或映射缺失时阻断并记 `source_revoked`；排队、运行中、待发与未派发的旧状态一次收尾，三次启动结果不变，期间没有发送也没有模型调用。旧数据由 `test/helpers/legacy-group-archive.ts` 按退役前（核心库 v24）的持久形态播种，因为退役后的代码不能再产生这些行。
- `test/26-qq.test.ts` 保留传输状态、配置校验与 `qq_group` 资料身份；群消息被忽略由 `test/85` 验收。`test/48-chat-results.test.ts` 覆盖元数据列表、有界快照、伪造来源拒绝、撤回时间窗失效与 schema v16 → v17 迁移；`test/49-chat-result-flow.test.ts` 用播种的归档覆盖接收、审批、撤回复核，以及「不凭快照外发」。
- [smoke-20](../../../../.scratch/agent-direction/smoke-20-retire-group-chat.mts) 让旧数据由真实旧代码（`e542261` 的工作副本、旧 CLI 与模拟 OneBot）产生，之后 SIGKILL 后台，换新代码在同一数据目录启动，再重启一次核对幂等。它在 macOS 本机与 tx（`--remote`，Linux、Docker 受限 worker）上运行。模型与 OneBot 为模拟；真实 QQ 群与 NapCat 没有入口，记为未实测；tx 生产库副本的升级演练需要 `ruukoto-backend` 权限，未经拥有者授权，没有做。
