Status: resolved

# 27 — 保留工具执行单元停止失败的核实结果

**What to build:** 工具 worker 启动失败、重复停止与 worktree 临时执行入口必须保留整单元停止失败，不能把无法核实转换为成功后释放目录占用。

**Blocked by:** 无。本单完成共享生命周期修复，已解除工单 26 原生接入的前置阻塞。下面保留修复前核实的分支；真实停止失败的 OS 单元尚未复现，不把静态核查或模拟失败作为原生边界证据。

依据：[工单 26](26-native-sandbox.md)、[ADR 0004](../../../.agents/notes/implemented/architecture/2026-09-20-tool-worker-per-task-container.md)、[ADR 0021](../../../.agents/notes/implemented/architecture/2026-10-04-subagent-worktrees.md)、[原生执行沙箱的已确认方案](../../../.agents/notes/implemented/architecture/2026-10-10-native-execution-sandbox.md)。

## 修复前已核实代码路径

1. `ToolWorkerHost.start` 的 ready 失败路径调用 `unit.entry.stop().catch(() => false)` 后丢弃返回值，仅抛原错误；`ToolRouter.ensureWorker` 的 starting 占位把 rejected startPromise 转成 null，再返回 true。单元未能回收时仍可能报告已退出。
2. `ToolWorkerHost.stop` 在调用 `unit.entry.stop()` 前置空 `this.unit`；第一次返回 false 后，第二次调用因 `!this.unit` 直接返回 true。受管登记表里 starting 与实际单元均持有同一 host，停止结果必须一致，不能由后续入口把失败改成成功。
3. `Runtime.createWorktreeInContainer` 没有登记 starting 或实际执行单元；finally 忽略 `host.stop()` 的 false 并吞异常。其“残余由主管进程登记兜底”的注释没有对应登记代码，创建与汇总的临时 worker 需要进入取消、后台停止与占用核实路径。
4. `killProcessGroup` 的核实只调用 `pidAlive(pid)` 检查主 PID，未检查组中其余进程；脱离进程组的后代更不在该范围内。local 不能凭这个返回值用于受限边界验收。

## 实施范围

- 保留启动后已经创建的执行单元及其停止结果，覆盖 ready 失败、starting 占位与实际单元登记。启动 Promise 被拒绝不能单独证明单元已回收；尚未创建任何单元的启动失败与已创建但停止未核实必须区分。
- 核实结果须传到 `ToolRouter`、`Driver` 和 Runtime 的 worktree 临时执行入口。stop 返回 false 或抛错均按未核实处理；重复停止、登记表清理和任务收尾不能抹掉该结果，也不能据此释放占用或建立替代执行环境。沿用现有 `task.tool_process_unreaped`、`mode_switch_unverified` 与占用恢复路径，跨层错误按类型与 code 判别。
- worktree 创建与改动汇总的临时执行单元归入所属任务的受管生命周期；相关目录占用和副本成果在退出未核实时保留，已收到工具结果不能代替停止核实。
- 本单不切换默认后端，不接入 Seatbelt/bubblewrap，也不以 local 或模拟测试宣称后代回收成立。原生回收机制与按平台验收由工单 26 负责，macOS 沿用拥有者已选的方案 (a)：无法核实即保留占用并报告。

## 验收标准

- [x] 启动失败且 stop 返回 false 或抛错时，停止入口保留未核实结果，父任务持有占用；任务状态、事件与占用查询可见明确原因，不能只写 stderr。
- [x] 同一执行单元的并发和重复 stop 返回一致的核实结果；不会因句柄已置空而将 false 改为 true。
- [x] worktree 创建与改动汇总登记可回收单元，覆盖启动窗口、取消与后台停止；无法核实退出时保留相关目录占用和副本成果。
- [x] 用可控启动器覆盖未创建单元的启动失败、ready 失败后停止成功/返回 false/抛错、并发与重复停止、临时 worker 的启动取消和后台停止；断言最终占用与可见状态，区分模拟回归与真实容器/systemd/native 停止证据，未知效果不自动重放。
- [x] 同步运行说明与图解中关于停止核实的表述；原生停止仍须通过工单 26 按已确认口径开展的两平台实测。

## 实施计划（2026-10-11）

本单先于 26 的产品接入交付，28 不依赖本单。按以下三批实施；每批先补能暴露原问题的定向用例，再修改对应路径。停止结果的归属与被否方案见[停止未核实结果保留](../../../.agents/notes/implemented/bug-fix/2026-10-11-preserve-unverified-worker-stop.md)。

### 1. 一个执行单元保留一份启动与停止结果

- 在 `packages/agent/src/tool-worker/host.ts` 中让启动记录覆盖 launch、ready、init 与 stop；保留单元身份，合并并发 stop，重复调用返回同一核实结果。ready/init 失败也走同一清理入口。未创建单元可证明无需回收；创建后 stop 返回 false 或抛错必须保留未核实事实与原启动原因。
- 在 `packages/agent/src/tool-router.ts` 的 `ensureWorker`、`stopWorker`、`prepareToolBoundary` 中使用该记录。starting 登记不能以 Promise rejected 推断成功，也不能在启动中的取消之后安装迟到的 ready worker。每次启动使用独立登记身份，避免同任务重建覆盖尚未核实的记录。
- 核查 `packages/agent/src/execution/launchers.ts` 的每个 `launch`：拒绝返回前若已产生进程，必须交出可停止身份或保留清理失败；不能把 spawn 后失败伪装为“没有单元”。继续使用 `ExecutionError` 的 code，消息仅用于解释。
- 修正 `packages/agent/src/managed-processes.ts` 的 `killProcessGroup`：查整个原进程组，主 PID 先退出仍须对剩余成员完成 TERM/KILL 与核实；权限或查询失败按未核实。真实同组后代测试验证心跳停止。脱离进程组的回收仍由 26 的平台机制承担，不扩大 local 的隔离承诺。同步其两个调用方：local launcher 与 `mock-tools.ts`。

交付条件：可控 launcher 覆盖未创建单元失败、ready/init 失败、停止成功/false/异常、并发与重复 stop、启动中取消，证明失败不会因句柄清空变成 true；真实进程测试证明主进程消失不提前结束组回收。

### 2. 所有任务收尾消费同一核实结果

- 修改 `packages/agent/src/driver.ts` 的 `killManagedProcesses`：一个 stop 抛错不能跳过其他单元；聚合 false/异常，保留未核实记录，不能无条件 `registry.clear()`。同任务的并发收尾复用结果，不因下一次列表为空返回成功。
- 逐一接入自然完成、`sdk.prompt` 抛错、prompt 前已取消、`requestStop` 和模式切换失败。当前自然完成忽略回收返回值，prompt 异常还会先 `finalize` 再回收，须调整为核实后再决定占用。执行结果、工具效果与退出核实分别保留，不把已知成功工具改成未知，也不把已开始但缺结果的写操作重放。
- `Store.endTask` 已提供 `keepOccupancy`、`occupancyIssueReason` 与 `task.tool_process_unreaped`，优先复用；终态与事件同事务。收尾未核实不得释放目录或唤醒同目录执行；模式/授予变化不得提交新执行环境。同步 `Runtime.switchTaskMode` 的直接停止路径，避免 Driver 与 Runtime 各自覆盖结果。
- 验证重连快照、占用查询和后台重启后仍能看到未核实原因；恢复沿用拥有者核实后的 `resume-queue`，不新增自动重试或自动释放入口。

交付条件：任务自然完成、失败、取消及模式切换竞争中，false/异常均留下持久事件和占用；同目录第二会话不能开跑，成功回收才按原规则释放，终态事件不重复。

### 3. worktree 临时执行纳入父任务生命周期

- 沿 `packages/runtime/src/subagents.ts` → `work-copy.ts` → Runtime 执行回调传递实际发起的父任务身份，创建和汇总均如此；`WorkCopyExecutor` 与相关测试注入同步调整。不能只靠 `worktree-init-*` 合成 ID 关联取消。
- 在 `Runtime.createWorktreeInContainer` 启动之前登记可取消记录，实际单元产生后更新身份，复用第 1 批的启动/停止规则。受管登记经 Runtime 注入现有 Driver registry，保持 runtime → agent 的依赖方向，不让 agent 反向 import Runtime。
- 将已收到的 Git 结果与 finally 的停止结论分开处理。停止未核实时保留父目录占用、工作副本与已知结果，以带 code 的错误上报；不能返回创建/汇总成功后继续委派、建立替代环境或重放 Git。创建尚未登记工作行时也要能按父任务及执行记录定位现场。
- 覆盖创建与汇总的 ready 前取消、调用中取消、后台停止、结果已返回但 stop 失败，以及模式变化；核实受影响目录受现有占用与工作状态保护，不能只断言 registry 调用了 stop。

交付条件：临时 worker 的失败与普通 worker 走到相同的可见终态和占用恢复规则；工作副本及成果保留。完成后解除 26 的接入阻塞。

### 验证与文档交付

新增 `test/100-worker-stop.test.ts` 集中覆盖可控 launcher 与真实同组进程回收；在 `test/94-task-ending.test.ts` 补收尾竞争与占用，在 `test/83-subagent-worktrees.test.ts`、`test/84-subagent-integrate.test.ts`、`test/95-work-copy.test.ts` 补临时执行归属。测试编号仅用于落点，不与 26、28 共用新文件。

最小回归分两组执行：`npx tsx --test test/100-worker-stop.test.ts test/01-concurrency.test.ts test/04-crash-recovery.test.ts test/10-access-modes.test.ts test/94-task-ending.test.ts`；`npx tsx --test test/83-subagent-worktrees.test.ts test/84-subagent-integrate.test.ts test/86-subagent-recovery.test.ts test/95-work-copy.test.ts test/91-release-acceptance.test.ts`。收尾跑 `npm run check:static`；真实容器/systemd 回归按实际可用环境另记证据，不把注入 stop(false) 写成 OS 回收失败复现。

实现时同步 `docs/modules/execution.md`、`docs/modules/runtime.md`、`docs/modules/core.md` 中实际变化的停止与占用事实，以及 `docs/usage.md` 的核实恢复步骤；核对 `docs/visual/deployment.html` 的既有表述。将提案转为 implemented，在承载决定的入口添加笔记锚点。本轮只落计划，不改运行文档，不勾选验收。

## Comments

### 2026-10-08：登记静态核查发现

定位：`src/agent/tool-worker/host.ts` 的 `start` / `stop`，`src/agent/tool-router.ts` 的 `ensureWorker`，`src/runtime/runtime.ts` 的 `createWorktreeInContainer`，`src/agent/managed-processes.ts` 的 `killProcessGroup`。本次工单 26 先建立边界探针，尚未接入 native；这张工单记录共享生命周期问题，未修改相关实现。

### 2026-10-11：分拣为 ready-for-agent

拥有者要求先将本单升为 ready-for-agent。复核上方四条代码路径仍成立；按既有停止与占用契约补清实施范围、失败上报归属和模拟回归要求，无需等待原生接入。方案 (a) 依赖停止未核实的结果完整传递，因此同步将本单登记为工单 26 原生接入前置；原生探针可独立继续。本次只更新工单，未实施修复，验收项保持未勾选。

### 2026-10-11：制定实施计划

按当前 workspace 包结构补充三批计划、调用方与测试落点。复核发现 Driver 的自然完成、prompt 异常和登记清理也会丢失停止结论，纳入同一修复；没有增加新的执行后端或恢复权限。状态保持 ready-for-agent。


### 2026-10-11：实施完成

启动记录先于异步 launch 登记，保留尚未创建单元与已创建但退出未核实的区别；ready/init、同步或异步 launch 失败、启动取消、并发与重复 stop 均保留同一停止结论。静态启动兼容入口以 `WorkerStartError.host` 交出失败记录，`ExecutionError.unit` 保留已产生单元后的启动异常身份。容器与 systemd 查询失败不再作为已退出证据，受保护停止包装脚本同步修正但未部署。

Driver 聚合全部登记单元，缓存每项停止结果及首个任务停止意图；自然完成、异常、取消与模式变化在退出核实之后决定占用，未核实事件与终态同事务。直接模式切换复用这条收尾，保存写操作未知效果和专用模式失败事件；成功停止期间出现取消或权限变化时拒绝迟到切换。

worktree 创建与汇总传递实际父任务身份，临时启动名独立，启动前归入父任务登记。`worktree_start` 在工具操作账本保存副本定位，ready 后另记 Git 意图；已收到的 Git 结果在停止核实之前保存，未收到结果的已派发写操作不重放。父任务同时临时占用外部副本：成功只释放该副本，失败保留父目录和副本占用，使子任务及其他会话无法改写成果。沿现有 `resume-queue` 显式核实恢复，释放多条遗留占用并丢弃已结束的旧 Driver；同进程新 worker 能执行，旧操作不会重放。occupancy 表原本允许同任务多行，未改 schema 或默认后端。

决策提案转为 [implemented](../../../.agents/notes/implemented/bug-fix/2026-10-11-preserve-unverified-worker-stop.md)，相关入口留锚点；执行、运行时、core、操作说明及部署图解同步现状。工单 26 的原生接入前置解除，其两平台原生验收仍独立进行。

#### 离线与模拟回归

- `npx tsx --test test/100-worker-stop.test.ts test/01-concurrency.test.ts test/04-crash-recovery.test.ts test/10-access-modes.test.ts test/94-task-ending.test.ts`：当时 66/66 通过；随后补齐组合与恢复竞争后，`npx tsx --test test/100-worker-stop.test.ts test/94-task-ending.test.ts test/64-tool-op-ledger.test.ts` 最终 60/60（27 + 24 + 9）通过。
- `npx tsx --test test/83-subagent-worktrees.test.ts test/84-subagent-integrate.test.ts test/95-work-copy.test.ts`：最终 42/42 通过；`npx tsx --test test/86-subagent-recovery.test.ts test/91-release-acceptance.test.ts`：6/6 通过。
- `npx tsx --test test/01-concurrency.test.ts test/03-lifecycle.test.ts test/04-crash-recovery.test.ts test/05-overflow-db.test.ts`：core 多目录占用改动后 14/14 通过。
- `npx tsx --test test/07-real-tools.test.ts test/08-approvals.test.ts test/63-approval-gate.test.ts test/66-control-seam.test.ts`：51/51 通过。
- `npm run check:static`：lint、所有 workspace 与 foundation 类型检查、决策笔记及文档门禁通过。

false、异常、Docker/systemd 查询失败及包装脚本失败状态均为可控注入，断言父任务终态、事件、占用、未知效果与副本字节；不作为真实 OS 单元停止失败复现。首次静态检查发现 finally 中抛错，已将停止结论处理移到 finally 之后并通过复查。

#### 真实资源证据与限制

- `test/100-worker-stop.test.ts` 在本机 macOS 运行真实同组进程：主进程先退出、后代忽略 TERM，旧实现返回成功时心跳仍增长；修复后 TERM/KILL 覆盖原组且心跳冻结。
- 经 `ssh tx` 将当前 `managed-processes.ts` 与无依赖的断言脚本复制到一次性目录，用 Linux Node v24.21.0 原生类型剥离运行同组对照：主进程已退出后心跳继续增长，回收返回 true，心跳 5 → 17 → 17；临时进程与目录清理完成。此证据只覆盖原进程组，不覆盖脱组后代或 native 后端。
- 构建唯一镜像 `ruukoto-worker:issue-27-stop` 后运行 `RUUKOTO_WORKER_IMAGE=ruukoto-worker:issue-27-stop npx tsx verification/foundation/scripts/linux-isolation/container-worker-smoke.mts`：Docker Desktop 16/16，真实容器已移除，脱组后代心跳 4 → 4 且文件仍存在。首次构建因容器内继承本机回环代理而拒绝连接，清空 HTTP/HTTPS/ALL_PROXY 及小写构建参数后重建成功。
- `RUUKOTO_WORKER_IMAGE=ruukoto-worker:issue-27-stop npx tsx verification/smoke/smoke-04-desktop-execution.mts`：产品级真实 Docker 6/6，模型使用本地桩，包含中断后实际容器回收。镜像 manifest 为 `sha256:27e2129e58f765cd4a4449cd1c4b1b9683cb9e49365eb934a163ca7f74099a0a`；本次专用标签已清理。
- 未运行全量 `npm run check`，未部署 systemd 包装脚本，未声称真实 systemd 停止失败或原生两平台验收通过。原生后代回收与 macOS 已确认口径仍由工单 26 验收。
