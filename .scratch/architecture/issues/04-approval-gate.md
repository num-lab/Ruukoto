Status: resolved

# 审批闸门：审批全程收进一个模块

## 目标

「提交 → 自动审查 → 等待 → 获批后复核 → 单次消费 → 交回快照」由一个模块负责，工具族只提供审批范围、获批后复核与（需要时）同事务提交的本地效果。来源：2026-09-26 架构审查的候选 04。

## 背景

2026-09-27 核对（main 9535a9d）：

- 两端共用：`Driver.awaitApproval`（`driver.ts:1192–1286`，提交与状态切换、自动审查、等待、未批准时写「已知未执行」）连同等待表、计数、审查中止器（:159–162）、`runAutoReview`（:1294–1372）、`resolveConfirmation` / `supersedeAllWaiters`（:1376–1411）都在 Driver；`Store.consumeApproval`（`store.ts:1178`）一条条件 UPDATE 完成单次消费。
- 中间一段（按 toolOpId 重找批准 → 复核 → 消费并写 `task.approval_consumed` → 选执行参数 → 失败文案）各写一份：路由器 `consumeApproved`（`tool-router.ts:365–398`，文件、HTTP、MCP 共用）、应用数据 `consumeApproved` + `runDestructive`（`app-data/tools.ts:181–244`）、通知 `approveThenCommit`（`scheduler-tools.ts:289–322`）。Driver 里测试用的 confirmTools 门（`driver.ts:1134–1189`）是第四份等待代码，批准后不消费。
- 已分叉：
  | | 文件 / HTTP | MCP | 应用数据 | 通知 |
  |---|---|---|---|---|
  | 获批后复核 | 无（都在消费之后的执行器里） | 消费事务内 `mcpConfigBlock` | 事务外：身份、应用库版本 | 事务外：身份、目标；事务内：资料 |
  | 效果与消费同事务提交 | 否 | 否 | 否（另一个库） | 是 |
  | 执行参数 | 审批前在内存里构造的请求 | 审批记录的 params | 审批记录的 params | 审批前的闭包值 |
  | 未批准时模型看到的文案 | 路由器一套 | 同左 | 多「或版本已变化」 | 写死「拥有者拒绝…未登记」 |
  | 等待时传 signal | 传 | 传 | 不传 | 不传 |
- 缺陷：
  1. 通知获批后 `requireCtx()`（`scheduler-tools.ts:303`）重读 Driver 共享的 `hostToolCtx`（`driver.ts:464–470`）。main 的宿主工具没声明顺序执行，pi 先逐个过调用门再并行执行（`pi-agent-core/dist/agent-loop.js:330–371`）；同批另一个宿主工具先结束就把上下文置空，获批的 `schedule_create` 抛「工具调用缺少宿主任务上下文」，批准停在 approved 未消费。
  2. 应用数据破坏性路径在 try 里 `return runDestructive(...)` 没有 await（`app-data/tools.ts:308`、`:420`）：获批后存储层的错误不经 `fail`，不写 `app_data.rejected`，冲突文案少「（当前版本：…）」。
  3. 带使用范围的凭据在消费之后才被拒：审批前只 `credentials.get` 查存在与 host（`tool-router.ts:537–542`），scope 拒绝在执行器（`approved-ops.ts:264–273`）。
  4. 复核或消费失败的批准永远停在 approved，编排器重试门把 approved 视为不安全（`orchestrator.ts:607`）。
- 其他不一致：未批准时库里存 Driver 的文案（`driver.ts:1251–1262`，`recordToolResult` 以先写者为准），模型看到各族的文案；提前中止分支把本任务所有 pending 审批置 stale，且不看计数就转回 running（`driver.ts:1221–1227`）。

## 决定

### 范围

- 新建 `src/agent/approval-gate.ts`，类 `ApprovalGate`（每个 Driver 一个，依赖 store 与 reviewer）：提交与任务状态切换、自动审查、等待（等待表、计数、审查中止器）、决定落库与「已知未执行」记录、获批后复核与单次消费、`task.approval_consumed` 事件、失败文案。
- Driver 只接线：工具边界模式切换 → `supersedeAll()`；停止 → `cancelAll()`；控制面应答 → `resolve()`。Driver 保留 `resolveConfirmation()`、`supersedeWaiters()` 一行委托，`runtime.ts` 不改。
- 文件、HTTP、MCP、应用数据、通知与 confirmTools 门都走闸门。

### 接口

```ts
request<T = void>(input: {
  task: Task; hostOpId: string; toolName: string;
  params: Record<string, unknown>; scope: ApprovalScope; signal?: AbortSignal;
  /** 获批后复核：同步，在消费事务内、条件更新之前执行；返回原因即放弃消费。 */
  recheck?: () => string | null;
  /** 与消费同一事务提交的本地效果（通知登记）；抛错则整笔回滚。 */
  commit?: (approvalId: string) => T;
}): Promise<
  | { approved: true; approvalId: string; params: Record<string, unknown>; value: T }
  | { approved: false; text: string }
>
```

- 返回的 `params` 是审批记录保存的快照。
- 复核只有一种形态：同步、在消费事务内。应用数据的身份与应用库版本、通知的身份与目标挪进事务（都是同步读，原本紧接消费、中间无 await）。应用库不在核心事务内，写入时应用库再按期望版本核对，与现状相同。
- recheck 或 commit 抛错：放弃消费，审批标失效，错误原样抛回该族。
- 不做事务外的异步预检（现在没有需要异步复核的族）。
- `Db.tx` 不能嵌套：recheck、commit 里不再开核心库事务。
- 路由器依赖 `approvals: Pick<ApprovalGate, "request" | "supersedeAll">`；应用数据与通知的依赖改名 `requestApproval: ApprovalGate["request"]`；删 `ApprovalOutcome`。
- 复核失败、消费失败的结果由通用 `tool_execution_end` 记录各族原样返回的闸门文案；未批准的「已知未执行」照旧由闸门写入，写的就是返回的那一句。

### 执行参数

保持现状：执行参数取自审批前构造、与审批记录同源的请求；宿主推导的事实（固定解析地址、目标文件身份、解析后的正文）只在内存。MCP 与应用数据用返回的快照。修正 `tool-router.ts:427` 的注释。

### 失败文案（落库与返回同一句）

| 情况 | 文案 |
|---|---|
| 拥有者拒绝 | 拥有者拒绝执行 <工具> |
| 自动审查拒绝 | 自动审查拒绝执行 <工具>：<理由> |
| 模式切换或信号中止 | 审批已失效（模式切换或任务停止），<工具> 未执行；如仍需要请重新申请 |
| 停止 | 任务停止，确认等待解除（<工具> 未执行） |
| 复核失败 | 该族给出的原因，原样 |
| 消费失败 | 批准已失效（任务结束、权限版本变化或已被消费），<工具> 未执行 |

通知的「未登记」、应用数据多出的「或版本已变化」去掉。

### 顺手修的缺陷

1. 通知复核用调用开始时捕获的上下文 `verifyMain(input.ctx)`，不读共享 `hostToolCtx`。
2. 应用数据 `return await`，获批后的存储错误重新经过 `fail`。
3. HTTP 在审批前拒绝带使用范围的凭据（文案与执行器一致），执行器检查保留。
4. 复核或消费失败时同一事务把审批从 approved 标 stale（条件 `status='approved' AND consumed_at IS NULL`）。
5. 提前中止只置本审批 stale 并照常看计数；等待结束时从等待表删掉本条并移除 abort 监听。
6. 应用数据与通知把 SDK 的 signal 传给闸门。

第 5、6 条在可达路径上与现状等价。

### confirmTools 门

并入闸门：批准后先消费再放行 SDK 执行，文案随上表统一。重启时按已消费判为不确定。

### 不在本单

- 要不要审批（完全访问模式下只有 MCP 跳过；`review.ts:68–78` 自动审查策略）：留在各族与 review.ts。
- 文件执行器在消费之后核对目标身份与原文（防 TOCTOU 的必要位置，失败按已知错误记录）。
- scope 里的摘要（`paramsSha256`、`contentSha256` 等）消费时不比对。
- `task.approval_consumed` 没有线上消费方：保留为审计事件。
- `consumeApproval` 第一个版本条件恒为真：不动 SQL。
- stale / superseded / canceled 不发审批事件，TUI 靠重新拉快照移除（控制面接缝，候选 07）。

### 移交候选 05

- 消费后的失败定性：HTTP 传输失败记已知错误（`approved-ops.ts:351–356`），MCP 记效果未知；MCP 把远端 JSON-RPC 错误应答也标效果未知（`mcp/client.ts:181` 兜底为 `connect_failed`），与 `tool-router.ts:673` 注释和 ADR 0008:7 相反。完全访问模式下 MCP 写调用不经审批也走同一分类，属于工具操作账本的判定。
- HTTP 发送不接中止信号（`approved-ops.ts:209–244`）：一旦可中止，停止时已消费的 HTTP 从已知变成不明，与上一条同一个决定。

### 领域与文档

- CONTEXT.md 在「审批请求」后加「批准消费」。
- 不新写 ADR；ADR 0008、0009 里的 `Driver.awaitApproval` 是当时的名字，不改。
- `runtime.md`「架构要点」加「审批闸门（架构工单 04）」；:329–330 补「复核或消费失败的批准标 stale」。
- 修正注释：`app-data/tools.ts:9`、`:48`，`tool-router.ts:427`，`scheduler-tools.ts` 文件头。

### 测试

- 新增 `test/63-approval-gate.test.ts`（`new Store(new Db(tmp))` + 假 reviewer）：批准只消费一次、快照与记录一致、写 `task.approval_consumed`、回到 running；拒绝/自动拒绝/模式切换/停止的返回与落库文案逐字相同且未消费；recheck 返回原因或抛错 → stale；recheck 内递增权限版本 → 消费失败文案与 stale；已消费的不被标 stale；commit 抛错连同消费回滚、stale；两个并发请求都结束后才回 running；提前中止只动本审批。
- 各族回归：37 号通知并行批次（`schedule_create` + 另一个 main 宿主工具）批准后登记成功；28 号应用数据获批后存储层拒绝，模型收到 `fail` 的完整文案；25:291、49:157 加审批 stale 断言；03 号 confirmTools 批准后已消费并有 `task.approval_consumed`；08 号 HTTP 带范围凭据审批前拒绝、无审批记录。
- 收尾变异：复核结果被忽略、复核挪到事务外、失败不标 stale、stale 条件漏 `consumed_at IS NULL`、落库与返回文案不同、commit 不在消费事务内、通知改回读共享上下文、应用数据去掉 `await`、confirmTools 不消费、HTTP 审批前不查凭据范围、提前中止置全部 pending stale、计数归零前转回 running。

## 步骤

0. 工单与 CONTEXT.md「批准消费」。
1. 搬移、不改行为：`ApprovalGate` 接管提交、自动审查、等待、应答、模式切换失效、停止解除与 confirmTools 门（照旧不消费）；Driver 只接线；各族仍拿旧形状结果自己消费。新增 63 号（提交与等待一半）。
2. 批准之后的一半：`request()` 加复核、消费、事件、失效标记与文案表；路由器、应用数据、通知改用它，删三份 `consumeApproved`、两份 `approvalFailureText` 与 `ApprovalOutcome`；缺陷 1、2、4、5、6 随迁移生效；63 号补消费一半，各族回归。
3. confirmTools 门改走 `request()`（批准后消费）。
4. HTTP 审批前拒绝带使用范围的凭据。
5. 文档收尾，变异检查，工单标记完成。

第 1、2 步提交前各跑一轮对抗式等价复核。每步 `npm test` 与 `npm run typecheck` 都通过后在分支 `approval-gate` 本地提交，不 push。不在 tx 上跑真实模型验收。

## Comments

### 2026-09-27：实现交付

按 0→5 在分支 `approval-gate` 本地提交，未 push：

- 第 0 步 e1d6eaa：工单与 CONTEXT.md「批准消费」。
- 第 1 步 a5f18dc：`src/agent/approval-gate.ts` 接管提交、自动审查、等待、应答、模式切换失效、停止解除与 confirmTools 门（纯搬移）；新增 63 号（提交与等待）。
- 第 2 步 83bf5d4：`request()`（同事务复核、单次消费、事件、提交本地效果、失效标记、文案表）；路由器、应用数据、通知改用它，删三份 `consumeApproved`、两份 `approvalFailureText` 与 `ApprovalOutcome`；缺陷 1、2、4、5、6 随迁移修复；63 号补消费一半，37、28 号回归测试（修复前均失败），25、49 号加 stale 断言。
- 第 3 步 9549723：confirmTools 门改走 `request()`，批准后先消费再放行。
- 第 4 步 74a6d9c：HTTP 审批前拒绝带使用范围的凭据（缺陷 3）。
- 第 5 步（本提交）：`docs/runtime.md`「架构要点」加审批闸门，补 stale 说明；本工单。

每步 `npm test` 与 `npm run typecheck` 都通过（最终 610 项，609 通过，1 项按开关跳过）。第 1、2 步提交前各跑一轮对抗式等价复核：第 1 步没有可达路径上的差异（`resolve()` 的事件改用等待方自己的任务，唯一调用方的前置检查使差别走不到）；第 2 步找到一处计划外差异，见下面第二条。

与上面的决定不同、或决定没写到的地方（请复核）：

- 模拟模型（`test/helpers/mock-provider.ts`）原来把同一消息里的多个工具调用都标成 index 0，pi-ai 会把它们合并成一个调用，所以并行批次复现不出来。改为每个调用各占一个 index。只有三处脚本一次发多个调用：10:453（两个都是未知工具，断言照旧成立）、45:71（伪造的调用不在子任务工具清单里，断言照旧成立且更严格）、37 号新测试。
- 编排器 `orchestrator.ts:729` 的「有未处理的审批请求」原来认 `pending || stale`。批准后复核或消费失败的审批现在也会变 stale，但拥有者其实答复过，所以条件改为只认 `decisionSource` 为空的 stale（未答复即失效），与改动前一致。这条没有测试覆盖：只有 coding 子任务的 MCP 写调用在等待期间遇到配置变化才走得到。
- 提前中止分支现在由闸门自己记入「已知未执行」（改动前留给通用的 `tool_execution_end` 记录）。
- 应用数据的身份复核放进 recheck 后，为了照旧留 `app_data.rejected`（identity / identity_mismatch），闸门返回后再调用 `reject()`，文案不变。
- recheck 或 commit 抛错后标 stale 的事务如果本身失败，不遮住原始错误，批准保持未消费（仍是已知未执行）。
- confirmTools 门的消费断言加在 08:828（唯一走批准路径的 mock_gate 测试），没有加在 03 号：03 号只测拒绝和中断。
- confirmTools 门在 auto-review 模式下现在也走确定性审查策略（`tool` 范围直接转拥有者，记 `asked_owner` 与 `task.confirmation_reviewed`），与其他范围一致。
- 变异 15 处都能被发现：复核结果被忽略、复核挪到事务外、复核失败 / 消费失败 / 抛错不标 stale（三处）、stale 条件漏 `consumed_at IS NULL`、落库与返回文案不同、commit 不在消费事务内、通知改回读共享上下文、应用数据去掉 `await`、confirmTools 门不消费、HTTP 审批前不查凭据范围、提前中止置全部 pending stale、计数归零前转回 running、提前中止不看计数。

按决定留在范围外、本单未处理：见「不在本单」与「移交候选 05」。
