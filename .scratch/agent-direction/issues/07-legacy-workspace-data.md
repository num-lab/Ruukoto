Status: resolved

# 07 — 把旧开发会话和资料映射到工作区

**What to build:** 升级旧开发数据后，拥有者能按工作区找到原会话、历史和产物，记忆及资料权限保持原有边界。

**Blocked by:** [05 — 按工作区创建和切换开发会话](05-workspace-sessions.md)

依据：[已确认规格](../spec.md) 与 [ADR 0017](../../../docs/adr/0017-two-agent-products.md)。

## 验收标准

- [x] 同一旧项目包含不同目录时可形成可核查的工作区映射；目录失效或归属有歧义时明确列出，不静默猜测。
- [x] 历史、产物、记忆来源、指令及工具配置仍可定位，保留旧标识作为必要的兼容来源。
- [x] 跨项目资料授权映射不隐式扩大；撤销授权后的查询与上下文注入仍按来源校验。
- [x] 迁移重复执行不重复创建，失败可恢复；源记录保留，不要求删除旧存储字段。
- [x] 完成相关端到端检查、类型检查及仓库要求的验证；同步本次行为涉及的运行说明和图解，验证记录区分模拟结果与真实环境结果。

## Comments

### 2026-10-02：实施计划

本计划基于当前 HEAD `c9fafa0`、工单 05/06 的交付记录和两项并行只读核查制定，继续使用 ponytail skill。05、06 已完成，本单可以开始。以下是待实施方案，尚未运行迁移或验收。

#### 已确认的事实与实施边界

当前工作区是带 `rootDir` 的 Project，schema 为 v20。`sessions.project_id` 同时承担会话的资料身份与配置来源：历史、产物及记忆来源校验通过它定位，指令、Web Search、MCP、Jev 和记忆候选也使用它。JSONL 通过原 `sessionFile` 与 `piSessionId` 定位，历史索引按会话 ID 保存，产物关联原任务和会话。

直接改写 `sessions.project_id` 会改变这些边界。一旧项目包含多个目录时，原会话本来能读取同项目的其他目录资料；多个旧项目使用同一目录时，它们仍有不同的资料身份。前者不能因整理工作区而被静默收窄，后者不能因合并展示而获得新的默认读取权限。`AccessScope.sourceRefAccessible` 按来源会话当前的项目判定，改写项目还可能使原授权的撤销不再控制原资料。

本单采用加法迁移：新增工作区组织归属，保留旧会话的 `projectId` 作为资料和配置来源。工作区显示原会话，历史、产物、记忆、授权与凭据继续通过原标识定位。满足严格条件的单目录完整旧项目可以复用原 ID 认领根目录；其他情况只建立组织映射。

兼容行为须明确：映射旧会话的后续任务继续使用原项目配置；在目标工作区新建的会话使用目标工作区配置。界面显示两类来源并提供原设置入口，不能把组织映射描述为配置继承。使用新增或其他 Project ID 的会话不会因组织映射获得关联旧项目的资料或凭据；安全认领原 ID 时，后续新会话沿用该身份本来拥有的配置与访问范围。如需开放其他来源，使用工单 06 已有的可信配置与授权入口。这里保留 06 的设置能力，不建立第二份配置状态。

07 处理当前实例内的归属映射。旧实例与 Coding Agent 独立档案之间的实际导入、备份及切换由工单 21 负责，不能在本单绕过产品目录隔离。角色与群聊退役也不在本单实施。

#### 实施步骤

1. **增加会话组织归属，并保留所有来源标识。**

   在 `sessions` 增加可空的 `workspace_project_id` 外键，映射为 `Session.workspaceProjectId`。目标必须是带根目录归属的 Project；旧库升级只补列，不扫描目录、不自动迁移业务记录。继续保留原 `project_id`、会话/任务/产物 ID、pi 会话 ID、历史文件路径、记忆及各版本来源、配置与授权 ID。

   共享一个展示归属规则：显式工作区映射优先；没有映射且来源项目已有根目录时使用来源项目；其余仍列在旧项目下。该规则只供拥有者的组织查询和界面使用，不能进入 `AccessScope`、模型工具身份或凭据范围判定。原项目完整保留为兼容来源，工作区详情通过已映射会话派生关联来源列表，不再保存一份项目映射副本。

   快照及新映射事件携带组织归属；任务 TUI 与配置中心同步投影。新会话创建仍以选定 Project 为实际身份；迁移不通过 `open_workspace` 新建空会话。旧 API 未带组织参数时保持原语义。

   主要落点：`src/core/db.ts`、`src/core/types.ts`、`src/core/store.ts`、`src/control/protocol.ts`、`src/tui/state.ts`、`src/config-tui/app.ts`。schema 从实施时实际版本递增，目前为 v20。

2. **提供只读预览，明确列出可映射项、歧义与异常。**

   增加拥有者控制面 `preview_workspace_migration`，返回实例标识、源项目、完整会话归属与目录身份、已有工作区、建议动作、实际配置来源及待处理原因。先通过现有 CLI 的 `project migration-preview` 提供可保存的结构化结果；调整根目录或会话分配后，用同一命令的 `--plan <文件>` 重新预览并生成绑定最终选择的修订，再使用 `project migration-apply --plan <文件>` 应用。两条命令复用已认证控制面，适用于当前连接实例，不直接编辑数据库，也不另做一套迁移向导。

   预览只处理普通 dev 会话；角色绑定和群聊会话明确排除。混合项目的普通会话可以映射，但不能认领整个混合项目。同一旧项目的目录按真实身份分组：先严格核实登记的 realpath、dev、ino 仍有效，再用 `sameDirIdentity` 做符号链接及挂载别名去重。不能用“路径相同或 inode 相同”的归属匹配代替目录未被替换的核实。

   同目录多个旧项目、一个项目多个目录、已有根目录但存在根外会话、嵌套目录对应多个根，以及已知 worktree 情况都分别列出。拥有者选择实际根目录及其会话分配；不自动推断共同祖先、Git 根或临时 worktree 的所属工作区。新根须满足现有目录与保护根校验；选择包含多个仓库的父目录时，明确核对所选会话的真实目录位于该根内。同一真实目录已有工作区时复用其 ID，不按显示名称决定归属。

   目录失效、被替换或无权核实时，保留原记录并列出原因，不把当前同路径的新目录当作旧目录。历史文件缺失、未落盘或损坏也须单独报告，不能显示为“没有历史”。这些记录仍可从旧项目查阅可读的历史与产物；执行继续遵循既有目录身份检查。目录恢复后可重新预览，涉及重新绑定执行目录的处理不由组织迁移顺带完成。

   安全认领原 ID 的快捷路径仅在以下条件全部满足时提供：来源项目尚无根目录；项目会话集合非空，且完整集合均为非角色的普通 dev；所有目录仍有效且为同一真实目录；目标就是该目录本身；没有其他项目占用该根；没有已映射到其他工作区的会话。认领共同祖先、只选部分会话或混合项目均不能走此路径，因为 06 会让认领后的指令按项目根目录读取。

   同步收紧现有 `findWorkspaceProjects` 与 `Runtime.openWorkspace` 的旧项目认领条件，避免目录入口在迁移流程之外把多目录项目直接认领到其中一个目录。已认领的根外会话只列异常并允许在目录有效时显式组织映射；其配置来源仍是原项目，报告须显示原指令实际使用的根目录。

   预览按源项目查询并限制载荷；记录分页或未完成扫描，不能用截断结果宣称已核查完整项目。使用现有目录身份与保护根能力，迁移逻辑集中在一个模块，避免 Runtime 和 CLI 各自推断。

   主要落点：`src/control/workspace.ts`、`src/runtime/runtime.ts`、`src/control/server.ts`、`src/cli.ts`，新增一个集中实现预览与应用的模块即可。

3. **在一个 SQLite 事务中应用明确选择的映射，并提供幂等回执。**

   `apply_workspace_migration` 接受实例标识、明确选中的会话分配或安全认领动作、`expected_revision` 和稳定 `request_id`。预览修订使用相关元数据的规范化内容哈希：来源根目录和设置版本、完整源会话集合、类别/角色绑定、登记目录身份、现有组织映射及目标根身份。无关任务输出不使预览过期，不使用全局事件 seq 作为修订。

   应用先查询成功回执：同键同规范请求返回原成果，同键异参返回 `request_conflict`。这一步必须先于修订检查，避免成功写入后的同键重放被自己的变更误判为过期。没有回执时，重读相关记录、比较修订并再次核实目录；来源新增会话、角色绑定变化、映射被其他客户端修改、目标根失效或身份冲突时拒绝并要求重新预览。

   用 `Store.withTx` 把必要目标 Project 的创建、合规根目录认领、组织字段条件更新、对应持久事件及成功回执一起提交。复用现有 `meta` 保存按迁移请求 ID 命名的回执，记录请求摘要、原映射与结果，不新增多阶段状态机。事务内做最后一次同步目录身份核查；SQLite 与文件系统没有跨系统事务，不能承诺以后目录不会被替换，后续任务仍须按既有规则验证。

   新工作区使用已有创建默认值；旧配置、授权和凭据不复制或合并。迁移不会改写 JSONL、移动产物文件、重建会话、恢复审批或重放未完成任务。组织映射不改变运行中任务身份，无需停止无关任务。对安全认领，事务内重新核查完整条件。

   任一步失败整体回滚，不留下空项目、部分映射或成功事件。应答丢失及进程重启后以原请求 ID 查询/重发；相同映射的新请求也应返回已有归属，不重复创建。不同归属不能被普通重试覆盖。成功后的回退仅恢复显式会话组织映射，并校验当前值；已成功认领的根目录身份保留，回执区分认领与可恢复的组织映射。新工作区及迁移后产生的执行事实保留，不能用旧数据库备份覆盖新任务或已发生的撤销。

   主要落点：迁移模块、`src/core/store.ts`、`src/runtime/runtime.ts`、`src/control/server.ts`。沿用现有事务、请求键校验和明确拒绝/应答丢失处理。

4. **打通工作区查阅、切换、恢复与新建会话。**

   工作区计数和会话列表按组织归属查询，保留旧 `list_session_summaries(project_id)` 按原身份查询的语义。给同一操作增加明确的 `workspace_id` 参数，两种参数互斥，复用现有摘要与活动时间算法；映射事件不能让旧会话被显示为刚刚执行任务。

   TUI 中选择工作区、恢复已映射旧会话后，当前工作区选择状态继续指向目标工作区，不能被 `view.projectId` 改回源项目。会话标题或详情显示“工作区”和“配置与资料来源”。`/resume`、工作区列表、重连快照及重载恢复使用同一组织归属规则；历史、产物、prompt、审批与任务操作仍按原会话/任务 ID 读取。

   ruukoto-dev 的 `/new`、`/new-session` 从当前目标工作区创建新会话，使用目标工作区 Project ID 和配置，不跟随旧会话的来源身份。没有工作区映射的旧会话继续旧行为。`ruukoto` 的原项目界面和旧 API 查询语义保留。

   配置中心工作区详情列出关联旧资料与原配置入口：项目 ID、对应会话、指令解析基准、MCP/Jev 引用及原授权方向。多个来源的配置并列显示，不推断优先级，不合并指令或允许列表。访问源设置仍使用 06 的设置版本及各配置版本，新工作区设置只作用于使用该身份的新会话。

   授权页面读取原 `data_grants`，显示原授权 ID、来源、目标、类别及当前撤销状态，撤销调用原 ID。新建授权仍须指定实际资料来源和读取方，不能把一个工作区的全部关联来源隐式当作授权端点。记忆保留原项目和来源版本；跨来源或无会话来源的项目记忆留在来源项目，不按正文、目录名或最近任务猜分配。

   主要落点：`src/control/ops.ts`、`src/core/store.ts`、`src/control/workspace.ts`、`src/tui/app.ts`、`src/tui/state.ts`、`src/tui/reload-state.ts`、`src/config-tui/app.ts`。资料权限及任务配置读取不替换为工作区组织字段。

#### 验证与验收

新增 `test/76-legacy-workspace-data.test.ts` 集中验证映射控制面、事务和来源边界，编号在实施时核实；复用 `test/helpers/testkit.ts`、伪终端和模拟 MCP。界面与摘要用例放在现有 test/33、69、74，必要的投影检查覆盖 test/13、19、66。不增加依赖，不重复编写已有授权算法测试。

必须覆盖以下场景：

- 一个旧项目两个目录映射到两个工作区；两个旧项目同目录映射到同一工作区；明确选择父目录作为多仓库工作区；安全原 ID 认领及部分/祖先/混合认领拒绝。
- 同名目录、符号链接、dev+ino 挂载别名、已有根身份冲突、源/目标目录删除或替换、嵌套根歧义、已认领根外会话、混合项目的普通会话与角色/群聊排除。
- 迁移前后原会话/任务/产物及 pi ID、文件路径、JSONL 和产物字节保持可核对；原历史、工具结果、产物、记忆来源与版本、prompt/选择记录仍能读取。缺失或损坏如实报告，不生成空历史伪装成功。
- 一旧项目分到不同工作区后，旧会话原有项目内访问保留；多个旧项目归入同一工作区后仍拒绝未授权跨来源访问；目标工作区使用其他 Project 身份的新会话不因映射获得源资料与记忆。安全认领原 ID 时，新会话继续该 ID 已有的配置和资料范围。
- 原 history/artifact/memory 授权 ID 和方向保持；撤销最后一条有效原授权后，旧会话后续查询、派生记忆注入及发送前复核仍拒绝。多个等价授权保留现有语义。
- 旧会话在迁移后的后续任务使用原指令、Web Search、MCP、Jev 和记忆来源；目标工作区新会话使用目标配置。原凭据 scope、服务 ID 和配置版本保持，不被组织映射扩大。
- 工作区列表计数、旧会话恢复、历史/产物查阅、实时映射事件、重连与重载正确；恢复旧会话后再 `/new` 或 `/new-session` 创建到目标工作区。映射不改变活动时间或运行中任务身份。
- 预览零写入；两客户端竞争、源会话集合变化、角色/目标身份变化均使旧预览失效；同键重放、同键异参、成功后新键重复、重启后核实及事务中途故障正确处理。故障注入须发生在部分 SQL 已执行之后，证明整体回滚。
- v20 旧库加列后原归属和资料仍可读；重复升级不重建；成功后的映射回退只恢复显式组织字段，保留已确认根目录、新任务、配置修改及授权撤销事实，与事务失败全部回滚分别验证。

实施后的检查顺序：

```bash
npx tsx --test test/76-legacy-workspace-data.test.ts test/33-config-tui.test.ts test/69-session-summaries.test.ts test/74-workspace-sessions.test.ts
npx tsx --test test/09-artifacts.test.ts test/11-history-read.test.ts test/16-context-memory.test.ts test/24-mcp.test.ts test/53-jev-config.test.ts test/55-jev-runtime.test.ts test/75-workspace-settings.test.ts test/13-tui-state.test.ts test/19-tui-demo.test.ts test/30-workspace-entry.test.ts test/66-control-seam.test.ts
npm run typecheck
npx tsx --test test/67-visual-docs.test.ts
npm test
```

新增 `.scratch/agent-direction/smoke-07-legacy-workspace-data.mts`，沿用 06 的真实 bin 后台、隔离档案、socket、SQLite、JSONL 和文件，串联旧入口造多目录数据、预览/应用、查原历史与产物、恢复旧会话、创建新会话、原授权撤销、同键核实及重启。macOS 本机执行，Linux 经 `ssh tx` 在隔离目录执行；模型与 MCP 可打桩，记录分别说明模拟部分和真实进程/文件/目录身份结果。07 不宣称真实日常档案的跨实例迁移已完成；代表性旧数据导入由 21 验收。

同步 `docs/runtime.md`、`CONTEXT.md` 中工作区组织归属与旧资料/配置来源的兼容说明。实施时记录该边界的简短 ADR，说明为何保留原 `projectId`，并与 ADR 0017 的工作区模型及 ADR 0001/0016 的完整历史原则对应。对所有实际改动的 `src/`、`deploy/` 文件按仓库要求运行 `grep -l <文件路径> docs/visual/*.html`，同步命中页面的图、表与正文；预计重点为 `storage-layout.html`、`control-protocol.html`、`context-pipeline.html`，并完成 test/67。

完成后逐条登记五项验收证据，区分模拟与真实环境。06 的记录中只有 macOS 产品冒烟结果，不能把此前计划中的 Linux 检查算作已经通过；本单新验证和既有环境性失败均须按实际结果记录。计划当前仅修改本工单，不进行迁移，也不把验收标为完成。

### 2026-10-02：步骤 1 实施完成（会话组织归属）

实施计划步骤 1 已完成，步骤 2/3/4 与验收未实施，工单保持 ready-for-agent：

- schema v20 → v21 纯加列迁移：`sessions.workspace_project_id`（可空，`REFERENCES projects(id)`）；升级只补列，不扫描目录、不迁移业务记录，旧会话默认 NULL。新库经 CREATE TABLE 携带，旧库经 `ensureColumns` 幂等补齐。
- 类型与存储映射：`Session.workspaceProjectId`（types.ts）；`rowToSession` 行映射；`createSession` 不写该列（默认 NULL），新会话创建行为与旧 API 语义不变，未经 open_workspace 新建会话。所有来源标识（project_id、会话/任务/产物 ID、pi 会话 ID、历史文件路径、记忆与授权 ID）未动。控制面快照与 op 结果的会话载荷自动携带该字段（Session 整体序列化，`src/control/protocol.ts` 无需专门改动）。
- 新持久事件 `session.workspace_mapped`（sessionId、projectId、workspaceProjectId；null = 恢复未映射）。`Store.mapSessionToWorkspace` 为唯一写入路径：目标非 null 时必须带根目录归属（否则 `invalid_params`）、会话不存在 `not_found`、同值幂等不产生事件；调用方须 `withTx` 包住（校验、更新与事件单一事务）。任务 TUI（`src/tui/state.ts`）与配置中心（`src/config-tui/app.ts`）投影更新本地会话的组织归属，来源标识不变；demo 合成会话补该事件（test/19 全类型覆盖约束）。
- 共享展示归属规则 `sessionDisplayAttribution`（`src/control/workspace.ts`）：显式映射优先（`mapped`）、无映射且来源项目带根目录归属时用来源项目（`workspace`）、其余仍列在旧项目下（`legacy`）。仅供组织查询与界面展示，不进入 AccessScope、模型工具身份或凭据范围判定。
- 验证：新增 test/76（5/5：v20→v21 迁移可读性与默认 NULL、来源标识保留、重复打开不再迁移、默认 NULL 与快照载荷、store 校验/幂等/事件载荷/恢复、展示规则、ViewState 投影）；回归 74/13/19/30/33/50/66/67/69/75 全过；`npm run typecheck` 通过。test/75 的 v19 迁移用例版本断言跟进到 v21（同 issue 05 对 test/50 的惯例）。文档：runtime.md 数据布局 schema v21，`docs/visual/storage-layout.html`（v21 与 `workspace_project_id`）与 `control-protocol.html`（`session.workspace_mapped` 事件行）同步，test/67 3/3。
- 步骤 3 须知：`mapSessionToWorkspace` 目前无控制面调用方，由迁移事务接入；回退可恢复的组织映射用同一方法的 `null` 参数（事件留痕）。步骤 4 须知：展示查询按 `sessionDisplayAttribution` 归属，`kind` 供「工作区/配置与资料来源」标注区分。

### 2026-10-02：步骤 2/3 实施完成（只读预览与事务化应用）

实施计划步骤 2 与 3 已完成，步骤 4（工作区查阅/切换/恢复/新建）与文档/冒烟/验收登记未实施，工单保持 ready-for-agent：

- **集中模块**：预览与应用的全部推断集中在新模块 `src/runtime/workspace-migration.ts`；`Runtime.previewWorkspaceMigration`/`applyWorkspaceMigration` 只做接线，CLI 经已认证控制面调用，两边不各自推断。
- **预览**（`preview_workspace_migration`，零写入）：返回实例标识、源项目（含 `config_source_project_id` 恒为源项目）、目录分组（登记身份先核实再按 `sameDirIdentity` 去重；失效/被替换/无权核实分列且不把同路径新目录当旧目录）、逐会话归属（角色/群聊明确 `excluded`、`instruction_base_dir` 按 issue 06 规则、历史缺失/未落盘/损坏单独报告不显示为「没有历史」）、已有工作区、findings（多目录、同目录其他旧项目、混合项目、已认领根外会话、嵌套根、worktree（`.git` 为文件））、`safe_claim` 全条件、建议计划与限制载荷（session limit 截断如实报告，截断不可认领不可生成修订、workspaces 列表封顶）。
- **修订**：`revision = r1.<sha256>`，内容为规范化（键递归排序）哈希输入——来源根目录与 settings_version、完整源会话集合（kind/角色绑定/登记目录身份/现有组织映射）、角色绑定行、目标根身份，加上显式选择本身（身份而非路径字符串）；无关任务输出不过期，不使用事件 seq。带 `--plan` 的预览校验选择后生成修订，选择非法时返回 `plan_errors` 且修订为 null。
- **应用**（`apply_workspace_migration`）：先查成功回执（meta 键 `migration_receipt:<request_id>`，请求摘要含 instance/project/plan/expected_revision 的规范化哈希）——同键同规范返回原成果，`同键异参 request_conflict`，先于修订检查；无回执时重读记录、校验计划、比对修订（不符即 `revision_conflict`），`Store.withTx` 单事务提交目标 Project（createProject 既有默认值，不占用的目录先 `findProjectByRoot` 复用其 ID）、`attachProjectRoot` 认领、`mapSessionToWorkspace` 组织更新、事件与回执；事务内做最后一次同步目录身份核查。回执区分认领与可恢复的组织映射（`claim` 与 `mappings: [{sessionId, from, to}]` 分别记录）。
- **回退**（plan `action="revert"`, CLI 同一 `migration-apply` 入口）：按原回执校验每个会话当前值（已被修改即 `revision_conflict` 拒绝），只恢复显式组织映射；claim 与新建的 工作区保留（claim 回退明确拒绝），不删除项目、不覆盖执行事实。
- **收紧**：`Runtime.openWorkspace` 与 `findWorkspaceProjects` 新增同款防御——旧项目普通 dev 会话分布在多个登记真实目录时不可经目录入口认领（`invalid_params`，指引去 migration-preview）；共享去重助手 `distinctDirIdentities`（`src/core/dir-identity.ts`）。
- **CLI**：`ruukoto project migration-preview <项目id> [--plan <文件>] [--limit N]`（`--plan` 校验选择并把 `project_id/instance_id/revision` 写回计划文件）与 `ruukoto project migration-apply --plan <文件> [--request-id <id>]`（缺省请求键按计划文件内容派生，同一文件重发即原键核实）。
- **偏差登记**：选择校验统一要求会话真实目录位于所选根内（现有工作区目标同此，计划原文只对父目录新根显式要求）——判定的保守侧：跨根映射会在工作区下静默制造「根外会话」（归属如猜测而非明示），已认领的根外会话在本单只列异常并允许在目录有效时显式映射；若后续工单确认现有工作区目标的跨根映射作为显式选择放开，只需放宽 `validatePlan` 的 `insideOrEqual` 检查并补根外场景用例；apply 不做 `expected_current_value` 形参（修订预核对 + SQLite 单写者同步段已覆盖「被其他客户端修改」）；预览/应用计划校验失败的错误码为 `invalid_params`（消息指引重新预览），修订/漂移类为 `revision_conflict`；worktree 以 `.git` 文件为已知信号。
- **验证**：test/76 扩至 13/13（预览归组与建议/异常与排除/安全认领全条件与回执幂等/两个目录两个工作区与父目录多仓库/修订稳定与四类过期/事务中途故障（第二个映射写入时注入，部分 SQL 已执行）整体回滚与同键恢复/revert 当前值校验与 claim 拒绝/目录入口收紧 op 与纯函数）；test/30 候选断言按计划跟进收紧（P 复查点）；回归 (74/75/30/66/24/53/55) 108/108、(33/69/13/19/09/11/16) 83/83、test/67 3/3；`npm run typecheck` 通过；**全量 `npm test`：782 项中 780 通过、1 跳过（真实模型门控既有）、1 失败**——test/08「DNS 在批准时固定」60s 超时，干净 HEAD（步骤 1 时已建 worktree 复现同一失败）环境性既有失败，与本单无关。
- **步骤 4 须知**：应用/回退仅经 op 与 CLI，未接 TUI/配置中心界面；`session.workspace_mapped` 投影两端已在步骤 1 就位；工作区维度查询参数、工作区详情关联来源列表、计数与恢复逻辑待步骤 4 按本单边界消费 `workspaceProjectId` 与 `sessionDisplayAttribution`。文档全量同步（runtime.md/CONTEXT.md/ADR/visual 细化）与 smoke-07 属后续阶段。

### 2026-10-02：步骤 4 实施完成（工作区查阅、切换、恢复与新建会话）

实施计划步骤 4 已完成；步骤 1-4 的实施全部落地。文档全量同步（runtime.md/CONTEXT.md/ADR/visual 细化）、smoke-07 与验收登记属后续阶段，工单保持 ready-for-agent：

- **归属查询**：`list_session_summaries` 增加 `workspace_id` 参数（与 `project_id` 互斥、必填其一，双传/空传 `invalid_params`）；`Store.listSessionSummariesForWorkspace` 以 `COALESCE(s.workspace_project_id, s.project_id)` 归属（显式映射优先、未映射留在来源项目），与按原身份查询共享同一条 SQL 与活动时间算法；`session.workspace_mapped` 不带任务引用，不会让已映射旧会话显示为刚刚执行任务。CLI 无此命令；TUI 与旧 API 语义不变，ruukoto 产品恒用 `project_id` 原身份查询。
- **任务 TUI（仅 ruukoto-dev）**：选择面板计数与会话列表按展示归属（含已映射旧会话）；`switchSession` 的选择状态（`selectedProjectId`）、《`/resume` 的默认项目（`currentDisplayProjectId`）、重连/启动/重载恢复（同一 `switchSession` 路径）都按组织归属——恢复已映射旧会话后选择状态继续指向目标工作区，不被 `view.projectId` 改回源项目；ruukoto 产品恒用原身份。会话标题经纯函数 `sessionTitleAttribution`（`src/tui/state.ts`，app 渲染与断言共用）：工作区加「工作区 」标注，mapped 另注「（配置与资料来源：原项目）」（紧随工作区名，不被行尾 cwd 截断）。历史/产物/prompt/审批/任务操作仍按原会话与任务 ID（未动）。
- **`/new` 与 `/new-session`**（ruukoto-dev）：项目取 `currentDisplayProjectId`——从已映射旧会话创建新会话落到目标工作区（目标 Project ID 与配置），不跟随来源身份；无映射旧会话与 ruukoto 产品保持旧行为（来源项目身份）。
- **配置中心（ruukoto-dev）**：工作区详情经已映射会话派生列出「关联旧资料来源」（`workspaceMappedSources` 于 `src/control/workspace.ts`，不保存映射副本）：来源项目 ID/名称、映射会话数、MCP 项数、Jev 启停、原授权出/入向计数、设置版本、指令基准目录，并列显示不合并、不推断优先级；行值沿用 `project:<id>`（重载恢复按值匹配既有菜单 id，进入原配置入口——来源的设置/MCP/Jev/授权各按来源项目 ID 与其自身版本访问）。授权页沿用 06 实现（原授权 ID/方向/类别/撤销态、按原 ID 撤销、新建方向固定本项目，关联来源不作隐式授权端点），未改动；记忆不做迁移或合并（配置中心无记忆合并入口，CLI/工具按原 projectId 读取）。
- **测试**：test/76（互斥/归属查询/活跃时间不受映射事件影响/ruukoto 原样，共 17）;test/69（存储层 COALESCE 归属与映射事件不算活跃）;test/74（工作区计数/会话列表归属/选择状态/无映射旧行为；**抗抖说明**：伪终端 ENTER 选择在全量并行负载下有输入批处理抖动（issue 05 既有记录），切换与新建改经与按键同一实现的 `switchSession`/`cmdNew` 处理器断言，面板读侧保留终端断言;标题归属断言改经与渲染共用的 `sessionTitleAttribution` 纯函数）;test/33（工作区详情关联来源行与原配置入口）。
- **验证**：检查块 (76/33/69/74) 54/54、(09/11/16/24/53/55/75/13/19/30/66) 143/143；test/67 3/3（control-protocol 的 list_session_summaries 行补 workspace_id 说明）;`npm run typecheck` 通过;**全量 `npm test`：788 项中 786 通过、1 跳过（真实模型门控既有）、1 失败**——test/08「DNS 在批准时固定」60s 超时，干净 HEAD（步骤 1 worktree）复现同一失败，环境性既有失败与本单无关。另一次同源排查：本阶段初两次并行批运行曾判 test/33 授权用例 60s 超时，stash 二分证明与内容无关（并发批负载，同 issue 06 R1 记录的负载型等待），同内容复跑通过。
- **至此步骤 1-4 实施完成**。后续阶段待办：`docs/runtime.md`/`CONTEXT.md`/ADR 与 visual 页面全量同步（本阶段 visual 为最小一致性）、`.scratch/agent-direction/smoke-07-legacy-workspace-data.mts`（真实 bin/后台/SQLite/JSONL 与重启核实）、逐条验收登记与评审。

### 2026-10-03：实施完成（验证场景补齐、冒烟、文档同步与全量验证）

步骤 1-4 的实施、验证场景补齐、产品级冒烟与文档同步全部完成；验收证据按五条标准登记如下，区分真实环境与模拟。

**本阶段改动**

- 测试补齐（test/76 由 17 项增至 21 项）：接入边界（两旧项目归入同一工作区后原授权 ID/方向与项目内访问保留、跨来源仍拒，目标工作区新会话不因映射获得源资料，显式授权→撤销最后一条→拒绝，复用 test/75 的脚本化模型与宿主工具接缝，不重写授权算法用例）；配置来源（映射旧会话后续任务使用原指令与禁用 Web Search 的工具清单，MCP 服务 ID/配置版本、凭据绑定、记忆项目与版本不被动，工作区新会话用目标配置，安全认领后新会话延续原 ID 指令）；标识与字节核对（pi 会话 ID/历史文件路径/JSONL 与产物字节（真实 bash 大输出）、任务与选择记录迁移前后逐项一致；缺失/损坏如实报告由 preview 用例覆盖）；回退只恢复显式组织字段且新任务/配置修改/授权撤销全部保留；目标根被替换时应用明确拒绝且零副作用；回执跨进程重启核实（meta 持久 + 重开 Db 同键重放）。
- 冒烟 `.scratch/agent-direction/smoke-07-legacy-workspace-data.mts`（沿用 06 的真实 bin 后台、隔离档案、socket、SQLite/JSONL/文件，串联旧入口造多目录数据、CLI 预览/应用、查原历史与产物、撤销原授权、同键核实及重启）。
- 文档：`docs/runtime.md`（旧数据组织迁移一节：workspace_project_id 展示归属、CLI 三步流程、回执/修订/回退、workspace_id 参数、TUI 与配置中心行为；工作区入口补认领收紧与指令基准注记）、`CONTEXT.md`（域词「工作区组织归属」）、新增 ADR 0018（保留原 projectId 作为资料与配置来源，组织归属只作展示；对应 ADR 0017 工作区模型与 ADR 0001/0016 完整历史原则）、visual 的 storage-layout（迁移回执 meta 行）、control-protocol（迁移应用幂等纪律段落）、context-pipeline（指令基准与授权端点不因组织归属改变）。

**验证（真实环境与模拟分列）**

- **产品级冒烟**（真实 bin/ruukoto-dev.mjs 后台两次拉起、真实 control socket、SQLite（含直接读取核对 schema v21、workspace_project_id 归属与回执）、CLI migration-preview/--plan/apply、JSONL 历史文件、产物文件、目录身份；模拟：模型服务 MockModelServer）：**macOS 本机两轮 9/9**（2.1s/轮）；**Linux（ssh tx，/tmp 隔离目录，npm ci 真实安装，Node v24）一轮 9/9（7.6s）**，用毕已清理服务器目录。场景：旧入口造多目录数据与原授权 → CLI 只读预览（结构完整 + 事件数不变） → --plan 修订写回 → apply 两个目录各成工作区 → SQLite 核对归属与来源标识 → 同计划文件重放 replayed / 交换分配同派生键 request_conflict → 原历史与 prompt 快照产物字节一致 → 原授权 ID/方向保持与撤销 → 目标工作区新会话与 workspace_id 归属查询（project_id 旧语义不变） → 重启后归属/回执/撤销状态都在。
- **离线测试**（进程内真实 Runtime/socket/SQLite/文件，模型打桩）：计划检查序列 (76/33/69/74) 60/60；(09/11/16/24/53/55/75/13/19/30/66) 143/143；test/67 3/3；`npm run typecheck` 通过。**全量 `npm test`（2026-10-03）：794 项中 792 通过、1 跳过（真实模型门控既有）、1 失败**——test/08「DNS 在批准时固定」60s 超时，干净 HEAD（步骤 1 worktree）复现同一失败，为环境性既有失败，与本单无关。
- 过程性抖动登记：test/33 授权用例在满负载全量中偶发 60s 超时（issue 06 R1 已登记的负载型等待，内容无关，stash 二分证实）；本单 test/74 归属用例曾两次因等待文本匹配到空状态提示语「选择会话」而断言先行帧（已修正为以会话行本身等待，随后三轮全量证实稳定）。

**与验收标准对应**

1. 同一旧项目包含不同目录时可形成可核查的工作区映射；目录失效或归属有歧义时明确列出，不静默猜测 → preview 目录分组与 findings（test/76 预览两项）、修订与 apply 校验（test/76 修订/拒绝）、smoke 场景 2/3；认领收紧（test/76 收紧两项、test/30 用例跟进）。
2. 历史、产物、记忆来源、指令及工具配置仍可定位，保留旧标识作为必要的兼容来源 → 标识与字节核对（test/76 字节用例）、配置来源（test/76 配置用例）、preview 历史缺失/未落盘/损坏单独报告（test/76 异常用例）、smoke 场景 3b/5。
3. 跨项目资料授权映射不隐式扩大；撤销授权后的查询与上下文注入仍按来源校验 → 接入边界用例（test/76，含跨来源默认拒、新会话不因映射获得、显式授权可读、撤销最后一条拒绝）、授权 ID/方向保持（test/76 + smoke 场景 6）；授权算法本身沿用 test/75/16 既有覆盖，未重复编写。
4. 迁移重复执行不重复创建，失败可恢复；源记录保留，不要求删除旧存储字段 → 同键重放/同键异参/相同映射新请求复用（test/76 步骤 3 用例 + smoke 场景 4/8）、事务中途故障整体回滚与同键恢复（test/76）、重启核实（test/76 存储层 + smoke 场景 8）、回退只恢复显式字段且事实保留（test/76）、v20 旧库加列只读与重复升级不重建（test/76 迁移用例）。
5. 完成相关端到端检查、类型检查及仓库要求的验证；同步运行说明和图解，验证记录区分模拟结果与真实环境结果 → 上述全量与冒烟记录；runtime.md/CONTEXT.md/ADR 0018 同步；对所有改动 `src/` 文件按约定 grep docs/visual 并同步命中页面（storage-layout、control-protocol、context-pipeline），test/67 3/3。

**遗留与说明**（供评审与后续工单）：迁移的产品 UI 面板入口不在本单（拥有者经 CLI 操作，与 05/06 的 CLI 拥有者入口一致）；角色绑定变化使预览失效的修订输入已含 agent_roles 行，未单列角色翻转用例（普通会话集合变化已覆盖修订过期）；smoke 未验证真实外部服务（模型与 MCP 均为打桩），不宣称真实日常档案的跨实例迁移已完成（工单 21 负责）。审查与最终验收勾选由后续评审执行，工单保持 ready-for-agent。

### 2026-10-03：评审修复（code-review 两轴）

对未提交 diff（HEAD 211a8dc）的评审发现逐项处置，行为边界均不放宽：

**Standards**

1. `resolveDirIdentitySync` 移入 `src/core/dir-identity.ts`（与异步 `resolveDirIdentity` 同一判定），workspace-migration 两处手卷解析改为复用（resolveTarget 新根与 claim_source 目标）。
2. 目录入口认领判定收敛为共享纯函数 `legacyProjectClaimableFromDir`（`src/core/dir-identity.ts`）：`findWorkspaceProjects` 与 `runtime.openWorkspace` 共用「全部普通 dev、非角色绑定、同属一个登记真实目录」；`computeSafeClaim`（safe-claim 全条件）刻意更严——互加交叉注释说明分层，不强行合一。
3. `writeReceipt` 改为 `Omit<MigrationReceipt, "version" | "createdAt">` 对象参数，消除位置参数堆。
4. `src/cli.ts` 的 `readJsonFile` 移到 `--grant` 文档注释之上，`parseGrants` 注释归属恢复。
5. 两项「评审接受不改」的选择补 `ponytail:` 注释：`sessionSummaries` 的 SQL 片段插值（仅类内两常量）与配置中心 `project:<id>` 行值协议。

**Spec**

6. `historyStatusOf` 校验样本（≤64 KiB）内每一条完整 JSONL 行，任何损坏行 → `unreadable`（含行号原因）；样本截断的末段按不完整不作损坏判定；缺失/未落盘/不可读区分不变。新增 test/76 用例：合法文件、中段损坏行、超过样本上限且截断在行中段的干净文件。
7. 新增角色翻转过期用例：改绑 agent_roles（coding 改绑源项目会话）使预览修订过期、被绑定会话明确排除、不可安全认领。
8. inside-root 对 `existing_workspace` 目标的保守判定保持（评审确认的偏差项），「步骤 2/3 实施完成」的偏差登记已补理由（避免工作区下静默制造根外会话）与放开路径（放宽 validatePlan 检查）。

**验证**：`npm run typecheck` 通过；评审指定集合（76/74/75/30/33/69/13/19/66/67）123/123；计划检查块 (76/33/69/74) 62/62、(09/11/16/24/53/55/75/13/19/30/66) 143/143；test/76 全量 23/23。**全量 `npm test` 两轮（2026-10-03）：首轮 796 项中 793 通过、1 跳过、2 失败**（test/08 DNS 60s 超时——干净 HEAD 基线已复现的环境性既有失败；test/33 授权用例 60s 负载型超时——issue 06 R1 既有登记，单跑 15/15 通过证实内容无关）；**次轮 796 项中 794 通过、1 跳过、1 失败**（仅 test/08 环境性失败）。工单保持 ready-for-agent，等待最终验收决策。

### 2026-10-03：验收登记

五项验收标准逐条登记最终证据（模拟 = 模型经 MockModelServer 打桩；真实 = 真实 bin/ruukoto-dev.mjs 后台、控制面 socket、SQLite（含直接读取核对）、JSONL 历史文件、产物文件、目录身份与 CLI 端到端）：

1. **可核查的工作区映射，歧义明确列出**：预览目录分组与 findings（多目录/同目录多旧项目/失效/被替换/嵌套/worktree/根外会话/混合排除）、修订与应用校验、目录入口收紧（test/76 预览·拒绝·收紧用例、test/30、33、69；模拟）；CLI 预览/计划/应用到 SQLite 归属核对（冒烟场景 2/3/3b：macOS 两轮 9/9 + 父级复核，Linux ssh tx 隔离目录 9/9，服务器副本已清理；真实）。
2. **来源可定位，旧标识保留**：pi 会话 ID、历史文件路径、JSONL 与产物字节、任务与选择记录迁移前后逐项一致；指令/Web Search/MCP/Jev/凭据/记忆来源不变（test/76 字节核对与配置来源用例、preview 历史缺失/未落盘/损坏单独报告；模拟）；原历史与 prompt 快照产物字节一致（冒烟场景 5；真实）。
3. **授权不隐式扩大，撤销仍生效**：两旧项目归入同一工作区后跨来源默认拒、目标工作区新会话不因映射获得源资料、显式授权→撤销最后一条→拒绝；授权 ID/方向经迁移保持（test/76 接入边界用例，复用 test/75 接缝，未重写授权算法用例；模拟）；原授权 ID/方向保持与撤销原 ID 的 revokedAt（冒烟场景 6；真实）。
4. **幂等可恢复，源记录保留**：同键重放/同键异参/相同映射新请求复用、事务中途故障整体回滚与同键恢复、回执跨进程重启核实、回退只恢复显式组织字段且新任务/配置修改/授权撤销保留、v20 旧库加列只读与重复升级不重建（test/76 步骤 3 与回归用例；模拟）；同计划文件 replayed、交换分配 request_conflict、重启后归属/回执/撤销状态都在（冒烟场景 4/8；真实）。
5. **端到端检查、类型检查与文档同步，模拟与真实分列**：`npm run typecheck` 通过；计划检查序列 (76/33/69/74) 62/62、(09/11/16/24/53/55/75/13/19/30/66) 143/143、test/67 3/3（模拟）；全量 `npm test`（评审修复后两轮最终）：796 项中 794 通过、1 跳过（真实模型门控既有）、1 失败 = test/08「DNS 在批准时固定」60s 超时（干净 HEAD 基线已复现的环境性既有失败，与本单无关）；`docs/runtime.md`、`CONTEXT.md`、ADR 0018 与 visual 三页同步（storage-layout/control-protocol/context-pipeline，真实文件）。负载性抖动记录：test/33 授权用例在满负载下偶发 60s 超时（issue 06 R1 既有登记的负载型等待，单跑 15/15 通过，与内容无关）；test/74:585 的既有等待形状（issue 05 遗留）留待单独工单处理，本单未改。文档与评审循环见上方各阶段评论；按验收约定本单不宣称真实日常档案的跨实例迁移（工单 21）与真实外部服务已完成。
