Status: ready-for-agent

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

### 2026-10-06：第一轮设计决定

Q1–Q3 按推荐确定：

- 范围包含 10 个静态、非 `ToolRouter` 的工具族：`host_data`、`web_search`、`app_data`、`scheduler`、`delegation`、`subagent`（含 `subagent_message`）、`chat_results`、`service`、`skills`、`todo`。
- 编码/文件审批/产物读取的 `ToolRouter` 路径、动态 MCP 和测试 `confirmTools` 路径留在现有接缝，不并入普通宿主工具族。
- 每个工具模块导出带 `category`、`names`、`create(runtime)` 的族适配器，可选声明操作账本规则。Driver 接收一张族清单，从同一清单生成工具数组和直接宿主派发集合。
- 统一每次调用的宿主接缝，能力按 `call`、`identity`、`approval`、`effects` 分组注入。`verifyMain` 与 `verifyHost` 保持不同入口，族只使用实际需要的能力；不把 `kick` 放进通用宿主上下文。

事实更新：

- 当前 `ensureSdk()` 有 9 个独立族装配块，工单原文所说的 7 个已过时。
- 当前直接宿主派发判断位于 `src/agent/driver.ts:1197–1207`，不是工单原记录的旧行号。
- 当前测试目录有 94 个测试文件，仍无直接构造 `Driver` 的测试。
- `ToolOpLedger` 现有 `FamilyCheck` 只覆盖 `app_data`、`scheduler`、`delegation`、`chat_result`、`subagent`；`approval` 在账本中表示效果无法直接核实的分类，不等于工具一定接入 `ApprovalGate`。
- Driver 的 `hostToolCtx` 是共享可变槽位；并发宿主调用可能覆盖彼此上下文。第四条必须改为每次 `execute` 闭包独立持有调用上下文。
- `kick` 继续由拥有对应异步队列的模块持有，不进入通用族适配器：调度器和 SubAgent 管理器各自负责自己的队列，Driver 继续负责任务占用释放后的唤醒。

### 2026-10-06：第二轮设计决定

Q4–Q7 按推荐确定：

- 工具操作账本声明随族适配器移动：族声明每个工具的 `no_effect`、`approval` 或族核实规则，并可提供 `FamilyCheck` 构造器；`ToolOpLedger` 仍是结果、效果未知和停止/重启补记的唯一写入模块。未知动态工具继续按 `approval` 分类。
- 每次宿主调用通过独立句柄获得上下文：`bindCall(sdkCallId)` 返回 `{ context, release }`。工具的异步闭包持有自己的 `context`，结束时调用 `release()`；删除 Driver 的共享 `hostToolCtx` 槽位。
- 新增 `src/agent/host-tool-families.ts`，放置族适配器、调用能力和账本声明类型。Runtime 构造族清单，Driver 接收清单并在任务内以统一调用 runtime 创建工具。
- 本单补齐静态宿主工具的产物登记：所有会创建任务产物的族都使用 `effects.recordArtifact`。`web_search` 的响应产物进入 `task.tool_result.artifactIds`；MCP/ToolRouter 产物不纳入本单。

### 2026-10-06：第三轮设计决定

Q8–Q10 按推荐确定：

- `HostToolFamily` 统一包含 `category`、`names`、`build(runtime)` 和可选的 `ledger`。工具定义返回的名字在构建时与 `names` 核对，重复名字直接拒绝。
- 新增 `test/90-host-tool-families.test.ts`，覆盖族清单派发、并发调用上下文、族账本规则、重复工具名拒绝和 Web Search 产物登记；现有工具族与 Runtime 集成测试保留作为回归。
- 按四步交付：先建立适配器类型与独立调用句柄，再迁移 10 个静态族与 Runtime 清单，随后迁移账本声明并补 Web Search 产物登记，最后同步 `docs/runtime.md` 与 `docs/visual/` 并完成交付记录。
- 分支为 `host-tool-families`，每步通过 `npm run typecheck` 与完整 `npm test` 后本地提交，不推送。
