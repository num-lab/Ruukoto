Status: resolved

# 14 — 取消整项工作而不影响其他委托

**What to build:** 拥有者或主 Agent 可以取消一项工作，停止它的活动和排队子任务，其他工作继续执行。

**Blocked by:** [11 — 主 Agent 委派通用 SubAgent 并收到结果](11-subagent-delegation.md)

依据：[已确认规格](../spec.md) 与 [ADR 0017](../../../docs/adr/0017-two-agent-products.md)。

## 验收标准

- [x] 同时存在两项工作时，取消其中一项会停止其所有活动及排队任务，另一项保持可执行。
- [x] 取消与子任务创建、工具执行或结果回传发生竞争时，不遗漏已属于被取消工作的执行。
- [x] 迟到结果保存为事实，不唤醒并重新启动被取消工作；未知效果操作不自动重放。
- [x] 取消任务不自动销毁 SubAgent 身份，不丢弃历史、产物或未汇总改动；拥有者能查到明确终态。
- [x] 完成相关端到端检查、类型检查及仓库要求的验证；同步本次行为涉及的运行说明和图解，验证记录区分模拟结果与真实环境结果。

## Comments

### 2026-10-03：实施计划

基于 HEAD `e542261` 制定。11 已交付：核心库 v24、控制协议 v11、`subagent_delegate` / `subagent_result`。12 的计划尚未实施，会带来 v25 / v12；本单的版本号实施时按实际落地顺序核实，与 12 同批发布时可以合并为一次升级。

现状核实：

- **单任务取消已可用**：`Runtime.cancelTask`（`src/runtime/runtime.ts:2770`）对 queued 任务直接条件转换为 canceled；对 running/awaiting 任务走 `Driver.requestStop`（`src/agent/driver.ts:964`）。停止路径依次持久化意图、快照账本、解除审批等待、abort、回收进程组、`settleTask` 补记，再由 `finalize`（`driver.ts:1024`）只在 running/awaiting 状态下条件写终态；效果未知的操作标记 `effect_unknown`，不重放。
- **终态口径**：编排器把 canceled 映射为 failed，超时取消映射为 timeout（`src/runtime/orchestrator.ts:547`）。`handleSubAgentTerminal`（`:711`）将结果与 idle/unverified 状态同事务登记，main 父会话按 `wake:<childId>` 唤醒（`:810`、`:876`），启动巡检按同键补发（`:593`，`src/core/store.ts:899`）。旧 analyze 自动重试门要求 `status === "failed"`（`orchestrator.ts:616`），canceled 不会触发；新 analyze 已走 SubAgent 链路，没有重试。
- **dev 父会话的结果注入**：`listUndeliveredSubAgentResults`（`store.ts:1036`）在下一次父任务开始时注入（`driver.ts:717`）。
- **委派登记事务**（`src/runtime/subagents.ts:214`）同步执行，与另一个同步事务天然串行。

实际缺口：

1. 没有工作级取消，也没有工作取消状态（`work_delegations` 只有创建字段，`src/core/types.ts:158`）。
2. 已取消工作仍可继续委派，登记事务不检查取消。
3. 已取消工作的迟到结果仍会唤醒 main（包括巡检补发），也仍会注入 dev 父模型，可能促使主 Agent 重启这项工作。
4. **单任务取消存在丢失窗口**：队列循环把任务转为 running（`runtime.ts:2597`）之后，要先 `await this.getDriver(session)`（`:2622`），`driver.run` 才设置 `currentTask`（`driver.ts:691`）。取消落在这个窗口时，`requestStop` 在 `driver.ts:968` 直接返回 false，而停止意图要到 `:974` 才持久化。结果是取消被吞掉，任务照常运行。工作取消要逐个停止 running 任务，同样会遗漏。
5. 拥有者和主 Agent 都没有取消入口，`work list/show`（`src/control/server.ts:851`、`src/cli.ts:724`）也看不到工作的终态。

#### 默认取舍（推荐即规格，有异议再改）

- **取消状态用独立列，一次写入。** `work_delegations` 增加 `canceled_at`、`canceled_by`（`owner` 或 `agent:<taskId>`）、`cancel_reason`，条件为 `canceled_at IS NULL`，重复取消幂等返回原记录。工作状态由字段与任务状态派生：已取消、进行中（有活动任务）、空闲。不新建状态机，也不改写已结束任务的 completed/failed/canceled 结果。
- **发起者：拥有者与主 Agent。**
  - 拥有者走控制面 `work_cancel` 和 `ruukoto work cancel <工作ID> [--reason R]`。
  - 主 Agent 用新工具 `subagent_cancel(work_id, reason?)`，普通 dev 会话与 main 都装配。回报唤醒的轮次也允许，因为取消只收窄能力，与 12 的关闭同一口径。
  - SubAgent 自身（无此工具，`verifyHost` 拒绝）和其他父会话的工作一律拒绝。
- **一个事务登记，停止在事务外完成。** 事务内依次：
  - 写入取消字段；
  - 该工作的 queued 任务直接转为 canceled，`errorMessage` 记 `work_canceled`；
  - running/awaiting 任务写 `cancel_requested=1`；
  - 追加 `work_delegation.canceled` 事件。

  提交后对每个活动任务调用现有 `cancelTask(taskId, {reason: "work_canceled"})`，用 `Promise.allSettled` 等待停止完成，返回各任务的最终状态。无法回收的执行按现有逻辑保留占用，SubAgent 记为 unverified。
- **竞争口径：**
  - **与委派登记**：登记事务内拒绝已取消的工作。两个事务串行，所以先登记的任务必然在取消事务的清单内，后登记的必然被拒，不会遗漏。新工作和其他工作不受影响。同键重放仍返回原记录，不新建任务。
  - **与任务启动**：修复缺口 4，作为根因修复，所有取消调用方都受益。`cancelTask` 先在事务内写 `cancel_requested=1`，再 `requestStop`；`Driver.runInner` 开头读取到该标记就直接 `finalize(canceled)`，不调用模型。这样取消要么被启动检查拦下，要么 `requestStop` 已经能找到 `currentTask`，窗口关闭。已知上限：超时取消如果正好落在这个窗口，终态会记为 failed 而非 timeout，不另外存原因（`ponytail:` 注释）。
  - **与工具执行**：沿用账本的停止快照与 `settleTask`，效果未知的操作只标记、不重放。已取消的工作不能再登记执行，SubAgent 链路也没有自动重试。
  - **与结果回传**：迟到结果照常通过 `setTaskResult` 保存为事实，`subagent_task.*` 事件、`subagent_result` 与 `work show` 都可查。取消提交后，这项工作的结果不再自动送进任何父模型：
    - `handleSubAgentTerminal` 在唤醒前重新读取工作，已取消就不建 wake；
    - 队列循环对 `wake:<childId>` 任务加一道检查（`runtime.ts` `runQueueLoop`，与 `inboundGate` 同处），子任务所属工作已取消就取消这个 wake。所有唤醒都经过这里，所以能同时覆盖取消前已排队的 wake、检查后才插入的 wake 和巡检补发的 wake；
    - dev 的注入查询增加 `canceled_at IS NULL`。

    选择“不注入”而不是“以迟到结果名义注入”，是为了用一条规则排除主 Agent 据此重启工作的可能；需要时由主 Agent 主动 `subagent_result` 读取。
- **身份与成果保持。** 取消不关闭 SubAgent，任务结束后按占用核实记为 idle 或 unverified，之后仍可按 12 的规则复用于其他工作。工作目录、会话 JSONL、产物与工作记录都不删除。16/17 的 worktree 与未汇总改动同样不动，由 17 负责汇总。
- **旧 coding draft 不纳入。** 它没有 `work_id`，仍可用 `ruukoto cancel <taskId>` 单独取消；17/23 迁移后自然纳入工作取消。

#### 实施步骤

1. **存储。**
   - `db.ts`：在 SCHEMA_SQL 与 `ensureColumns` 中为 `work_delegations` 补三列，追加迁移注释，版本号实施时核实。
   - `types.ts`：`WorkDelegation` 增加 `canceledAt`、`canceledBy`、`cancelReason`；新增事件 `work_delegation.canceled {workId, parentSessionId, subAgentId, canceledBy, reason, canceledTaskIds, stoppingTaskIds}`；`PROTOCOL_VERSION` 升一档。
   - `store.ts`：增加 `cancelWorkDelegation(id, at, by, reason): boolean`（条件更新）与 `listActiveTasksByWork(workId)`，更新 row 映射与插入。
   - `listUndeliveredSubAgentResults` 增加 `canceled_at IS NULL` 条件。`listRoleTasksPendingWake` 增加 NOT EXISTS 已取消工作的条件，避免巡检先建 wake 再被取消。
   - 旧行三列为空。

2. **单任务取消的窗口修复**（根因，所有调用方共享）。
   - `Runtime.cancelTask` 的 running 分支在 `getDriver` 之前，先在事务内 `setCancelRequested(id, true)`。
   - `Driver.runInner` 开头：`store.getTask(task.id)?.cancelRequested` 为真时 `finalize(task, "canceled", {interruptReason: "cancel_requested"})` 并返回。

   调用方包括：控制面、超时巡检、入站门、调度、QQ 撤回（`grep cancelTask(` 共 11 处）。语义都是“取消”，修复后不会再吞掉。

3. **工作取消**（`src/runtime/subagents.ts`）。
   - **管理器**：`SubAgentManager.cancelWork({workId, by, reason, parentSessionId?})` 按上述事务完成登记，依赖新增的 `cancelTask(taskId, reason)`（Runtime 接线）。
     - 工作不存在报 not_found；
     - 由主 Agent 发起时核对父会话归属；
     - 已取消则幂等返回原记录和当前任务状态。
   - **委派检查**：`delegate` 在准备前和登记事务内（`:214` 起）都检查 `work.canceledAt`，命中报 `invalid_state: 工作已取消`。同键重放的查重仍在最前面。
   - **控制面与 CLI**：`Runtime.cancelWork`（停止中拒绝）、控制面 op `work_cancel {work_id, reason?}`、CLI `ruukoto work cancel`。

4. **主 Agent 工具。**
   - `subagent-tools.ts` 新增 `subagent_cancel`，加入 `SUBAGENT_TOOL_NAMES`。
   - `tool-op-ledger.ts` 规则表增加 `subagent_cancel: "subagent"`；`subagentOpCheck` 按 `op.toolName` 分支，取消以 `canceledAt` 非空判定为已提交（12 的 `subagent_close` 按 `closedAt` 判定，同一处分支）。
   - `subagent_result` 的工作头部标明取消时间、发起者和原因。
   - `session-factory.ts` 的 dev/main 提示补一句：不再需要的工作用 `subagent_cancel`，已取消的工作不能继续委派。

5. **结果回传门。**
   - `orchestrator.ts` `handleSubAgentTerminal` 在 `:810` 唤醒前重新读取工作，已取消就返回。
   - `runtime.ts` `runQueueLoop` 增加 wake 检查（见上）。

6. **展示。**
   - `tui/state.ts` 处理 `work_delegation.canceled`：写入工作字段并追加说明。`worksSummaryForSession` 对已取消的工作显示“已取消”。创建事件补出的对象带上三列 null。
   - `demo-session.ts` 补一条取消事件。
   - `work list/show` 的工作对象自然带上新字段。TUI 不新增命令。

**与相邻工单的交界：**
- **12：** 关闭仍拒绝有活动任务的 SubAgent，提示语加上 `ruukoto work cancel <工作ID>`；继续已取消的工作由本单在委派检查中拒绝；复用以 SubAgent 可用性为准，不受旧工作取消影响。两单的委派检查谁先落地，另一单按实际代码合并。
- **13：** 已取消工作的成员失去该工作的通信资格。
- **15：** 重启时 `canceled_at` 与 `cancel_requested` 均已持久化，`backend_restart` 中断事件携带 `cancelRequested`。15 保证已取消工作的中断任务不被恢复，巡检不唤醒。
- **17：** 取消不删除 worktree 或未汇总改动。
- **18：** 18 的计划已定已取消的工作不自动向原 IM 入口汇报，取消所在轮次已有回复。本单的 wake 拦截保证不会产生汇报轮次；18 若先实施，本单在其收尾判定中加入 `canceled_at`。

不做：
- 整项工作级联到 main 正在运行的唤醒轮次（只拦截排队中的 wake）；
- 工作级“完成/关闭”状态；
- TUI 取消命令；
- 旧 coding draft 纳入工作取消；
- 重启后的恢复决策（15）。

#### 验证与验收

新增 `test/<NN>-subagent-cancel-work.test.ts`（编号实施时核实，避开 12 的 test/81 以及 16 等计划占用的编号），复用 test/80 的 testkit、模型桩（可挂起的 responder）与 `realTools()`：

- **只停被取消的工作**：同一父会话下工作 A 有一个 running（模型挂起）和一个 queued 任务，工作 B 有一个 running 任务。取消 A 后：
  - A 的 queued 任务直接变为 canceled（零模型请求）；
  - A 的 running 任务经停止路径变为 canceled，worker 已回收；
  - B 的任务继续完成，B 之后仍可继续委派；
  - dev（拥有者 CLI 取消）与 main（`subagent_cancel` 工具）各走一遍。
- **竞争：**
  - 委派已发出、尚在准备阶段的 await 中时取消，委派在事务内报“工作已取消”，零新任务；
  - 委派先提交时，新任务出现在取消的 canceledTaskIds 中；
  - 注入钩子让取消落在“已转 running、`currentTask` 尚未设置”的窗口，任务以 canceled 结束，零模型调用。另加一例普通单任务 `cancelTask` 的同窗口回归；
  - 工具执行中取消：`mock_mark` 已开始时停止，操作标记 effect_unknown，没有任何重放或重试；
  - 自然完成与取消竞争，最终只有一个终态，已完成的结果不被改写；
  - 断言 SQL 不变式：已取消工作下不存在 queued 任务。
- **迟到结果：**
  - 取消提交后才完成的任务，结果记录一次，`subagent_task.*` 事件与 `subagent_result` 可查；
  - main 父会话没有新的 wake 任务；取消前已排队的 wake 被队列检查取消，并且不调用模型；
  - 重启后巡检不补发 wake；dev 下一轮上下文不含该结果；
  - 已取消的工作不能再登记执行，同键重放只返回原记录。
- **身份与终态：**
  - 取消后 SubAgent 未关闭，状态为 idle（无法回收时为 unverified，用 test/80 的占用注入方式验证）；
  - 工作目录文件、会话 JSONL、产物和 resultRef 仍可读；
  - `work show` 和 TUI 摘要显示已取消及发起者与原因，重复取消幂等；
  - 其他父会话和 SubAgent 会话都不能取消；
  - 迁移后旧工作的取消字段为空，`subagent_cancel` 的账本核实结果正确。
- **回归**：test/80 全部用例；超时取消仍记为 timeout（窗口外）。

```bash
npx tsx --test test/<NN>-subagent-cancel-work.test.ts test/80-subagent-delegation.test.ts test/27-orchestration.test.ts test/39-coding-delegation.test.ts test/39-coding-results.test.ts test/03-lifecycle.test.ts test/10-access-modes.test.ts test/22-auto-review.test.ts test/34-event-stream-backend.test.ts test/62-tool-availability.test.ts test/64-tool-op-ledger.test.ts test/66-control-seam.test.ts test/59-system-prompt.test.ts test/40-qq-private.test.ts
npx tsx --test test/13-tui-state.test.ts test/14-tui-app.test.ts test/29-cli-entry.test.ts test/34-event-flow-view.test.ts test/36-event-flow-state.test.ts
npm run typecheck
npx tsx --test test/67-visual-docs.test.ts
npm test   # nohup + 退出码文件，跑时不改 src/test
```

新增 `.scratch/agent-direction/smoke-14-cancel-work.mts`，沿用 smoke-11 的结构与 `--remote` 方式，在真实 Runtime、控制面、SQLite、独立 JSONL 与 Docker 受限 worker 上运行，macOS 本机与 `ssh tx` 各跑一轮。检查内容：

- 两项工作并行，经 CLI `work cancel` 取消其中一项；
- 被取消工作的运行中容器实际退出，queued 任务未启动；
- 另一项工作照常完成；
- 迟到结果可查，但没有唤醒；
- 空闲期间无残余容器；
- 重启后取消状态保持，旧任务不运行。

模型为模拟、消息平台不启用，分别记录。真实 QQ/Telegram 仍记为未实测。

文档同步：

- `CONTEXT.md`：工作委托条目补充当前实现的取消说明。
- `docs/runtime.md`：SubAgent 章节补充取消的入口、事务口径、竞争规则、迟到结果不送达父模型，以及单任务取消窗口的修复。
- ADR 0020 追加“整项取消（issue 14）”补充段，记录上述取舍；ADR 0017 实施记录加一行。
- 对每个改动的 `src/` 文件执行 `grep -l <路径> docs/visual/*.html`，预计命中 task-lifecycle（取消路径与启动检查）、orchestrator（迟到结果不唤醒）、tool-call-path、once-only、storage-layout、control-protocol、context-pipeline、deployment，同步后跑 test/67。

完成时逐条登记五项验收证据，区分离线逻辑测试、真实后台与执行边界、模拟模型/平台和真实平台。本次只保存计划，工单状态与验收勾选保持不变。

### 2026-10-04：实施完成与验收证据

按 2026-10-03 计划实施。实施时 12 已落地（HEAD `a5377c9`），版本号按实际落地顺序取：核心库 v25 → v26、控制协议 v12 → v13。全部取舍按「默认取舍」执行；测试编号取 82（12 占 81，16/18 计划仅占位）。实施中的必要附带修复：`db.ts` `migrateFrom` 范围 `<= 24` 扩为 `<= 25`（不改则 v25 库无法打开，test/75 的 v19 升级用例一并核实）；`test/75` 的 v25 固定断言随版本升 v26。

**验收证据（离线逻辑测试，模型为 MockModelServer 模拟）：**

1. **只停被取消的工作**：`test/82`「只停被取消的工作（dev）」——工作 A 的 running（模型挂起）经停止路径 canceled（取消意图持久化、占用释放）、直接落库的排队任务直接 canceled（`work_canceled`、零模型请求），事件 `work_delegation.canceled` 的 `canceledTaskIds`/`stoppingTaskIds` 分开登记；工作 B 照常完成并可继续委派；已取消工作拒绝继续委派（`invalid_state`），同键同参重放返回原记录；SQL 不变式（已取消∧queued = 0）逐例断言。拥有者控制面 `work_cancel`（CLI 同路）与主 Agent 工具 `subagent_cancel`（main，`by=agent:<任务ID>`）各走一遍。
2. **竞争**：`test/82`「竞争」——准备阶段门闩化管理器：取消落在准备 await 中时登记事务报「工作已取消」零新任务；先提交的继续委派出现在取消事件的 `canceledTaskIds`；自然完成与取消竞争唯一终态且已完成结果不被改写。「取消窗口」——延迟化 `getDriver` 注入「已转 running、currentTask 未设置」窗口：工作取消与普通单任务 `cancelTask` 各一例，任务以 canceled 结束、零模型调用（根因修复：`cancelTask` 先事务内写 `cancel_requested`，`runInner` 开头读到标记直接定态）。“工具执行中取消”维度：SubAgent 任务只有只读工具，带副作用操作无法存在于子任务，按计划的共享停止路径语义用单任务覆盖——`mock_mark` 已开始时取消，操作标 `effect_unknown`、标记不重放、调用不重试（取消执行路径只有 `cancelTask` → Driver 停止路径一条，工作取消复用同一路径）。
3. **迟到结果**：`test/82`「迟到结果」——取消前已排队的 `wake:<childId>` 被队列启动前检查取消（`work_canceled`）且不调用模型；dev 下一轮上下文不含该结果（`[SubAgent 结果]` 注入排除已取消工作）；「身份与终态」含 main 挂起取消——迟到结果登记一次、`subagent_task.failed` 事件可查、main 不建 wake；重启后巡检清单不含已取消工作的子任务（`listRoleTasksPendingWake` 的 NOT EXISTS 实测挡住补发）、取消与未关闭状态跨重启保持、无新模型调用。超时取消仍记 `deadline_exceeded`（窗口外），由 test/27/03 回归覆盖；窗口内的已知上限（记 canceled 非 timeout）已在 driver.ts 写 `ponytail:` 注释。
4. **身份与终态**：`test/82`「身份与终态」——取消不关闭 SubAgent：正常回收记 `idle`、占用注入（test/80 手法）记 `unverified`，`closedAt` 不变；工作目录、会话 JSONL、`resultRef` 保留可读；已完成任务的结果摘要/引用/最终回答不被改写；`work_get`（work show 同数据）带取消三列；重复取消幂等（只发一次事件）；其他父会话与 SubAgent 会话的取消均报「不属于本会话」；`subagent_cancel` 账本核实 committed/not_committed（`subagentOpCheck` 按 `canceled_at`）。「v25 → v26 迁移」——旧工作的三列为空、条件写入幂等、账本先 not_committed 后 committed。TUI 摘要与 note 显示已取消及发起者与原因（随 test/13/14/19 回归）；（Spec 指出的摘要缺原因一处已采纳补齐）。
5. **仓库要求的验证**：`npm run typecheck` 无错；定向套件 test/82（8 例）+ 80/81/27/39×2/03/10/22/34(event-stream)/62/64/66/59/40（54+70 例）+ 13/14/29/34(event-flow)/36（84 例）+ 67（4 例）+ 75（12 例）全绿；`npm test` 全量 891 项：890 通过、0 失败、1 跳过（基线同前）。

**真实环境（模型/平台仍为模拟，模型为 MockModelServer）：** `smoke-14-cancel-work.mts` 在真实 Runtime + 控制面 + SQLite + 独立 JSONL + Docker 受限 worker 上 7/7 PASS，macOS 本机（darwin arm64）与 `ssh tx` Linux 各一轮：两项工作并行经真实 CLI `ruukoto-dev work cancel <工作ID> --reason …` 取消一项（`alreadyCanceled:false`、`canceledBy:"owner"`）、排队任务零模型请求、运行中容器实际退出（`docker ps -a` 为空）、另一项工作照常完成、迟到结果事件 / `work_get` 可查且不唤醒、下一轮只注入未取消工作的结果、空闲无残余容器、重启后取消与未关闭保持、旧 queued 任务保持 canceled 且不变式成立。（首跑 `ssh tx` 因远端磁盘 100% 失败于 `npm ci`；清理旧 smoke 同步目录释放 2.6G 后复跑通过，与代码无关。）

**同步**：`CONTEXT.md` 工作委托与 SubAgent 条目；`docs/runtime.md` SubAgent 章节（新增「整项取消（issue 14）」，登记/竞争/迟到结果/窗口修复/控制面 op）；ADR 0020 补充段「整项取消（agent-direction issue 14）」六条决定；ADR 0017 实施记录一行；`src/control/protocol.ts` 注v13。`docs/visual/` 按 .skills/visual-docs 同步八页：control-protocol（op `work_cancel`、事件 `work_delegation.canceled`、版本 v13）、orchestrator（lede、三层记录 v26 与取消列、委派时序图唤醒门、拒绝表「工作已取消」行、新节「整项取消」含登记事务时序图）、task-lifecycle（启动/取消转换行、runInner 判定首条、wake 门、SubAgent 取消行）、storage-layout（v26、迁移表）、tool-call-path（`subagent_cancel` 四处）、context-pipeline（注入排除与提示）、once-only（账本核实）、index（编排器卡片）；`shoot.sh` 全页 18 张切片逐张核对无重叠/截断/错向。同步中发现并修复：`docs/visual/orchestrator.html` 的 SubAgent 取消行原说「首版没有取消整项工作的入口」（过时，已改）；其他页无既述与新行为冲突的事实。核实时另发现 test/75 的版本固定断言随升级需同步（已修，属测试维护项而非代码缺陷）。

**code-review（两轴）**：Standards 无硬性违规（`ponytail:` 注释、既有事务机制复用、图解页锚点均合规；7 处判断调用逐一核定，均与现有惯例自洽，如 `WorkCanceledBy`/`SubAgentClosedBy` 同形分名、deps lambda 与本文件 `kickSession` 风格一致，不采纳改动）。Spec 指出的「TUI 摘要缺取消原因」已采纳（`worksSummaryForSession` 补上 `cancelReason`）；「awaiting_confirmation 且无 Driver 的任务」组合与既有单任务 `cancelTask` 口径完全一致（awaiting 任务必有持有它的 Driver，重启恢复另有补记），非本单引入，维持现口径；迁移用例对 `work_get` 三列的覆盖由 smoke A5 承担；回归与双平台冒烟的实际执行记录即本条。

**未实测**：真实 QQ/Telegram 平台（模型与消息平台均为模拟，分别记录）。
