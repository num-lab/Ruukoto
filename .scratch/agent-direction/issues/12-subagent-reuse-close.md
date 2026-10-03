Status: ready-for-agent

# 12 — 继续委派、跨工作复用并显式关闭 SubAgent

**What to build:** 同一个 SubAgent 可以继续原工作或接手新工作，保留上下文；主 Agent 和拥有者都能显式关闭它。

**Blocked by:** [11 — 主 Agent 委派通用 SubAgent 并收到结果](11-subagent-delegation.md)

依据：[已确认规格](../spec.md) 与 [ADR 0017](../../../docs/adr/0017-two-agent-products.md)。

## 验收标准

- [ ] 同一主 Agent、同一用户会话内，先补充原工作，再复用同一 SubAgent 承接另一工作，各次执行保留独立记录。
- [ ] 复用时重新确定当前工作、有效工具、资料、工作目录与权限，前次批准不延续。
- [ ] 任务终态、TUI 退出及空闲超时均不自动关闭；空闲不要求继续调用模型或运行工具进程。
- [ ] 主 Agent 和拥有者可查看并显式关闭，关闭后拒绝新委派；历史、产物及未汇总改动保持可查。
- [ ] 关闭与新委派发生竞争时结果明确，不能出现显示已关闭却继续接收任务的状态。
- [ ] 完成相关端到端检查、类型检查及仓库要求的验证；同步本次行为涉及的运行说明和图解，验证记录区分模拟结果与真实环境结果。

## Comments

### 2026-10-03：实施计划

基于 HEAD `e542261` 制定。11 已交付：核心库 v24（`sub_agents` / `work_delegations` / tasks 四个关联列）、控制协议 v11、`subagent_delegate` / `subagent_result`；全量 873 项中 872 通过、1 跳过。

现状核实：

- **继续原工作已部分可用**：带 `work_id` 委派时，同一 Agent 新建一条任务记录。
- **重新确定已基本成立**：每个任务自带 `read_scope`，worker 按任务 id 重建（`tool-router.ts` `workerKeyFor`），任务固定 confirm、无 grantedPaths；审批按 task_id 记录。
- **不自动关闭已成立**：没有任何路径会自动关闭 Agent；空闲时 Driver 已 dispose，不保留模型或进程。

实际缺口：

1. 没有把空闲 Agent 用于另一项工作的入口。
2. 没有关闭能力。
3. 继续委派不检查 Agent 是否忙。11 允许在任务运行时排队，登记时会覆盖 `current_task_id`；前一任务终态再把状态置为 idle，后一任务实际在跑却显示空闲。
4. 快照文件名 `materials-<key>.txt` 只按执行键命名。复用后，新工作的首键可能与旧工作某次执行的键相同，在同一目录内覆盖旧快照。
5. 发送前只复核本任务的来源引用。复用保留的上下文含旧工作资料，撤销后仍会注入。

#### 默认取舍（推荐即规格，有异议再改）

- **关闭用独立列，不改状态值。** `sub_agents` 增加 `closed_at`、`closed_by`（`owner` 或 `agent:<taskId>`）。`state` 继续只表示执行状态（running/idle/unverified），不重建 CHECK。待核实的 Agent 也能关闭，占用保留到 15 处理。
- **有活动任务时拒绝关闭。** 活动任务指 queued/running/awaiting_confirmation。提示等待任务结束，或由拥有者 `ruukoto cancel <taskId>` 后再关闭。不引入“已关闭但仍在跑当前任务”的中间态；整项取消属于 14。这样竞争结果只有两种：先关闭则委派报“已关闭”，先委派则关闭报“有活动任务”。
- **继续与复用都要求可用。** 可用指同一父会话、未关闭、state 为 idle 且无活动任务。忙碌时明确拒绝，不排队。这同时修复缺口 3。
- **复用的上下文是该 Agent 的全部历史。** 因此复核其所有任务来源引用的并集，任一撤销即不可再用，并提示新建 SubAgent。dev 的 read_paths 只按本次任务重新钉定；历史中已读过的正文与普通会话历史同等对待，本单不追溯。

#### 实施步骤

1. **存储 v24 → v25。**
   - `db.ts`：在 SCHEMA_SQL 与 `ensureColumns` 中为 `sub_agents` 补两列，追加迁移注释。
   - `types.ts`：`SubAgent` 增加 `closedAt`、`closedBy`；新增事件 `subagent.closed {subAgentId, parentSessionId, closedBy, taskId|null}`，`PROTOCOL_VERSION` 从 11 升到 12。
   - `store.ts`：
     - `closeSubAgent(id, at, by): boolean`，条件为 `closed_at IS NULL` 的一次写入；
     - `findActiveSubAgentTask(subAgentId)`；
     - row 映射与插入同步更新。
   - 旧行两列为空，不扫描、不改写旧记录。

2. **委派：复用入口与可用性检查**（`src/runtime/subagents.ts`）。
   - **入参**：`SubAgentDelegateInput` 增加 `subAgentId`，只在省略 `workId` 时使用。把现有 `isNewWork` 拆成 `newAgent`（两者都省略）与 `newWork`（省略 workId）。复用时插入一条新工作，指向既有 Agent，并发 `work_delegation.created` 事件（TUI 已按“同一 SubAgent 的新工作”分支处理）。
   - **可用性检查** `assertAvailable(agent, parentSession)`：准备前检查一次，登记事务内再检查一次。依次核对：
     - 父会话归属；
     - `closed_at`（报“已关闭”）；
     - idle 且无活动任务（报“正忙/待核实”）；
     - 工作目录 realpath 与 dev/ino 和子会话 `cwdReal/cwdDev/cwdIno` 一致，否则报“目录已不存在或被替换，请新建 SubAgent”。这对应“复用须核对实际文件状态”；
     - 若 19 已落地：该 SubAgent 名下有源自入站事件的工作（宿主 PR 评审，上下文含不可信资料）时拒绝复用，只能关闭。19 先实施则由 19 补上这一条。
   - **顺序**：查重仍最先执行，同键同参的重放即使 Agent 已关闭或忙碌也返回原记录，不新建任务。新工作路径在事务开头先按（父会话, 键）核实已提交记录，同参返回、异参冲突。这样同键并发也不再落到 UNIQUE 约束的原始报错。
   - **来源复核**：事务内对“该 Agent 历史任务的 sourceRefs ∪ 本次 sourceRefs”调用 `sources.verify`。
   - **快照**：改名为 `materials-<workId>-<key>.txt`，旧任务输入中的旧文件名不动。
   - **任务输入**：复用时多一行宿主说明：“本 SubAgent 此前承接过其他工作；只读路径与资料以本次为准，之前的范围不延续。”
   - **工具层**（`subagent-tools.ts`）：
     - `subagent_delegate` 增加可选 `sub_agent_id`，与 `work_id` 互斥；
     - 参数摘要只在提供 `sub_agent_id` 时纳入该字段，保持 11 的重放摘要不变；
     - 委派仍限拥有者发起的任务。

3. **关闭。**
   - **管理器**：`SubAgentManager.close({subAgentId, by})` 在同步事务内完成：
     - Agent 不存在报 not_found；
     - 由主 Agent 发起时，Agent 必须属于本父会话；
     - 已关闭则幂等返回；
     - 有活动任务时报 busy 并给出任务 id；
     - 否则写两列并发 `subagent.closed` 事件。
   - **保留内容**：不删除工作目录、会话、JSONL、产物与工作记录。
   - **主 Agent 入口**：新工具 `subagent_close(sub_agent_id)`，普通 dev 会话与 main 都装配。
     - 回报唤醒的轮次也允许关闭，因为关闭只收窄能力，不同于委派。
     - SubAgent 自身和其他父会话由 `verifyHost` 与归属检查拒绝。
     - `tool-op-ledger.ts` 规则表增加 `subagent_close: "subagent"`，`subagentOpCheck` 按 `closedAt` 判定是否已提交。
   - **拥有者入口**：控制面新 op `subagent_close {sub_agent_id}`，对应 Runtime 的 `closeSubAgent`（停止中拒绝）；CLI `ruukoto work close <SubAgentID>`。TUI 不新增命令。

4. **查看与展示。**
   - **主 Agent 查看**：`subagent_result` 的 `work_id` 改为可选。省略时列出本会话的 SubAgent：状态或已关闭、当前工作、名下工作、最近任务状态，供主 Agent 跨轮次挑选复用对象。按工作读取时同时标明 Agent 是否已关闭。
   - **拥有者查看**：`work list/show` 的 agent 对象自然带上两列。
   - **TUI**：`state.ts` 处理 `subagent.closed` 事件，`subAgentStateLabel` 在关闭时优先显示“已关闭”；demo 与默认对象补字段。
   - **提示词**：`session-factory.ts` 的 dev/main 提示补一句——补充原工作用 `work_id`，相关新工作可用 `sub_agent_id` 复用并保留上下文，不再需要时用 `subagent_close`。

5. **发送前复核并集**（`driver.ts` `checkBeforeSend`）。subagent 类会话的复核对象从本任务的 `readScope.sourceRefs` 改为本会话全部任务的并集，阻断原因仍为 `task_sources_revoked`。

不做：同级通信资格（13）、整项取消（14）、running/unverified 的恢复（15）、TUI 关闭命令、空闲超时配置（规格要求不自动关闭，无需配置）。

#### 验证与验收

新增 `test/81-subagent-reuse-close.test.ts`（编号实施时核实），复用 test/80 的 testkit、模型桩与 `realTools()`，逐条覆盖六项验收：

- **独立记录**：工作 A 首次 → A 继续 → 同一 Agent 用于工作 B。三条任务的 id、workId、readScope、结果各自独立。A 首次的 resultSummary/resultRef 在后续执行后逐字节不变。`activeWorkId` 依次切换。B 的模型请求包含 A 的回复正文，证明上下文保留。dev 与 main（经工具 + materials）各走一遍。
- **重新确定**：
  - B 任务的读范围只有 B 的路径，worker 实际拒绝读取 A 的路径；
  - 仍为 confirm、grantedPaths 为空、无审批记录；
  - 任务输入写明工作 B 与复用说明；
  - A 的资料来源撤销后，复用委派被拒；登记后才撤销时，发送被阻断；
  - 工作目录被删除或替换后，复用明确失败；
  - 跨父会话复用、在 SubAgent 会话中复用均被拒绝。
- **不自动关闭**：任务终态后断开已认证的控制面客户端（相当于 TUI 退出），再等待一段时间，`closedAt` 仍为空，模型请求数与 worker 均为零增量；重启后空闲 Agent 仍可复用。
- **查看与关闭**：
  - 主 Agent 用 `subagent_result` 总览、拥有者用 `work show` 都能看到状态；
  - 主 Agent 关闭与拥有者 CLI 关闭各一次，重复关闭幂等；
  - 关闭后新委派报“已关闭”，同键重放返回原记录且不新增任务；
  - 会话历史、产物、工作目录与 `subagent_result` 仍可读；
  - 有活动任务时关闭被拒，`ruukoto cancel` 后可以关闭；
  - 其他父会话和 SubAgent 自身不能关闭。
- **竞争**：
  - 委派已发出、尚在 await 准备阶段时同步关闭，委派在事务内报“已关闭”，零新任务；
  - 委派先提交时关闭报“有活动任务”；
  - 两个复用请求并发指向同一空闲 Agent，一个成功、一个报“正忙”；
  - 任何时刻都不存在“已关闭且有 queued/running 任务”的组合（断言 SQL）。
- **迁移与账本**：v24 → v25 时旧 sub_agents、工作与任务保留，新列为空；`subagent_close` 的账本核实结果正确。

test/80 的继续委派用例改为先等待 Agent 变为 idle 再继续，以符合新的可用性规则。

```bash
npx tsx --test test/81-subagent-reuse-close.test.ts test/80-subagent-delegation.test.ts test/27-orchestration.test.ts test/39-coding-delegation.test.ts test/39-coding-results.test.ts test/62-tool-availability.test.ts test/64-tool-op-ledger.test.ts test/66-control-seam.test.ts test/59-system-prompt.test.ts
npx tsx --test test/13-tui-state.test.ts test/14-tui-app.test.ts test/29-cli-entry.test.ts test/34-event-flow-view.test.ts test/36-event-flow-state.test.ts
npm run typecheck
npx tsx --test test/67-visual-docs.test.ts
npm test   # nohup + 退出码文件，跑时不改 src/test
```

新增 `.scratch/agent-direction/smoke-12-subagent-reuse-close.mts`，沿用 smoke-11 的结构与 `--remote` 方式，在真实 Runtime、控制面、SQLite、独立 JSONL 与 Docker 受限 worker 上运行，macOS 本机与 `ssh tx` 各跑一轮。检查内容：

- 继续委派与复用的执行记录相互独立；
- 复用后旧路径在真实容器中实际被拒；
- 经 CLI `work close` 关闭后委派被拒；
- 关闭后历史、产物与目录仍在；
- 空闲期间无残余容器；
- 重启后关闭状态保持、空闲 Agent 仍可复用。

模型与消息平台为模拟，分别记录。真实 QQ/Telegram 仍记为未实测。

文档同步：

- `CONTEXT.md` 的 SubAgent 条目改写当前实现说明。
- `docs/runtime.md` 的 SubAgent 章节补充继续、复用、关闭、可用性规则与快照文件名。
- ADR 0020 追加“继续、复用与关闭（issue 12）”补充段，记录上面四项取舍；ADR 0017 实施记录加一行。
- 对每个改动的 `src/` 文件执行 `grep -l <路径> docs/visual/*.html`，预计命中 orchestrator、tool-call-path、storage-layout、control-protocol、context-pipeline、deployment，同步后跑 test/67。

完成时逐条登记六项验收证据，区分离线逻辑测试、真实后台与执行边界、模拟模型/平台和真实平台。本次只保存计划，工单状态与验收勾选保持不变。

### 2026-10-04：与委派失败清理的协调

`delegate` 准备阶段现有两处清理缺口：正文超过 `INPUT_TEXT_CAP` 时新建目录会残留；沿原工作委派失败时写入的快照文件会残留。两处已登记为 [visual-docs-review 工单 03](../../visual-docs-review/issues/03-subagent-delegate-leaves-files.md)。本工单改快照命名、改造准备阶段时，如果先合入，请让失败清理覆盖新命名的文件，或者顺手把 03 一起修掉。
