Status: resolved

# 运行中任务的收尾协议集中到一个函数

## 目标与边界

目标：运行中任务的收尾协议只在 `packages/agent/src/task-ending.ts` 实现一次，覆盖取消意图、账本快照、停止核实、结算、终态、停止结论与唤醒。Driver、宿主操作和工作流作业改为提供 `halt` 与同事务写入。契约、范围、不变项、行为变化与被否方案见[决策笔记](../../../.agents/notes/implemented/architecture/2026-10-16-task-ending-protocol.md)，本工单不重复。

来源：2026-10-16 架构评审候选 01；拥有者同日分三轮逐题确认全部推荐，并在独立审查后授权修订本方案。它接续[工单 14](14-task-ending.md)：工单 14 统一了 `Store.endTask` 的事务，本单统一事务之前的协议。

非目标：

- 不改落盘与事件格式，也不统一停止结论存储；
- 不建任务到归属的登记表；
- 不改嵌套归属下由谁结束任务；
- 不动 queued 终态、`recover()`、`resumeQueue`；
- 不改 `CONTEXT.md`。

## 方案

以下方案已通过独立复审，四项审查意见均在方案层关闭，记录见 Comments。实施时先写用例，后改调用方；每步完成后跑对应定向用例。

1. 在 `test/94-task-ending.test.ts` 加函数级用例，先失败。用真实 Store、真实 `ToolOpLedger` 和可控的 `halt` 覆盖笔记「验收标准」，包括嵌套结束与自然完成竞争、迟到结果、事务回滚后快照保留、唯一终态与唯一唤醒。
2. 新增 `packages/agent/src/task-ending.ts`：导出 `TaskEndingContext` 与 `endTaskExecution`，按笔记四步顺序实现。中止快照在所有中止动作前同步保存；终态事务前重读共享容器。模块不持有按任务去重的 Promise 或归属登记表。加 `Note:` 锚点，并为存储统一留 `XXX`；沿 agent 包已有 exports 模式供 runtime 引用。
3. Driver（`packages/agent/src/driver.ts`）：`run(task, ending?)` 在本任务初始化时接入上下文，省略时创建本任务独有的对象；`requestStopInner`、`finalize`、`boundaryTask` 与 `yieldWorkspace` 的失败收尾共用它。提供当前任务上下文的只读引用入口供 Runtime 捕获失败兜底所需对象。各路径的 `halt` 保留各自已有的停止动作：显式停止中的 SDK 中止与进程回收仍并行，审批与 assembly 中止移到快照之后；自然完成及工具回调内的失败路径不一律增加 `sdk.abort()`，避免等待当前工具自身。保留原浏览器、MCP、输出与思考清理的适用路径及停止结论。
4. 宿主操作（`packages/runtime/src/host-execution.ts`）：attach 时创建本任务上下文；`stop`／`stopInner` 改用新函数，`halt` 停止 entries。`inTx` 写工作副本宿主结果与 `workCopyHost.stopVerified`，或 `updateWorkflowExecution`；失败兜底不清空已取得快照。
5. 工作流（`packages/runtime/src/workflows.ts`、`workflow-steps.ts`）：
   - `AgentJob` 创建上下文，通过新增的 `WorkflowAgentContext.ending` 传入 `WorkflowSteps.agent`，在调用 `Driver.run` 时原样传递；同步直接构造该上下文的测试夹具。
   - `stopJob` 的中止路径在 `job.controller.abort()` 与等待 entries 前取得首次快照；即使 `stopJob(false)` 已开始，也先保存首次中止快照与取消意图，再复用停止 Promise，不能被 `job.stop` 早退跳过。自然收尾与 catch 使用同一对象，避免 `halt` 等待包含自身的收尾 Promise。
   - `runAgent` 的自然收尾不再以空快照结算，步骤写入放进 `inTx`；自然停止的 `stopJob(false)` 只承担执行单元停止与结论复用，避免它和 `runAgent` 重复执行收尾协议。catch 的 `halt` 返回已存的 `stopVerified`，终态在各自停止开始时按运行状态决定。
   - `unsafeReason` 增加与最终输出无关的逐操作结果缺失检查，与 `safeToRetry` 共用现有只读／审批未消费分类；结果缺失且不能证明无写入的操作返回 `write_result_missing`。该查询不补账本，完整写结果与合法输出可正常完成。
   - 在 `test/105-workflow-runtime.test.ts` 覆盖合法输出仍因写结果缺失暂停、依赖不派发及正常结果放行；同步自然收尾不补只读结果的旧断言。在 `test/107-workflow-runtime-wiring.test.ts` 或 `test/112-workflow-real-steps.test.ts` 覆盖默认适配器共享上下文与嵌套停止。
6. Runtime（`packages/runtime/src/runtime.ts`）：
   - 普通队列在 `getDriver` 前创建上下文，传入 `Driver.run`，调度 catch 复用。已取得 Driver 后异常，`halt` 等待 `driver.stopManagedProcesses(task.id)` 后固定返回 false；调用抛错由统一入口按未核实处理。worker 停止成功不代表浏览器等全部应停资源已退出，兜底保留占用及 `tool_process_unreaped` 事件。只有本次 `getDriver` 未返回即抛错、尚未调用本任务 `run` 时，`halt` 返回 true。
   - 在 `test/94-task-ending.test.ts` 增加真实队列回归：浏览器停止返回 false、首次终态事务执行变更后抛错并回滚、worker 停止返回 true，断言调度 catch 仍保留占用及未核实事件，同目录后续任务保持 queued；另覆盖 `getDriver` 未返回时释放、已取得 Driver 的异常保守保留、已提交终态不被覆盖。测试必须经过真实 catch 与 finally，不能只手工调用 Store 模拟兜底。
   - `doStop` 找不到 Driver 的分支：创建独立上下文，不传 `halt` 或 `abort`，保留原取消标记、未结算操作与占用。
   - `executeOrdinaryWorkCopy` 在请求父任务停止前捕获其上下文；停止失败兜底调用新函数，不再直接 `endTask`，不重新停止或取快照，保留占用。完整处理兜底 Promise；再次落盘失败记诊断并保留现场，不留下未处理拒绝。
   - 宿主 attach 同步失败列为直接 `endTask` 的显式例外；在 `test/work-copy-host-runtime.test.ts` 分别覆盖零执行单元启动、同事务结果与停止结论，以及父任务停止失败后的保留与错误报告。
   - `cancelTask`／`interruptTask` 的归属查找不变。
7. 文档与笔记：
   - 同步 `docs/modules/agent-tools.md`（账本停止）、`docs/modules/runtime.md`（任务收尾）和 `docs/modules/workflows.md`（共享停止快照、宿主职责与缺失结果暂停）；
   - 笔记转 implemented；
   - 就地更新[工作流运行与存储](../../../.agents/notes/implemented/architecture/2026-10-13-workflow-runtime-and-store.md)中 `HostExecutionManager` 的职责；
   - 把 `host-execution.ts` 等入口的锚点补到新笔记。

验证方法：

- 定向跑 `npx tsx --test test/94-task-ending.test.ts test/100-worker-stop.test.ts test/106-workflow-host.test.ts test/64-tool-op-ledger.test.ts test/92-subagent-lifecycle.test.ts test/82-subagent-cancel-work.test.ts test/10-access-modes.test.ts test/58-plan-mode.test.ts test/105-workflow-runtime.test.ts test/107-workflow-runtime-wiring.test.ts test/110-workflow-workcopy.test.ts test/112-workflow-real-steps.test.ts test/work-copy-host-runtime.test.ts test/125-agent-wait-resource.test.ts`，再按 [pre-push-checks](../../../.agents/skills/pre-push-checks/SKILL.md) 补调用方用例。
- `npm run check:static`。
- 每项行为变化在隔离副本中撤掉修改，确认对应用例失败。

## 进展与交接

- 当前角色与阶段：实施、文档与工程验收完成；独立实现审查通过，无未解决阻断。
- 下一角色与动作：无待实施或验收动作；拥有者可审阅本次提交。结果、环境与未覆盖项见[实施证据](../17-task-ending-protocol-evidence.md)。
- 实施基线：develop `9928103`。本次提交包括：
  - `task-ending.ts`、Driver、HostExecution、WorkflowCoordinator、WorkflowSteps 与 Runtime；
  - `94`、`105`、`106`、`112` 与工作副本宿主回归；
  - 本工单、[实施证据](../17-task-ending-protocol-evidence.md)、implemented 决定、三篇模块文档及两篇既有笔记的事实与互链。
- 阻塞与恢复条件：无阻断。反例已形成回归用例，可控探针与生产接线的证据分别记录。

## 验收与证据

- 工程验收：通过。最终扩展回归 332/332、macOS／Linux 独占停止专项各 33/33、静态检查与 16 组隔离撤修负例完成；真实队列、默认接线、事务回滚、唯一终态／唤醒及工作副本失败路径均有回归，独立实现审查无未解决阻断。Linux 的定向组、最后两次局部补修、完整 setup 的磁盘前提与未运行的外部验收见[实施证据](../17-task-ending-protocol-evidence.md)。
- 产品验收：不适用。没有交互变化；工作流暂停与取消交错时的终态显示差异记在笔记「后果」节。
- 方案审查：通过。再次独立复审确认意见 4 关闭，前三项关闭结论继续有效。上轮相关现有用例 90/90 通过；本次主审复跑保守分支探针，确认占用、未核实事件及同目录队列阻挡，笔记与文档检查通过。方案结论与实现验收分别记录；细节见 Comments。

## Comments

### 2026-10-16：方案确认

架构评审候选 01 的推荐在三轮访谈中全部被拥有者接受。访谈中按代码事实修正了评审报告的三处说法：

- 后台执行提案不新增任务执行归属；
- 「模块持有任务到执行归属的映射」作废，因为它会自锁，也会改动取消窗口；
- 调度循环防御路径不一律按未核实处理，`getDriver` 抛错时按已核实处理。

### 2026-10-16：独立方案审查

审查对象：develop `9928103` 上本工单及[收尾协议提案](../../../.agents/notes/implemented/architecture/2026-10-16-task-ending-protocol.md)，对照当前 Driver、宿主操作、工作流、Runtime、Store 与工具操作账本。结论：方案不通过，以下三项均返方案者修订并复审；修订要求尚未替代提案中的决定。

1. **P1：自然收尾取消结算后，缺失工具结果的工作流可能被判成功。** 提案「行为变化」承诺仍由 `unsafeReason` 以 `write_result_missing` 暂停，但 [workflows.ts](../../../packages/runtime/src/workflows.ts) 的 `unsafeReason`（审查基线第 631 行）只在 `hasOutput=false` 时检查这一条件。[Driver 的工具结果落盘失败分支](../../../packages/agent/src/driver.ts)（第 1670 行）保留结果缺失并继续，随后仍可生成最终输出。真实 Store、Coordinator 的隔离探针登记无结果的 `write` 操作并让步骤返回 `done`：现有实现为 `paused/effect_unknown`；只模拟取消自然结算后为 `succeeded`、步骤 `completed`，操作仍是 `resultSummary=null`、`effectUnknown=false`。`safeToRetry` 会拒绝重试，却不能阻止这个成功判定。修订要求：独立检查结果缺失且不能证明无写入效果的操作，不能以步骤已有输出放行；增加有最终输出而工具结果未落盘的回归用例。

2. **P1：嵌套收尾会丢失外层较早取得的停止快照。** 提案要求只在 `endTask.onChanged` 标效果未知，同时保留内层 Driver 先结束同一任务。[WorkflowSteps 的停止入口](../../../packages/runtime/src/workflow-steps.ts)（第 188 行）在调用 `driver.requestStop` 前等待 `ready`，允许工具结果在外层与内层的 `beginStop` 之间落盘。此时内层快照为空并先写终态，外层因 `changed=false` 丢弃原快照，违反提案「效果以停止瞬间为准」的要求。用真实 Driver、Store、Ledger 构造该时序，再按提案将外层标记放进 `onChanged`，得到 `outerSnapshot=["op-nested"]`、`innerSnapshot=[]`、`outerChanged=false`，操作与任务的 `effectUnknown` 均为 false。修订要求：明确外层停止快照如何传递、合并到实际写终态的一层，并在其终态事务内处理；补充嵌套停止与迟到结果用例，证明效果未知在唯一终态事件前落盘。

3. **P2：路径清单遗漏工作副本的两条失败收尾。** [runtime.ts](../../../packages/runtime/src/runtime.ts) 的 `executeOrdinaryWorkCopy` 在宿主登记失败（第 770 行）及父任务 `requestStop` 失败后的兜底（第 778 行）直接结束运行中任务。两处均未出现在工单实施步骤或提案排除项中，不能满足「其余运行中任务全部经新函数」的验收标准。修订要求：逐处明确归属；前者可列为有依据的「尚未启动执行单元」例外，后者需说明如何接入统一协议并保留停止未核实事实，补齐对应验证。

其余重点结论：当前普通队列调用链中，`getDriver` 抛错前尚未启动本任务的执行单元，提案对该分支返回 true 的前提成立；此结论仅适用于所审查的调用链。

验证证据：

- 已执行 `npx tsx --test test/94-task-ending.test.ts test/64-tool-op-ledger.test.ts test/105-workflow-runtime.test.ts test/106-workflow-host.test.ts`，85 项全部通过、无跳过。日志位于本次会话临时文件 `/tmp/ruukoto-17-review-baseline.log`，未入库；这些现有用例不覆盖上述两个反例。
- 意见 1 的探针使用真实 Store、ToolOpLedger 与 Coordinator，宿主注入执行器只登记写操作意图并返回输出；对比原实现与实例级 `settleTask` 空操作，隔离模拟「自然收尾不再结算」。探针没有中止路径，不代表新函数已实现或整套方案已执行。
- 意见 2 的探针播种活动任务与未结算 `bash` 意图，先取外层快照，再通过 Promise 边界写入迟到的 `Command aborted` 结果，调用真实 Driver 停止路径，最后执行提案要求的外层条件终态事务。未启动模型或 OS 执行单元，证据针对快照与事务时序。
- 本次审查未修改源码；未运行全量检查、`check:static`、Linux、真实模型或 IM 验收。两个探针为会话内实验，未保存为仓库回归用例；实施时须补齐可重复执行的测试。

### 2026-10-16：按审查意见修订方案

拥有者授权由本会话承担方案修订。本轮只修改工单与 proposed 笔记；目标、既有归属与落盘格式沿用，补齐实现这些要求所需的内部参数、失败路径与反例验收。三项意见已有对应修订，是否关闭由后续独立复审确认。

| 初审意见 | 本轮修订 | 独立复审重点 |
| --- | --- | --- |
| 1：有输出时漏判工具结果缺失 | 提案增加「工作流的缺失结果判定」：与最终输出无关地检查未落盘写结果，复用既有只读／审批未消费分类，不借自然收尾补账本 | 暂停发生在步骤完成与交付之前；正常写结果可以完成，只读与审批未消费仍可有限重试；Agent 与宿主任务都覆盖 |
| 2：嵌套停止丢失外层快照 | 提案增加「同一任务共享停止快照」：从任务启动起共享 `TaskEndingContext`，首次中止前保存，`halt` 后重读，赢得终态的一层消费 | 不能只在内层 `requestStop` 时传快照；默认适配器、自然完成竞争、事务回滚和下一任务隔离均须有用例，不引入按任务等待自己的 Promise |
| 3：遗漏工作副本失败收尾 | attach 失败明确列为零执行单元启动的例外；父任务停止失败的兜底沿用请求前捕获的上下文进入统一函数，保留占用并处理再次落盘失败 | 例外只限 attach 同步失败；异步兜底不读到下一任务的上下文，不重取快照、不释放占用或留下未处理拒绝 |

同步补充 `workflow-steps.ts`、`WorkflowAgentContext`、直接构造上下文的夹具与 `docs/modules/workflows.md` 的实施落点。工作流暂停与取消交错时的描述限定到实际先提交终态的一层，沿用「先结束者定终态」，不以外层目标覆盖内层已提交状态。

本轮验证：

- 执行 `node --import tsx /tmp/ruukoto-17-revision-probe.mjs`，五组断言通过：嵌套停止遇迟到结果仍标未知且唯一终态／唤醒；自然收尾在等待期间读到后来取得的中止快照；事务回滚后快照供兜底使用；有输出但写结果缺失仍被拒绝而完整写结果放行；只读／审批未消费保持安全且自然收尾不补结果。
- 探针在临时库使用真实 Store、ToolOpLedger，以独立时序模型模拟提案四步，并对照当前 Coordinator 的 `unsafeReason`；未修改生产函数。脚本位于本次会话的临时目录，未入库；它证明局部协议与判定，不能代替真实 Driver／工作流接线、SDK 停止与操作系统回收的回归测试。
- `npm run check:static` 通过，含 lint、类型、笔记与文档检查，日志为 `/tmp/ruukoto-17-revision-static.log`；最终文字调整另核实笔记、Markdown 段落、相对链接与空白。
- 未重跑此前 85 项应用用例，未执行全量、Linux、真实模型或 IM 验收。当前没有生产实现，工程验收继续待验证；本会话的方案自检不作为独立复审通过证据。

### 2026-10-16：修订版独立方案复审

审查对象：develop `9928103` 上本工单、收尾协议提案的修订正文及停止未核实笔记的关联互链。对照真实 Driver、Store、ToolOpLedger、HostExecutionManager、WorkflowCoordinator、默认 WorkflowSteps 和 Runtime 调用链；并行只读审查分别核对规格与仓库安全约定。结论：初审三项在方案层关闭，但新增以下 P1 阻断，退回方案者；本次未修改提案或生产代码。

初审意见的关闭依据：

- 意见 1：提案「工作流的缺失结果判定」独立检查逐操作结果，不再以最终输出放行；验收包含合法输出仍暂停、依赖不派发及 Agent／宿主两条路径。
- 意见 2：从任务启动共享上下文，首次中止前保存、`halt` 后重读，能覆盖原嵌套停止与自然完成反例；验收要求默认适配器接线、回滚保留和新任务隔离。实施时 `stopJob(false)` 已开始后的首次中止也须保存快照，不能被现有 `if (job.stop) return job.stop` 早退挡住；这是已有契约的落地要求。
- 意见 3：attach 同步失败已明确为零执行单元启动的例外；父任务停止失败兜底已纳入共享上下文、占用保留及拒绝处理，并分别列出验收。

4. **P1：调度兜底只核实受管进程，丢失浏览器停止未核实。** 本工单第 6 步及[提案「范围」](../../../.agents/notes/implemented/architecture/2026-10-16-task-ending-protocol.md#范围)（审查版本第 78 行）指定拿到 Driver 后以 `driver.stopManagedProcesses(task.id)` 作为 `halt`。但 [Driver](../../../packages/agent/src/driver.ts) 的显式停止还独立合并 `browser.close` 的结论（基线第 1255–1256 行），该结论不在受管进程登记表内。当受管进程全部已停、浏览器返回 false，随后终态事务失败时，`run` 在第 869 行等待拒绝的 `stopPromise`，错误进入调度 catch。按提案重新只查受管进程会得到 true，继而写 failed 并释放目录占用。自然 `finalize` 与 `run finally` 没有另一个浏览器停止核实步骤能补回这项事实。这违反工单第 3 步保留浏览器停止结论、提案第 143 行回滚后仍保留占用及既有停止未核实规则；属于本次明确纳入的既有缺陷尚未修全。修订要求：调度兜底复用本任务的完整停止结论，或在无法证明全部应停资源已退出时保守保留，不把 worker 的 true 当作整任务的 true；补一条 Runtime 回归，组合浏览器 false、首次终态事务回滚与 worker true，断言占用和未核实事实保留、同目录后续任务不派发。`getDriver` 抛错且本任务尚未启动执行单元的例外不受此意见影响。下一责任角色：方案者。

验证证据：

- 主审执行 `npx tsx --test test/94-task-ending.test.ts test/64-tool-op-ledger.test.ts test/105-workflow-runtime.test.ts test/106-workflow-host.test.ts test/work-copy-host-runtime.test.ts`，90 项全部通过、无跳过；日志 `/tmp/ruukoto-17-rereview-tests.log`。这些现有用例不覆盖新增反例，也不验证尚不存在的实现。
- 主审复跑 `node --import tsx /tmp/ruukoto-17-browser-fallback-probe.mjs`，断言通过。探针用真实 Runtime 取得 Driver，播种运行中任务及占用；注入 `browser.close=false`，首次 `endTask` 执行变更后抛错，由真实 `withTx` 回滚。随后调用真实 `stopManagedProcesses` 并按提案的核实结果模拟调度兜底，输出为 `browserReaped=false, firstTerminalRolledBack=true, fallbackReaped=true, status=failed, occupancyRetained=false`。脚本在临时目录，未入库；仅验证停止结论与事务失败的组合，不声称执行了尚未实现的 helper 或真实浏览器停止。
- `npm run check:static` 通过（lint、类型、笔记与文档检查），日志 `/tmp/ruukoto-17-rereview-static.log`；工单状态、引用文件与末尾换行另行核实，`git diff --check` 通过。
- 未执行全量、Linux、真实模型、真实浏览器或 IM 验收；生产实现、接线与真实停止仍待实施阶段验证。

### 2026-10-16：调度兜底意见返工

接受复审意见 4，选择审查允许的保守保留分支：取得 Driver 后的运行异常，`halt` 等待受管进程回收后固定返回 false，不把 worker 的 true 作为整任务核实成功；`getDriver` 尚未返回、本任务尚未调用 `run` 的例外仍返回 true。未新增完整停止结论缓存，`TaskEndingContext` 继续只保存原停止快照。提案已记录这个选择的备选与代价：异常时资源即使实际已退出，也可能需要拥有者核实后恢复。

工单第 6 步与提案验收现要求真实队列 catch／finally 的组合用例，覆盖浏览器 false、终态事务回滚、worker true、未核实事件与占用保留，以及同目录后续任务不派发；另覆盖取得 Driver 前失败、取得后失败和已有终态竞争。复审对 `stopJob(false)` 的落地提醒也已写入第 5 步：已有停止 Promise 不能挡住后来首次中止的快照与取消意图。

执行 `node --import tsx /tmp/ruukoto-17-browser-conservative-probe.mjs` 通过。该脚本沿用复审的真实 Runtime／Driver／Store 夹具与首次终态变更后抛错注入，模拟修订后的兜底，再实际向同目录另一会话提交任务。结果为 `browserReaped=false, firstTerminalRolledBack=true, fallbackReaped=false, status=failed, occupancyRetained=true, nextTaskStatus=queued, modelCalls=0`；另断言未核实事件已落盘。脚本位于临时目录，未入库；浏览器结论是可控替身，兜底使用手工调用模拟，不能替代尚未实现的真实调度 catch 接线测试。

`npm run check:static` 通过，日志 `/tmp/ruukoto-17-browser-revision-static.log`；两份文档的状态、相对链接、空白与末尾换行另行核实。

本轮仅修订方案，未重跑上轮 90 项应用用例，未执行全量、Linux、真实模型、真实浏览器或 IM 验收。意见 4 待独立复审确认关闭；此前关闭的三项意见不重新打开，工程验收继续待验证。

### 2026-10-16：调度兜底修订独立复审

审查对象：develop `9928103` 上再次修订的工单与 proposed 笔记，重点复核意见 4、相邻的停止去重说明及验收要求。生产代码与上轮相同；本次只复核受影响部分，前三项关闭结论继续有效。规格与安全约定两条只读复核均无新增阻断，主审确认方案通过，状态转 `ready-for-agent`，下一责任角色为实施者。

意见 4 的关闭依据：

- 已取得 Driver 的异常兜底等待受管进程停止后固定按未核实处理；即使 worker 返回 true，也保留占用与 `tool_process_unreaped` 事件。停止调用抛错沿统一入口的保留路径，不需要完整停止结论缓存即可覆盖原浏览器 false 与终态事务回滚反例。
- `getDriver` 尚未返回、尚未调用本任务 `run` 的例外仍符合当前普通队列调用链；条件终态不覆盖已有终态。Runtime 原有 `finally` 可以重查队列，持久占用阻止同目录派发；拥有者核实后的恢复仍沿现有 `resumeQueue`。
- 工单与提案已要求真实队列 catch／finally 的回归，覆盖浏览器 false、终态事务回滚、worker true、未核实事件、占用、后续排队及已有终态竞争；手工 Store 探针明确只证明方案。`stopJob(false)` 后首次中止必须先记录快照与取消意图的补充与已过审契约一致。
- 保守兜底可能保留实际已退出资源的占用，需要拥有者核实恢复；这个代价、被否的完整结论缓存方案及正常收尾不受影响均已记入提案，未改变执行归属或落盘格式。

验证证据：

- 主审读取并复跑 `node --import tsx /tmp/ruukoto-17-browser-conservative-probe.mjs`，断言通过：`browserReaped=false, firstTerminalRolledBack=true, fallbackReaped=false, status=failed, occupancyRetained=true, nextTaskStatus=queued, modelCalls=0`，未核实事件存在。真实 Driver／Store 处理首次停止与事务回滚，修订后的兜底仍由探针模拟；同目录后续任务经过真实队列，未调用模型。
- 主审执行 `npm run verify-notes` 与 `npm run check:docs`，均通过；更新审查记录后核实状态、引用文件与末尾换行，`git diff --check` 通过。
- 未重跑生产代码未变的上轮 90 项应用用例，也未重跑全量、类型与 lint；未执行 Linux、真实模型、真实浏览器或 IM 验收。新协议实现、真实接线与操作系统停止仍待实施验证，工程验收保持待验证。

### 2026-10-16：实施与独立审查

按已确认方案先补失败回归，再实现统一入口、共享上下文及全部调用方；未改变执行归属、落盘格式或终态仲裁规则。补充两处实现细节：Driver 交接前公开候选快照，成功只撤去未被外层中止采用的候选；Host 自然停止期间首次中止先保存事实再复用原 Promise，已提交终态则沿原停止结论早退，避免重复取消补账本。两处由真实 Store／Driver／Host 回归证明，决定已同步。

独立实现审查直接核对需求、实际 diff、调用方和文档，并亲跑相关最小回归。发现的 Driver 停止快照过晚及 Host 后到中止早退两项阻断均修复并复核关闭；候选采用窗口、已终态重复中止及保留已核实模式切换释放行为的最终调整也已复核，结论通过。审查者没有修改工作区。

函数级与真实队列、默认适配器、宿主及工作副本接线、事务回滚与条件终态回归均已落地。隔离副本的 16 组撤修负例按预期失败；macOS／Linux 的 local 原生进程停止专项通过。原方案中的临时探针不再充当实现验收证据，最终范围、命令、数量与缺口集中在[实施证据](../17-task-ending-protocol-evidence.md)。

扩展回归另发现工作流重复中止只复用了单元停止、仍重复写执行事件，暂停调度因此持续重新收尾。以真实 Coordinator 的并发重复调用回归复现取消意图写两次，再用归属内部 `job.abort` 缓存整次协议，保留 `job.stop` 的单元职责；首次中止仍先保存意图与快照。独立复审亲跑三条相关回归通过，无新自锁或取消窗口变化；最终扩展批次 332/332 通过、无跳过，静态检查通过；工单转 `resolved`。未提交、合并、部署或发布。
