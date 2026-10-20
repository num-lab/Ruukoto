# Agent Note: Git graph 行窗口化与增量布局

Status: implemented

## 问题

Desktop 的 Git graph 此前把全部已加载提交渲染成完整 DOM：每行一个绝对 SVG，并逐条绘制穿过该行的父边；分页只增不减，页数没有上限。提交数到万级、车道数几十时，行内 SVG 元素是提交数 × 活跃车道数量级，页面内存可达 GB 级；Electron 与 MyGo 的同一份 renderer 分别跑在 Blink 与 WebKit 上时，峰值差异也主要由这个页面放大。已有[分页](2026-10-17-desktop-git-history-pages.md)与[自动续页](2026-10-17-desktop-git-lazy-loading.md)只约束读取与追加时机，不约束渲染。

## 决定

渲染只覆盖可视窗口：窗口行保持在正常流内，前后各插一个 aria-hidden 占位 `<li>` 撑出已卸载行的高度，末尾 `IntersectionObserver` 哨兵仍是流内 `<li>`，因此 `ol` 的 `min-width: max-content` 与哨兵宽度来自真实行内容。另加一个高度为 0 的流内标尺 `<li>`，宽度保存本次打开以来测到的最大行自然宽度；滚到短行窗口时横向滚动范围、`scrollLeft` 与哨兵宽度不塌缩。窗口大小为视口高度换算的行数加上下各 6 行 overscan，另有至多一个窗口外焦点行；`.git-graph-log` 设置 `overflow-anchor: none`。

新增 `git-graph-model.ts` 按页增量维护布局：`laneAt`、`parentLanes`、`rowById` 与每 128 行一份的车道快照。窗口布局从起点前最近巡检点克隆车道状态并前滚得到，不再构造逐行 `edgesByRow`；续行判定用 `rowById.has(父提交 id)`。只有 `commits.length` 不短于已处理数、首提交 id 与已处理末提交 id 均未变时才增量追加，否则重建；HEAD 变化不影响布局。同一长度且首尾相同但中间被改写的情形无法识别，依赖 Inspector 的修订游标与刷新替换首批约定。时钟偏移导致父提交排在子提交之前时，`to < from` 的边不绘制，与旧布局一致。

图线仍是每行自己的绝对 SVG（`height: 100%`），只为本窗口行生成；28px 行高、`nodeY`、弯折与展开行内图线拉伸保持原样。展开状态按提交 id 上提到面板；展开内容自然高度由已渲染 `CollapsibleContent` 的 `scrollHeight` 测量并按 id 缓存，用于窗口外占位、总高度与滚动夹紧。视口宽度变化保留旧高度，窗口范围或行重新渲染时重测；滚动容器在空仓库后首次挂载时重新挂接尺寸观察；刷新后清理不存在的 id；窗口上方高度变化用 `top(first)` 差值补偿 `scrollTop`。

焦点行通过行按钮的 focus 事件跟踪；滚出窗口后以绝对定位行渲染在其真实偏移处，并按行号放在窗口行之前或之后。窗口换行移除原 DOM 导致焦点落回 `document.body` 时，把焦点接回旁路行。每行 `<li>` 带 `aria-setsize` 与 `aria-posinset`，父关系 sr-only 文本仍区分已加载与「（更早提交）」。

## 备选方案

- **单 SVG／合并路径 + `content-visibility`** — 合并图线能把图线元素降到 O(边)，但不减少行 DOM；`content-visibility` 只跳过布局绘制，节点内存仍随历史线性增长，解决不了 GB 级峰值。
- **累计条数上限或滚动淘汰** — 实现最省，但改变[分页决定](2026-10-17-desktop-git-history-pages.md)已承诺的「可继续查看全部可达历史」，需要重新确认产品范围。
- **引入虚拟列表依赖** — 需要额外兼容 Radix 展开高度、话题/焦点与现有 CSS；仓库当前不增加依赖，且窗口行 + 占位已足够表达。
- **绝对定位窗口行** — 行脱离正常流后 `ol` 的 `max-content` 与末哨兵宽度会塌缩到视口，横向滚动时 IntersectionObserver 不再命中；需自建宽度管理，成本高于流内行加占位。
- **用滚动位置判定代替 IntersectionObserver** — 会改动[自动续页](2026-10-17-desktop-git-lazy-loading.md)已确认的触发机制与回归，而且横向滚动场景仍需保证内容宽度，不减少工作量。

## 后果

- **收益**：行 DOM、行内图线元素与读屏可导航行数只取决于视口与一个焦点行，不再随已加载提交数增长；追加一页只处理新增行；布局状态从 O(提交数 × 车道数) 的边对象降为 O(提交数 + ⌈提交数／128⌉ × 最大车道数)。
- **代价与已知上限**：Tab、读屏、文本选择、Ctrl+A 与浏览器 Find 只覆盖当前窗口内的行（窗口外焦点行旁路渲染时仍可选中；2026-10-18 拥有者确认接受）；横向内容宽度是本次打开见过的最宽行，刷新导致首提交变化时重置；窗口外已展开行要等重新进入窗口才重测高度，期间总高度暂按旧值；展开动画期间占位与总高度按内容自然高度更新；展开行重新进入窗口会重新挂载内容，CSS 展开动画可能重播而高度按缓存保持。窗口上方高度变化只在窗口起点不变时补偿滚动位置，起点同时变化（例如大幅滚动同帧）不补偿。时钟偏移的向上父边会占用一个额外 lane，只影响图宽，不绘制该边。真实 WKWebView 的滚动手感、动画重播与输入法仍需人工复验。

## 验证

`test/desktop-git-layout.test.ts` 覆盖模型 70000 行巡检点窗口、与 Demo `layoutGitGraph` 的逐行车道／父边／穿越边等价、增量追加等价整图、首尾谓词、续行变实线与多车道夹具；`test/desktop-git-windowing.test.ts` 覆盖 metrics／range／夹紧／焦点旁路与 SSR 窗口上界、`aria-setsize`／`aria-posinset` 和更早父提交文本；`test/desktop-git-lazy.test.ts` 的 observer 回归改为校验流内窗口行、标尺与哨兵位置；真实 Chromium 由 `.scratch/desktop-shadcn/evidence/git-windowing/verify.mjs` 驱动，覆盖横向滚动后续页、展开／折叠、焦点旁路、宽度变化与重测、空仓库后收到提交、刷新缩短后的末页与滚动上限、空仓库。
