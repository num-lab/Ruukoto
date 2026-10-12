# Agent Note: 把已成立的代码约定写进根 AGENTS.md

Status: implemented

## 问题

根 `AGENTS.md` 原本只有命令、目录导航与四个 skill 指针，共 1420 个非空白字符。改动者要遵守的判断准则——`core` 不反向依赖、错误带 `code` 判别、类型逃逸只出现在哪三类边界、状态与事件同事务——只存在于代码习惯里，要靠读 `src/` 反推。

代价在两处。一是慢：每次改动都要先花时间确认某个做法是约定还是巧合。二是不可靠：反推出的规则可能是错的，且不会有任何东西纠正它。本轮盘点中我自己就先写下「`execution` 是唯一把工具执行移出后端进程的边界」，随后被反例推翻——`node:child_process` 出现在 9 个文件里，含 `packages/core/src/instance-lock.ts` 与 `packages/tui/src/dev.ts`。这条错误规则如果直接写进常驻指示，会被后续每次改动沿用。

## 决定

在根 `AGENTS.md` 增设「约定」小节，按六个主题分组：模块边界、错误处理、类型、持久化、测试、语言与形态。每条 1–2 行，说明该做什么，并把承载细节的文档放在括号里链接（`docs/architecture.md`、`docs/modules/core.md`、`docs/development.md`、`CONTEXT.md`）。

收录判据是**取证**，不是合理性：

- 零反例的规则直接收录。`packages/core/src/` 的 26 个文件对 `src/` 其他区的出边数为 0；全仓 550 个相对 import 全部带 `.ts`，0 个 `.js`；空 `catch` 0 处；`console.log` 只出现在 `packages/tui/src/cli.ts`、`packages/tui/src/tui/index.ts`、`packages/tui/src/config-tui/index.ts`；文件名无例外全部 kebab-case。
- 反例边界明确的规则，把边界一并写清。类型逃逸有 406 处 `any`，但集中在可归类的三类边界：`packages/core/src/store.ts` 的 29 个 `rowToXxx(row: any)` 行映射、`packages/agent/src/app-data/` 的 wire 解析、第三方 SDK。判别方式是 `instanceof` + `.code ===`（14 处），全仓只有 3 处解析 `message`，且都是 `node:sqlite` 唯一索引冲突的兜底。这条写成「只允许在这三类边界出现」，而不是「不允许 `any`」。
- 取证不成立的规则**不写**。除上面那条已推翻的判断外，另有 8 条同性质的不成立规则被排除：「`tui` 只通过控制协议访问后端」（3 条 type-only 直连 `agent`）、「适配层只被 `runtime` 调用」（`packages/channels/src/scheduler/news.ts`、`packages/channels/src/github/events.ts` 反向）、「测试只断言行为」（42 个测试文件直读 SQLite，是刻意做法）、「错误 code 一律字面量联合」（42 个子类里 16 个无 `code`）、「不允许 `any`」、「导出必须有 JSDoc」（179/298，60%）、「测试编号唯一」（10 组重号）、「分层严格单向」。

与直觉相反但属刻意做法的两条，明确写成「不得改写」：测试直读 SQLite 断言落盘布局，以及 `noUncheckedIndexedAccess` 关闭。

## 备选方案

- **不写，继续靠代码反推** — 零维护成本。否：本轮已证明反推会得出错误规则，且错误不会被纠正；这正是动机所在。
- **写成一篇 `docs/` 设计文档** — 不占用常驻上下文。否：约定要在**改动前**就在上下文里才起作用；放进 `docs/` 意味着 agent 得先想到去读它，与「找不到规则」的问题同构。
- **每条都附取证与反例计数** — 可核查。否：根 `AGENTS.md` 是常驻指示层，附上计数会让它变成盘点报告；取证留在工单 [02](../../../../.scratch/codebase-management/issues/02-conventions-section.md) 里，规则本身只留可执行的句子。
- **只收录零反例的规则** — 最安全。否：会把类型逃逸、错误判别这些最有价值的规则排除，因为它们本就是「有边界」而非「无例外」。
- **把全部 20 条取证结论都写进去，包括不成立的** — 一次写全。否：不成立的规则写进常驻指示就是制造幻觉，后续改动会照着它做。
- **同时加门禁校验规则与代码一致** — 防漂移。否：本批未加。规则涉及语义（哪三类边界算合法逃逸），机械检查会退化成关键词扫描，误报比漂移更贵。漂移明显时再评估。

## 后果

改动前的判断准则从「读代码反推」变成「先对照清单」，六个主题各有一条入口。错误规则被挡在常驻指示之外：本轮盘点推翻的那条判断与另外 8 条不成立规则都留在工单里，附带反例路径。

代价与遗留：

- `AGENTS.md` 从 1420 增至 2456 个非空白字符（86 行）。仍在指示层范围内，但已接近「常驻 vs 链接」的边界；后续再加主题应先考虑归并而不是追加。该边界在[抬高超限并改写为一句一规则](2026-10-12-agents-md-resident-depth.md)中按 DSH 常驻层形状重新划定：分层判据写成「常驻层只放改动前必须知道、跳过一次就会出错的规则」，上限提到 4300。
- 规则与代码会漂移，本批没有门禁。`packages/core/src/` 破例 import 其他区、或第 4 个文件开始写 `console.log` 时，`AGENTS.md` 不会自动红。缓解靠 `docs/` 与 notes 的既有触发条件；这类结构性漂移通常伴随更大改动，届时一并修正。
- 取证是一次快照。计数（406 处 `any`、550 个 import）会变，规则里的**边界**而非计数才是承诺，因此计数只写在工单与本笔记里。
- 收录判据是「已经在遵守」，不表示每条都理想。「测试直读 SQLite」与「关闭 `noUncheckedIndexedAccess`」是本次明确写下的既有取舍，不是推荐做法。

## 测试

- 每条规则的关键断言都独立复核过：`packages/core/src/` 出边为 0、550/550 import 带 `.ts`、空 `catch` 0 处、`console.log` 仅 3 个文件、`SCHEMA_VERSION = 32` 单调、`withTx` 151 处调用、`rowToXxx(row: any)` 29 个签名、`.code ===` 14 处、解析 `message` 仅 3 处。
- `npm run check:static` 通过。
