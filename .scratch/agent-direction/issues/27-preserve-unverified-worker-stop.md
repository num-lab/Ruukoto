Status: ready-for-agent

# 27 — 保留工具执行单元停止失败的核实结果

**What to build:** 工具 worker 启动失败、重复停止与 worktree 临时执行入口必须保留整单元停止失败，不能把无法核实转换为成功后释放目录占用。

**Blocked by:** 无。本单修复共享生命周期，可在现有后端上独立实施，是工单 26 原生接入的前置。下面是当前代码的确定分支，尚未用真实停止失败的 OS 单元复现，不把静态核查作为原生边界证据。

依据：[工单 26](26-native-sandbox.md)、[ADR 0004](../../../.agents/notes/implemented/architecture/2026-09-20-tool-worker-per-task-container.md)、[ADR 0021](../../../.agents/notes/implemented/architecture/2026-10-04-subagent-worktrees.md)、[原生执行沙箱的已确认方案](../../../.agents/notes/proposed/architecture/2026-10-10-native-execution-sandbox.md)。

## 已核实代码路径

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

- [ ] 启动失败且 stop 返回 false 或抛错时，停止入口保留未核实结果，父任务持有占用；任务状态、事件与占用查询可见明确原因，不能只写 stderr。
- [ ] 同一执行单元的并发和重复 stop 返回一致的核实结果；不会因句柄已置空而将 false 改为 true。
- [ ] worktree 创建与改动汇总登记可回收单元，覆盖启动窗口、取消与后台停止；无法核实退出时保留相关目录占用和副本成果。
- [ ] 用可控启动器覆盖未创建单元的启动失败、ready 失败后停止成功/返回 false/抛错、并发与重复停止、临时 worker 的启动取消和后台停止；断言最终占用与可见状态，区分模拟回归与真实容器/systemd/native 停止证据，未知效果不自动重放。
- [ ] 同步运行说明与图解中关于停止核实的表述；原生停止仍须通过工单 26 按已确认口径开展的两平台实测。

## Comments

### 2026-10-08：登记静态核查发现

定位：`src/agent/tool-worker/host.ts` 的 `start` / `stop`，`src/agent/tool-router.ts` 的 `ensureWorker`，`src/runtime/runtime.ts` 的 `createWorktreeInContainer`，`src/agent/managed-processes.ts` 的 `killProcessGroup`。本次工单 26 先建立边界探针，尚未接入 native；这张工单记录共享生命周期问题，未修改相关实现。

### 2026-10-11：分拣为 ready-for-agent

拥有者要求先将本单升为 ready-for-agent。复核上方四条代码路径仍成立；按既有停止与占用契约补清实施范围、失败上报归属和模拟回归要求，无需等待原生接入。方案 (a) 依赖停止未核实的结果完整传递，因此同步将本单登记为工单 26 原生接入前置；原生探针可独立继续。本次只更新工单，未实施修复，验收项保持未勾选。
