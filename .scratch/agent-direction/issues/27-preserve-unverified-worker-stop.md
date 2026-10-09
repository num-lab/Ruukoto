Status: needs-triage

# 27 — 保留工具执行单元停止失败的核实结果

**What to build:** 工具 worker 启动失败、重复停止与 worktree 临时执行入口必须保留整单元停止失败，不能把无法核实转换为成功后释放目录占用。

**Blocked by:** 无。工单 26 第一阶段代码核查发现；下面是当前代码的确定分支，尚未用真实停止失败的 OS 单元复现，不把静态核查作为原生边界证据。

依据：[工单 26](26-native-sandbox.md)、[ADR 0004](../../../docs/adr/0004-tool-worker-per-task-container-exec-account.md)、[ADR 0021](../../../docs/adr/0021-subagent-worktrees.md)。

## 已核实代码路径

1. `ToolWorkerHost.start` 的 ready 失败路径调用 `unit.entry.stop().catch(() => false)` 后丢弃返回值，仅抛原错误；`ToolRouter.ensureWorker` 的 starting 占位把 rejected startPromise 转成 null，再返回 true。单元未能回收时仍可能报告已退出。
2. `ToolWorkerHost.stop` 在调用 `unit.entry.stop()` 前置空 `this.unit`；第一次返回 false 后，第二次调用因 `!this.unit` 直接返回 true。受管登记表里 starting 与实际单元均持有同一 host，停止结果必须一致，不能由后续入口把失败改成成功。
3. `Runtime.createWorktreeInContainer` 没有登记 starting 或实际执行单元；finally 忽略 `host.stop()` 的 false 并吞异常。其“残余由主管进程登记兜底”的注释没有对应登记代码，创建与汇总的临时 worker 需要进入取消、后台停止与占用核实路径。
4. `killProcessGroup` 的核实只调用 `pidAlive(pid)` 检查主 PID，未检查组中其余进程；脱离进程组的后代更不在该范围内。local 不能凭这个返回值用于受限边界验收。

## 验收标准

- [ ] 启动失败且 stop 返回 false 或抛错时，停止入口保留未核实结果，父任务持有占用并报告明确原因。
- [ ] 同一执行单元的并发和重复 stop 返回一致的核实结果；不会因句柄已置空而将 false 改为 true。
- [ ] worktree 创建与改动汇总登记可回收单元，覆盖启动窗口、取消与后台停止；无法核实退出时保留相关目录占用和副本成果。
- [ ] 用可控的停止失败启动器验证上述分支，并区分模拟回归与真实容器/systemd/native 停止证据；未知效果不自动重放。
- [ ] 同步运行说明与图解中关于停止核实的表述；原生的完整后代回收仍须通过工单 26 的两平台实测。

## Comments

### 2026-10-08：登记静态核查发现

定位：`src/agent/tool-worker/host.ts` 的 `start` / `stop`，`src/agent/tool-router.ts` 的 `ensureWorker`，`src/runtime/runtime.ts` 的 `createWorktreeInContainer`，`src/agent/managed-processes.ts` 的 `killProcessGroup`。本次工单 26 先建立边界探针，尚未接入 native；这张工单记录共享生命周期问题，未修改相关实现。
