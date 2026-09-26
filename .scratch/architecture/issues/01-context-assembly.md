Status: ready-for-agent

# 模型上下文组装收成一个深模块

## 目标

为一次模型调用组装模型上下文的逻辑（任务开始钉版，每次调用的输入收集、选择、压缩与 Jev，发送前复核与选择记录）从 `driver.ts` 收进一个模块。driver 只在 context 钩子里交出消息，在发送前拿回改好的请求。来源：2026-09-26 架构审查的候选 01。

## 背景

2026-09-26 核对：

- 组装逻辑在 `src/agent/driver.ts:548–1215`（约 670 行），另有 14 个只服务组装的字段（`:256–284`、`:1121–1123`）；driver 共 2422 行。近 8 个功能有 7 个同时改了 driver 与选择器。
- pi 吞掉 context 钩子里的异常，组装因此分两半：钩子里算视图，失败原因先存进字段（`:568`）；发送函数里复核并落选择记录（`:975`），只有这一步拦得住请求。
- 26 个集成测试（16、55、60、61 号）经完整 Runtime、控制面与 mock provider 测这段；进程内只测纯选择器。
- 钩子里任何异常都记成 `context_budget_exceeded`（`:604–606` 存原因，`:1037–1039` 抛出）。

## 决定

### 范围

- 搬进模块：钉版项目指令（捕获产物）、继续来源、记忆 id 与 Jev 配置；输入收集（含 QQ 撤回过滤）、选择、压缩点编排与摘要调用、Jev 步骤；发送前的上下文复核（阻断原因、选择缺失、Jev 凭据与记忆的新鲜度、配对、预算重估）、按预算收紧 maxTokens、选择记录、prompt 快照、发送后补记用量；`checkToolPairing` 与 `ContextSendBlocked`。
- 留在 driver：模型选择一致性检查；QQ/角色/任务三道工具白名单（属于候选 03）；阻断后中断任务并暂停队列；计划模式与技能库的钉版（另有使用方：计划模式决定工具收窄，技能库供 `skill` 工具与 `/skill:` 展开），由 driver 钉版后交给模块。
- 资料受限会话（QQ 群、chat）的开关随代码一起搬；ADR 0016 预告的 chat 窗口方案不提前做。

### 接口（`src/agent/context-assembly.ts`）

```ts
/** driver 原样传入自己的 deps 对象（结构上满足）；模型栈在调用时读取。 */
export interface ContextAssemblyDeps {
  store: Store; memories: MemoryStore; access: AccessScope;
  artifacts: ArtifactStore; credentials: CredentialStore;
  modelRuntime: ModelRuntime; modelCatalog: ModelCatalog; agentDir: string;
  budgetOverrides?: Partial<SelectorBudgetConfig>;
  jev?: JevRequestConfig; compaction?: { summaryTimeoutMs?: number };
}

/** 任务开始：钉版项目指令（捕获产物）、继续来源、记忆 id、Jev 配置。 */
export function beginContextAssembly(input: {
  task: Task;
  session: { id: string; projectId: string; cwdReal: string };
  accessor: Accessor;
  restricted: boolean;                          // QQ 群与 chat：不注入指令/记忆/技能，不跑 Jev 与压缩
  recalledFilter?: (messages: any[]) => any[];  // 只有 QQ 群会话传
  plan: boolean;                                // driver 钉版后交进来
  skills: SkillLibrary | null;
}, deps: ContextAssemblyDeps): ContextAssembly;

// ContextAssembly 的四个方法：
assemble(messages, sdk: { systemPrompt; tools; model; sessionFile? }): Promise<{ messages } | undefined>;
prepareSend(model, context, options): { model; options };
afterSend(stream): void;
abort(): void;
```

- `assemble` 是 context 钩子，不抛错：失败记成阻断原因；实例中止后返回 undefined。
- `prepareSend` 依次收紧 maxTokens、复核、落选择记录、存快照。被拦下时抛 `ContextSendBlocked`，driver 据此中断任务并暂停队列；预算配置无效或选择记录落库失败抛原始错误，任务记失败（同现状）；快照失败只写 stderr，不拦发送。
- `afterSend` 异步补记用量，失败静默。`abort` 幂等，中止 Jev 与摘要请求。

不变式：

- 每个任务一个实例，任务结束即丢；钩子与发送之间的状态都在实例里。本轮选择用过即清（pi 每次发送前都先跑钩子，`pi-agent-core/dist/agent-loop.js:179–192`）。
- 实例自己持有一个 AbortController，替代组装代码里对 driver `currentTask`/`stopRequested` 的 6 处检查与两个中止器；driver 在 `requestStop` 与任务结束时调 `abort()`。
- 摘要调用时读取当前模型栈，不按任务钉版（实例持有 driver 同一个 deps 对象）。
- driver 自己的检查先于 `prepareSend`：被工具检查拦下的请求不留选择记录。

### 依赖与测试替身

- SQLite、记忆、产物、凭据：真实现，放临时目录。
- 摘要模型：真实模型栈指向 `MockModelServer`；Jev：沿用本地 HTTP 模拟。不开新端口。
- 模块不持有 pi 的 `AgentSession`：driver 把系统提示、生效工具、模型与会话文件路径作为普通值交进来。

### 行为变化

- 搬移带来的两处边缘差异：预算配置无效改在 driver 的模型/工具检查之后抛出（两种错误同时出现时先报哪个会变）；读原任务链判定计划模式失败时，不再连带把项目指令换成读取失败说明。
- 失败分类拆开：`context_budget_exceeded` 只留给选择器判定超预算与发送前预算重估；钩子里的其他异常记 `context_selection_failed:<原因>`。两者后续处理相同。
- 不在本单：`selectContext` 每次调用最多跑 5 遍；QQ 撤回过滤使选择记录序号错位；压缩前覆盖段估算偏高。

### 测试（替换，不叠加）

- 下沉到模块接口、删掉 Runtime 版（22 个）：16 号的多轮修剪与选择记录用量、项目指令钉版、继续来源；55 号全部 8 个；60 号全部 4 个；61 号的第二层摘要、S 伸进当前任务、摘要失败 ×4、chat 不压缩。
- 保留端到端并只留跨接缝的断言（4 个）：16 号「必须项超预算」（零请求、中断、队列暂停）；16 号「授权撤销」只留 memory_read 拒绝；61 号「第一层」只留占位经 history_read 读回、会话文件不变、重启后压缩点仍生效、/context 显示；61 号「摘要等待中停止」只留主模型零请求。
- 20、21、59 号不动。模块测试原地替换；testkit 加一个夹具函数（临时目录、`Db`/`Store`、记忆、产物、凭据与指向 `MockModelServer` 的模型栈）。

## 步骤

0. 修 19 号：demo 补 `project.jev_changed` 与 `task.context_experiment` 样例（自 322fb56 起红），作为搬移的基线。
1. 纯搬移：现有测试不改（只有 61 号 `checkToolPairing` 的导入路径跟着改）；`docs/runtime.md:1311` 顺手改。
2. 换测试。
3. 拆失败分类：加 `context_selection_failed`、模块测试断言与 `consumeBlockedReason` 的兜底前缀。

每步 `npm test` 全绿后在分支 `context-assembly` 本地提交，不 push。不在 tx 上跑真实模型验收。
