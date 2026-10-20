# Demo 全局 Neutral 配色验收

2026-10-16；拥有者要求整个 demo 采用 shadcn/ui 默认配色，范围替代此前只给消息流换色的限制；布局、字号、交互和正式 Desktop 不随之改动。

官方来源为 [Theming 默认 Neutral CSS](https://ui.shadcn.com/docs/theming)。26 项语义颜色在 theme.css 集中声明，保留原 reference.css 来源快照，通过 :root 与 html.dark 的别名覆盖旧蓝灰主题；Tailwind 直接映射 background、foreground、card、popover、primary、muted、accent、border、input、ring。删除消息流重复颜色和焦点环修补，桌面背景改用 muted，浅色窗口阴影去掉蓝色倾向。原 macOS 交通灯、状态和 diff 保留语义色。

独立只读审查核对官方 token、CSS 选择器优先级与源码差异，无阻断；审查者亲跑 demo check 通过。主代理运行 demo check 与根 check:static，通过类型、SSR、生产构建、lint、笔记与文档检查。正式 Desktop、冻结稿、demo 共享原语、reference.css 与依赖锁共 80 个文件哈希未变。

浏览器验证深色背景 .145、侧栏／右栏／菜单 .205、输入区 .269；浅色背景／右栏／菜单 1、侧栏 .985、输入区 .97，均为无色度 OKLCH。模型菜单的文字和边框、设置窗口的背景与分栏、主按钮颜色符合默认 token；菜单仍无位移／缩放，保留渐显。10 个区域的宽高、字号、字重、行高、内边距、间距与圆角在同一临时侧栏宽度和展开状态下逐项比较完全一致；没有修改 JSX、会话数据或交互函数。

本次新增主题导入触发 Vite 全页重载，临时侧栏宽度重置后已通过界面恢复，随后才作精确几何比较。截图见[深色](neutral-palette-dark.png)和[浅色](neutral-palette-light.png)，测量见同目录 neutral-palette.json。浏览器模拟验收不替代正式 Electron 验收，本轮未迁移正式 GUI。
