# 抽出共用事件投影包 packages/view

Status: ready-for-agent

## 目标与边界

实现[规格 R4](../spec.md)：新建 `@ruukoto/view`，承载控制面客户端共用的快照与事件投影，TUI 与桌面端都依赖它。本单只抽桌面端第一阶段需要的部分：`ViewState` 的快照安装、事件应用、历史与任务详情安装，以及会话、任务、审批、工作委托的选择器；`EventFlow` 的事件到流条目投影。渲染、命令、输入历史与工作流侧栏留在 TUI。

非目标：不改变 TUI 的可见行为，不改控制面协议。

## 方案

1. 新建 `packages/view`（package.json、exports `./*.ts`、typecheck）。在 `scripts/workspace-boundaries.mjs` 的分层表加入 `view: ["core", "control"]`，并把 `tui` 的允许层加上 `view`。ESLint 对 `packages/view/src/**` 用 `no-restricted-imports` 拒绝 `node:*`，用 `no-restricted-globals` 拒绝 Node 全局 `Buffer`、`process`、`global`、`require`、`__dirname`、`__filename`、`setImmediate`。typescript-eslint 推荐配置对 TS 文件关闭了 `no-undef`，根配置又给全部文件开了 Node 全局，所以只能显式列出这些名字。
2. 去除 Node 与 pi-tui 依赖：
   - **UTF-8 字节计数**：`event-flow.ts` 中的四处（任务输入、正文偏移累加、总字节数、历史合并）和 `state.ts` 中审批参数字节数的一处，原来用 `Buffer.byteLength`，改为 view 内基于模块级 `TextEncoder` 的 `utf8ByteLength`。计数单位必须是 UTF-8 字节，不能改成字符串长度；孤立代理项与 `Buffer` 一致，按 U+FFFD 计 3 字节。
   - `randomUUID` 改用 `globalThis.crypto.randomUUID`。
   - `ACTIVE_TASK_STATUSES` 从 `core/types.ts`（运行时引 `node:crypto`）拆到 core 中不依赖 Node 的模块，`types.ts` 改为再导出。
   - `sessionDisplayAttribution` 从 `control/workspace.ts`（引 `node:fs`）移到同类无 Node 依赖的模块；拆出的模块对领域类型只做 type-only 引用。
   - `workflowStatus` 移到 view 的纯模块，TUI 改为从 view 引用。
   - `accessModeStyle` 中返回 ANSI 的部分留在 TUI。
3. 把 `state.ts`、`event-flow.ts` 的投影部分移入 view，TUI 改为引用新位置。`command-history.ts`（`node:sqlite`）留在 TUI，搬迁时保住现有的命令恢复与失败提示。
4. 浏览器运行检查：新增 `test/37-view-browser.test.ts`，同一个检查函数分三步：
   - **打包**：用根目录已有的 esbuild，以 `platform: "browser"`、`bundle: true`、`format: "esm"` 打包，入口取 `packages/view/src/` 下的全部模块。传递引入的 `node:*` 会让打包直接失败。
   - **产物全局检查**：对打包产物运行 ESLint `Linter` 的 `no-undef`，全局只给 `globals.browser`，不包含 Node 全局。产物已经含有 view 可达的全部依赖代码，所以依赖模块里的 `Buffer`、`process` 等自由变量也会被报出来，没有执行到的分支同样覆盖；这里不用 `no-restricted-globals`，因为它只能拦列出的名字。方案者已实测：以 `packages/core/src/views.ts` 为入口时，三处 `Buffer` 都被报出；入口不用 `Buffer`、只有依赖用 `Buffer` 时，依赖里的那处也被报出；只导出不依赖 Node 的函数时，被 tree-shake 掉的代码不会误报。
   - **执行**：把产物放进不提供 `Buffer`、`process` 的 `node:vm` 上下文里运行：安装快照，应用带 offset 的「中文🙂」正文片段与审批事件，断言拼接后的正文、`totalBytes` 与 `paramsBytes` 和在 Node 下的结果一致。

   负例放在 `test/fixtures/view-browser/`：入口本身不用 Node 全局，所依赖的模块用了 `Buffer`；检查函数必须拒绝它。值引用是否传递依赖 Node，由打包加产物全局检查判定，不再另维护 ESLint 允许名单。
5. 开发启动器：`packages/tui/src/dev.ts` 的 `classifyWatchPath` 把 `packages/view/src/` 归为 `tui`。后台不引用 view，所以改 view 只需重载任务界面。监听目录已经覆盖 `packages/*`，不需要改。03 接入桌面前端时再扩展这一分类。
6. 文档：新增 `docs/modules/view.md`，写清投影的输入与安装约定：快照、实时与补发事件、历史页、任务详情（`get_task` 返回的 seq 加 `read_task_events`）、单条历史分段（`read_history_entry`）；调用方每次安装新快照都换一个代次（包括重连，以及同一连接内因 seq 缺口重同步），并丢弃旧代次的异步结果；全局 seq 缺口检测归 `ControlConnection`，view 不另写连接恢复。另外更新 `docs/architecture.md` 模块地图与依赖方向、`AGENTS.md` 仓库布局，并就地同步[同仓 workspaces 分包](../../../.agents/notes/implemented/architecture/2026-10-11-in-repo-workspace-packages.md)的包表与依赖方向。

## 进展与交接

- 当前：第三轮独立方案审查通过，首轮与第二轮阻断均已在方案层关闭；拥有者确认的范围不变，实现未开始。
- 下一步：实施者按本单方案抽取 view、同步 TUI 与开发重载、落实浏览器检查及回归用例，完成列明的文档与验证后交独立实现审查。
- 基点：`develop` @ `4611eff`。可与 02 并行。
- 阻塞：无。

## 验收与证据

工程待验证。

- TUI 回归：`test/13-tui-state.test.ts`、`test/14-tui-app.test.ts`、`test/34-event-flow-view.test.ts`、`test/36-event-flow-state.test.ts`、`test/19-tui-demo.test.ts` 全部通过，断言不放宽。
- view 单测：覆盖 seq 去重、补发、正文按偏移拼接与工具意图／结果配对；`utf8ByteLength` 与 `Buffer.byteLength` 在 ASCII、中文、emoji 与孤立代理项上结果相等。
- 浏览器运行：`test/37-view-browser.test.ts` 通过，并且满足下面三条：
  - 在修订前的代码上，它必须能复现首轮审查的 `ReferenceError: Buffer is not defined`；
  - 间接依赖负例被产物全局检查拒绝；
  - 以 `packages/core/src/views.ts` 为入口时，产物全局检查报出 `Buffer`。这对应第二轮审查的反例。
- lint 负例：在 view 中引入 `node:*` 与使用 `Buffer` 时，lint 都会报错。
- 开发重载：`test/32-dev.test.ts` 断言 `classifyWatchPath("packages/view/src/event-flow.ts")` 为 `tui`，且 `planWatchRestart(["tui"], "tui")` 只重启前端。
- 跑 `npm run check:static`。

产品验收不适用：TUI 可见行为不变。

## Comments

2026-10-15：拥有者完成 grilling 并确认整体方案，本单由规划阶段建立。

### 2026-10-15 独立方案审查

审查对象：`43c16ac` 中的本单方案，对照桌面规格 R4、R9、R19、04–07 工单、TUI 事件流规格、当前源码与同仓分包决定。结论：需修订，暂不能交实施；以下两项由方案者补齐后复审，不改变已确认的产品范围。

1. **P1：第 2 步遗漏 Node 全局 `Buffer`，现有验收不能证明浏览器可运行。** `event-flow.ts` 的任务输入、正文偏移累加、总字节数与历史合并共四处使用 `Buffer.byteLength`，`state.ts` 的审批参数字节数另有一处。仅替换 `randomUUID` 和拆 import 后，正文投影仍会在关闭 Node 集成的渲染进程中抛错；`node:*` import 负例捕获不到全局 `Buffer`，当前 ESLint 与基础 tsconfig 还默认启用 Node 全局。实测将当前 EventFlow 转译后放进不提供 `Buffer` 的 VM，仅隔离未参与本用例的 `workflowStatus` import，应用一条带 offset 的「中文🙂」片段即得到 `ReferenceError: Buffer is not defined`。修订要求：把五处 UTF-8 字节计数纳入迁移，使用浏览器可用的实现，不能改成字符串长度；增加不提供 Node 全局的投影执行检查，覆盖中文／emoji 偏移及审批参数，并明确 view 对 Node 全局的检查。依据：[规格 R4](../spec.md)、[事件投影](../../../packages/tui/src/tui/event-flow.ts)、[状态投影](../../../packages/tui/src/tui/state.ts)、[ESLint 配置](../../../eslint.config.mjs)。
2. **P2：第 3 步没有覆盖开发启动器，迁移后 TUI 修改不再自动重载。** `classifyWatchPath` 只识别既有包名；实测旧路径 `packages/tui/src/tui/event-flow.ts` 返回 `tui`，新路径 `packages/view/src/event-flow.ts` 返回 `null`，对应重启计划为后台与前端均不重启。这会回归现有 `npm run code` 开发反馈，不能依赖尚未交付的 03 偶然补齐。修订要求：将 `packages/tui/src/dev.ts` 纳入本单影响范围，让 view 变更继续重载 TUI，并在 `test/32-dev.test.ts` 增加迁移路径的分类与重启断言；实施时再由 03 接入桌面前端。依据：[开发启动器](../../../packages/tui/src/dev.ts)、[既有定向测试](../../../test/32-dev.test.ts)。

抽取与依赖核对：`tui → view → control/core` 可以保持无环；拆出的状态常量与展示归属模块只需对领域类型做 type-only 引用，`workflowStatus` 放在 view 的纯模块、由 TUI 引用即可。命令持久化仍留在 TUI，搬迁时须保住现有命令恢复与失败提示；不要求新增命令框架。

04／07 交接事项（不计入本单阻断）：现有完整恢复由 `app.ts` 的 `loadHistory`、`restoreEventFlow`、`readTaskFlow`、`loadEntry` 协作完成，除 `read_history` 外，还用 `list_tasks`、`get_task`（含 seq）、`read_task_events` 与按 UTF-8 偏移分页的 `read_history_entry`，并丢弃旧连接代次的异步结果。只安装快照与历史页不能恢复思考记录、工具操作身份和完整长正文。view 的文档应说明这些输入及安装约定；04／07 的方案者须补齐调用与 op 放行名单，并覆盖冷启动、重连、长正文和子会话历史。全局 seq 缺口检测仍由 `ControlConnection` 持有，不另写一套连接恢复。依据：[TUI 恢复调用方](../../../packages/tui/src/tui/app.ts)、[连接管理](../../../packages/control/src/connection.ts)、[冷重连回归](../../../test/14-tui-app.test.ts)。

本轮证据：macOS、Node v24.15.0；`npx tsx --test test/13-tui-state.test.ts test/36-event-flow-state.test.ts` 为 31/31 通过；上述无 Buffer 执行反例与开发重载路径反例均已执行。`npm run check:static` 与 `git diff --check` 通过；`.scratch` 不在常驻文档扫描范围，另行核实本单 11 个相对链接、段落换行、单一状态字段及文件末尾换行。它们只证明当前方案的前提与缺口，不代表新包已验收。尚未运行真实 Electron／浏览器、Linux／Node 22 或全量 `npm run check`；本轮未改实现。

### 2026-10-15 方案修订

方案者按首轮审查修订，没有改动拥有者确认的范围。

- P1：方案第 2 步把五处 `Buffer.byteLength` 换成基于 `TextEncoder` 的 UTF-8 计数；第 1 步用 `no-restricted-globals` 拦截 Node 全局；第 4 步新增浏览器打包加无 Node 全局的 VM 执行检查。原来的 ESLint 值引用允许名单由打包判定代替，不再维护。
- P2：第 5 步把 `packages/view/src/` 归为 `tui` 重载，并在 `test/32-dev.test.ts` 加断言。
- 04／07 交接事项已写进[04](04-code-tree-and-stream.md)与[07](07-inspector-subagent-and-diff.md)的方案与验收；view 文档要写的输入与安装约定，列在第 6 步。

方案者已在当前代码上核实：`event-flow.ts` 第 105、194、211、313 行与 `state.ts` 第 319 行各有一处 `Buffer.byteLength`；`classifyWatchPath` 对 view 路径返回 `null`；`planWatchRestart(["tui"], "tui")` 只重启前端。

### 2026-10-15 第二轮方案审查

对象：`43c16ac` 上的未提交方案修订，本单复审前内容的 SHA-256 前缀为 `140ec3d41285`；相关规格、提案笔记与 04／07 的恢复交接同步核对。结论：首轮五处 UTF-8 计数遗漏和开发重载遗漏已在方案层补齐；新增检查替代方式还有以下一项 P2 阻断，交方案者修订。本轮不构成 04／07 整单方案审查通过。

1. **P2：第 4 步的 browser 打包不足以替代跨包 Node 依赖检查。** 第 1 步的 `no-restricted-globals` 只作用于 view 源码，依赖模块里的全局变量不受检查；esbuild 的 `platform: "browser"` 会拒绝 Node 内置模块引用，但不会拒绝自由变量 `Buffer`。用现有 [core/views.ts](../../../packages/core/src/views.ts) 做负例：入口 `export { previewValue } from "@ruukoto/core/views.ts"` 通过拟定的 import／global lint 和浏览器打包，无 Node 全局的 VM 执行 `previewValue("中文🙂")` 也通过，执行 `previewValue("中".repeat(257))` 才报 `ReferenceError: Buffer is not defined`。因此只执行正文与审批的固定样例，不能兑现「值引用是否传递依赖 Node 由打包判定」，未走到的依赖分支仍可能使界面失败。修订要求：保留 browser 打包及 VM 行为检查，另外对打包产物或完整值依赖图应用 Node 全局限制，并加一条入口自身无 Node 全局、依赖中含 `Buffer` 的负例；可直接对产物复用现有 ESLint 规则，无需恢复手工允许名单。规格 R4 与提案笔记的判定说明同时同步。实测对上述产物运行同一条 `no-restricted-globals` 能捕获 `Buffer`。

首轮修订验证：`TextEncoder.encode(text).byteLength` 与 `Buffer.byteLength(text)` 在空串、ASCII、中文、emoji、孤立高／低代理项及混合文本共 8 例中相等；拟定 lint 对直接 `node:*` 和 `Buffer` 两个负例均报错。开发监听会遍历 `packages/*/src`，现有 `planWatchRestart(["tui"], "tui")` 已验证只重启前端；因此增加 view 分类足以覆盖原重载反例。以上是方案可行性证据，新增包与回归测试尚未实现。

04／07 交接补充（不计入 01 阻断）：04 把代次递增限定为「连接每次重建」，仍遗漏同一连接内的快照重同步。[ControlConnection](../../../packages/control/src/connection.ts) 遇到 seq 缺口会在原连接上再次握手；[TUI onSnapshot](../../../packages/tui/src/tui/app.ts) 每次安装快照都会递增 generation 并清空流游标。04 的方案者应把失效边界明确为每次安装新快照，覆盖同连接重同步时旧历史请求迟到；07 沿用同一流程。此项在 04 的独立方案审查中落实。

本轮验证：上述 UTF-8、lint、打包／VM 与重载最小探针均已执行；`npx tsx --test --test-name-pattern='重复事件丢弃；序号缺口触发重同步' test/12-reconnect-pending.test.ts` 为 1/1 通过。`npm run check:static`、`git diff --check` 通过，本单 16 个相对链接、段落换行与末尾换行另行检查通过。未重复运行首轮 31 项测试，未运行真实 Electron／浏览器、Linux／Node 22 或全量检查；本轮只写本单审查记录，保留方案者在其他文件中的修订。

### 2026-10-15 第二轮方案修订

方案者按第二轮审查修订，拥有者确认的范围不变。

- P2：第 4 步在打包和 VM 执行之间加了一步产物全局检查：对浏览器目标的打包产物运行 `no-undef`，全局只给 `globals.browser`。依赖模块里的 Node 全局也会被查出，不必维护名字清单。另外加了一条间接依赖负例，以及第二轮审查的 `core/views.ts` 反例作为验收；规格 R4 与笔记的判定说明已同步。
- 实测（macOS、Node v24.15.0、esbuild 0.28.1、`globals` 17.13.0）：以 `packages/core/src/views.ts` 为入口时报出 3 处 `Buffer`；入口自身不用 Node 全局、只有依赖用 `Buffer` 时报出 1 处；只导出不依赖 Node 的函数时，`Buffer` 所在的代码被 tree-shake 掉，0 处误报。探针是临时文件，已清理。
- 第二轮的交接补充：第 6 步写明"每次安装新快照都换代次"；04 和 07 已按这条把失效边界改为每次安装快照。

### 2026-10-15 第三轮方案审查

对象：`43c16ac` 上的最新未提交修订，本单复审前内容的 SHA-256 前缀为 `7627ff21aa84`。重点复核第 4 步的产物检查、R4 与提案笔记的一致性，以及 04／07 的快照代次交接；实现源码未变。结论：方案通过，无未解决阻断，可交实施；本结论不代表新包已实现或工程验收通过，也不替代 02–07 各自的独立审查。

第二轮 P2 已关闭：审查者独立使用现有 esbuild 打出 browser／ESM 产物，再用 ESLint `Linter`、`no-undef` 与仅 `globals.browser` 检查。以 `core/views.ts` 为入口时检出 3 处 `Buffer`；入口只再导出 `previewValue` 时，检出依赖中的 1 处 `Buffer`，无需执行其长文本分支。只引用安全常量并使用 `TextEncoder` 的正例为 0 处，说明未使用的 Node 分支被移除后不会误报。这覆盖了上轮打包成功但运行可能失败的反例，允许名单的替代方案可行。

执行可行性已验证：使用 `node --experimental-vm-modules` 与 `vm.SourceTextModule` 加载正例 ESM 产物，VM 只注入 `TextEncoder`，确认 `Buffer` 与 `process` 均不存在；空串、ASCII、中文、emoji、孤立高／低代理项及混合文本共 8 例的 UTF-8 字节计数与 Node 相等。该探针验证测试方法，实际快照、事件和审批路径仍由实施者落实到 `test/37-view-browser.test.ts`。各负例按相应阶段核实；若前置打包或全局检查已拒绝原代码，首轮 VM 的 `ReferenceError` 可通过单独运行隔离后的执行阶段复现，不要求完整检查越过前置拒绝。

此前关闭项保持有效：五处计数的替换范围与开发重载回归未被撤回；01、04、07 现已一致要求每次安装新快照时更换代次，包含同连接 seq 缺口重同步，04 的验收也覆盖旧请求迟到。规格 R4 与提案笔记同步描述打包加产物全局检查，没有新增待拥有者决定的取舍。

本轮验证：macOS、Node v24.15.0；上述产物检查正反例与 ESM／VM 探针通过，`npm run check:static`、`git diff --check` 通过；本单 16 个相对链接、单一状态、段落与末尾换行另行检查通过。源码未变，沿用前两轮未受影响的回归证据；未重复应用测试、未运行真实 Electron／浏览器、Linux／Node 22 或全量检查。本轮只更新本单状态与审查交接记录，保留方案者的其他修订。
