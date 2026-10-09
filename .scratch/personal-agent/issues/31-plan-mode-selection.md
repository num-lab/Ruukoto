Status: resolved

# 31 — 将 Plan 纳入模式选择并移除 `/plan` 命令

## 目标

在普通开发会话中，将 Plan 做成与 Ask for approval、Auto review、Full access 并列的模式选项。通过 `/mode` 与 Shift+Tab 选择 Plan 后，后续消息持续用于调研和完善计划，直到拥有者手动切换模式。删除 TUI 中的 `/plan` 命令，并取消所有新提交入口通过 `/plan …` 文本标记进入计划模式的行为。

本工单延续 [12：会话模式选择](12-session-mode-command.md)、[15：自动审查](15-auto-review-mode.md) 与 [26：原计划模式](26-plan-mode.md)，修订 26 的一次性入口和下一条普通消息恢复执行的约定。

## 已确认决定

1. Plan 持续到拥有者手动切换模式。生成计划后不自动退出；即使拥有者在 Plan 下要求“开始实现”，Agent 也应提示先切换模式。
2. Plan 固定采用 Auto review 的受限执行环境与审批策略。复用现有计划工具白名单，保留 `bash`，延续调研期间不修改文件、长期记忆和外部状态的计划说明；不提供严格只读保证。
3. 删除 TUI 的 `/plan` 注册、补全与帮助，并停止后台从新提交的输入文本识别计划模式，包括 CLI/API 提交。计划模式由可信模式设置确定。
4. 仅普通开发会话支持 Plan，覆盖 `/mode` 列表、Shift+Tab 循环和状态显示；main、SubAgent、退役归档与 IM 入口不在本工单的新增范围。
5. 中断后 `/continue` 创建新任务，以提交时当前选中的模式为准，显式一次性模式优先。不会从源任务的输入或继续链继承计划约束，旧审批不继承。
6. 修改会话默认模式仅影响后续新任务，已排队、运行或等待审批的任务保留提交时固定的模式。任务级接口不能进入或退出 Plan，也不能改变 Plan 任务固定的 Auto review 审批策略；需要切换时先中断，再按当前模式继续。非 Plan 任务原有的三种访问模式切换能力继续有效。
7. Plan 随 TUI 切换普通开发会话沿用，将源会话的选择同步并保存到目标会话，覆盖目标原默认模式。
8. 不兼容旧 `/plan` 行为。删除所有从任务输入和 `resumesTaskId` 链识别计划模式的逻辑，包括历史任务；不做旧标记回填、历史特判或专门恢复分支。历史文本保留原文，但 `/plan` 文本不再决定执行模式。旧中断任务创建继续任务时同样遵循第 5 项。

## 已核实现状与约束

- [计划模式模块](../../../src/agent/plan-mode.ts) 当前从任务输入及逐级 `resumesTaskId` 链推导计划模式；没有独立的会话计划状态。计划说明包含“拥有者的下一条消息即按计划执行”，本工单需要改正这条说明。
- [模式类型](../../../src/core/types.ts) 当前只有三个访问模式。会话默认模式与任务权限模式共用类型和取值列表；计划模式与 Auto review 的组合需要明确表示，不能只在 TUI 增加一个名称。
- [Runtime](../../../src/runtime/runtime.ts) 在提交时固定会话默认值或显式模式，已有任务不随会话默认值改变。默认值设置具有版本校验、持久化与事件广播；重连必须显示后台真实值。
- `/continue` 创建新任务，使用提交时的会话默认权限，但现有计划限制会沿原任务链继承。任务级 `switch_mode` 可以调整权限，却不会重算任务开始时钉定的计划工具集。
- [TUI](../../../src/tui/app.ts) 切换会话时，会将源会话的模式及模型同步到目标会话并保存。本工单将 Plan 纳入这条既有同步路径。
- 现有计划白名单移除 `edit`、`write`、长期记忆写入、非只读 MCP 及其他未列工具，但保留 `bash`、`request_file_access`、`http_request`、`todo_write` 和技能。`bash` 仍可能写工作区；后两种外部访问工具也接受写文件或 POST 等参数，人工批准后可以执行。因此工具白名单和计划说明不等于技术上的全面只读约束。
- Plan 中的 Auto review 必须遵循 [ADR 0005](../../../docs/adr/0005-auto-review-mode.md)：符合策略的越界读取可交独立审查，写入、带凭据请求及不能确认的操作仍按策略转人工；审查失败不放宽权限。保持 [ADR 0003](../../../docs/adr/0003-enforce-explicit-access-modes.md) 的权限与拥有者身份边界。
- [CONTEXT.md](../../../CONTEXT.md) 当前将计划模式定义为一次性 `/plan`，并明确避免将其当作访问模式或安全边界。实现时应更新为常驻模式选择、固定 Auto review 与工具收窄的组合，说明与上述 ADR 的关系。

## 实施范围

1. 在既有会话模式选择与持久化路径中表示 Plan。界面显示为一个独立选项，后台明确表示计划工作方式与固定 Auto review 的组合；复用既有权限策略，不新增一种自动审批策略。会话默认值、新任务的固定模式、快照与事件必须能完整恢复这一选择。
2. 沿用模式设置的版本条件更新、事件广播与重连刷新。提交与继续在后台固定最终模式，显式一次性模式优先；重试复用原请求身份，不能因之后切换默认值而重复建任务或改变已接收的新任务。
3. 新模式接入普通开发会话的 `/mode`、Shift+Tab、状态显示与跨会话设置同步。CLI/API 的会话默认设置、提交与继续应可表达同一 Plan 选择；配置中心共用的会话默认模式列表和标签也需同步。后台拒绝非普通开发会话的 Plan 设置或提交，界面按资格显示选项。
4. 计划工具集和说明从任务固定模式确定，接入已有执行画像、统一工具过滤及 SubAgent 管理器的计划资格检查。保留既有白名单；计划说明改为持续调研、完善计划，执行前由拥有者手动切换模式。任务中收到“开始实现”不自行退出 Plan。
5. 删除 TUI 的 `/plan` 条目，以及运行时、Driver、状态栏和相关调用方从输入或继续链识别计划模式的代码。TUI `/plan` 按未知命令处理；CLI/API 里的 `/plan …` 只作为普通输入文本，任务模式仍由显式参数或会话默认值确定。
6. 明确区分会话默认值设置与任务级模式切换。任务级接口拒绝进入或退出 Plan，以及改变 Plan 任务的审批策略；拒绝不得改写任务模式、权限版本或待处理审批。非 Plan 任务的既有切换行为保留。
7. 若持久化表示需要改变字段或模式取值约束，完成必要的 schema 升级和控制面类型同步。已有三个模式的数据保留有效；不根据旧 `/plan` 文本迁移计划状态。只保留通用数据升级，不添加旧计划行为兼容。
8. 更新 CONTEXT、README、`docs/runtime.md` 与受影响的 `docs/visual/`。Plan 的用户选择、权限映射与只读约束边界使用同一说明；若形成新的模式表示决策，记录与 ADR 0003、0005 的关系。

## 验收标准

- [x] 普通开发会话的 `/mode` 和 Shift+Tab 提供四种选项，包含 Plan；Esc 取消不改状态。状态栏准确区分当前任务模式与后续任务默认模式。
- [x] 在 Plan 下连续提交至少两条普通消息，均保留计划说明和工具收窄；计划完成及“开始实现”消息不导致自动退出。手动切换后，新任务使用所选执行模式且没有计划说明。
- [x] Plan 固定使用 Auto review 的受限执行环境及策略：符合策略的读取进入独立审查，写入和非合格操作按策略转人工，审查失败转人工，不能自动升级为 Full access。`bash` 等保留工具的提示约束边界如实说明。
- [x] 计划白名单在装配、发送前与工具调用门一致生效；`edit`、`write`、记忆写入、非只读 MCP 与未列工具不可见，伪造调用被阻断。相关资格检查从新模式判断，不再读取文本标记。
- [x] Plan 中断后，保持 Plan 再 `/continue` 仍为计划模式；切到 Full access 再继续则使用 Full access 并开放对应执行工具。反向从执行任务继续到 Plan，以及显式一次性模式覆盖默认值也正确；旧批准不继承。
- [x] 会话默认模式切换不改写已排队、运行或等待审批的新任务。任务级接口不能进入或退出 Plan、不能改变其审批策略，拒绝时不修改权限版本或审批；非 Plan 任务的原有三种模式切换不回归。
- [x] TUI 切换普通开发会话时，Plan 按现有设置同步路径保存到目标会话。多客户端版本冲突、断线、后台重启与提交重试均显示并使用后台真实选择；同一请求不重复建任务。
- [x] CLI/API 默认设置、提交与继续可选择 Plan；配置中心能正确显示及设置适用会话的 Plan。main、SubAgent、归档会话与 IM 入口不能获得 Plan，后台校验不只依赖界面隐藏。
- [x] `/plan` 从 TUI 注册、补全、帮助和 README 命令表移除；TUI 视其为未知命令。CLI/API 输入 `/plan …` 不触发计划模式；旧输入和继续链也不触发计划模式，无历史特判或旧标记回填。
- [x] 完成 CONTEXT、运行文档及命中图解页同步，运行 `npm run typecheck`、相关测试和仓库规定检查。优先更新已有模式、计划、TUI 命令和执行画像的测试，覆盖真实模式流转；改动 `src/` 后按可视化文档 skill 完成图解检查。

## Comments

### 2026-10-07：创建工单与第一轮访谈

拥有者要求将计划模式与 Ask for approval、Auto review 和 Full access 并列，并删除 TUI 的 plan 命令。通过 grilling 与 ponytail 核实既有模式生命周期、工具约束、继续链、持久化和历史工单。

第一轮 Q1—Q4，拥有者答复：“Q2 采用 auto-review；其余按照推荐”。由此确认 Plan 常驻至手动切换、固定 Auto review、沿用既有工具白名单与提示约束、退役所有新提交的 `/plan` 文本标记、仅普通开发会话支持。Q5—Q8 尚待答复，状态为 `needs-info`。

### 2026-10-07：第二轮访谈与定稿

拥有者答复：“Q8 不需要兼容；其余按照推荐”。确认继续任务使用提交时当前模式，显式一次性模式优先；会话默认设置只影响后续新任务，Plan 不支持任务内部切换；Plan 随 TUI 切换普通开发会话沿用；旧 `/plan` 标记及继续链不保留任何计划行为兼容。

八项产品决定均已确认，决策前沿已收敛。正文整理为最终工单，状态为 `ready-for-agent`；本次交付为新增 issue，实现与验收属于后续任务。

### 2026-10-07：实现完成与验收

Plan 已纳入普通开发会话的 `/mode`、Shift+Tab、状态栏与配置中心，并通过既有版本更新、事件、快照与跨会话同步路径持久化。后台将会话默认与一次性提交模式明确区分于访问策略：Plan 固定保存为 `Task.planMode=true` 与 `accessMode=auto-review`，采用原有受限执行入口和审批策略。任务画像、说明、工具过滤与 SubAgent 管理器均读取固定字段；生成计划和“开始实现”输入不退出 Plan。TUI 删除 `/plan`，运行时与 Driver 删除文本及继续链模式识别；历史文本没有回填或专门恢复分支。

继续任务按当前默认或显式模式新建，既有任务与审批不因默认模式变化改写；Plan 任务的任务级模式切换在修改权限版本或审批前被拒绝。提交摘要改为记录原请求参数，未显式模式为 null，使用 `request-v2:` 前缀；通用旧摘要按原三种访问模式核实，同一请求不随后续默认值或任务模式变化漂移，显式 Plan 不与旧 Auto review 摘要混淆。schema 升到 32，控制协议升到 16，迁移验证了原会话字段、任务、索引、外键保留以及故障回滚和重试。

验收覆盖持续多轮 Plan、工具白名单与伪造调用阻断、发送前工具泄漏阻断、越界读取独立审查、写入与审查失败转人工、排队/运行/待审批任务模式固定、当前模式继续与显式覆盖、身份资格、TUI 取消/循环/跨会话/版本冲突/重连、后台重启及真实 CLI 设置/提交/继续。配置中心保存采用后台返回的真实版本，同值 Plan 保存不虚增本地版本。

最终 `npm run typecheck` 与 `git diff --check` 通过；`npm test` 共 1008 项，1007 通过、0 失败、1 跳过（未启用的真实模型连通性检查）。完整测试过程中修正了配置中心新增测试对相同通知重绘的等待，以及既有 QQ 最终汇报测试的等待竞态：后者在模拟回执延迟 200 毫秒时复现 `sending !== sent`，等待汇报记录落到 `sent` 后通过，生产发送逻辑未改。图解自动检查与人工渲染核对记录如下。本次未另行运行真实模型或独立 Linux 容器部署验证；访问后端与审批策略仍复用已覆盖的原路径。

### 2026-10-07：领域文档与图解同步、核实和渲染

已同步 CONTEXT 的“会话默认模式”“计划模式”，删除 README 命令表中的 `/plan`，更新 CLI 模式选项与 `set-session-mode` 示例，重写 runtime.md 计划模式及 TUI 说明，并记录 ADR 0025。Plan 使用独立任务字段与固定 Auto review 的组合，访问策略仍为 ADR 0003 / 0005 的三种；文档明确保留工具可能写入，不宣称全面只读保证。

图解变更清单：

- `task-lifecycle.html#states`：模式切换导致中断的行补明 SubAgent 与 Plan 任务拒绝切换。
- `task-lifecycle.html#restart`：继续创建新任务，按当前默认或显式模式决定 Plan，旧批准不继承。
- `task-lifecycle.html#mode`：默认模式四个选项、普通开发资格、版本条件保存、跨会话同步、提交时固定字段、任务级 Plan 拒绝，以及底栏在任务模式与默认值不同时同时显示。
- `tool-call-path.html#availability`：计划画像读取任务固定的 `planMode`；白名单、MCP 只读过滤、三处共用集合、固定 Auto review 与只读边界。
- `tool-call-path.html#modes`：Plan 映射自动审查列；修改委派从父任务固定字段判断。
- `context-pipeline.html#pipeline`：计划说明行改为按固定画像注入；说明要求持续完善计划和手动切换，不依赖任务输入或继续来源存在性。
- `orchestrator.html#subagent`（含 `#subagent-modify`）：准备阶段拒绝条件与修改委派正文改用父任务 `planMode`，删除继续链判断说法。
- `storage-layout.html#core-db`：会话默认字段与版本、任务 `plan_mode` 的用途；`#schema`：schema v32、迁移范围、会话 CHECK 重建和旧行默认非 Plan。
- `control-protocol.html#handshake`：快照恢复会话默认值与任务固定模式；`#outcome`：`request-v2:` 摘要绑定原请求参数、隐式模式记 null、通用旧摘要候选；`#ops`：提交/继续/默认设置接受 Plan，任务切换拒绝；`#events`：默认模式和入队字段；`#versions`：协议 v16。
- `once-only.html#table`：控制面提交摘要不随后续会话默认值变化。
- `index.html#core`：任务生命周期说明加入会话默认值固定到任务；相关页补全源码与 ADR 0025 链接。

本次变化对应的源码与核实位置：

- 会话四选项与任务三种访问策略分别在 `src/core/types.ts` 的 `SessionDefaultMode` / `SESSION_DEFAULT_MODES` / `AccessMode`，任务固定字段在 `Task.planMode` 和 `task.queued`。
- 提交固定 `planMode` 和 `auto-review`、普通开发身份检查及请求摘要：`src/runtime/runtime.ts:1942` 的 `submit`；`request-v2:` 为第 2013 行，旧摘要候选为第 2018 行。`src/core/store.ts` 的 `insertQueuedTask` 校验 Plan 固定使用 Auto review，事件带 planMode，`findMatchingSubmission` 核对原摘要或旧候选。
- 继续不继承模式：`src/runtime/runtime.ts:2099` 的 `continueTask`；默认设置只写会话：第 2121 行的 `setSessionDefaultMode`、`src/core/store.ts:509` 的同名方法；实际版本冲突码为 `default_mode_conflict`（第 513 行）。
- Plan 任务在修改权限、回收执行单元与失效审批之前拒绝：`src/runtime/runtime.ts:2149` 的 `switchTaskMode`；存储层 `requestModeSwitch` / `applyModeSwitch` 也拒绝 Plan。
- 画像、白名单、注入与三处使用：`src/agent/tool-availability.ts:85` 的 `executionProfile` / `taskToolSet`；`src/agent/driver.ts:552` 把 Task.planMode 交给画像，随后按 profile.plan 装配、激活、发送前复核和调用门过滤，并以 profile.plan 调用 beginContextAssembly，后者在 `src/agent/context-assembly.ts:455` 注入 `PLAN_NOTICE`；`src/agent/plan-mode.ts:9` / 第 27 行固定说明与白名单。
- 修改委派资格：`src/runtime/subagents.ts:310` 直接检查父任务固定 planMode，显式 modify 与继续 writeTarget 都拒绝。
- TUI 资格与循环：`src/tui/app.ts:1890` 的 `sessionModes`，`cycleMode` / `cmdMode`；跨会话同步在 `switchSession`（第 1360 行）的设置保存路径；底栏第 3024 行读取 Task.planMode，模式与默认相同合并显示、不同分别显示。注册表 `src/tui/commands.ts` 不再有 `/plan`；`src/tui/state.ts` 从 task.queued 应用 planMode，不读文本。配置中心 `src/config-tui/app.ts` 同样按会话资格提供选项，并保存后台返回的实际模式与版本。
- CLI 保存命令是 `src/cli.ts:420` 的 `set-session-mode`；submit/continue 的 `--mode` 经 `parseMode` 接受 Plan，未显式模式由后台固定。
- schema：`src/core/db.ts:15` 的 SCHEMA_VERSION=32，`ensureColumns` 新增 tasks.plan_mode（默认 0）；第 968 行的 `rebuildSessionModeCheck` 显式复制列、保留默认模式与版本并重建 create_request 索引。构造器在事务外关闭外键、事务内重建并检查外键、失败回滚，finally 恢复外键；没有历史文本回填。
- 协议：`src/core/types.ts` 的 PROTOCOL_VERSION=16，`src/control/protocol.ts` 头注释已记录 v16；`src/control/ops.ts` 与 server 参数校验区分会话/提交模式和任务访问模式。ConnectSnapshot 携带 Session/Task，`src/tui/state.ts` 从快照及事件恢复真实选择。

已修正文档与当前代码不一致的旧说法：一次性 `/plan`、下一条消息恢复执行、从源任务/继续链推导计划模式、访问模式不变、所有越界操作仍逐次人工审批、从输入推导 TUI 计划标注、隐式提交摘要取当前默认值，以及当前 schema v31 / 控制协议 v15。代码事实由上述提交、画像、说明、委派与迁移位置支持。协议页原“头注释只记六段变化”计数也不成立，已改为无数量的描述。

CLI/API `/plan …` 普通文本与 TUI 未知命令的用户操作细节在 README 和 runtime.md 说明；客户端 demo 数据、命令调度返回结构等内部适配不另加图解机制。

验证：最终 `npx tsx --test test/67-visual-docs.test.ts` 为 4/4 通过，源码锚点、取值覆盖、首页和站内链接均有效；`git diff --check` 通过。枚举覆盖由主代理更新为 AccessMode 与 SessionDefaultMode 两项，分别核对原三值和新增 plan。

渲染：对 task-lifecycle、tool-call-path、context-pipeline、orchestrator、storage-layout、control-protocol、once-only 均运行 `.agents/skills/visual-docs/shoot.sh`。七页分别 8 / 15 / 12 / 21 / 16 / 18 / 5 张，共 95 张；通过汇总图检查全部切片布局，再放大核对 17 张涉及改动的切片。最终状态表小改后重渲染 task-lifecycle，并核对第 2 张切片；没有文字重叠、越框、表格横向截断或箭头指向问题，页面均低于脚本 32000px 上限。

截图留在 `/tmp/vis-<页面>-<序号>.png`，汇总图为 `/tmp/qa-<页面>-slices.png`；不进入仓库。没有因同步文档发现需新增工单的代码问题，无未核实的本次模式文档项。Linux 执行边界与真实模型行为由主代理报告测试结果，本次文档 QA 未额外运行线上验证。
