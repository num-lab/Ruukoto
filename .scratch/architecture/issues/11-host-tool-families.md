Status: resolved

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

## 已确定的范围与验收

本单覆盖十个静态宿主工具族的装配、直接派发、调用上下文与账本声明。会话工具类别、任务收窄、审批消费与身份现场复核仍由已有模块决定。Router、动态 MCP 与测试 `confirmTools` 保留原执行接缝。

验收以真实工具路径为准：Driver 不再逐族维护依赖字段与派发 OR；每次 `execute` 独立捕获身份，成功与异常都释放自己的句柄；静态族的停止、重启、结果落盘失败补记使用族声明；停用能力的历史操作仍可核实；Web Search 的响应产物关联到对应工具结果事件；工具重名或声明与实际构建不符即拒绝。

“工具族模块、类别表、清单”是三处接线责任。若新增工具类别，仍须扩展 `src/core/types.ts` 的 `ToolCategory` 联合类型；因此不承诺每次新增只修改三个文件。

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

### 2026-10-06：实现细化

- SubAgent 工具族有真实的两种装配形状：父会话得到完整工具族，子会话只得到 `subagent_message`；`names` 因此允许按调用 runtime 返回名字清单。宿主评审仍由执行画像关闭消息激活。
- Runtime 在应用库、来源解析器与调度器初始化之后、恢复之前建立同一份族清单；账本从其 `ledger` 声明派生，Driver 直接接收同一清单。缺失应用库、停用调度器或缺失服务配置只使 `names/build` 为空，历史操作的规则与核实器仍保留。
- 调度器的可信通知目标以调用上下文中的 `taskId` 解析，审批后复核也使用捕获的上下文。避免把当前任务查找作为第二条时序约束。
- `ToolOpLedger` 只留下 Router/mock 与已删除 `coding_delegate` 的规则；兼容 `coding_delegate` 的 analyze/draft 核实不依赖当前工具装配。新增活跃工具族无需扩展中央账本规则或族名联合类型。
- `HostCallBinder` 仅返回独立句柄；未注入 binder 的既有模块测试可继续直接提供 `taskContext`。不存在生产的共享上下文或旧释放函数兼容路径。
- Web Search 的响应产物关联断言放在已有 `test/23` 服务故障集成用例，`test/90` 验证真实并发 execute、清单与账本接缝，避免重复建立模拟搜索服务。

### 2026-10-06：实现验证记录

本地分支 `host-tool-families` 从 develop `6e3135e` 建立，目前已提交：

- `17a6a30`：设计决定记录。
- `93c6dd1`：独立 `HostCall` 与族清单基础接口。
- `eba4a2e`：十个静态族的 Runtime 清单、Driver 装配与派发、族账本声明、Web Search 产物关联及相应测试。

原计划的第二、三步在 `eba4a2e` 一并交付：全局族清单需要在恢复前同时提供工具构建入口与完整账本声明，避免用两张临时清单接线。第一步未使用后台退出码文件，后续完整检查已改为后台运行并写退出码文件。

验证：

- 改动前基线：typecheck 通过；完整 906 项，904 通过、1 跳过、1 失败。
- 第一实现步：typecheck 通过；完整 908 项，906 通过、1 跳过、1 失败。
- 族清单与账本接入后的完整检查：914 项，912 通过、1 跳过、1 失败。日志和退出码位于 `/var/folders/y4/36h8kvvd4q52vjptp522rzfc0000gn/T/ruukoto-host-family-check-b7ke9i5p/`。
- 上述唯一失败均为 `test/08-approvals.test.ts:704` 的 DNS 解析用例：不可解析目标等待 60 秒后超时；改动前已失败，因此不能声称本机完整测试全绿。该项未纳入本单修改。
- 新测试包含真实并发 execute 的正常/异常收尾、名字漂移/重复、族声明参与四个账本入口。Web Search 产物引用在既有 23 号服务故障集成用例断言；48、64 号仅更新账本接线。
- 临时移除独立上下文、构建结果重复检查、停止路径族分类、Web Search 产物登记，四项变异均击中对应断言；源码均已恢复。日志位于 `/var/folders/y4/36h8kvvd4q52vjptp522rzfc0000gn/T/ruukoto-host-family-mutations-pkfsdx_0/`。
- 恢复后 23、67、90 号共 22 项通过。独立只读复核未发现 P1/P2 缺陷，覆盖来源目标 ctx、权限/审批重核、停用能力恢复与 SubAgent 变体。
- 共享上下文属于结构性耦合；本单没有声称已复现生产身份串用。新的接口把每个 execute 独立持有身份与释放自己的绑定作为明确保证。

### 2026-10-06：文档同步与交付

- `docs/runtime.md` 更新架构要点、工具操作账本和 Web Search 产物引用。
- `docs/visual/tool-call-path.html` 更新页头、`#path`（族清单与独立调用时序）、`#availability`（装配条件与 SubAgent 协作消息）、`#ledger`（各族声明与旧操作兼容）。
- `docs/visual/context-pipeline.html#subagent` 更新 SubAgent 消息构建入口，修复已删除的 Driver 注释锚点，并缩短资料快照节点文案、调整 read 箭头；`docs/visual/index.html` 同步工具调用路径卡片。
- 文档中原“RULES 按全部静态工具穷尽登记”改为当前事实：宿主规则随族声明，Router/mock/旧操作保留固定规则；原“编排器重试门共用 RULES”已不符合固定角色退役后的代码，删除，当前实际调用者为 ToolRouter 的 HTTP 效果判定。
- 核实依据：`Runtime.initHostToolFamilies` 与 `start`、`Driver.ensureSdk/bindHostCall/handleToolCall`、`createSubAgentFamily`、`ToolOpLedger.ruleOf/recordFamilyVerdict`、Web Search `saveRawResponse`。
- 图解页校验 67 号四项通过；工具调用页与上下文页的 26 张渲染切片均核对。最终核对发现工具可用性表漏列 `subagent_message`，已补齐父会话完整清单和子会话单独装配说明，并重做本页检查。
- 最终收尾检查 typecheck 退出码 0；完整测试仍为 914 项（912 通过、1 跳过、唯一基线 DNS 超时失败），无新增失败。最终日志及退出码：`/var/folders/y4/36h8kvvd4q52vjptp522rzfc0000gn/T/ruukoto-host-family-final-8t99nosa/`。

实现、测试和文档在本地分支交付；没有 push 或合入 develop。MCP 的产物事件关联仍在本单范围外。

文档与本交付记录随收尾提交保存。补齐协作消息表格后，工具调用页已再次生成并检查 15 张切片，67 号仍为 4/4 通过。
