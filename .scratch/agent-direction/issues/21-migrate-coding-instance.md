Status: resolved

# 21 — 把旧开发资料迁入 Coding Agent

**What to build:** 拥有者预览并把旧开发会话及资料迁入独立 Coding Agent，迁移后能按工作区继续使用，并有可核查的恢复路径。

**Blocked by:** [01 — 两个产品独立安装和启动](01-independent-products.md)；[07 — 把旧开发会话和资料映射到工作区](07-legacy-workspace-data.md)

依据：[已确认规格](../spec.md) 与 [ADR 0017](../../../docs/adr/0017-two-agent-products.md)。

## 验收标准

- [x] 预览源实例、目标实例和开发资料归属，核对备份及未完成任务，不覆盖未核实的目标数据。
- [x] 迁移开发会话、历史、产物、记忆和配置，保留旧项目到工作区的映射，原有资料仍可定位。
- [x] 来源与读取方分到不同实例时保留来源及授权记录；无法核验的派生记忆不自动注入，明确列出待处理项，不通过复制敏感正文或共享凭据扩大访问。
- [x] 迁移中断可继续，重复执行不重复导入；用实际代表性开发数据验证恢复或回退，不删除源资料。
- [x] 迁移不导入个人平台凭据或重放未完成任务、旧审批和未知效果；不要求跨端同步机制已实现。
- [x] 完成相关端到端检查、类型检查及仓库要求的验证；同步本次行为涉及的运行说明和图解，验证记录区分模拟结果与真实环境结果。

## Comments

### 2026-10-03：实施计划

基于 HEAD `e542261` 制定。01 已交付两个产品入口与分开的档案根：ruukoto 为 `~/.ruukoto`，ruukoto-code 为 `~/.ruukoto-code`。07 已交付同一实例内的旧项目 → 工作区组织映射。当前核心库 v24、控制协议 v11；12 的计划会把核心库升到 v25，本单的版本号实施时核实。

#### 现状核实

- **源与目标的含义。** 旧开发资料在 ruukoto 产品的数据目录里：普通 dev 会话与 main、coding、chat 角色会话、QQ 群会话、应用数据、调度、IM 配置混存。本机 `~/.ruukoto` 存在；tx 上的旧实例在 `/var/lib/ruukoto`，数据库只有 ruukoto-backend 能读。目标是 ruukoto-code 的数据目录，本机 `~/.ruukoto-code` 尚不存在。产品归属登记在 meta `product.type`，跨产品打开同一目录会被拒绝（`src/runtime/runtime.ts:508`、`src/core/product.ts:22`）。
- **07 只在同一实例内映射。** 07 计划明确把“旧实例与 Coding Agent 独立档案之间的导入、备份及切换”交给本单。可以复用的部分：`historyStatusOf`（`src/runtime/workspace-migration.ts:213`）区分历史缺失、未落盘与损坏；`resolveDirIdentitySync`、`sameDirIdentity`（`src/core/dir-identity.ts`）做严格的目录身份核实；预览 → 计划文件 → 应用、请求键由计划文件派生的回执模式（`src/cli.ts:285`）。
- **Schema 迁移可直接复用。** `new Db(dir)` 打开时会在事务内把任意旧版本迁到当前版本（`src/core/db.ts:553`）。`Db.prepare` 是公开方法（`db.ts:964`）。
- **文件布局。**
  - JSONL 登记为源数据目录下的绝对路径 `session_file`（`src/core/store.ts:438`）。启动时按 `_<piSessionId>.jsonl` 修复缺失的登记（`runtime.ts:1253`）。
  - 产物正文是 `<dataDir>/artifacts/<artifactId>.bin`（`src/agent/artifacts.ts:36`）。
  - 历史索引是可重建的派生数据，索引缺失时会重建（`src/core/history-index.ts:8`）。
- **记忆来源检查已经是 fail-closed。** `sourceRefAccessible` 在来源会话或产物行缺失时返回 false（`src/core/access.ts:168`），上下文装配与宿主工具都经过它。来源留在旧实例的记忆即使被复制也不会注入，但目前没有列出它们。
- **与目录或机器绑定的身份。** 工作区根与会话 cwd 保存 realpath + dev/ino。`findProjectByRoot` 用 `root_real` 或 dev/ino 任一匹配（`store.ts:160`），根目录有部分唯一索引（`db.ts:917`）。另一台机器的 dev/ino 可能巧合命中本机目录。
- **配置与凭据分两处。** 项目指令与 Web Search 在 `projects` 行；MCP 服务在 `mcp_services`；Jev 在 meta `jev.project.<id>`（`src/agent/jev-config.ts:24`）。这些只保存绑定名，秘密值在 `<agentDir>/credentials.json`，模型凭据在 `auth.json`，都不在数据库里。QQ/Telegram 配置在 `qq_config` / `telegram_config` 表。
- **实例锁。** 锁目录是 `<dataDir>/runtime.lock/`，用 mkdir 建立，并按 pid 与命令行核实持锁进程（`src/core/instance-lock.ts:139`）。目前只有“获取”，没有不写入的只读探测。CLI 也没有离线打开数据库的命令，数据库只由 Runtime 打开。
- **连接补发有上限。** 补发上限为 5000 条，超出时客户端重取快照（`src/control/server.ts:30`）。

#### 实际缺口

1. 没有跨实例导入。
2. JSONL 路径绑定在源数据目录。
3. 跨机器时目录身份不可信。
4. 凭据绑定指向源 agentDir。
5. 无法核验的记忆没有清单。
6. 无法只读确认源后台已停止。
7. 没有导入账本与回退路径。

#### 默认取舍（推荐即规格，有异议再改）

- **方向与执行方式：目标侧离线 CLI。** 命令只在 ruukoto-code 产品下可用：
  - `ruukoto-code legacy-import preview --from <源数据目录> [--plan <文件>]`
  - `ruukoto-code legacy-import apply --plan <文件>`
  - `ruukoto-code legacy-import revert <导入ID>`
  - `ruukoto-code legacy-import list`

  预览和应用都要求目标后台已停止，CLI 持目标实例锁执行。这样不与运行中的任务、编排器或事件推送交错；导入后由拥有者启动后台，客户端重连取新快照。不走控制面，因为在线导入要处理事件广播与缓存，收益不大。
- **源全程只读。** 先用只读连接（`readOnly: true`）对源库做 `VACUUM INTO`，生成临时快照（mkdtemp，0700，命令结束即删除），再用 `new Db(快照目录)` 把快照迁到当前 schema。之后的读取都基于快照；JSONL 与产物从源目录按需读取。
  - 不在源目录建锁或写入任何文件。新增只读探测 `probeLockHolder(lockDir)`，复用 instance-lock 的持锁核实；源后台存活时拒绝，提示先停止或改用副本。
  - 快照不落进目标目录，避免把整库个人资料复制进开发实例。
  - `VACUUM INTO` 在只读连接上的可用性实施时核实；不可用时改用 `node:sqlite` 的 `backup()`。
- **导入单位用 allow-list，保留原 ID。** 选择单位是源项目，只导入其中的普通 dev 会话；角色绑定会话、QQ 群会话与 main 资料一律排除。ID 是全局随机值，原样保留。这样 JSONL 与产物中的 ID、记忆 sourceRefs、`resultRef` 都不需要重写，符合 ADR 0018“保留原 projectId 作为资料与配置来源”。
  - 目标中已有同 ID 且不属于本源此前导入的行：拒绝，不覆盖。
  - 项目重名：按计划文件改名。
  - `create_request_id`：置空，它是实例内的创建幂等键。
- **各类资料的处理。** 用 `ATTACH` 快照后，在一个事务内执行 `INSERT … SELECT`，显式列出列名。

  | 资料 | 处理 |
  | --- | --- |
  | projects | 导入。根目录在本机严格核实身份一致、且目标没有同根工作区时保留；否则清空根四列成为旧来源项目，原值记入回执 |
  | sessions | 导入。`session_file` 改写为目标 `sessions/` 下的同名文件；`default_access_mode=full_access` 降为 confirm，列入报告；`workspace_project_id` 规则见下一条 |
  | tasks、tool_ops、confirmations、artifacts、selection_records、context_checkpoints | 随会话导入。未终态任务按“不重放”收尾，规则见下文 |
  | events | 导入属于这些会话或任务的事件，按原顺序追加到目标尾部，分配新 seq，正文原样；回执记录 seq 区间 |
  | JSONL、产物正文 | 复制文件并记录 sha256。源文件缺失或损坏时照样导入记录，在报告中如实列出，不生成空历史 |
  | memories、memory_versions | 只导入导入项目中所有版本来源都落在本次导入范围内、或为 owner_note 的项目记忆。personal 记忆只导入计划中显式选中的条目，即拥有者确认的发布，同样受来源规则约束。其余不复制正文，列为待处理，正文仍留在源实例 |
  | data_grants | 两端项目都导入时原样导入（含撤销状态）。一端留在源实例时只在回执中记录授权 ID、方向与类别（标注“跨实例，不生效”），不进 `data_grants` |
  | mcp_services、Jev meta | 导入。目标 `credentials.json` 中缺少对应绑定名时，以 `enabled=0` 导入并列出，由拥有者重新绑定 |
  | SubAgent | 随父会话导入，并按 12 的 `closed_at` 以关闭状态登记，原工作目录不迁移。12 未落地时不导入子会话，列为待处理 |
  | 不导入 | history_index（及其 state）、occupancy、agent_roles、inbound_events、chat_result_acceptances、schedules、schedule_runs、notification_ops、standing_permissions、qq_*、telegram_config、GitHub 归档表、`agent-data/main.db`、meta 中的回执键，以及 agentDir 下全部文件（models/auth/default-model/credentials/skills）；预览只列出名称与差异，不读取凭据值 |

- **工作区映射。**
  - 源会话已映射到工作区 W 且 W 随本次导入并保留根：映射原样保留。
  - W 的根被目标已有工作区 T 占用：改指向 T。这是 07 的组织映射，资料身份仍是原 project_id。
  - W 的根在本机无效：映射置空，列为“用 `project migration-preview` 重新组织”，即导入后复用 07 的工具。
  - 会话 cwd 在本机无效：记录照常导入，标为“仅可查阅”，继续执行仍由既有目录身份检查拒绝。
- **不重放的规则。**
  - queued 任务：改为 canceled（`error_message` 标注 migration，未重放）。
  - running / awaiting_confirmation 任务：改为 interrupted（原因 migration）。结果未登记的工具操作与该任务置 `effect_unknown=1`。
  - 状态为 pending，或已批准但未消费的审批：改为 stale。
  - 会话默认不入队，目标启动后没有可运行的旧任务。
- **幂等与续跑。**
  - 回执与条目账本用新增的两张表（加法迁移）：
    - `instance_imports`：id、请求键、源实例 ID/产品/schema、计划摘要、目标备份路径与 sha256、事件 seq 区间、报告 JSON、状态 applied/reverted、时间。
    - `instance_import_items`：import_id、kind ∈ project/session/memory/grant/mcp/meta/file、item_id，主键为 (kind, item_id)。
  - 修订值是导入集合（行 ID 与关键状态、文件 sha256）加上目标冲突状态的规范化哈希。源或目标在预览后变化，应用即报 `revision_conflict`。
  - 应用流程：
    1. 先查回执，同键同参返回原结果，同键异参报冲突。
    2. 对目标库做 `VACUUM INTO` 备份到 `<dataDir>/migration/<导入ID>/target-before.db`，这就是“核对备份”。
    3. 复制文件：先写临时名再 rename；目标已有同 sha 的文件则跳过，sha 不同则拒绝。
    4. 单事务插入全部行、账本与回执。
  - 中断发生在第 4 步之前：用同一计划重跑即可。发生在之后：重跑返回回执。已导入项按账本识别为“已导入”。导入后源侧新增的活动只在报告中列出，不做增量同步。
- **回退与“核对备份”。** `revert` 按账本删除导入的行、事件区间与经 sha 核对的复制文件，回执保留并标为 reverted。
  - 以下任一情况拒绝回退并逐项列出：导入的会话在导入后有新任务或新事件；导入的项目有新会话、新授权或工作区引用；导入的记忆有新版本。这些活动是目标侧的事实，不能抹掉。
  - 整库恢复保留为手工路径：停止后台后用 `target-before.db` 恢复，写进运行文档。
  - 任何情况下都不删除或修改源资料。
- **与 ADR 的关系。** 与 ADR 0017 不冲突：开发历史迁入开发产品属于迁移，不是跨端同步；personal 记忆只导入显式选中的条目，对应“明确选定”。与 ADR 0018 一致：保留原 ID 与来源身份，组织归属只用于展示。
- **与 22、23 的边界。**
  - 22 负责 main 会话、应用数据、调度、平台绑定、coding/chat 历史、长期授权，以及个人侧引用开发历史的记忆。可复用本单的快照与 ATTACH 骨架，但本单不为 22 预先抽象。
  - 23 负责移除 ruukoto 中旧开发会话的写入口。本单不改源实例，导入后源中的开发会话仍可被继续使用；预览会报告导入后源侧的新增活动，运行文档建议不再在旧实例继续这些会话。

#### 实施步骤

1. **存储与只读探测。**
   - `src/core/db.ts`：新增两张表（SCHEMA_SQL、迁移注释、版本号实施时核实）。
   - `src/core/instance-lock.ts`：导出 `probeLockHolder`（只读，不建锁、不接管）。
   - `src/core/types.ts`：回执类型。不新增事件类型，回执行本身就是审计记录，避免协议与 TUI 改动。
2. **集中模块 `src/runtime/legacy-import.ts`。** 预览、应用、回退的全部判断都在这里，CLI 只做接线，与 07 的 `workspace-migration.ts` 同构。
   - 快照：只读 `VACUUM INTO` 到 mkdtemp，再 `new Db` 迁移。
   - 校验：源 `product.type` 必须为 ruukoto 或未登记；源后台不能存活；目标 `product.type` 必须为 ruukoto-code 或未登记（未登记时补记）；快照 `PRAGMA integrity_check` 通过。
   - 预览输出：
     - 源/目标实例 ID、产品、schema、路径；目标是否为空、已有项目数与此前导入；
     - 每个项目：会话归属（普通 / 角色 / 群 / 子会话）、工作区与根在本机的核实结果、历史状态（`historyStatusOf`）、产物文件缺失、未终态任务及收尾方式、待处理审批；
     - 记忆分为可导入与待处理（附原因）、授权分为导入与跨实例记录、凭据绑定缺口、agentDir 差异（只列名称）、重名与 ID 冲突、导入后源侧新增；
     - 修订值。
   - 应用：按上一节流程执行，`ATTACH` 必须在事务外完成。
   - 一张 `TABLE_POLICY` 表登记每张表“导入 / 排除 + 理由”。导入前核对目标库的全部表都已登记、两库列集合相同，否则拒绝，避免新表默认被漏判或被复制。
3. **CLI**（`src/cli.ts`）。增加 `legacy-import` 子命令：产品不是 ruukoto-code 时拒绝；复用 `defaultDirs()` 与 `--data-dir`；持 `acquireInstanceLock(目标数据目录)`。`preview --plan` 把修订值写回计划文件（07 的做法）；`apply` 的请求键由计划文件内容派生。结构化 JSON 输出到 stdout。
4. **文档。**
   - `docs/runtime.md`：数据布局一节增加旧实例导入的流程、导入与排除范围、回退和整库恢复。
   - `CONTEXT.md`：如需要，补“实例导入”词条。
   - 新增短 ADR（编号实施时核实）：跨实例导入保留原 ID、allow-list、源只读、目标离线；关联 ADR 0017/0018。ADR 0017 实施记录加一行。

不做：在线或控制面导入、TUI/配置中心入口、增量同步、导入 agentDir 配置与凭据、跨实例授权生效、为 22 抽象通用迁移框架、清理未提交复制文件的专门命令（重跑会覆盖；孤儿文件不被任何记录引用，启动修复只认已登记会话）。

#### 验证与验收

新增 `test/<NN>-legacy-instance-import.test.ts`，编号实施时核实，避开 12 计划的 81 及其他并行计划。

**测试源实例的构造。** 用 testkit 以 ruukoto 产品建源实例，模型打桩，内容覆盖：

- main、coding、chat 角色会话与 QQ 群会话；
- 两个普通 dev 项目，其中一个混有角色会话，并有 07 的工作区映射；
- 已完成、失败、queued、running 与待审批的任务；
- 产物，包括 prompt-snapshot；
- 记忆：来源全部在 dev 范围、引用 main 历史、owner_note、personal 各一类；
- 授权：双端都在 dev 范围、跨到 main 项目各一条；
- 带凭据的 MCP 与 Jev；
- QQ/Telegram 配置、调度、长期授权；
- 一个 v20 旧库 fixture（沿用 test/76 的做法）。

源实例停止后导入到 ruukoto-code 临时目录。各项验收对应的检查：

1. **预览与不覆盖。**
   - 预览内容完整、目标数据零写入。
   - 源目录前后逐文件 sha256 不变（含 v20 旧库只在快照上迁移）。
   - 源后台存活时拒绝；产品错配时拒绝（目标是 ruukoto 目录，或源是 ruukoto-code 目录）。
   - 目标已有数据时：同 ID 冲突、文件 sha 冲突、重名未改名均拒绝且零写入；按计划改名后可以导入。
   - 目标备份存在且 sha256 与回执一致。
2. **资料可定位，映射保留。** 启动目标后台后：
   - 导入会话的 `read_history` 与源 JSONL 字节一致；`read_artifact` 与正文一致；任务、审批、工具操作、选择记录逐项一致；事件按顺序完整。
   - 原工作区映射保留；同根时指向目标工作区；无效根时置空并在导入后由 07 预览接手。
   - 用原项目指令与工具配置在有效 cwd 中新建任务可以执行；cwd 无效的会话明确拒绝执行。
   - 历史缺失或损坏如实报告。
3. **跨实例来源。**
   - 引用 main 的记忆不导入，并列入待处理。
   - 跨实例授权只出现在回执中，`data_grants` 中没有。
   - 未选中的 personal 记忆不导入；选中后可导入。
   - 选择记录证明导入的记忆按来源规则注入。
   - 目标 `credentials.json`、`auth.json` 与 qq/telegram 表为空或保持不变；缺少凭据的 MCP 与 Jev 处于停用状态。
   - `TABLE_POLICY` 覆盖全部表（新表未登记时测试失败）。
4. **中断、续跑、回退。**
   - 复制文件之后、事务之前注入故障：同一计划重跑成功，且没有重复的行或文件。
   - 事务进行中、部分 SQL 已执行时注入故障：整体回滚。
   - 成功后同键重放返回回执；同键异参报冲突。
   - 源或目标变化后报 `revision_conflict`。
   - 分两批导入时，已导入项识别正确。
   - `revert`：无导入后活动时，行、事件区间与文件都被移除，回执标为 reverted，源不变；有导入后活动时拒绝并列出阻挡项。
   - 跨进程重启后仍能核实回执。
5. **不重放。**
   - 目标启动后模型请求为零：queued 任务已 canceled，running 任务已 interrupted 且 `effect_unknown=1`。
   - stale 审批无法再批准；`full_access` 已降为 confirm。
   - 目标侧没有入站、调度或通知记录。

```bash
npx tsx --test test/<NN>-legacy-instance-import.test.ts test/76-legacy-workspace-data.test.ts test/71-product-entry.test.ts test/09-artifacts.test.ts test/11-history-read.test.ts test/16-*.test.ts test/75-workspace-settings.test.ts test/29-cli-entry.test.ts
npm run typecheck
npx tsx --test test/67-visual-docs.test.ts
npm test   # nohup + 退出码文件，跑时不改 src/test
```

**冒烟脚本（模拟模型、真实进程）。** 新增 `.scratch/agent-direction/smoke-21-migrate-coding-instance.mts`，使用真实 `bin/ruukoto.mjs` 与 `bin/ruukoto-code.mjs`、socket、SQLite、JSONL 和产物文件，模型打桩。流程：用 ruukoto 造源数据 → 停止 → `legacy-import preview/apply` → 启动 ruukoto-code → CLI 读取历史与产物 → 重启 → `revert` → 源哈希不变。macOS 本机与 `ssh tx` 的 `/tmp` 隔离目录各跑一轮，跑完清理。

**真实代表性数据演练。** 使用本机 `~/.ruukoto/data`：以只读方式作为源，导入到临时 ruukoto-code 档案（`RUUKOTO_CODE_*_DIR` 指向临时目录）。依次执行预览、应用、启动并查阅若干会话的历史与产物、回退，前后核对源目录哈希树。实施时先核实本机普通 dev 会话的规模；不足以代表时，用 tx 旧实例的副本。读取 `/var/lib/ruukoto` 需要 `sudo -u ruukoto-backend`，必须先征得拥有者同意；不同意则在记录中写明“tx 真实数据未实测”。模型在演练中打桩或不调用，分开记录。

**文档同步。** 对每个改动的 `src/` 文件执行 `grep -l <路径> docs/visual/*.html`，预计命中 storage-layout（新表、导入回执、`migration/` 目录）、deployment（cli.ts、instance-lock）、index（db.ts），同步后跑 test/67。

完成时逐条登记六项验收证据，区分离线逻辑测试、真实进程冒烟（模拟模型）、本机真实数据演练与 tx 副本演练。本次只保存计划，工单状态与验收勾选保持不变。

### 2026-10-04：实施完成（schema v28，ADR 0022）

按 2026-10-03 计划实施并交付。当前核心库 v27 → v28（新增 `instance_imports` / `instance_import_items`）；决策记录新增 [ADR 0022](../../../docs/adr/0022-legacy-instance-import.md)，ADR 0017 实施记录已加行。

**交付物**：`src/core/db.ts`（v28 两表）、`src/core/instance-lock.ts`（`probeLockHolder` 只读探测）、`src/core/types.ts`（回执类型）、`src/runtime/legacy-import.ts`（预览/应用/回退/列表全部逻辑与 TABLE_POLICY）、`src/cli.ts` + `src/cli-entry.ts`（`legacy-import` 子命令，仅 ruukoto-code）、`test/85-legacy-instance-import.test.ts`（7 项子测试）、`.scratch/agent-direction/smoke-21-migrate-coding-instance.mts`、`docs/runtime.md`（数据布局 + 迁入节）、`CONTEXT.md`（实例导入词条）、`docs/visual/`（storage-layout 新增实例导入小节与账本两表、deployment 锁探测与命令、index 卡片）。

**与计划的实施差异（均已记录于 ADR 0022）**：
- 源快照改为逐文件复制 `ruukoto.db`+WAL 侧车到临时目录后迁移：实测只读连接 `VACUUM INTO` 会在源目录生成 `-shm/-wal` 侧车写入，复制是唯一零接触方式。
- 目标写入用单事务逐行 INSERT（替代 ATTACH + INSERT…SELECT）：同等原子性与逐字节忠实，收尾/降级/路径改写等转换在类型化代码中完成。
- effect_unknown 口径与运行时恢复一致：结果未登记且可能已开始执行的操作才置 1；被未消费审批挡住的操作属「已知未执行」不置（CONTEXT.md 效果未知定义）。
- 审查后加强：修订值改为每行整行规范化哈希 + 文件 sha256（源任何行内容变化都会触发 `revision_conflict`）；回退阻挡项时间比较用 `>=` 收口同一毫秒；renames 指向不存在/不导入项目的键报错而非静默忽略。
- 账本文件条目含续跑归属规则：故障重跑时已复制文件（sha 相同跳过复制）仍归本次导入，回退经核对后可移除。

**验证证据（区分模拟与真实）**：

| 验收 | 离线逻辑测试（模拟模型） | 真实进程冒烟（模拟模型） | 真实数据演练 |
| --- | --- | --- | --- |
| 1 预览/不覆盖 | test/85 子测试 1/2/6：预览完整、目标零写入、源 sha 不变、存活/错配拒绝、重名/ID/文件冲突零写入、改名通过、备份存在且 sha 一致 | smoke-21 场景 2/3：目标零写入、修订写回、回执+备份 sha、重放幂等 | ~/.ruukoto v11 真实实例预览/应用：备份 sha 一致、同键重放 |
| 2 资料可定位/映射保留 | 子测试 3：历史/产物字节一致、任务/审批/工具操作/选择记录/事件正文逐项一致、组织映射保留、有效 cwd 可执行、失效 cwd 拒绝 | smoke-21 场景 4/5：read_history、产物字节、授权方向、重启后仍可读 | 目标后台启动后 status/history-search/read-artifact 可读；49 个复制文件与源逐字节一致 |
| 3 跨实例来源 | 子测试 5：引用 main 记忆列待处理不注入、personal 未选中不导入/选中可导入、跨实例授权仅回执、MCP/Jev 缺凭据停用、目标凭据为空、选择记录证明注入规则；TABLE_POLICY 全表登记核对 | —（测试覆盖） | 真实源无个人记忆/授权，结构核对以测试为准 |
| 4 中断/续跑/回退 | 子测试 6：复制后故障同计划重跑无重复、事务内故障整体回滚、同键重放/异参 request_conflict、revision_conflict、两批导入识别、阻挡项逐项列出、干净回退行/事件/文件移除且源不变、跨进程核实回执 | smoke-21 场景 6a/6b：导入后新任务阻挡回退（blockers 列出）、第二目标干净回退、源哈希树不变 | 真实实例回退：行/事件/49 文件全移除、回执 reverted、源 52 文件哈希树前后不变 |
| 5 不重放 | 子测试 3：目标启动模型请求为零、queued→canceled、running→interrupted 且 effect_unknown、审批 stale 不可再批准、full_access 降 confirm、无入站/调度/通知 | —（测试覆盖） | — |
| 6 端到端/类型/图解 | test/85 7/7；定向回归 123/123（85/76/71/09/11/16/75/29/67）；全量 npm test 918/919（唯一失败 test/32 为 worktree 目录名导致的既有环境问题，stash 改动后同样失败；test/81 曾在与另一并行测试套件同跑时偶发失败一次，隔离运行 9/9 通过）；`npm run typecheck` 绿；test/67 图解 4/4 | smoke-21：macOS darwin-arm64 7/7 + tx（Linux x64）7/7 | 演练机型 macOS（darwin arm64，Node v24.15） |

**冒烟与演练环境**：模型层打桩（MockModelServer / 不可达 stub，演练中不调用模型）；其余全真（bin 进程、socket、SQLite、JSONL、产物、实例锁）。tx 真实数据未实测：`/var/lib/ruukoto` 需 `sudo -u ruukoto-backend` 读取，按计划未征得拥有者同意不触碰，记录于此；本机 `~/.ruukoto/data`（schema v11，4 项目/13 会话/26 任务/374 事件/40 产物）已作为代表性真实数据完成预览→应用→启动查阅→回退全流程。

**code-review（两轴）**：Standards 轴无硬性违规（复用 canonicalJson/sha256/historyStatusOf 与锁原语、账本全表登记获肯定）。Spec 轴处置：事件正文逐字节核对已补入测试 3；修订整行哈希、`>=` 阻挡边界、renames 校验均已修；effect_unknown 任务级口径保留（与运行时恢复一致，ADR 0022 §5 写明）；续跑文件归属的「唯一归属」灰区保留并已在代码注释说明（revert 删除自己账本且 sha 相符的文件，孤儿文件被后续导入认领后随其回退移除，语义自洽）。

**过程中修复**：账本插入顺序（FK 要求回执先行）、测试夹具（角色会话复用启动登记、平台表 NOT NULL 列、在途任务改为停库后写入）、修订含文件 skip 标志导致续跑不可能（已剔除，冲突检测在应用期仍生效）。
