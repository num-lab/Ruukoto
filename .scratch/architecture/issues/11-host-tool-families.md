Status: needs-triage

# 宿主工具族：每个工具族一个 adapter，driver 只收一张清单

## 目标

每个宿主工具族声明类别、工具名、工具操作账本声明，并按统一的每次调用宿主上下文（身份复核、审批、产物登记、效果未知标记）构建；Runtime 交给 driver 一张清单，派发集合由装配结果推出。加一个工具族从改 9 处降到 3 处（工具族模块、类别表一行、清单一行）。来源：2026-10-05 架构审查的候选 04。

## 背景

2026-10-05 核对（develop d109dbe）：

- c1e52f3（service 工具族）的接线改动：`driver.ts` 4 处（import、`DriverDeps` 字段、工厂块 + `ensureSdk` 展开、`handleToolCall` 名单），另改 `tool-availability.ts`、`types.ts`、`runtime.ts`、`session-factory.ts`、`tool-op-ledger.ts`。
- 宿主派发判定是 10 路 `*_TOOL_NAMES` OR（`driver.ts:1252–1266`）；7 个工厂块几乎一样，都传 `coreStore / taskContext / bindCall / verifyMain / requestApproval`（`driver.ts` 420–575）。
- `DriverDeps.subagents` 是 8 个成员的 Pick，Runtime 用纯转发 lambda 填（`runtime.ts:2968–2979`）。
- driver 最近 10 次提交几乎都是两种改动：加 `DriverDeps` 字段 + 工厂块，或加 `toolClass === "subagent"` 分支（后者归候选 08）。
- 没有测试直接构造 `Driver`；93 个测试文件中 73 个经 `testkit.ts` 启动 Runtime + ControlServer + MockModelServer。

## 待访谈

- 账本声明（无写入效果、写操作按宿主操作 ID 核实）是否随工具族一起声明。
- 宿主上下文的边界：哪些是每次调用的、哪些是每任务的。
- 与候选 08 的先后（08 先消掉 `toolClass` 分支，本单的 driver 改动更小）。

## 相关 ADR

- 工单 03（工具可用性）：类别表仍是可见性的唯一来源；本单只把装配与派发移出 driver。
- 工单 05（工具操作账本）：工具族声明的形状沿用。

## Comments
