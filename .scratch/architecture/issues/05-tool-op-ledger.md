Status: resolved

# 工具操作账本：停止与重启共用一处结果核实

## 目标

「记录结果 → 标效果未知 → 停止 / 重启时补记」由一个模块负责，工具族只声明哪些工具无写入效果、写操作怎么按宿主操作 ID 核实是否已提交。停止与重启对同一个操作得出同一结论。来源：2026-09-26 架构审查的候选 05，外加 04 移交的两条（消费后的失败定性、HTTP 中止信号）。

## 背景

2026-09-27 核对（main f6d99c3）：

- 两条路径各自按工具族手写核实：
  - 停止路径 `Driver.requestStop`（`driver.ts:810–919`）：中止前快照「结果缺失、不在四个族里、按审批判定不确定」的操作（:828–838），中止后按应用数据（3b）、调度（3c）、委派（3d）、群结果逐族核实，最后 `finalize` 在终态事务里标效果未知（:922–958）。
  - 重启路径 `Runtime.recover`（`runtime.ts:830–900`）：先 `recoverAppDataOps`（:796）与另三个族的循环（覆盖全部任务，含终态），再对活动任务跑通用判定（:861，只覆盖活动任务）。
  - 四个 `settle*Op`（`app-data/tools.ts:69`、`scheduler-tools.ts:66`、`delegation-tools.ts:38`、`chat-result-tools.ts:62`）骨架相同：选文案 → `recordToolResult` → 条件成立再 `appendEvent`。
- 「结果 + 事件」手写配对：四个 settle、停止路径与重启路径的只读补记、重启的通用补记、`tool_execution_end`（:1290）、审批闸门 `recordNotExecuted`（`approval-gate.ts:193`）。「标效果未知」（操作标记 + 事件 + 任务标记）手写四处：`finalize`、`recoverAppDataOps` 终态分支、重启通用判定、路由器 `markMcpEffectUnknown`（`tool-router.ts:608`）。
- 漏登记的工具静默落进效果未知：`read`、`web_search`、`history_*`、`memory_list/read`、`skill`、`todo_write` 等只读工具在停止或重启时未结束，一律标效果未知（按审批判定：无审批 = 不确定）。`orchestrator.ts:102` 的 `RETRY_SAFE_TOOLS` 是同一批名字的第二份清单。
- 已分叉或有缺口：
  1. 应用数据写操作「审批未消费 + 应用库无法核实」：停止路径标效果未知（3b 不看审批），重启路径落到通用判定记已知未执行。
  2. 重启时终态任务残留的通用操作不补记（只有四个族覆盖终态任务）；「驱动器缺失仍转中断」的异常路径（`runtime.ts:3380–3390`）直接转 interrupted 不补记任何操作，这些操作永远停在进行中。
  3. 停止快照排除「已批准未消费」的操作；批准刚好在停止瞬间被消费、执行又没落结果时，操作不在快照、不在任何族，`finalize` 不标，终态后重启也不补，静默留空。
  4. 重启「审批未消费」补记落库与事件不是同一句（`runtime.ts:867–870`：落库多「（批准不跨重启执行）」）。
  5. 停止路径写死「后台停止前」，拥有者中断、取消也走这里。
  6. 结果落盘失败的即时核实只对应用数据（`driver.ts:1307–1320`）。
- 04 移交：
  - MCP：`classifyMcpError` 把 SDK 的 `ProtocolError`（远端 JSON-RPC 错误应答）兜底成 `connect_failed`（`mcp/client.ts:181`），写工具因此标效果未知，与 `tool-router.ts:593` 注释、ADR 0008 相反。但 SDK 2.0.0 的 `callTool` 在远端成功应答后还会按缓存的 outputSchema 本地校验 `structuredContent`，不符也抛 `ProtocolError`（码与远端的分不开），这时远端已执行。issue 16 交付的「SDK 按 outputSchema 校验」由 `test/24-mcp.test.ts:924` 断言（不符即失败）。
  - HTTP：消费后所有失败都记已知错误（写方法的「已发出、等响应时断开」也一样）；`status` 为空时模型只看到「HTTP 无响应」，失败原因不进返回文本（`tool-router.ts:358–363`）；发送不接中止信号，停止要等最长 30 秒超时（`approved-ops.ts:351`）。

## 决定

### 范围

- 新建 `src/agent/tool-op-ledger.ts`，类 `ToolOpLedger`（Runtime 构造一个，注入 Driver 与路由器）：
  1. 「结果 + 事件」配对写入（落库与事件同一句）；
  2. 标效果未知（操作标记 + `task.tool_effect_unknown` + 任务标记，幂等）；
  3. 分类器（取代 `isToolOpExecutionUncertain`）；
  4. 停止与重启的补记入口。
- `store` 只留 SQL 原语；Driver 里四份名单过滤、`DriverDeps.appData.writeVerdict` 的停止用途、两个 `listUnresolved*` 查询删掉。
- 四个族的 settle 函数瘦成只回答核实：`committed | not_committed | unverifiable`，并提供各自的证据文案。

### 规则表

`Record<StaticToolName, Rule>`，键是全部静态工具名常量的联合类型，漏登记即编译错误。规则三种：

| 规则 | 工具 |
|---|---|
| `no_effect` 无写入效果 | `read`、`read_artifact`、`history_search`、`history_read`、`memory_list`、`memory_read`、`web_search`、`skill`、`todo_write`（清单只由成功调用的参数推出）、`app_data_query`、`schedule_query`、`notification_query`、`coding_result`、`chat_result_list`；`http_request` 的 GET/HEAD、`request_file_access` 的读（按持久化参数判定） |
| `family` 按族核实 | 应用数据写（应用库回执）、调度与通知写（调度账本）、`coding_delegate`（子任务）、`chat_result_accept`（接收账本） |
| `approval` 按审批判定 | `bash`、`edit`、`write`、`http_request` 其他方法、`request_file_access` 写、`memory_save`、`memory_revoke`、`mock_*`；MCP 动态工具与未登记名字 |

- 记忆族不登记核实：`memory_revoke` 只改 `memories.status`，不写带 `tool_op_id` 的版本行，无法从磁盘证明它发生过；在模块注释写明。
- MCP 读工具也按审批判定：副作用类别不在 `tool_ops` 里，重启时拿不到钉版计划（已知上限）。
- `mock_*` 在测试里代表可能有副作用的通用工具（`mock_mark` 写外部标记）。

### 分类顺序（停止与重启同一个）

对每个结果缺失、未标未知的操作：

1. 有审批且全部未消费 → 已知未执行（证据强于其余各条）；
2. `no_effect` → 补记「未完成：只读操作在{时机}中止，无写入效果」（`is_error` 真）；
3. 有族核实 → 已提交 / 已知未提交（族的证据文案）；无法核实 → 效果未知；
4. 其余 → 效果未知。

### 停止与重启

- 停止：`ledger.beginStop(task)` 在中止前取快照（规则为 `approval`、结果缺失、按审批判定不确定）；中止后 `ledger.settleTask(task, "停止前")` 跑全套分类器，快照里的操作与分类器得出「效果未知」的操作一起在 `finalize` 终态事务里标记（终态被竞争路径抢先则不标，同现状）。已知结果（只读、已知未执行、族核实）在终态事务之前补记，同现状。
- 语义：停止或重启时，已开始未结束的操作一律效果未知，除非规则给出更确定的结论。快照里的操作即使在中止期间落了结果（bash 的「已中止」说明不了效果）仍标未知，同现状。
- 重启：一趟覆盖全部任务（含终态），终态任务残留的不确定操作补标操作级与任务级效果未知；活动任务转中断时 `effectUnknown` 按本任务的未知操作计。仍在恢复事务内。
- 结果落盘失败：`ledger.settleAfterWriteFailure` 只对有族核实的操作即时核实（四个族），其余照旧留给重启（真实结果已拿到只是没写进去，标未知不对）。

### 文案

- 时机：停止路径「停止前」，重启「后台重启前」，结果落盘失败「结果写入失败前」。
- 重启「审批未消费」：「已知未执行：审批未消费即发生后台重启（批准不跨重启执行）」，落库与事件同一句。
- 族的「已提交 / 已知未提交」证据文案原样保留。

### RETRY_SAFE_TOOLS

由账本的 `no_effect` 集合推导，删掉 `orchestrator.ts:102` 的清单。对 coding 子任务等价（多出的名字 coding 装配不到；`http_request` GET 需要审批，已被「有批准即不重试」挡住）。

### MCP 定性

- 任务开始钉版 outputSchema（`PlannedTool.outputSchema`），预检与 inputSchema 相同（普通对象、≤16 KiB、TypeBox Compile），不合格禁用该工具并写明原因（原来每次调用 SDK 在发送前报 invalid outputSchema，效果等价）。
- 调用传 `toolDefinition: { name, inputSchema }`：SDK 不再本地校验输出，-32020 刷新后的自动重发也关掉。
- 远端成功应答后按钉版 schema 校验 `structuredContent`；不符记已知错误「远端已执行，但结构化结果与声明的 outputSchema 不符」，不标未知。24:924 照旧成立。
- `ProtocolError` → 新码 `remote_error`（已知错误，不标未知）。

### HTTP 定性与中止

- GET/HEAD：失败一律已知错误。
- 其他方法：以 `ClientRequest` 的 `finish`（请求已交给操作系统发送）划界：之前失败（连接被拒、TLS、凭据、URL）已知错误；之后失败（等响应超时、重置、响应读取失败）经账本标效果未知。正文只发出前半截即断开按未发出处理。
- 返回文本带 `outcome.message`；效果未知时加「请求可能已送达、结果无法确认，未自动重发」。
- `input.signal` 传给 `transport.request(url, { signal })`；中止按上面同一规则定性。停止时进行中的写请求照旧由停止快照标未知，收益是停止不再等超时。

### 领域与文档

- CONTEXT.md 在「批准消费」后加「效果未知」。
- 不新写 ADR：MCP 这条回到 ADR 0008 原意；HTTP 这条与 ADR 0008 对 MCP 写调用的规则同构，写进 CONTEXT.md 与 runtime.md。
- `runtime.md`「架构要点」加「工具操作账本（架构工单 05）」，修正停止与重启相关段落。

### 不在本单

- 调用门分派名单（`ROUTED_TOOL_NAMES`、宿主名单，候选 03 留的口子）。
- 要不要审批与自动审查策略（各族与 `review.ts`，04 已定）。
- 通知 outbox 发送操作的 `effect_unknown`（它自己的状态机）；GitHub 退役迁移的 `effect_unknown`。
- 文件执行器消费后核对目标身份与原文（04 已定）。
- `memory_revoke` 写版本行（能让记忆族可核实，另开工单）。
- 应用库 schema；tx 上的真实模型验收。

## 测试

- 新增 `test/64-tool-op-ledger.test.ts`（`new Store(new Db(tmp))` + 假族核实）：
  - 配对：落库与事件同一句；重复补记不重发；标未知幂等并写任务标记。
  - 分类器四条各一例；审批未消费时族返回无法核实仍记已知未执行；族三种结论；参数判定（GET / POST、读 / 写文件）；动态名字按审批判定。
  - 停止：快照不含只读与族操作；快照内操作中止期间落了结果仍标未知；快照外、中止期间批准被消费而无结果的操作由 `settleTask` 标未知。
  - 重启：终态任务残留通用操作补标操作级与任务级未知；活动任务中断的 `effectUnknown` 按本任务未知操作计。
- 回归（修复前应失败）：
  - 重启播种（照 28 号停机时直接写库）：活动任务无结果的 `read` 记「未完成、无写入效果」、任务不标未知；终态任务无结果的 `bash` 重启后标效果未知。
  - 25 号：写工具远端 `rpcError` 记已知错误、任务不标未知；写工具返回不符 schema 的结构化结果，文案写明远端已执行、不标未知。
  - 08 号：POST 服务端收下后重置连接 → 效果未知；POST 到无监听端口 → 已知错误；GET 被重置 → 已知错误；停止挂起的 POST 几秒内返回。
  - 其余随文案变化改断言。
- 收尾变异：审批判定与族核实次序对调；忽略 `no_effect`；GET 当写；重启跳过终态任务；停止快照含只读操作；`settleTask` 不标窗口操作；落库与事件两句；标未知不写任务标记；`ProtocolError` 改回 `connect_failed`；不传 `toolDefinition`；不做钉版 schema 校验；`sent` 恒真 / 恒假；不传中止信号。

## 步骤

0. 工单与 CONTEXT.md「效果未知」。
1. 纯搬移、行为不变：`ToolOpLedger` 接管「结果 + 事件」配对与标效果未知（审批闸门、`tool_execution_end`、路由器 MCP、`finalize`、重启三处）；四个族的 settle 只回答核实；文案与分类不变。
2. 规则表与分类器；停止（`beginStop` / `settleTask`）与重启（`settleAll`）走同一入口；删 `isToolOpExecutionUncertain`、两个 `listUnresolved*` 与 Driver 四份名单过滤；缺陷 1–6 与只读不标未知随之生效。
3. `RETRY_SAFE_TOOLS` 由账本推导。
4. MCP 定性。
5. HTTP：`finish` 划界、文案带原因、接中止信号。
6. 文档收尾，变异检查，工单标记完成。

第 1、2 步提交前各跑一轮对抗式等价复核（第 2 步：行为变化清单之外没有差异）。每步 `npm test` 与 `npm run typecheck` 都通过后在分支 `tool-op-ledger` 本地提交，不 push。不在 tx 上跑真实模型验收。

## Comments

### 2026-09-27：实现交付

按 0→6 在分支 `tool-op-ledger`（从 main f6d99c3 开，#4 合并后）本地提交，未 push：

- 第 0 步 dcb4b71：工单与 CONTEXT.md「效果未知」。
- 第 1 步 4a9fd20：`src/agent/tool-op-ledger.ts` 接管「结果 + 事件」配对与标效果未知；审批闸门、`tool_execution_end`、路由器 MCP 标记、`finalize`、重启恢复与四个族的 settle 都经它写（纯搬移）。
- 第 2 步 36b3487：规则表、分类器、`beginStop` / `settleTask` / `settleAll` / `settleAfterWriteFailure`；四个族的 settle 收成 `FamilyCheck`；删 `isToolOpExecutionUncertain`、两个 `listUnresolved*`、Driver 四份名单过滤与 `DriverDeps.appData.writeVerdict`；新增 64 号。
- 第 3 步 9bc58e2：编排器重试门改用 `hasNoWriteEffect`，删 `RETRY_SAFE_TOOLS`。
- 第 4 步 c419e50：MCP `ProtocolError` → `remote_error`；调用传钉版定义；outputSchema 钉版预检与路由器校验。
- 第 5 步 1160823：HTTP `finish` 划界、无响应文案带原因、接中止信号。
- 第 6 步（本提交）：`docs/runtime.md`「架构要点」加工具操作账本，修正任务状态机、重启恢复、结构化审批、MCP 写调用与应用数据恢复段落；本工单。

每步 `npm test` 与 `npm run typecheck` 都通过（最终 621 项，620 通过，1 项按开关跳过）。第 1、2 步提交前各跑一轮对抗式复核：第 1 步等价（唯一可观察差异：重启路径的 `task.tool_effect_unknown` 事件带上了 sessionId，TUI 因此在本地未载入该任务时也能应用它）；第 2 步没有清单外的代码级差异，下游后果见下。回归测试在修复前均确认失败（重启播种、25 号远端错误、08 号 HTTP 重置与停止挂起请求）。

与上面的决定不同、或决定没写到的地方（请复核）：

- **分类顺序**：实现为「审批未消费 → 无写入效果 → 族核实 → 效果未知」，第一轮定的是无写入效果在前。08:602 的崩溃测试里，带未消费审批的读文件操作被先判成「无写入效果」；审批没消费即证明没执行，「已知未执行」更准。两条都是已知结论，哪些操作标效果未知不变。上面「分类顺序」已按实现改写。
- 第 1 步里四个族的 settle 仍自己选文案、经账本写入，收成只回答核实推迟到第 2 步（工单原写第 1 步完成）。
- **重试门的下游后果**：failed 的 analyze 子任务若有只读操作结果缺失、又在结果回传前崩溃，重启补记后满足重试条件会被自动重试（改动前不重试）；`http_request` GET 与读文件被拒或失效（审批未消费）时不再挡重试（旧清单不含它们，已批准或已消费的审批照旧挡住）。
- **升级后首次重启**：历史终态任务残留的结果缺失操作会被一次性补记（写 `task.tool_effect_unknown`、置任务级标记）。已写入的委派结果里 `effect` 可能仍是 `none_unknown`，与新置的标记不一致；对终态任务，「审批未消费即发生后台重启」「在后台重启前中止」的措辞不精确。
- 重启事件顺序：先写完全部操作的补记，再逐个写 `task.interrupted`（原先按任务交错）；没有依赖顺序的消费方。
- `ruleOf` 用 `Object.hasOwn` 查表（原型链上的键如 `hasOwnProperty` 按审批判定；不可达，防恢复事务抛错）。
- MCP：outputSchema 不受支持的工具在任务开始即禁用（`mcp check` 显示原因），原先是每次调用时 SDK 在发送前报错；连接与发现阶段的 `ProtocolError` 同样记 `remote_error`（原 `connect_failed`，只影响不可用原因的文案）。
- HTTP：响应头已到、正文读取失败仍按「无响应」处理（状态码照旧丢弃），写方法因此标效果未知（保守）。
- 04 号崩溃测试改为等标记内容落盘再杀进程：`appendFile` 先建文件后写入，满载时偶发空文件（与本单无关的既有问题）。
- 重启的 `task.interrupted.effectUnknown` 改读补记之后的任务标记，与停止路径（`finalize` 读任务标记）同一口径：原先只看本次重启新标的操作，崩溃前已被运行时标过（如 MCP 写调用超时）的任务事件会报 false，TUI 按事件把标记改成 false。第 6 步随文档一起提交，有回归测试（修复前失败）。
- 变异 16 处都能被发现：审批判定与族核实次序对调、忽略无写入效果、GET 当写、重启跳过终态任务、停止快照含只读操作、`settleTask` 不标窗口操作、落库与事件两句、标未知不写任务标记、`ProtocolError` 改回 `connect_failed`、不传 `toolDefinition`、不做钉版 schema 校验、`sent` 恒真 / 恒假、不传中止信号、结果落盘失败不核实、重启中断事件只看本次新标。

按决定留在范围外、本单未处理：见「不在本单」。
