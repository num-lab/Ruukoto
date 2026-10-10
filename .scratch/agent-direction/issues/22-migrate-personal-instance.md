Status: resolved

# 22 — 把旧主会话和服务状态迁入 Personal Agent

**What to build:** 拥有者将旧 main 的会话、应用数据、调度及平台状态迁入独立 Personal Agent，保留旧角色档案和发送事实。

**Blocked by:** [01 — 两个产品独立安装和启动](01-independent-products.md)；[19 — 把现有 GitHub 评审迁移到通用 SubAgent](19-github-subagent-review.md)；[20 — 退出核心群聊并保全旧群资料](20-retire-core-group-chat.md)

依据：[已确认规格](../spec.md) 与 [ADR 0017](../../../.agents/notes/implemented/architecture/2026-10-02-two-agent-products.md)。

## 验收标准

- [x] 预览并确认源/目标实例及个人数据归属，核对备份与未完成任务；不覆盖未核实的目标数据。
- [x] 主会话、应用数据、调度、平台绑定和必要凭据在新实例可用；旧 coding/chat 历史、结果与发送记录保持可核查。
- [x] 切换时明确交接平台连接和调度的执行归属，旧新实例不能同时消费同一入站或继续发送同一批通知。
- [x] 来源资料落在另一实例时保留来源、授权和映射；无法核验的派生记忆或发送引用不自动使用，明确列出待处理项，不靠扩大读取或共享凭据恢复可读性。
- [x] 中断后可继续，重复迁移不重复创建；审批、排队任务及 pending/在途/unknown 发送均按实际效果处理，不当作新请求重放。
- [x] 用代表性个人数据演练恢复和回退；回退也保留切换期间新增的执行及发送事实，不用旧备份重发已有副作用。
- [x] 完成相关端到端检查、类型检查及仓库要求的验证；同步本次行为涉及的运行说明和图解，验证记录区分模拟结果与真实环境结果。

## Comments

### 2026-10-05：实施计划

基于 HEAD `d2f6f74` 制定。01/19/20 均已交付（19 的工单头漏标 resolved，一并在本单修正）。当前核心库 v28、控制协议见 `src/control/`；21 已交付跨实例导入骨架（ADR 0022，schema v28 两表、`src/runtime/legacy-import.ts`、`ruukoto-code legacy-import`、test/85、smoke-21）。本单是 21 的镜像方向：旧 ruukoto 实例的个人侧资料迁入**全新 ruukoto 实例**（源与目标同为 ruukoto 产品，目标为另一数据目录）。

#### 现状核实

- **方向与产品。** 源 = 旧 ruukoto 实例（`product.type` = ruukoto 或未登记）；目标 = 新 ruukoto 实例（同产品、不同目录）。21 的模块核心（快照逐文件复制、`probeLockHolder` 只读探测、VOLT 核对备份、账本/回执幂等、修订整行哈希、文件 sha 复制、事件按序追加）方向无关；方向特异性集中在 `TABLE_POLICY`（`legacy-import.ts:70-107`）、`buildImportSet` 的会话/记忆/授权选择（`:411-643`）与 `checkTargetProduct` 的字面值（`:295`）。21 明确"不为 22 预先抽象"，本单复用其导出辅助，新写方向模块，不为两方向新建通用引擎。
- **个人侧身份链（探索核实，file:line 见备注）。** main 角色行在 `agent_roles`（编排器 `ensureRoles` 幂等、已有行跳过）；应用数据 = `<dataDir>/agent-data/main.db`，核心 meta `app_data.main_instance_id` 与其 `app_meta.instance_id` 互认，`app_audit.task_id` 引用核心任务行（ID 原样保留→回执不断链）；调度 `schedules`/`schedule_runs`（打开运行 = `closed_at IS NULL`）；发送账本 `notification_ops`（`UNIQUE(source_kind, source_key)`，重启时 sending→effect_unknown）；平台 `qq_config`/`telegram_config`（`config_version` 钉版身份，telegram `last_update_id` 只前进 = 消费一次状态；QQ 推送无游标）；长期授权 `standing_permissions`（钉版目标含 configVersion + main 会话 + machine/unit/action，用前逐项核实）；入站 `inbound_events`（`(source, external_id)` 去重键，registered/queued 会在启动重派）；群归档四表（`qq_sessions`/`qq_inbox`/`qq_outbox`/`chat_result_acceptances`，20 已退役，启动时 `retireGroupChat` 幂等收尾残留）；GitHub 归档三表（v4 遗留，退役迁移幂等、meta `github_retirement_done`）；凭据只有绑定名入库，秘密在 `<agentDir>/credentials.json`（name+host+header+purpose+secret+scope）。
- **启动时目标会做什么。** `Runtime.start`：prepareRecovery 触发逾期调度（合并进未完成运行）、sending→effect_unknown；recover 收尾未终态任务/审批；编排器重派 registered 入站；适配器按配置表连接平台。因此导入的任何"活"状态都会被目标启动接管——这是交接的落点，也是"不重放"必须收尾的位置。
- **目标已初始化的冲突。** 目标后台一旦启动过，`ensureRoles` 已建 main/coding 角色行（PK = 角色 id）与 main 会话；导入源 main 角色行会撞 PK。因此要求目标为**全新实例**（或仅含同源此前导入），目标已有自有角色行时拒绝。

#### 默认取舍（推荐即规格，有异议再改）

- **执行方式与命令面。** 与 21 同构：目标侧离线 CLI、不走控制面、持目标实例锁、源全程只读（`ruukoto.db` 与 `agent-data/main.db` 都逐文件复制到快照后读取）。命令复用 `legacy-import` 子命令，按产品分流：`ruukoto legacy-import` = 本单的个人方向；`ruukoto-code legacy-import` = 21 的开发方向（不变）。两方向共享错误码与回执表。
- **导入范围（allow-list）。** 导入：main/coding/chat 角色行及其项目与会话（含一层 SubAgent 与工作委托）、QQ 群会话与群归档四表、这些会话的任务/工具操作/审批/产物/选择记录/压缩点/事件、调度两表、发送账本、长期授权、`inbound_events` 全量、`qq_config`/`telegram_config`、GitHub 归档三表与 `github-archive-manifest.json`、`agent-data/main.db`（+WAL）与 meta `app_data.main_instance_id`/`github_retirement_done`/导入项目的 `jev.project.*`、main 项目与可核验来源的 personal 记忆、两端都导入的资料授权、导入项目的 MCP 服务。排除：普通 dev 会话及其 SubAgent 与项目（属 Coding Agent，经 21 迁移；预览列出并指向 21）、history_index 两表（可重建）、occupancy（运行时占用）、instance_imports/_items（目标自有账本）、跨到 dev 项目的记忆正文与授权（只进回执）。
- **身份与路径重写。** 行 ID 一律原样保留。角色会话 cwd 与 `agent_roles.work_dir`、角色项目根四列改写为目标 `<dataDir>/../agent-work/<角色>`（apply 时建目录并取目标 dev/ino/realpath——`ensureRoles` 幂等跳过既有行，不会重建）；普通会话 `session_file` 改写为目标 `sessions/` 下同名文件；会话 `create_request_id` 置空。main 会话 `default_access_mode` 原样保留（同产品延续，不做 21 的降级）。
- **不重放收尾（关键状态全部落定）。** 任务/审批沿用 21 口径（queued→canceled、running/awaiting_confirmation→interrupted 且 effect_unknown 同口径、未消费审批 stale，原因 migration）。新增：未关闭的调度运行置 `closed_at`（pending news 随运行关闭自然落空，schedule 的下个到期在目标正常触发）；发送账本 `pending→canceled`（`error_kind=migration`，已知未发送不当作新请求重发）、`sending→effect_unknown`、其余终态原样；`inbound_events` 的 registered/queued→failed（不再重派，任务侧已收尾）。SubAgent 按 21 规则以关闭状态登记。
- **交接（执行归属切换）。** 目标接管 = 导入 `qq_config`/`telegram_config`（含 `config_version` 与 telegram `last_update_id`，入站去重表随行，旧修订不回看）、活动调度原样（逾期按运行恢复语义在目标触发一次，旧 pending 发送已取消、不双发）、长期授权原样导入（同机同入口身份链完整则继续有效，跨机时机器/修订不符在使用侧 fail-closed 失效）。旧实例侧不改一字：预览与应用的报告明确列出交接清单，运行文档写明"导入后不得再启动旧实例消费平台或调度"。**必要凭据**（`qq_config`/`telegram_config` 引用的绑定名 + purpose `github_webhook` 的绑定）从源 `<dataDir>/../agent/credentials.json` 合并进目标凭据库：目标无同名→复制；同名同值→跳过；同名异值→冲突拒绝。报告只记 secret 的 sha256，不落值。MCP/Jev 凭据不复制，沿用 21 的"缺绑定停用导入"规则。
- **记忆与授权来源（fail-closed）。** personal 记忆**不再要求计划选中**（同产品延续，非跨产品发布；21 的 `personal_memories` 计划字段在本方向不用），只受来源规则约束：全部版本来源落在导入范围（或 owner_note）才导入，引用 dev 会话/群外来源的列为待处理（正文留源实例，不靠共享凭据恢复可读性）。资料授权两端都导入才入库，否则只记回执（标注跨实例、不生效）。
- **幂等、续跑与回退。** 复用 21 全部机制：请求键幂等 + 修订整行哈希（含新增各表）、目标 VACUUM INTO 备份、文件临时名+rename、单事务入库。账本类别扩展（schema v29，重建 `instance_import_items` 的 CHECK）：新增 `agent_role`/`schedule`/`platform_config`/`standing_permission`/`credential`。调度运行、发送账本、入站事件、群归档、GitHub 归档按行 manifest（id 列表 + 逐行 sha256）记入报告 JSON：续跑时"同键同 sha=同源已导入跳过、同键异 sha=id_conflict"；回退时逐行 sha 比对，被目标运行时改过的行（已发送、已 advance、已消费 offset）即阻挡项——切换期间新增的执行及发送事实不抹掉。目标启动后新增入站事件/发送操作/调度/运行（created_at/received_at >= 回执 created_at）也是阻挡项。应用恢复路径：中断在事务前重跑同计划，事务失败整体回滚；回退 `revert` 与 `list` 同 21。整库恢复保留为手工路径并在文档写明不重演副作用。
- **与 21、23 的边界。** 21 导入源后本单可再导（同目标不同产品互不干涉；源侧新增 dev 活动与本单无关）。本单不删除旧角色、不收缩旧类型（23）；不复制 models/auth/models.json（模型目录与 API key 走配置中心，预览只列 agentDir 名称差异）；不迁移 agent-work 工作目录内容（角色工作目录在目标重建）。

#### 实施步骤

1. **schema v29**（`src/core/db.ts`）：SCHEMA_VERSION=29；`instance_import_items` CHECK 扩为 14 类（SCHEMA_SQL 幂等 + v28→v29 重建表迁移，沿用 `rebuildScheduleActionCheck` 模板与 `rebuildTables` 条件）；`src/core/types.ts` 的 `InstanceImportItemKind` 同步扩展并更新注释（两个方向共表）。
2. **共享辅助导出**（`src/runtime/legacy-import.ts` 最小改动）：把 `LegacyImportError`、`openSourceSnapshot`、`openTargetReadonlyCopy`、`readLedger`、`checkTablePolicy`（改收 policy 参数）、`readMetaValue`、`insertRows`、`strictDirOk`、`memoryRefsInScope`、行工具（`allRows`/`rowsIn`/`columnNames`/`sha256File`/`canonicalJson`/`sha256` 已导出）改为 export；21 的行为零变化（test/85 不改）。
3. **新模块 `src/runtime/personal-import.ts`**：本方向的 `TABLE_POLICY`、`buildImportSet`（会话=角色/群/随父 SubAgent；新增调度/运行/发送/入站/授权/平台/归档集合与收尾决策）、`analyze`（目标合并：同源自跳、同键异冲突、全新实例核对、凭据冲突、修订）、`previewPersonalImport`（含交接清单与各收尾计数）、`applyPersonalImport`（凭据合并→备份→文件复制→单事务）、`revertPersonalImport`（manifest sha 核对 + 启动后活动阻挡项 + 凭据摘除）、`listLegacyImports` 复用 21 导出。故障注入钩子同 21（`__testHooks`）。
4. **CLI**（`src/cli.ts`、`src/cli-entry.ts`）：`legacy-import` 按产品分流调用两模块；ruukoto 侧用法文案、help、man 列表更新；请求键派生、退出码、锁语义与 21 完全一致。
5. **文档。**
   - `docs/runtime.md`：数据布局与旧实例迁入节补个人方向（导入范围、交接步骤与旧实例停用要求、回退/整库恢复、演练记录）。
   - `CONTEXT.md`："实例导入"词条扩为两方向。
   - 新 ADR 0023（编号按现状）：个人方向导入的决策（同产品目标、交接语义、必要凭据复制、manifest 账本、记忆不选中）。ADR 0017 实施记录加一行。ADR 0022 文末补一句指向 0023（镜像方向）。
6. **visual**：对改动的 `src/` 文件 `grep -l` 命中页（预计 storage-layout：新镜像小节 + v29 行 + 账本 14 类；deployment：CLI 分流；orchestrator/index：状态句），按 `.agents/skills/visual-docs/SKILL.md` 同步后跑 test/67。

不做：在线导入或控制面入口；源实例写入（含"停用旧平台"的源侧写入）；增量同步（源侧新增只在报告列出）；为两方向抽象通用引擎；MCP/Jev 凭据复制；agent-work 目录内容迁移；网页/GitHub 端外部重配置（webhook URL、bot 重绑由拥有者按文档操作）。

#### 验证与验收

新增 `test/86-personal-instance-import.test.ts`，沿用 test/85 骨架（testkit 构造源实例、停库后直写在途状态、`__testHooks` 故障注入、hashTree 核对源不变）。源实例覆盖：main 会话（普通 IM 任务 + 完成/排队/运行中/待审批任务）、其 SubAgent 与工作委托、应用数据（建表 + 审计行）、personal/main 记忆（来源在 main、来源在 dev、owner_note 各一）、两端/跨端授权各一、main 项目 MCP、活动调度三动作（含打开运行、pending/sending 发送、已终态）、telegram 配置（含 last_update_id）与 qq 配置、长期授权、IM 审批控制消息、群归档（legacyGroupArchive 助手）、GitHub 归档三表 + manifest、被排除的 dev 项目会话、一个 v20 旧库 fixture（沿用 test/76 做法）。

验收对应检查（六项）：

1. **预览与不覆盖**：预览完整（交接清单、收尾方式、待处理逐项）；目标零写入；源目录前后逐文件 sha 不变（含 v20 旧库只在快照迁移）；源/目标后台存活、目标为 ruukoto-code、源为 ruukoto-code、目标与源同实例（同 instance_id 或同路径）、目标已初始化自有角色行均拒绝；同名异值凭据冲突拒绝且零写入；目标备份存在且 sha 与回执一致。
2. **迁移可用与可核查**：目标启动后 main 会话历史/产物逐字节可读；应用数据工具可查询且审计回执（task_id 引用）完整；记忆按来源规则注入（选择记录证明）；调度在目标恢复逾期触发；`qq inbox/outbox`、群结果、coding/chat 历史、GitHub 归档、发送账本全部可查。
3. **交接归属**：目标 telegram 适配器以导入的 `last_update_id` 继续轮询（入站不重复消费；去重表随行）；dd 钉版目标的待发/审批按 configVersion 核实通过；活动调度只在目标触发一次（旧 pending 已取消，无双发）；长期授权在目标按原范围核实放行；`inbound_events` 无重派。
4. **来源与待处理**：引用 dev 会话的记忆不导入列待处理；跨到 dev 项目的授权只进回执；MCP/Jev 缺凭据停用导入；models/auth 不复制；`TABLE_POLICY` 全表登记核对（新表未登记测试失败）。
5. **中断、续跑、回退**：文件复制后/事务内故障注入 → 同计划重跑无重复；同键重放返回回执、异参 request_conflict；预览后源/目标变化报 revision_conflict；回退在无启动后活动时行/事件/文件/凭据摘除干净且源不变；目标启动后有新入站/新发送/新调度或已发送行被改动时拒绝回退并逐项列出；跨进程重查回执。
6. **检查**：定向测试集 + typecheck + test/67 全绿；全量 `npm test`（nohup + 退出码文件，跑时不改 src/test）。

冒烟脚本 `.scratch/agent-direction/smoke-22-migrate-personal-instance.mts`：真实 `bin/ruukoto.mjs` 双实例 + 本地 telegram HTTP stub。流程：真实源实例建 main 会话并停库 → 停库直写平台/调度/在途 fixtures + 凭据文件 → preview/apply → 目标后台启动（真实进程、真实 socket、模型打桩）→ stub 断言 `getUpdates offset = last_update_id+1`、逾期 wake_main 调度恰触发一次、已取消 pending 发送零外发、凭据合并成功 → 回退演练（目标启动后拒绝；第二目标干净 revert）→ 源哈希树前后不变。macOS 本机与 `ssh tx` 各一轮。

真实数据演练：本机 `~/.ruukoto/data`（v11 真实实例，演练前核实后台已停止）只读导入到临时 ruukoto 档案：预览→应用→目标启动前将导入的平台 enabled 置 0（避免真实连接）→ 启动查阅 main 历史/应用数据/调度/发送账本 → 停止后目测阻挡项 → 第二目标干净回退；源哈希树前后核对。tx `/var/lib/ruukoto` 需提权读取，未取得拥有者同意不触碰，记录"tx 真实数据未实测"。与 smoke-21 一样区分模拟模型与真实进程。演练产生的临时凭据副本随演练结束清理。

完成时逐条登记六项验收证据（离线逻辑测试 / 真实进程冒烟 / 本机真实数据演练）。本次先保存计划，工单状态与验收勾选在实施完成时一并更新。

### 2026-10-05：实施完成（schema v29，ADR 0023）

按 2026-10-05 计划实施并交付。当前核心库 v28 → v29（`instance_import_items` 类别 CHECK 扩五类，经重建表迁移）；决策记录新增 [ADR 0023](../../../.agents/notes/implemented/architecture/2026-10-05-personal-instance-import.md)，ADR 0017 实施记录已加行，ADR 0022 文末补镜像指向。

**交付物**：`src/core/db.ts`（v29 与 rebuildImportItemsKindCheck）、`src/core/types.ts`（账本类别扩注）、`src/runtime/legacy-import.ts`（方向无关辅助改导出 + 表登记核对容忍目标缺遗留表；21 行为不变，test/85 全绿）、`src/runtime/personal-import.ts`（个人方向预览/应用/回退全部判断）、`src/cli.ts` + `src/cli-entry.ts`（`legacy-import` 按产品分流，ruukoto 侧启用个人方向）、`test/86-personal-instance-import.test.ts`（5 项子测试）、`.scratch/agent-direction/smoke-22-migrate-personal-instance.mts`（6 场景）、`docs/runtime.md`（旧实例个人资料迁入节）、`CONTEXT.md`（实例导入词条扩两方向）、`docs/visual/`（storage-layout 个人方向小节 + v29 行 + 账本 14 类、deployment 分流、orchestrator 状态句、index 卡片）。另修正工单 19 漏标的表头状态（其正文与 ADR 0017 实施记录均已完成，仅 `Status:` 未随动）。

**与计划的实施差异（均已记录于 ADR 0023）**：
- 收尾转换带时间戳（closed_at/settled_at），目标行与源快照行 sha 不再相等；续跑的「同源识别」改为以此前（applied）同源回执的 manifest 为唯一证据——同键同 sha 跳过、其余同键 id_conflict；回执 manifest 按其写入目标的转换后行计算。
- 修订剔除凭据动作（含动作会让复制后中断的续跑永远撞 revision_conflict，冲突在应用期仍生效），同 21 当时剔除文件 skip 标志的教训。
- 全新目标缺 v9 前遗留 github_* 三表：apply 在导入事务内按快照自身 DDL 重建后插入；目标已有则列集合一致性核对照旧（共享的 `checkTablePolicy` 放宽为「目标整表缺失时跳过比对」，对 21 的导入面无影响——其全部导入表在新建库恒存在）。

**验证证据（区分模拟与真实）**：

| 验收 | 离线逻辑测试（模拟模型） | 真实进程冒烟（模拟模型 + telegram stub） | 真实数据演练 |
| --- | --- | --- | --- |
| 1 预览/不覆盖 | test/86 子测试 1：预览分节齐全（交接清单/app 绑定/收尾计数/分类/凭据动作/修订）、目标零写入、源 sha 不变、存活/产品错配/自我迁入（同路径、同实例 ID）/目标已初始化/未登记表逐项拒绝、v20 旧库只在快照迁移；子测试 3 备份存在且 sha 一致 | smoke-22 场景 2/3：目标零写入、计划写回、回执+备份、同键重放幂等、源哈希树不变 | ~/.ruukoto 真实实例（schema 29，3 角色、13 会话、9 群/归档文件）preview/apply：备份存在、计数与回执一致、process 间 list 可核实 |
| 2 迁移可用/档案可核查 | 子测试 2：角色行沿用（ensureRoles 幂等）、main cwd 改写目标 agent-work、历史字节前缀一致、产物一致、应用数据审计 task_id 不断链、记忆注入（选择记录证明）、SubAgent 关闭登记、群/接收/GitHub 归档与 manifest 可查、发送账本逐行可查 | smoke-22 场景 4：main 历史经控制面 read_history 可读、长期授权钉版与导入配置同代 | 真实目标后台启动：status 列出导入项目/会话，角色 work_dir 指向目标 agent-work；app_data 绑定元键与退役 meta 随行 |
| 3 交接归属 | 子测试 2：逾期 wake_main 恰触发一次、逾期 notify 恰产生一个新发送操作、旧 pending 保持 canceled 不外发、导入偏移与 config_version 保留 | smoke-22 场景 4：stub 首次 getUpdates 恰 offset=101（不回看 100）、canned 更新恰处理一次且 owner 回复恰一条、notify 新发送恰一条、旧 pending/发送中零外发 | —（真实实例无平台配置；连续性以冒烟为准） |
| 4 来源/待处理 | 子测试 1/2：引用 dev 的 personal 记忆与 dev 项目记忆列待处理、跨实例授权只进回执、MCP/Jev 缺凭据停用、模型目录与 API key 不进目标、TABLE_POLICY 全表登记 | —（测试覆盖） | 真实源无 personal 记忆/授权，结构核对以测试为准 |
| 5 中断/续跑/回退 | 子测试 3：复制后故障同计划重跑无重复、事务内故障整体回滚、同键重放/异参 request_conflict、源变化 revision_conflict、干净回退行/事件/文件/凭据摘除干净且源不变、回执跨进程可核实；启动后新入站/发送事实/平台偏移/调度推进/应用数据改写逐项列为阻挡项 | smoke-22 场景 5/6：目标有切换事实时 revert 拒绝并列出（新入站、发送事实）；第二目标干净 revert 行/文件/凭据移除、回执 reverted、源哈希树不变 | 真实实例目标启动查阅后干净停止，revert 干净：行/事件/2 文件移除、回执 reverted、源 52 文件哈希树前后不变 |
| 6 检查 | test/86 5/5；定向回归（85/76/71/29/75/37/38/40/79/17/27/28/67）全绿；`npm run typecheck` 绿；visual 页同步后 test/67 4/4；全量 894 项 890 通过（3 个既有环境项：test/08 DNS 环境超时——基线 commit 同样失败；test/32 档案路径 worktree 目录名既有项；test/83 隔离运行 13/13 通过）| smoke-22：macOS darwin-arm64 6/6 + tx（Linux x64）6/6 | 演练机型 macOS（darwin arm64，Node v24.15） |

**冒烟与演练环境**：模型层打桩（MockModelServer / 不可达 stub），Telegram Bot API 打桩（本机 HTTP stub，断言请求体）；其余全真（bin 进程、控制面 socket、SQLite、JSONL、产物、实例锁、凭据文件 0600）。tx 真实数据未实测：`/var/lib/ruukoto` 需 `sudo -u ruukoto-backend` 读取，按计划未征得拥有者同意不触碰，记录于此；本机 `~/.ruukoto/data` 已作为代表性真实数据完成预览→应用→启动查阅→回退全流程（该实例无平台配置/调度/记忆，交接维度以冒烟与测试覆盖，如实记录）。演练产生的临时目录与凭据副本已清理。

**code-review（两轴）**：Standards 轴无硬性违规（21 方向行为不变经 test/85 断言、秘密不进报告、源只读快照）。Spec 轴处置：manifest 同源识别机制的 ADR 表述已按实现写清（回执 manifest 为唯一证据）；`product.type` 与目标备份不随回退移除已补进 runtime.md 与 ADR 0023（与 21 一致）；「旧新实例不能同时消费」属源侧停用程序性边界（「不做：源实例写入」），目标侧由偏移续消费 + 旧发送全部落定保证同一批不双发，运行文档已写明停用要求。判断性提示（不回改）：once-only/outbox 页不写导入阻挡项（归属页规则）；`normalizePlan` 未知字段拒绝；CLI 双模块接缝为动态边界。顺手修正：ADR 0023 笔误一处；`manifestTables` 映射去重；package-lock 与 package.json 的 bin 条目补齐（npm install 重新生成，属锁文件追平）。

**过程中修复**：fixture 调度规则与 payload 按运行时规范化形状（timeZone/disambiguation/sourceRefs）；钉版目标 account = botId（smoke run 首次暴露 target_changed）；播种行时间一律早于导入时刻（回退阻挡项语义）；fixture 的 z_unregistered 演练后刷新哈希基准；源存活门禁用独立后台避免对夹具源的合法写入；历史断言改为导入前缀比对（目标接手后在原 JSONL 追加）。

**文档同步**：runtime.md 新增「旧实例个人资料迁入」节（范围、不重放收尾、交接与旧实例停用要求、回退阻挡项、整库恢复手工路径）；CONTEXT.md 实例导入词条扩两方向；ADR 0023 新增、0017/0022 互链；visual 四页（见交付物）经 shoot.sh 渲染逐张核对，test/67 全绿。未发现文档与代码的新不一致；评审两轴各自结论见上。
