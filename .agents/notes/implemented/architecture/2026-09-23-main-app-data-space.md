# Agent Note: main 应用数据空间：独立库、受控工具与破坏性确认例外

Status: implemented

原编号：ADR 0009

## 问题

main 角色（日常助手）需要按需建立待办、提醒、习惯等个人数据结构。按 [daily-agent 规格](../../../../.scratch/daily-agent/spec.md)第 8、9 项，这类领域数据不预建固定业务表，由 main 在独立的应用数据空间中自己声明表和字段，并经宿主提供的受控工具管理 schema 与数据；非破坏性变更自动执行，删表、删字段和批量迁移需要确认，所有变更留来源与版本记录。

这些数据是 main 自己声明的业务数据，既不属于后台运行时元数据，也不属于长期记忆（偏好、约定、决策、经验）。核心 `ruukoto.db` 保存任务、审批、事件与凭据绑定，不能向模型开放 schema 变更。没有独立存储与受控入口，模型要么能触及核心表，要么只能把结构化数据放进会话历史或长期记忆；删表、删字段、批量重写这类不可逆操作也没有确认关口。

## 决定

1. **独立应用库。** 应用数据存放在 `<dataDir>/agent-data/main.db`（node:sqlite；写连接设 WAL、`synchronous=FULL` 与外键约束），由 Runtime 管理打开、恢复与关闭。目录以 0700 创建，位于 `protectedRoots()` 的数据目录范围内。首次建立后，把应用库的稳定实例 ID 登记到核心库 `meta` 表（键 `app_data.main_instance_id`）；启动恢复先核对文件存在与实例身份。已登记但文件丢失、身份不符或损坏时，不自动创建空库、不覆盖既有实例绑定，应用数据能力停止并留下 `app_data.unavailable` 事件。两库没有共同事务，不使用 `ATTACH` 拼接。代码在 `packages/agent/src/app-data/store.ts` 与 `packages/runtime/src/runtime.ts` 的 `initAppData`。
2. **六个受控工具。** `app_data_define_table / migrate / query / insert / update / delete`，只在 main 角色的会话装配。工具类别 `ToolCategory` 含 `app_data`，只有 main 的会话类别清单列入它（`packages/agent/src/tool-availability.ts`）；装配、激活、发送前检查与调用门共用同一结论，执行入口每次重新核实宿主任务、会话、项目与 main 角色绑定。应用库不可用时不装配这六个工具。名称、类型、大小、关系与版本校验在存储边界执行，工具 JSON schema 只作输入提示，不代替执行时校验；SQL 标识符只来自已验证目录（仍统一引用），数据值全部绑定参数。
3. **版本与审计。** 存储格式版本（宿主维护，当前为 1）独立于 main 管理的 `schema_version` 与每次变更递增的 `revision`。所有写入在单事务内提交业务/schema 变更、版本递增与追加审计回执（`hostOpId` 唯一）；审计失败、约束失败或磁盘写入失败必须回滚业务变更，不为继续服务而丢弃审计。同一操作重复执行先查回执：同参数返回原结果，异参数报冲突。
4. **破坏性操作确认。** 删表、删字段、删唯一索引、多行写与批量重写进入统一审批桥：审批闸门（`packages/agent/src/approval-gate.ts`，经 `Store.consumeApproval` 消费）、控制面 `respond_confirmation` 与 TUI 待审批界面，不另建审批队列。审批范围 `ApprovalScope.kind = app_data_change` 固定应用库实例身份、任务与操作 ID、表与操作类别（`drop_table / drop_field / drop_unique_index / multi_row_write / rewrite_rows`）、schema/revision、规范化参数摘要、受影响数量与行 ID、行版本；schema 操作另固定旧定义与新定义。批准后重新核实 main 身份、任务状态、权限版本与应用数据版本，任何变化都使原批准失效，批准不能扩大到新出现的行；批准单次消费，执行参数取自批准记录的不可变快照。
5. **full_access 例外。** 完全访问模式的任务也不免除破坏性应用数据确认。这是相对[显式访问模式](../feature/2026-09-19-explicit-access-modes.md)「完全访问无需逐次确认」的特定例外：应用数据是 main 的个人结构化数据，删表、删字段、批量重写的破坏面独立于任务执行权限，daily-agent 规格第 9 项明确要求逐次确认。代码不走 MCP 写工具的 full_access 放行分支。[自动审查模式](../feature/2026-09-22-auto-review-mode.md)对此范围直接转拥有者：`classifyForReview`（`packages/agent/src/review.ts`）不覆盖 `app_data_change`，默认即转人工，不调用审查模型。
6. **有界查询与只读子进程。** 首版不开放任意 SQL、JOIN 或聚合，按 `_id` 主键游标分页，AND 条件限标量比较、空值检查与有限集合匹配。返回行数（默认 50、硬上限 100）、结果（64 KiB）、候选扫描（1,000 行 / 1 MiB）与总时限（2 秒）都是宿主常量（`QUERY_LIMITS`、`QUERY_TIMEOUT_MS`，`packages/agent/src/app-data/query.ts`）。每次查询启动固定入口的只读子进程（`node --import tsx query-child.ts`，以 `process.execPath` 启动），超时 SIGKILL 并等待退出；子进程只做只读查询，写事务全部留在宿主。该子进程用于真实终止超时计算，不构成完整的操作系统权限沙箱。
7. **双库恢复。** 恢复在通用未知效果判断之前，按应用库回执核实未落结果的应用数据写操作：有回执补记已提交结果；批准已消费但无回执、且应用库可核实时记未提交；应用库丢失、损坏或无法核实时保留 `effect_unknown`。只读查询不产生写入效果，不适用这条规则。重启只补记结果与事件，不自动重放修改。

   这条规则是工具操作账本（`packages/agent/src/tool-op-ledger.ts`）里应用数据族的核实：`appDataOpCheck`（`packages/agent/src/app-data/tools.ts`）按宿主操作 ID 查 `app_audit` 回执，停止与重启共用同一个分类器。分类顺序为：审批全部未消费 → 已知未执行；`app_data_query` 归无写入效果，结果缺失时记为只读操作中止，不标 `effect_unknown`；其余写操作按回执得出已提交、已知未提交或效果未知。扫描覆盖全部任务，包括已进入终态但结果缺失的操作；核心结果写入失败时立即按操作 ID 核实补记，补记再失败就留给重启恢复。补记沿用 `tool_ops` 条件更新，事件在同一核心事务中写入，重复恢复不重复发布。

## 存储格式与校验规则

- **宿主表。** 应用库内三张宿主表：`app_meta`（存储格式版本、`schema_version`、`revision` 与实例 ID）、`app_tables`（main 声明的业务表目录：字段、索引、创建与更新时的 revision）、`app_audit`（审计回执，`op_id` 唯一，取值就是核心库 `tool_ops` 的宿主操作 ID）。回执记录任务、会话、agent、schema 版本、revision、时间、理由、规范化操作、受影响范围与有界结果摘要，身份与时间由宿主填写；schema 变更另存前后定义（`definitions` 列）。业务表只由宿主按已校验目录创建；内部元表不是可自由查询或写入的业务表。
- **既有库不重建。** 打开时区分首次初始化与既有库验证：既有库缺 `app_tables`、`app_audit` 或存储格式版本记录即报 `storage_corrupt`，能力停止，不重建、不清空。新建一张空审计表会被恢复误当作「旧操作未提交」的证据。存储格式版本高于程序支持时报 `storage_version_too_new`。
- **首次初始化可续。** 首次初始化在「建库后、登记前」崩溃可恢复：核心库尚无登记时，下次启动打开已有文件并按它自身的实例 ID 补登记；已有登记时绝不覆盖。
- **名称与类型。** 名称限 `[a-z][a-z0-9_]{0,47}`，拒绝 `sqlite_`、`app_` 前缀、内部字段保留名（`_id`、`_version`）与重复名称。字段类型限 `text / integer / real / boolean / json / datetime`，由宿主在写入前校验与编码；整数限 JavaScript 安全整数，浮点数必须有限，datetime 校验后统一为 UTC ISO，JSON 必须可序列化并受字节与嵌套深度限制；缺省、空值与类型错误分别处理，不依赖 SQLite 自动类型转换。
- **行身份与关系。** 每表固定宿主维护的 `_id`（单调、不复用的整数主键）与 `_version`（行版本）。关系只能指向同一应用空间中已登记表的 `_id`；外键固定 `ON DELETE RESTRICT ON UPDATE RESTRICT`，禁止级联写入，删除被引用对象前必须显式处理关系。
- **索引。** 普通索引与唯一索引只能引用存在的标量字段，不支持表达式或部分索引。增加索引遇到重复数据等约束错误时整次回滚。删除普通索引自动执行，删除唯一索引按削弱数据约束的破坏性操作确认。
- **工具契约。** 所有写入带非空 `reason`。`app_data_define_table` 携带 `expected_schema_version`，表已存在时报冲突，不用 `IF NOT EXISTS` 掩盖不同定义。`app_data_migrate` 携带预期版本与有界的结构化步骤：`add_field`（只允许可空字段）、`add_index`、`drop_index`、`drop_field`、`drop_table`、`rewrite_rows`（按明确行 ID 与预期行版本重写字段值）；整次调用在一个事务内完成，只递增一次 revision；任意 SQL、脚本转换、隐式类型转换与任意表达式不受理。`app_data_insert` 按声明的 schema 原子插入，返回宿主分配的行 ID、行版本与数据库版本，非法行整批拒绝。`app_data_update` 与 `app_data_delete` 要求明确行 ID 与预期行版本，不接受无条件全表写入。insert、update、delete 可带 `expected_schema_version`，提供时校验。
- **自动与确认的划分。** 创建表、增加可空字段、增加索引、删除普通索引、受限插入与带版本的单行更新/删除自动执行。多行更新/删除与批量重写（含经 `migrate` 提交的 `rewrite_rows`）进入确认，与第 4 条的其余破坏性操作同属 `app_data_change`；混合迁移只要含一项破坏性操作（多表迁移中的删唯一索引也算），整次确认后执行。拒绝、取消、模式切换、批准失效与后台重启都不执行旧请求；确认期间不持有应用库事务或写锁。
- **版本冲突。** 写入在事务内检查预期 schema 版本，更新和删除再检查行版本，破坏性操作在批准后再核对请求时的 schema 版本与 revision。版本不一致返回可识别的冲突与当前版本，不自动覆盖，也不在后台重算后重试。成功的 schema 操作递增 schema 版本，有实际变更的事务递增 revision，失败不推进版本。
- **上限。** `LIMITS`（`packages/agent/src/app-data/store.ts`）集中定义宿主常量，模型不可调大：64 张业务表、每表 32 个业务字段、8 个索引、每索引 4 个字段、每表 10,000 行；单字段 16 KiB、单行 32 KiB（update 与 `rewrite_rows` 检查与旧值合并后的整行）、单次写入参数 64 KiB、100 行或 16 个迁移步骤；理由最多 1 KiB。按 UTF-8/JSON 实际字节检查，超限不执行，业务、行版本、revision 与审计都不推进。

## 查询契约

- **三种模式。** `app_data_query` 的 `mode` 为 `schema`、`rows` 或 `changes`。`schema` 分页发现表，或读取单表定义、索引、关系与当前版本，重启后不依赖会话记忆即可恢复结构；`rows` 查询业务数据；`changes` 分页查阅审计记录，或按 `op_id` 核实某次操作的提交结果。三种模式都分页并遵守返回字节上限。
- **候选窗口。** `rows` 可选择投影字段与 AND 条件，运算符为 `eq / ne / lt / lte / gt / gte / is_null / not_null / in`（`in` 最多 100 个值），按 `_id` 排序。先按 `_id > cursor` 逐行读取候选（`iterate()` 逐行累计大小，不先 `.all()` 收集），再在窗口内过滤与投影；单页的版本读取与行扫描在同一只读事务内。
- **游标。** 结果带 `scanned / complete / next_cursor / schema_version / revision`。游标绑定表、查询参数摘要与版本，跨页数据变化返回游标冲突，调用方重新查询。候选预算或行数上限截断时，游标推进到最后已处理的候选，连续的空窗口页也能前进；结果字节预算截断而有已匹配未返回的行时，游标停在最后已返回位置，未返回的行留给下一页。单条投影记录超过 64 KiB 时拒绝（`record_too_large`），要求缩小投影，避免空页死循环。请求显式超过限额时拒绝；合法分页耗尽预算时返回 `complete=false`，不把部分结果说成完整结果。
- **子进程边界。** 子进程入口是 `packages/agent/src/app-data/query-child.ts`，只读打开 `main.db`；宿主传入已验证的结构化参数，子进程再次校验。子进程环境只留 `PATH` 与库路径，不传 owner token、模型凭据或核心库句柄，IPC 请求、响应与错误输出都有界。2 秒总时限覆盖子进程启动、执行与结果收集；超时或任务取消后终止子进程并等待退出再返回错误；关闭 Runtime 时回收在途查询。

## 事件、分工与相关决定

- **写入时序。** 核心库先记工具意图，必要时消费批准，应用库再提交业务变更与回执，核心库最后记工具结果与事件。两库不宣称原子提交，中间窗口由第 7 条的回执核实覆盖。应用库已提交而核心结果写入失败时，按操作 ID 保留真实状态，不报成「未执行」，也不自动再次写入。
- **事件。** 正常执行与拒绝都留下 `task.tool_intent` / `task.tool_result`。身份不符、校验失败、预算超限与超时另留 `app_data.rejected` 事件，只记来源（`identity / validation / budget / timeout`）、工具名与错误码，不把超长输入或整条个人数据复制进事件正文。
- **与长期记忆分工。** 应用数据保存待办、提醒、习惯等结构化记录；偏好、约定、决策、经验继续进入长期记忆（MemoryStore），工具描述写明这一分工。应用记录不自动提升为长期记忆或控制指令。
- **调度器读取。** 调度器以带应用库实例 ID 的行字段引用（`app_data:<实例 ID>/<表>#<行>.<字段>`）读取应用记录作为通知正文来源，不为调度预建业务表，见[调度器与通知 outbox](2026-09-24-scheduler-outbox.md)。
- **实例导入。** 应用数据按文件整体迁移：`agent-data/main.db`（连同 WAL）经 sha256 核对复制，核心库的 `app_data.main_instance_id` 绑定随行，见[个人实例导入](2026-10-05-personal-instance-import.md)。

## 备选方案

- **预建 `todos`、`reminders`、`habits` 等固定业务表** — 结构由宿主预先确定，校验、迁移与调度器对接都只需针对已知字段，不必向模型开放动态 schema。不选，是因为需求访谈 Q6 定为由 main 自主决定领域数据是否结构化及其 schema；调度器以带版本的应用记录引用对接，按实际读取需求扩展窄接口，不提前增加固定业务字段。（见 daily-agent spec 第 8 项与 2026-09-22 Comments，[daily-agent issue 02](../../../../.scratch/daily-agent/issues/02-main-data.md) 实施计划末段）
- **在核心 `ruukoto.db` 内划出等效 namespace** — 工单把「独立应用数据数据库或等效 namespace」并列为可选形态；放进核心库，业务写入就能与核心库的工具意图、结果记录同事务提交，不需要双库恢复。不选，是因为核心库保存任务、审批、事件与凭据绑定，不能向模型开放 schema 变更，核心 schema 也不应随业务数据演进；独立库让核心表对应用数据工具不可达，代价是第 7 条的双库恢复。（见 daily-agent issue 02「实现范围」与实施计划第 1 步）
- **用核心 `Db` 类打开应用库（`new Db(dataDir, "main.db")`）** — 能复用现成的连接设置（WAL、`synchronous=FULL`、外键）与 schema 迁移框架。不选，是因为 `packages/core/src/db.ts` 的 `Db` 构造器会执行完整的核心 schema 与迁移；应用库直接用 `DatabaseSync` 打开，连接不开启扩展加载，不接受模型提供的数据库路径或 SQL。（见 daily-agent issue 02 实施计划第 1 步）
- **`ATTACH ruukoto.db` 拼接两库** — 两库在同一连接内可见，一个事务就能同时写应用数据和核心库的操作记录。不选，是因为应用数据连接必须触及不到核心任务、审批、事件与凭据表；两库不宣称原子提交，改为按「事件、分工与相关决定」中的写入时序分步提交，未落结果的操作按回执恢复。（见原决定第 1 条，daily-agent issue 02 实施计划第 5 步）
- **同进程 `Promise.race` 或 `DatabaseSync` 的 `timeout` 作查询截止** — 不用启动子进程，查询没有毫秒级的额外开销。不选，是因为项目最低支持 Node 22.19，其 `DatabaseSync` 同步执行，`timeout` 只是数据库锁等待上限，`Promise.race` 终止不了执行中的查询；也不依赖较新 Node 才有的 SQLite API。改为每次查询启动只读子进程，超时 SIGKILL。（见 daily-agent issue 02 实施计划第 3 步）
- **开放任意 SQL、JOIN、子查询、聚合或通用查询优化器** — main 能直接表达任何查询，不受结构化条件与逐页游标的限制。不选，是因为首版要兑现扫描、结果与耗时预算，任意 SQL 无法预先界定扫描范围，SQL 标识符也必须只来自已验证目录；已声明的索引用于约束与后续真实需求，不另写通用查询优化器。（见原决定第 6 条，daily-agent issue 02 实施计划第 3 步）
- **用 `SELECT ... WHERE <任意条件> LIMIT N` 当扫描上限** — 一条语句交给 SQLite 过滤，代码最简单。不选，是因为 `LIMIT` 限的是返回行数，命中很少时仍可能扫描整表；改为先按 `_id > cursor` 读取固定候选窗口，再在窗口内过滤与投影。（见 daily-agent issue 02 实施计划第 3 步）
- **外键级联写入** — 删除被引用行时自动清理依赖行，main 不必先显式处理关系。不选，是因为一次单行删除会隐式变成批量删除，绕开多行写的确认；外键固定 `RESTRICT`。（见 daily-agent issue 02 实施计划第 2 步）
- **完全访问沿用「无需逐次确认」，照搬 MCP 写工具的 full_access 放行分支** — 与显式访问模式的通用语义一致，完全访问任务不会被确认打断。不选，是因为删表、删字段、批量重写的破坏面独立于任务执行权限，daily-agent 规格第 9 项明确要求逐次确认。（见原决定第 5 条，daily-agent issue 02 实施计划第 4 步）
- **把主会话历史当作待办、提醒和习惯的唯一数据库** — 不需要新存储，main 在对话里记下即可。不选，是因为 main 的 JSONL 会话用于连续对话，结构化业务数据与它的结构要能在重启后不依赖会话记忆恢复，所以放进应用数据空间。（见 daily-agent spec「运行模型」与「明确不做」，daily-agent issue 02 实施计划第 2 步）

## 后果

- **收益**：核心库 schema 不因业务数据演进；应用库格式版本独立演进，过新或损坏时明确停止，不重建、不清空旧库。
- **收益**：核心任务、审批、事件与凭据表对应用数据工具不可达。coding/chat/QQ 会话与普通开发会话默认无法访问应用数据；其中 coding/chat 角色会话与 QQ 群会话已退役为不运行任务的归档（见[两个 Agent 产品](2026-10-02-two-agent-products.md)与[退役核心群聊](../simplification/2026-10-02-retire-core-group-chat.md)），main 的 SubAgent 任务按只读白名单装配，同样没有这些工具。资料授权、grantedPaths 与完全访问模式不扩大应用数据 API 范围。
- **收益**：每次写入都有同事务的审计回执，后台崩溃、停止或核心结果写入失败后能按操作 ID 判定是否已提交，不重放修改。
- **代价**：查询延迟包含子进程启动开销（毫秒级），换取可终止的查询截止。
- **代价**：两库没有共同事务。应用库已提交而核心结果未落盘的窗口靠回执补记；应用库丢失、损坏或身份不符时，未落结果的写操作只能保留 `effect_unknown`，应用数据能力停止，不自动重建空库。
- **代价**：完全访问任务遇到破坏性应用数据操作也要停下等拥有者确认。
- **已知上限**：首版查询没有任意 SQL、JOIN 与聚合，大表只能按游标多页读取，每页最多检查 1,000 个候选行；表数、字段数、行数等上限是宿主常量，超出即拒绝写入。
- **已知上限**：只读子进程不是操作系统权限沙箱；应用数据 API 的访问控制也不等于文件隔离。`main.db` 文件本身靠数据目录保护根与[工具工作进程与按任务容器](2026-09-20-tool-worker-per-task-container.md)的执行边界隔离，local 后端不能作为跨账户隔离的验证依据。

## 验证

`test/28-main-data.test.ts` 经真实存储、查询子进程与 Runtime 路径覆盖：跨重启读写与实例绑定、版本冲突、RESTRICT、原子回滚、`hostOpId` 幂等、恶意名称与超限、稀疏命中分页与游标推进、子进程超时真实终止、只有 main 获得工具与伪造身份不执行、三种权限模式下的破坏性确认、确认期间版本变化使批准失效、核心表与内部元表不可达、审计失败回滚、停止与恢复按回执补记、应用库丢失/损坏/身份不符、既有库缺审计表不重建。双库窗口与审计失败只能靠故障注入（`AppDataStore.faultNextWrite`、核心结果写入失败、删除审计表后重开）复现，正常路径测试覆盖不到，所以这些用例直接注入故障并核对表内容、回执、工具结果与事件，而不只看任务状态。工具操作账本的族核实顺序由 `test/64-tool-op-ledger.test.ts` 覆盖，会话类别清单由 `test/62-tool-availability.test.ts` 覆盖。

## 适用范围

完全访问的账户、环境、免审批及宿主任务授权传播采用[本决定](../feature/2026-10-12-full-access-current-account.md)；本篇其他独立规则继续适用。
