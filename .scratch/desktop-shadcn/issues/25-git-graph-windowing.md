# Git graph 行窗口化与增量布局

Status: ready-for-human

## 目标与边界

拥有者在 2026-10-18 对比 Electron 与 MyGo 内存后要求优化 Git graph，并在三个方案中确认选择「行窗口化」：只渲染可视区附近的行与图线，DOM 与已加载历史解耦；同时把布局改成按页增量维护，不再为全部已加载提交保存逐行边索引。拥有者确认接受以下行为变化：Tab 与读屏导航只覆盖当前窗口内的行（读屏用 `aria-setsize`／`aria-posinset` 表达位置）；焦点行在滚出窗口时仍保持渲染；展开详情状态按提交 id 上提保存，滚动或重渲染不丢失；文本选择、Ctrl+A 与浏览器 Find 只覆盖当前窗口内已渲染的行（2026-10-18 确认，与 Tab／读屏限制同源）。

目标：超大历史（万级到十万级已加载提交）下，Git graph 的行 DOM 与图线元素与已加载提交数解耦；布局状态从 O(提交数 × 活跃车道数) 的 `edgesByRow` 降为 O(提交数) 的行状态与巡检点；追加一页只处理新增行。既有交互保持：滚动接近底部自动续页（含横向滚动到右侧时仍能触发）、隐藏／离线／加载中／错误时暂停、追加失败重试、刷新替换首批、点击展开详情、左右滚动、HEAD／branch／tag／remote 标记、危险文本转义、`aria-busy` 与提交父关系读屏文本。

非目标：不改后台协议、页大小（200）、游标／修订核实、控制面与 DesktopHost；不改 `.scratch/desktop-shadcn/demo/` 与冻结稿；不引入虚拟列表依赖；不改详情内容、行高与视觉规范；不做真实 Electron／MyGo 窗口体验验收（另列人工复验）。已有决定[Git历史分页](../../../.agents/notes/implemented/feature/2026-10-17-desktop-git-history-pages.md)中「先不引入虚拟列表、按需追加」的当前阶段取舍被本工单取代，分页读取、游标与修订决定继续适用；[自动续页](../../../.agents/notes/implemented/feature/2026-10-17-desktop-git-lazy-loading.md)的触发与暂停规则继续适用；[提交详情](../../../.agents/notes/implemented/feature/2026-10-17-demo-git-commit-details.md)的详情内容与 28px 弯折不变。

关键契约：

1. 窗口行保持在正常流内；窗口前后各一个 aria-hidden 占位 `<li>` 撑出已卸载行高度；另有一个高度 0、宽度为已测量最大行自然宽度的流内标尺 `<li>`；末尾哨兵仍是流内 `<li>`，`ol` 的 `min-width: max-content` 与哨兵宽度保持自然内容宽度，横向滚到右侧仍能触发 IntersectionObserver。`.git-graph-log` 设置 `overflow-anchor: none`。
2. 布局模型每行只保留节点车道与父边车道，另有提交 id 到行号映射与每 128 行车道快照；不再构造逐行 `edgesByRow`。窗口从起点前最近巡检点前滚；模型内存在 O(提交数 + ⌈提交数／128⌉ × 最大车道数) 量级。
3. 渲染行数 = 视口高度换算的行数 + 上下各 6 行 overscan，加至多一个窗口外焦点行；与已加载提交数无关。窗口范围始终包含至少一行（滚动位置越界时夹紧），刷新或尺寸变化不会渲染成空列表。
4. 展开状态按提交 id 上提；展开内容自然高度由已渲染 `CollapsibleContent` 的 `scrollHeight` 测量并缓存，用于窗口外占位、总高度与滚动夹紧；视口宽度变化保留旧高度并在行重新渲染时重测；刷新后清理不存在的 id；窗口上方高度变化用 `top(first)` 差值补偿 `scrollTop`。行内动画与 28px 弯折保持原样。
5. 焦点行通过行按钮 focus 事件跟踪；滚出窗口后以绝对定位旁路行渲染在真实偏移处，并按行号放在窗口行之前或之后；窗口换行移除原 DOM 使焦点落回 `document.body` 时，把焦点接回旁路行；焦点离开列表时清除。
6. 模型只在前缀首尾不变时增量：`commits.length >= processed`、`commits[0]?.id === firstId`、`commits[processed-1]?.id === lastId`；否则重建。HEAD 变化不影响布局。中间内容被改写而首尾不变无法识别，依赖 Inspector 的修订游标与刷新替换首批约定，并在笔记记录为已知假设。父提交排在子提交之前（时钟偏移）时，不绘制 `to < from` 的边，与旧布局一致。
7. 首屏在服务端与无视口高度时渲染固定初始窗口（40 行或全部更少），挂载后按真实视口高度重算；渲染期不读 `window`。读屏：滚动容器保留 `role="region"`／`aria-busy`；每行 `<li>` 增加 `aria-setsize` 与 `aria-posinset`；父关系 sr-only 文本、HEAD 与 refs 语义不变。

## 方案

新增 `apps/desktop/src/renderer/git-graph-model.ts`：`buildGitGraph`／`extendGitGraph` 共用顺序处理路径，状态为 `processed`、`firstId`、`lastId`、`laneAt[]`、`parentLanes[][]`、`rowById: Map`、`laneCount`、每 128 行 `checkpoints[]`；`gitGraphCanExtend` 实现契约 6；`gitGraphWindow(model, commits, start, end)` 从最近巡检点前滚，返回窗口行的节点车道、穿越边与父边（车道 + 续行），续行判定用 `rowById.has`，并跳过时钟偏移的向上父边。

新增 `apps/desktop/src/renderer/git-graph-window.ts`：`gitGraphMetrics(count, expansions)` 提供总高度与 `top(row)` 前缀和；`gitGraphRange(metrics, scrollTop, viewportHeight, overscan)` 二分可视范围；`gitGraphClampScroll` 夹紧滚动；`gitGraphRenderWindow` 返回 `{ first, last, pinned }`，焦点行不并入范围。

改写 `apps/desktop/src/renderer/git-graph.tsx`：保留头部、空态、错误与重试标记、逐行绝对 SVG（`height: 100%`，只为本窗口行生成）和原 IntersectionObserver effect。模型用 `useRef` 缓存并按契约 6 增量扩展。状态为滚动位置（rAF 节流）、视口尺寸（ResizeObserver）、内容最大宽度、展开集合、展开高度缓存与焦点 id；渲染顶部标尺、顶部占位、旁路焦点行（如需）、窗口行、底部占位与流内哨兵。每行带 `data-commit-id`、`aria-setsize`、`aria-posinset`；内容高度、宽度标尺与焦点接回分别由独立 effect 处理。

`apps/desktop/src/renderer/git-graph-data.ts` 只保留 `GitRef`／`GitCommit`／`GitRepository` 类型（删除 `layoutGitGraph`，Demo 有独立实现）；`style.css` 为 `.git-graph-log` 增加 `overflow-anchor: none`、为 `.git-graph-body` 增加 `position: relative`（旁路焦点行的包含块），其余视觉规则不变。`git-graph.tsx` 顶部保留 demo git graph、提交详情、自动续页并新增本决定锚点。

测试与文档：改写 `test/desktop-git-layout.test.ts`（Demo 布局回归保留；模型 70000 行巡检点窗口、与 Demo 逐行车道／父边／穿越边等价、时钟偏移、增量追加等价整图、首尾谓词、续行变实线、多车道夹具）；新增 `test/desktop-git-windowing.test.ts`（metrics／range／夹紧／焦点旁路、SSR 5000 条窗口上界与 ARIA、更早父提交文本、空仓库与短列表）；更新 `test/desktop-git-lazy.test.ts` 与 `.scratch/desktop-shadcn/evidence/git-lazy-loading/observer-repro.mjs`（假 React 补 `useState`、ResizeObserver 与 rAF 桩、加载器映射新模块，断言哨兵为最后流内子元素、1px 且与占位同处于流内）；`test/desktop-demo-v4.test.ts` 的既有 SSR 断言继续通过。文档更新 `docs/modules/desktop.md` 的 Git graph 段与设计依据链接、`docs/usage.md` 的用户限制说明、`docs/development.md` 桌面测试清单；新增决策笔记 `.agents/notes/implemented/feature/2026-10-18-desktop-git-graph-windowing.md`，并在分页、自动续页与提交详情三篇补后续决定链接。

真实浏览器证据：`.scratch/desktop-shadcn/evidence/git-windowing/` 的 `fixture.mts`、`fixture-app.tsx` 与 `verify.mjs` 用 Vite 临时服务加载正式组件与正式 CSS，以 headless Chrome + DevTools Protocol 执行真实滚动、真实 IntersectionObserver 与真实 DOM 测量；覆盖窗口行有界、ARIA、横向滚动与哨兵宽度、横向滚动后仍触发续页、展开／折叠高度、焦点旁路（activeElement 与 offsetParent）、宽度变化、刷新缩短后夹紧与空仓库。证据见该目录 `README.md`、`result.json`、`verify.log` 与 `sha256.json`；需要本机 Chrome，不是 CI 门禁。

## 进展与交接

- 当前角色与阶段：实施者（Lead）完成代码、测试、文档、笔记与浏览器证据，独立实现审查已完成（无阻断）。
- 下一角色与动作：独立只读实现审查者核对契约与验收证据、相关调用方与测试、文档与决策一致性；无阻断后转拥有者复验。
- 当前内容：分支 `codex/desktop-demo-ui`，HEAD `2e5c455`，未提交改动为：新增 `apps/desktop/src/renderer/git-graph-model.ts`、`git-graph-window.ts`、`test/desktop-git-windowing.test.ts`、`.agents/notes/implemented/feature/2026-10-18-desktop-git-graph-windowing.md`、证据目录与工单；修改 `git-graph.tsx`、`git-graph-data.ts`、`style.css`、`observer-repro.mjs`、`test/desktop-git-layout.test.ts`、`docs/{modules/desktop,usage,development}.md` 与三篇既有笔记。以 `git status` 与实际 diff 为准。
- 阻塞与恢复条件：无。

## 验收与证据

| 要求 | 检查方法 | 结果与证据 |
| --- | --- | --- |
| 契约 1 横向续页与 DOM 有界 | 浏览器 fixture 底部＋横向最右后释放分页触发下一页；SSR 5000 条窗口上界 | 通过：`verify.log` 34 项（horizontalObserverFires、sentinelSpansContent、scrollLeftAvailable）；`test/desktop-git-windowing.test.ts` SSR 行数上界 |
| 契约 2 模型增量与巡检点 | 70000 行巡检点窗口、与 Demo 逐行等价、多车道夹具 | 通过：`test/desktop-git-layout.test.ts` 7/7 |
| 契约 3 窗口有界与焦点旁路 | 纯函数、SSR、浏览器 activeElement／offsetParent | 通过：windowing 4/4；`verify.log` 中 focusPinned／focusPinnedInList／rowsBoundedWithFocus |
| 契约 4 展开测量与滚动夹紧 | 纯函数、浏览器展开／折叠／宽度变化／刷新 | 通过：expandHeight／expandPushesRows／collapseRestores／widthResizeHeightAccounting／refreshScrollClamped／refreshShowsTail |
| 契约 6 续行与时钟偏移 | 增量等价、续行变实线、时钟偏移等价 | 通过：layout 测试中的续行与时钟偏移用例 |
| 契约 7 SSR 与读屏属性 | 既有 SSR 回归与 windowing SSR | 通过：aria-setsize／aria-posinset、更早父提交文本、demo-v4 SSR |
| 自动续页不回归 | `test/desktop-git-lazy.test.ts` 与 observer-repro | 通过：哨兵流内／最后子元素／1px 断言 |
| 文档、笔记与静态门禁 | `npm run check:static`（lint、typecheck、verify-notes、check:docs） | 通过：167 个文件链接与跨行段落、109 篇笔记、8 份文档预算均通过 |

工程验收：定向用例 54/54 通过（`desktop-git-layout`、`desktop-git-windowing`、`desktop-git-lazy`、`desktop-demo-v4`、`desktop-inspector-tools`）；相关 Desktop 回归 200/200 通过（含 `43-desktop-demo` 的定稿 CSS 前缀检查，窗口化样式已放到 Desktop 专属区段，不改共享前缀）；`npm run check:static` 通过；`npm run desktop:build` 与 `npm run desktop:mygo:build` 均通过（MyGo 产物约 9.9 MB）；浏览器 fixture 34 项通过（Chromium 155、macOS 27.0.1 arm64、Node v24.15.0）。产品验收：真实 Electron／MyGo 的滚动手感、展开动画、输入法与读屏体验未验证，保留人工复验；原生动窗口未纳入本证据。

方案与实现审查：第一轮独立方案审查（2026-10-18）提出横向哨兵、展开测量、选择／Find 与焦点、模型生命周期、浏览器证据五项阻断；修订后第二轮审查仍指出横向宽度依赖渲染行、展开高度在宽度变化后的缺口、旁路行包含块、时钟偏移父边与证据缺口，均已按意见修复并加入测试与浏览器断言。实施在第二轮审查结论返回前已经开始，违反「方案审查先于实施」的顺序，已记入 Comments；当前独立实现审查已完成（无阻断）。

## Comments

2026-10-18：拥有者确认在三个方案中选择「行窗口化」（含增量布局），接受 Tab／读屏只覆盖窗口行、焦点行保持渲染、展开状态上提；同日晚些时候确认接受文本选择、Ctrl+A 与浏览器 Find 只覆盖窗口内已渲染行。

2026-10-18 方案审查（第一轮，独立只读）：范围与既有决定一致；阻断项为横向哨兵宽度、展开／滚动测量、选择／Find 与焦点机制、模型生命周期、真实浏览器证据。修订为流内窗口行＋占位、逐行 SVG 保留、内容高度缓存、焦点旁路行、谓词明确的增量模型、必做 headless Chrome 证据，并取得选择／Find 限制的拥有者确认。

2026-10-18 方案审查（第二轮，独立只读）：确认模型生命周期谓词、巡检点前滚与重建语义可实施；新指出窗口行宽度塌缩、宽度变化后窗口外展开高度缺口、旁路行包含块与选择器、时钟偏移父边、浏览器证据不足。修复：增加流内宽度标尺并缓存最大行宽；保留旧高度并在行渲染时重测、按 `top(first)` 补偿滚动；`.git-graph-body` 设 `position: relative`；窗口跳过向上父边；浏览器 fixture 增加横向滚动、焦点 activeElement／offsetParent、宽度变化、刷新夹紧与 sr-only 用例。

2026-10-18 实现审查（独立只读）：确认契约 1/2/3/5/6/7 与代码一致、模型与 Demo 等价、证据哈希匹配；阻断项为契约 4 的展开测量 effect 缺少窗口范围依赖，窗口外展开行在宽度变化后重新进入窗口不会重测。另有非阻断问题：空仓库后同一实例挂载滚动容器时视口测量未重新挂接、证据计数写错、焦点 id 在刷新后未清理。修复：展开测量 effect 增加 `plan.first`／`plan.last` 依赖；尺寸观察 effect 以 `hasCommits` 为依赖在滚动容器首次挂载时重挂；刷新清理失效焦点 id；docs 标注焦点旁路行仍可选中；浏览器 fixture 增加空仓库→提交与变宽后总高度核算两条回归，计数更新为 34。

2026-10-18 实施记录：定向用例 54/54、相关 Desktop 回归 200/200、lint、桌面 typecheck 通过；浏览器 fixture 34 项通过并写入 `verify.log`／`result.json`／`sha256.json`；`npm run desktop:build` 与 `desktop:mygo:build` 通过。相关回归最初捕获 `43-desktop-demo` 的定稿 CSS 前缀断言：窗口化样式先放进共享区段导致不匹配，已改为放在 Desktop 专属区段后复验 200/200。实施在第二轮方案审查结论返回前已开始，属流程偏差；方案审查意见已逐项落实并复验，独立实现审查已完成（无阻断）。

2026-10-18 独立实现审查结论：无阻断。审查者核对契约 1–7、把 Demo `layoutGitGraph` 作为对照跑逐步等价与随机 DAG 窗口检查，并亲跑定向用例与静态门禁；非阻断项按现状处理：窗口起点变化时不做滚动补偿（已写入笔记上限）、时钟偏移父边可能多占一个 lane（只影响图宽，已有等价用例）、横向宽度在首提交变化时重置（已改口径）、展开行重进窗口可能重播 CSS 展开动画（保留人工原生复验）、`widthResizeScrollStable` 容差 160px 与初始窗口上限 60 行已收紧/保留（初窗改 40 行上限）。浏览器 fixture 最终 34 项通过，其中 reentryRemeasured／reentryHeightAccounting 在缺少窗口依赖的旧实现下会失败，用于守住本轮修复；证据目录的 sha256.json 与 static.log 已按最终内容重新生成。
