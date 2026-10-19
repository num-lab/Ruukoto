# Agent Note: 手写控件补齐过渡动画

Status: implemented

## 问题

Desktop 界面里由 shadcn 原语呈现的控件自带 `transition-all`／`transition-colors`，开合与弹层沿用原语动画；但手写 CSS 的部分只剩瞬态：工作区展开箭头旋转、工作区行与会话项、Git 提交行、右栏新标签入口、附件移除键的 hover 背景，以及添加工作区、标签关闭、附件移除键的悬停显示，都是立刻切换。提示条（toast）也直接出现。原因是冻结前缀只给侧栏宽度、筛选与标签排序等既定位置写了过渡，手写按钮没有统一来源。

## 决定

在正式追加段新增一段带本篇锚点的规则，集中补三类动作，不逐个散落到原有规则里：

- 手写可点击行统一 `background-color`、`color`、`opacity` 120ms：工作区行、会话项、Personal 行、Git 提交摘要、右栏新标签页入口、附件移除键。
- 默认隐藏、悬停或聚焦才显示的控件补 `opacity` 过渡：工作区添加键、标签关闭键；两者原先的显隐仍是瞬变，过渡不改变命中区域或几何。
- toast 用 180ms 的 `toast-in` 从下方 6px 淡入，与既有 `connection-fade-out` 的收尾时长一致。

工作区展开箭头原先声明 `transition: transform`，但 Tailwind v4 的 `rotate-90` 输出到独立的 `rotate` 属性，`transform` 过渡匹配不到，箭头一直瞬跳。改为在同一选择器上把 `transition-property` 覆盖为 `rotate`，保留冻结前缀的 150ms 时长与缓动；文件树目录行的箭头没有现成过渡，直接补 `rotate` 150ms。

既有全局 `prefers-reduced-motion` 规则把 `animation` 与 `transition` 置为 `none`，新增规则自动遵守，不另写媒体查询。所有改动只在 `apps/desktop/src/renderer/style.css` 的正式追加段，冻结前缀与可变 demo 不动。

## 备选方案

- **改冻结前缀或 demo**：Git 归档断言要求正式 CSS 以冻结稿原文开头、demo 以冻结稿加全部差量逐字一致，原地改会破坏比对来源；新增尾部差量即可，不必重定稿。
- **给手写按钮加 Tailwind 工具类**：可行但需要改 `app.tsx` 等 JSX，且同一批规则分散在多个文件；CSS 选择器集中一段更短，也不碰交互与可访问属性。
- **`transition: all`**：会把布局与颜色之外的变化也纳入动画，hover 时误动宽高；显式三属性更稳。
- **toast 用组件库或 Presence**：只有一条固定提示，直接 `@keyframes` 最短，且不引入新的依赖或焦点管理。

## 后果

上述控件悬停、显隐与 toast 出现都有短促过渡，操作反馈不再跳变；箭头旋转终于按既有设计过渡。代价是手写选择器与组件类名继续耦合，新增同类按钮需要记得加入选择器组；折叠、筛选、标签拖动与弹层动画仍由各自既有规则负责，本篇不重复。减弱动画、明暗主题与窄窗口布局行为不变，无需新的测试用例：这些改动只涉及呈现过渡，不影响输出了什么或何时输出。
