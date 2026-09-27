Status: ready-for-agent

# 参考块成为选择器的统一输入

## 目标

项目指令、技能目录、继续来源与计划说明四类参考块，各自的块文本由来源产出；选择器收一个统一的 `references` 输入，只管位置、预算与记账。新增一个参考块来源 = 来源产出块 + 分类表登记一行 + 组装接入一行。来源：2026-09-26 架构审查的候选 02。

## 背景

2026-09-27 核对（01 合并后，main 0452ce1）：

- 一个参考块从来源到发出要改：选择器的输入字段（`projectInstructions` / `skills` / `resumedFrom` / `planMode`）、块种类联合（`context-selector.ts:632`）、块文本（:635–688）、估算键 if 链（:715–718）、分类表（:154–166）、失败文案（:772）、两个输出版本字段（:763–764、:854–855，纯透传）；组装的钉版（`context-assembly.ts:144`）、受限会话三处闸（:263、:399、:511）、输入映射（:259–272）、选择记录映射（:667–668）；选择记录三件套；系统提示的标记说明（`session-factory.ts:34`）。
- eb08b2b（计划模式）漏改失败文案，f83f3e2 才补上「/计划说明」。
- `plan-mode.ts`、`skills.ts` 不拥有自己的块文本；项目指令与继续来源的读取在组装，块文本在选择器。
- 没有东西约束「每个估算键都有分类」：漏登记的估算静默落进 `/context` 的「其他」。

## 决定

### 范围

- 并入统一输入：项目指令、技能目录、继续来源、计划说明。
- 不并入：长期记忆（单独的记忆预算与逐条记账，选择器照旧按预算生成记忆块）；压缩摘要（由压缩点推出，属于选择器的压缩视图，分类照旧在分类表）。
- 不在本单：选择器与组装里的工具名字面量（`"skill"`、`"todo_write"`，工具结果的视图规则，留给候选 03）；系统提示的标记说明不改、不加守卫测试；driver 未使用的 `AppToolContext` 导入（本单不改 driver）。

### 接口（`src/agent/context-selector.ts`）

```ts
export interface ReferenceBlock {
  category: ContextCategory;       // 分类表登记的键
  placement: "prefix" | "task";    // 历史之前（跨任务稳定）/ 当前任务输入之前（只属于本任务）
  text: string;                    // 完整块文本，选择器包成 user 消息（timestamp 0）
}

SelectorInput.references?: ReferenceBlock[];  // 取代 projectInstructions / skills / resumedFrom / planMode；缺省为空
// SelectorOutput 删除 instructionVersion / skillVersion
```

- 视图顺序不变：前缀参考块（传入顺序）→ 记忆块 → 摘要块 → 移出标记 → 历史 → 任务级参考块（传入顺序）→ 当前任务输入。
- 估算按分类累加（同分类多块相加）；记忆照旧单独预算。
- 块头不含版本：选择器看不到版本。

### 块文本的来源

- 技能目录：`skills.ts` 的 `skillCatalogBlock(lib)`，没有可由模型加载的技能时返回 null。
- 计划说明：`plan-mode.ts` 的固定块 `PLAN_NOTICE`。
- 项目指令、继续来源：`context-assembly.ts`，紧挨各自的钉版读取。项目指令不单开模块。
- 来源模块只从选择器导入类型。

### 分类表与失败文案

- 分类表（现 `BREAKDOWN_CATEGORIES`）成为唯一带类型的登记处：键即 `ContextCategory`，`ReferenceBlock.category` 与选择器内部的 estimates 只能用登记过的键，漏登记 `npm run typecheck` 不过。
- 失败文案按分类表生成，逐项列出非零的必留分类；必留合计 = 所列各项之和。例：「必留内容（系统提示 1200 + 工具定义 3400 + 项目指令 500 + 计划模式 90 + 当前任务 50000 = 55190）超过输入预算 50000」。
- 删除从未抛出的 `ContextBudgetExceeded`。

### 组装

- 受限会话的闸收到构造时：`skills` 归一为 null、`plan` 归一为 false（项目指令、继续来源、记忆 id 本来就在钉版时跳过）；`contextInput`、`skillsInput` 的重复判断删除。唯一的行为变化：不可达的「受限会话 + 计划模式」不再注入计划说明。
- 私有方法 `references(tools)` 每次调用现算：项目指令 → 技能目录（本次工具集含 skill 时）→ 继续来源 → 计划说明。
- 选择记录：`instructionVersion` 取钉版项目指令的版本，`skillVersion` 取钉版技能库的版本（技能工具未启用、目录未注入时也记，同现状）。
- Jev 请求里的「继续任务的原始要求」改从钉版读取。

### 领域

- CONTEXT.md 增「参考块」。
- `docs/runtime.md:370–373` 改为「参考块与技能正文的块头」；:451 的「参考块」改为「前缀参考块」。

### 测试（替换，不叠加）

- 16 号「选择器：项目指令在最前…」改写为通用参考块测试：两种位置、传入顺序、各注入一次、预算紧张时必留、分类估算；删 `instructionVersion` 断言。第 2 步加：失败文案逐项列出分类标签；各分类都有块时 `/context` 分解没有「其他」。
- 61 号两个选择器测试：`projectInstructions` / `resumedFrom` 换成等价的 `references` 条目，断言不变。
- 59 号「参考块块头…」改走组装夹具：一次调用同时有项目指令文件、技能库（skill 工具启用）、记忆、继续来源和计划模式，断言五类块头原样、技能用法、全视图无警示措辞；技能正文与引用文件那半段不动。
- 56 号「技能目录超出预算」第 2 步改为解析 `技能 (\d+)`。
- 55 号：一个 Jev 测试改用继续任务，断言 Jev 请求的任务文本含原任务要求。
- 其余不动，作回归保护：60 号、56/58 号、16 号模块测试、21 号。
- 收尾做变异（位置处理、传入顺序、受限闸、版本来源、Jev 继续文本），确认新测试能发现。

## 步骤

0. 工单与 CONTEXT.md「参考块」。
1. 纯重构：`ReferenceBlock` 与 `references`、块文本搬到来源、版本移到组装、受限闸收到构造时、选择器文件头注释；16、59、61 号换输入形状，55 号加 Jev 断言。失败文案保持原样，行为不变。
2. 分类表带类型、失败文案按表生成、删 `ContextBudgetExceeded`；16 号加两条断言，56 号改解析。
3. 文档收尾：`docs/runtime.md` 选择器一节与上面两处措辞；工单标记完成，追加交付记录。

每步 `npm test` 与 `npm run typecheck` 都通过后在分支 `reference-blocks` 本地提交，不 push。不在 tx 上跑真实模型验收。
