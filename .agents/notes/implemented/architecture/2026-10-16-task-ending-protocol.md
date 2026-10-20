# Agent Note: 运行中任务的收尾协议集中到一个函数

Status: implemented

## 问题

运行中任务结束时要满足[停止未核实保留](../../implemented/bug-fix/2026-10-11-preserve-unverified-worker-stop.md)：先停执行单元并核实，再在终态事务里决定占用；效果未知只在终态条件更新成功后、于终态事件前补记（[工单 14](../../../../.scratch/architecture/issues/14-task-ending.md)）。`Store.endTask` 统一了终态事务本身，事务之前的协议却由三个执行归属各写一份：取消意图、账本快照、停止单元、结算、停止结论写入和提交后唤醒。三处是 `Driver.requestStop`／`finalize`、`HostExecutionManager.stop`、`WorkflowCoordinator.stopJob`。

2026-10-16 在 develop `9928103` 核对，三份已经分叉：

- Driver 在独立事务里 `settleTask`，终态事务的 `onChanged` 内标效果未知。
- 宿主操作把结算与标记都放进 `onChanged`；终态被其他路径抢先时，连已知结论也不补记，只能等重启 `settleAll`。
- 工作流中止在 `endTask` 之前无条件标效果未知，违反「条件更新成功后」；同一作业内虽有共享停止 Promise，内层 Driver 仍可先写终态。
- 工作流自然收尾分两个事务，并以空快照结算；账本 `settleAfterWriteFailure` 的决定却是写入失败缺结果的操作「其余标未知不对，留给重启」，Driver 自然收尾也不结算。
- 调度循环防御路径（`runtime.ts:4043`）在 `driver.run` 抛错时以 failed 释放占用，不核实单元；`doStop` 找不到 Driver 时则保留占用。

测试只能经 `startTestRuntime`、冻结队列、手写任务行和 `(runtime as any).getDriver` 才能测到收尾规则。不集中，下一条新的停止路径会再抄一份并继续分叉。

## 决定

`packages/agent/src/task-ending.ts` 导出收尾函数与调用方持有的 `TaskEndingContext`。函数承载运行中任务的收尾协议；执行归属负责停止自身、传递同一任务的上下文，并提供同事务写入：

```ts
interface TaskEndingContext {
  readonly taskId: string;
  stopSnapshot: string[] | null; // null 尚未中止；[] 已中止但没有待核实写操作
}

endTaskExecution(deps: { store; ledger; onReleased }, task, ending: TaskEndingContext, {
  terminal, reason,              // failed → errorMessage；canceled／interrupted → interruptReason
  abort?: true,                  // 写取消意图并在首次中止时取得快照
  halt?: () => Promise<boolean>, // 归属停下并核实；省略表示没有存活归属
  unreapedReason,                // task.tool_process_unreaped 的原因
  modeSwitchFailure?,
  inTx?: (r: { changed: boolean; reaped: boolean }) => void,
}): Promise<{ changed: boolean; reaped: boolean }>
```

顺序固定：

1. `abort` 时先在独立事务写取消意图，取值为 `terminal === "canceled"`；仅当 `ending.stopSnapshot === null` 时调用 `beginStop` 保存快照。这段必须在首次让出执行权，以及 `assembly.abort`、`AbortController.abort`、审批解除或停止单元之前完成；后续收尾不能用较晚的快照覆盖它。
2. 调用 `halt`。抛错按未核实处理，并写 `[ruukoto:task-ending]` 诊断；省略 `halt` 也按未核实处理，保留占用。
3. `halt` 返回后重新读取共享上下文，再开一个事务：`ending.stopSnapshot !== null` 时先 `settleTask` 补记已知结论，再 `endTask`（在 `onChanged` 内标效果未知），最后调用 `inTx`。是否结算由当前共享快照决定，不能只看本次调用的 `abort`，也不能使用进入 `halt` 前缓存的空值。`inTx` 写停止结论和归属自己的记录，并拿到 `changed`。
4. 提交后，只在确实释放占用（`changed && reaped`）时调用 `onReleased`。

函数放在 agent 包，因为 Driver 在 agent，不能直接调用 runtime 的值；账本也在 agent。

### 同一任务共享停止快照

`TaskEndingContext` 只保存任务 ID 与第一次中止的快照，不保存执行归属、停止 Promise、目标终态或调度锁。调用方为每个任务创建 `{ taskId, stopSnapshot: null }`，嵌套结束同一任务时传递同一个对象；父任务与工作副本宿主任务的 ID 不同，各有自己的对象。函数不建立按任务查找的登记表，也不等待另一层的收尾 Promise。

普通队列在调用 `getDriver` 前创建上下文，传给 `Driver.run(task, ending)`；调度 catch 复用同一对象。Driver 在本任务初始化时保存它，`requestStopInner`、自然 `finalize`、模式切换失败和让出目录失败都使用该对象。直接调用 Driver 的测试可省略参数，由 Driver 在本任务初始化时创建；不能在每次 `finalize` 时新建。模式切换与让出目录在停止单元前暂存候选快照，失败沿该事实收尾；成功且没有并发任务中止时恢复交接前快照，避免把成功交接变成自然收尾补账本。候选对并发中止可见；统一入口在首次中止时沿用候选内容并换成新数组引用，成功交接只撤回仍未被采用的候选，不能因内层停止入口尚未到达而抹去外层已采用的快照。迟到结果不能抹去停止前事实。

工作流在创建 `AgentJob` 时创建上下文，通过 `WorkflowAgentContext.ending` 传给执行器；默认 `WorkflowSteps.agent` 在启动时传给 `Driver.run`。外层 `stopJob`、内层 Driver、自然收尾与 catch 因而从启动起共享它，无需改变 `ManagedEntry.stop()` 签名。必须在 `job.controller.abort()` 和等待 `entry.stop()` 前保存首次快照；等到 `entry.stop` 的 `await ready` 之后才传给 `requestStop` 已太晚。

`stopJob(false)` 已开始停止单元后到达的首次中止，仍须先保存快照与取消意图，再复用停止 Promise；不能被 `if (job.stop) return job.stop` 提前返回挡住。

如果自然收尾先进入 `halt`，期间中止路径保存了快照，自然收尾在第 3 步会读到它，并在自己赢得终态时处理。若任务终态在任何中止请求之前已经提交，之后的中止仍不能追加未知效果。每个归属保留原有 Promise 去重；先写终态的一方消费共享快照，另一方只补已知结论和自身记录。

HostExecutionManager 在 attach 时为宿主任务创建上下文；自然停止尚未提交终态时，首次取消或中断仍先经统一入口保存快照，再等待原停止 Promise；已提交终态则沿原 Promise 早退，不改取消意图或补账本。原自然收尾读取同一快照，先提交者处理未知效果，后到者不再次停止单元或唤醒。Driver 提供当前任务上下文的只读引用入口，工作副本路径在请求父任务停止前捕获该引用，失败兜底沿用它；不能在异步 catch 中读取可能已属于下一任务的 Driver 状态。上下文随原有执行归属保留到收尾结束，事务失败不清空快照；下一任务创建新对象，不继承上一任务快照。

### 工作流的缺失结果判定

自然收尾且共享快照仍为 null 时，不调用 `settleTask`，不补工具结果、不标效果未知。工作流的安全判断据现有持久事实决定能否继续，不能以步骤已有最终输出代替工具结果：

1. `unsafeReason` 先沿用占用未核实、任务或操作已标效果未知的判断。
2. 复用 `safeToRetry` 的逐操作分类：只读工具，或该操作存在审批且全部未消费，才属于可以证明无写入效果的操作。只要任一操作 `resultSummary === null` 且不满足此分类，返回 `write_result_missing`，与 `hasOutput` 无关；此查询不写账本，也不借宿主族核实补结果。
3. 没有最终输出时，仍按原 `safeToRetry(task)` 判断已记录写操作能否重试；有完整工具结果及有效输出的正常写步骤继续完成。只读或全部审批未消费的尝试仍可按既有限额重试。

逐操作分类在 workflows 内由两处共用，沿用注入的同一 `ToolOpLedger.hasNoWriteEffect` 与审批事实。逐操作判断覆盖 Agent 与宿主任务，先于 `finishWorkflowStep`、结果交付或成功汇总；结果缺失的写操作原样保留，直到重启 `settleAll`。普通 Driver 的自然终态仍由其现有逻辑决定，不因工作流步骤暂停而改写任务终态。

### 范围

纳入以下路径：

- Driver：取消、中断、模式切换失败、后台停止、自然完成或失败、`yieldWorkspace` 停止未核实。
- `HostExecutionManager.stop`：工作流宿主操作与工作副本宿主任务。
- `WorkflowCoordinator.stopJob`：中止、自然收尾与 catch 分支。
- `doStop` 找不到 Driver：创建独立上下文，不传 `halt` 或 `abort`，沿用原取消标记与未结算操作，保留占用交恢复核实。
- 调度循环防御路径：已取得 Driver 而 `driver.run` 抛错时，`halt` 等待 `driver.stopManagedProcesses(task.id)` 后固定返回 false；受管进程停止成功不是本任务全部应停资源已退出的证据。该调用抛错仍由统一入口按未核实处理。只有本次 `getDriver` 尚未返回就抛错、因而未调用本任务 `run` 的分支，`halt` 才返回 true。
- `executeOrdinaryWorkCopy` 的父任务停止失败兜底（基线 `runtime.ts:778`）：复用请求停止前捕获的父任务上下文，不再次请求停止、不重新取快照，不传 `halt`，以 interrupted 和 `tool_process_unreaped` 保留占用；已有快照仍参与统一结算。原 fire-and-forget 分支完整处理兜底 Promise，持久化再次失败时输出 `[ruukoto:runtime]` 诊断，保留任务与占用等待恢复，不留下未处理拒绝、不自动重试或宣称已结束。

不纳入以下路径：

- queued 直接定终态：没有执行单元，`Store.endTask` 已足够。
- 重启 `recover()`、`resumeQueue`、工作流 host-start 的即时收尾。
- `executeOrdinaryWorkCopy` 的宿主 attach 失败（基线 `runtime.ts:770`）：attach 同步失败会移除登记，后续 `executeWorkCopy` 尚未调用，能证明没有启动执行单元。原事务继续成对写宿主失败结果、终态、释放占用与 `workCopyHost.stopVerified=true`；本例外不包括 attach 成功后的失败。
- 集合取消在各自事务内的部分。它们提交后调用的 `cancelTask` 会走新路径。

### 调度异常保守保留占用

Driver 显式停止还会合并浏览器停止结果，它不属于受管进程登记表。浏览器返回 false 后，终态事务若回滚，调度 catch 重查 worker 得到 true 也不能释放占用。异常可以发生在完整停止结果返回之前，兜底没有可靠的整任务核实证据；本次选择继续回收受管进程并保守保留，不增加第二套完整停止结果缓存或重新关闭浏览器来覆盖原失败。

该兜底复用原 `TaskEndingContext`，通过统一函数条件更新为 failed，使用 `tool_process_unreaped` 原因保存未核实事件与占用。若另一条收尾已提交终态，仍是空更新，不改写原状态或占用。helper 不调用 `onReleased`；Runtime 的原有 `finally` 唤醒可以重查队列，保留的占用必须阻止同目录后续任务派发。拥有者核实后的恢复继续走原 `resumeQueue`，不因再次取得 worker 的 true 自动放行。

### 保持不变

- 并发去重留在各归属：`stopPromise`、`state.stop`，以及工作流的 `job.stop`／`job.abort`。默认工作流 Agent 步骤把真实 Driver 登记为作业单元，这个 Driver 会自己结束同一任务。共享上下文只传事实，不承载等待关系；函数不保存按任务去重的 Promise，避免外层停止经单元进入 Driver 时等待自己。工作流 `job.stop` 只停止单元，`job.abort` 缓存整次中止；重复中止不能重写执行事件，否则暂停调度会由提交事件再次触发 `stopRun`，形成持续微任务唤醒并阻塞在途 I/O。自然停止已开始后第一次中止仍先保存快照，再建立 `job.abort` 并复用 `job.stop`。
- 嵌套归属沿用「先结束者定终态」，另一层的条件更新成为空操作。
- 以下三项留在 Runtime：「任务由谁执行」的查找、`cancel_requested` 取消窗口（[取消工作](../../implemented/feature/2026-10-04-cancel-work.md)）和 `doStop` 的停止顺序。
- 落盘与事件格式不变。停止结论仍分别存为占用行、`read_scope.workCopyHost.stopVerified` 和 `workflow_executions.stopVerified`，由 `inTx` 写入；`task.tool_process_unreaped` 的原因由各归属给出。存储统一在 `task-ending.ts` 以 `XXX` 标记。
- 唤醒仍用 Runtime 注入的 `kickAll`。

### 行为变化

- 宿主操作在终态竞争失败时也补记已知结论；中断时写 `cancel_requested=0`，与 Driver 一致。
- 工作流中止只在终态条件更新成功时标效果未知，并写取消意图。外层目标终态在该次停止开始时按运行状态决定；暂停后、停止途中又取消，若外层提交终态则任务记 interrupted、运行仍为 canceled。内层 Driver 仍按自己的停止入口选择目标，最终由先提交者决定，外层不覆盖它。
- 未收到中止请求的工作流自然收尾不再结算账本。写入失败缺结果的操作留给重启 `settleAll`；逐操作缺失结果检查以 `write_result_missing` 暂停运行，即使步骤已返回最终输出。
- 同一任务的自然收尾与中止竞争时共用首次停止快照；任何一层赢得终态都不能漏掉中止前已开始、随后才写入结果的操作。
- 调度循环防御路径在 `getDriver` 抛错且本任务尚未启动时释放占用；取得 Driver 后的运行异常缺少完整停止证据，一律保留占用待核实。
- 只有释放占用才唤醒；竞争失败的一方不再多唤醒一次。

## 既有笔记审计

- [停止未核实保留](../../implemented/bug-fix/2026-10-11-preserve-unverified-worker-stop.md)：部分重叠。本篇不改其规则，只把协议集中到一处；互链。
- [工作流运行与存储](../../implemented/architecture/2026-10-13-workflow-runtime-and-store.md)：部分重叠。`HostExecutionManager` 负责登记与停止，快照与终态协议归本篇。
- [main 应用数据空间](../../implemented/architecture/2026-09-23-main-app-data-space.md)：约束沿用。结果写入失败时只对宿主族可核实操作即时补记，其余留重启；工作流的缺失结果检查只暂停，不把自然收尾改成补记入口。
- [后台生命周期提案](../../proposed/feature/2026-10-14-bash-background-lifecycle.md)：部分重叠。它的最小修正留在 Driver 登记表里，跨轮句柄归属会话，不是新的任务执行归属。若它产生任务之外的停止事实，再重议本篇的范围。
- [取消工作](../../implemented/feature/2026-10-04-cancel-work.md)、[等待与报告归属](../../implemented/architecture/2026-10-14-agent-wait-and-report-ownership.md)：约束沿用，不改。
- [原生执行沙箱](../../implemented/architecture/2026-10-10-native-execution-sandbox.md)：无关。逐调用复核留在 `ToolWorkerHost.call`。
- 检索命中的调度、导入、IM 与产品笔记：无关。

## 备选方案

- **用按任务登记表持有归属和去重**：`cancelTask`、`interruptTask`、`doStop` 不必再分支，并发去重集中一处，这是 2026-10-16 架构评审最初的设想。否决：查找只有三处小分支；登记表会改动 `cancel_requested` 取消窗口与 `doStop` 的停止顺序；工作流 Agent 步骤内嵌 Driver，按任务去重会自锁。
- **一个任务只有一个结束者**：工作流作业承载的 Driver 只负责 halt，由协调器按步骤结论定终态，嵌套随之消失。否决：会改变可见行为，步骤输出无效时任务会从 completed 变成 failed；还要改 Driver 在 `profile.workflow` 下的收尾。它与集中协议是两件事，可以单独提出。
- **同时把停止结论存储统一为 `tasks` 的一列**：只剩一处读写。否决：约 40 处读取方、`workflow.execution` 事件和两个导入方向都要迁移，还要递增 `SCHEMA_VERSION`；集中协议并不依赖这一步。
- **函数放在 runtime**：归属查找与唤醒都在 runtime。否决：Driver 只能经注入回调调用它，而账本在 agent。
- **自然收尾也结算**：三条路径就完全同形。否决：这违反账本对写入失败的决定，会把已拿到真实结果的操作标成效果未知。
- **在嵌套 `requestStop` 时传入外层快照**：参数少，能覆盖内层中止先提交的情形。否决：`await ready` 或其他等待期间自然收尾可以先提交，届时尚未收到外层快照；因此从启动时就共享容器，并在终态事务前重读。
- **为调度兜底缓存并复用完整停止结论**：可以在全部资源已核实而仅终态写入失败时释放占用，减少人工恢复。此处不选：还须处理聚合未返回、不同收尾阶段和异常中断时的证据完整性；异常兜底保守保留即可满足本次安全要求，不增加第二套核实状态。若此类异常频繁导致不必要的人工恢复，再单独完善完整结论的传递。

## 验证

函数级、真实队列与默认适配器回归分别位于 `test/94-task-ending.test.ts`、`test/105-workflow-runtime.test.ts`、`test/106-workflow-host.test.ts`、`test/112-workflow-real-steps.test.ts` 与 `test/work-copy-host-runtime.test.ts`。实际执行环境、撤修负例和未验证项见[工单](../../../../.scratch/architecture/issues/17-task-ending-protocol.md)。以下要求由这些回归持续覆盖：

- 运行中任务直接调用 `endTask` 的位置只剩「不纳入」所列；其余都经 `endTaskExecution`。
- `test/94-task-ending.test.ts` 用真实 Store、真实 `ToolOpLedger` 和可控的 `halt` 覆盖以下行为，不启动 Runtime：
  - 释放并唤醒；`halt` 返回 false 或抛错时保留占用，并带上归属给的原因；
  - 快照只在终态条件更新成功时标效果未知；竞争失败时仍补记已知结论；
  - 没有中止快照的自然收尾不碰未结算操作；
  - 取消意图由终态推出；`inTx` 拿到 `changed`；省略 `halt` 时保留占用。
- 共享上下文的函数级用例覆盖两种竞争：外层取得快照后落下迟到结果、内层先定终态；自然收尾先进入 `halt`、中止在等待期间取得快照、自然收尾先定终态。均须断言原操作标未知、未知事件先于唯一终态事件、只唤醒一次；新任务不继承旧快照，终态事务回滚保留快照供既有兜底使用。
- 默认工作流适配器至少一条集成用例核实 `AgentJob → WorkflowAgentContext → WorkflowSteps → Driver` 使用同一上下文，真实嵌套停止有界完成。仅手工给两个 helper 调用同一对象不能替代这项接线证据。
- 工作流的缺失结果用例覆盖：写操作缺工具结果但有合法最终输出仍暂停，原操作保持结果缺失且未标未知，依赖步骤不派发；完整工具结果与有效输出可完成；只读或审批全部未消费可有限重试且自然收尾不补结果。缺失结果检查同时覆盖 Agent 与宿主任务。
- 工作副本用例分别证明 attach 失败零执行单元启动、原事务原子写入失败结果与停止结论，以及父任务停止失败兜底仍使用原快照、保留占用、不唤醒；重复写入失败须可见且保留现场。
- 每项行为变化都有一条撤掉修改就会失败的用例。调度循环须用真实 Runtime 回归覆盖：`getDriver` 抛错且零执行单元启动时释放；已取得 Driver 后异常即使 worker 返回 true 也保留；浏览器 false、首次终态事务回滚、worker true 的组合保留占用与未核实事件，同目录后续任务保持 queued；已有终态不被兜底覆盖。测试须实际经过队列 catch 与 finally，手工调用 Store 模拟兜底仅作为方案探针。
- 现有 `test/94`、`test/100-worker-stop`、`test/106-workflow-host` 和工作流、SubAgent 回归按 [pre-push-checks](../../../skills/pre-push-checks/SKILL.md) 选集通过，`npm run check:static` 通过。

## 后果

- 工作流外层中止的目标终态提前决定：暂停与取消交错时，若外层先提交，任务终态与运行状态可能不一致；内层先提交则保留内层选择。这只影响显示，安全判断读运行与执行记录，不以外层目标代替已提交终态。
- Driver 的结算并入终态事务：写入失败时结算与终态一起回滚；若既有兜底也未能完成收尾，任务留在运行中，直到重启 `recover()`。原实现可能出现结算已提交、终态未写的中间态。两者都保留占用，不会释放。
- 共享容器增加一条从任务启动到收尾的内部参数传递；复制对象、在 `halt` 前缓存快照或按会话复用都会丢失停止事实，须由接线与竞争用例证明。它不跨重启持久化，重启仍以既有账本及占用恢复。
- 工作流有合法输出但缺少写操作结果时会暂停，拥有者看到 `write_result_missing`；重启结算后可能转为效果未知，不能承诺重启即可恢复或重试。
- 已取得 Driver 后的调度异常，即使实际资源全部退出，也可能因兜底缺少完整证据而保留占用，须拥有者核实后恢复。这是避免终态事务回滚丢失浏览器停止失败事实的保守代价；正常 Driver 收尾不受此分支影响。
- 回退时连同 Runtime 与默认适配器恢复原调用链，没有数据迁移。
