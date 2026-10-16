# Agent Note: Demo 消息流采用 AI Elements

Status: implemented

## 问题

拥有者要求先在 demo 试用 shadcn/ui 的 AI Elements，再审阅后续 GUI。正式 Desktop 已按[前版定稿](../architecture/2026-10-15-desktop-shadcn-demo.md)迁移；不能把新试验自动变成正式界面的变更，也不能覆盖原冻结副本。

## 决定

仅修改独立 demo。采用 [shadcn/ui 当前 AI Elements](https://ui.shadcn.com/docs/ai-elements) 的 Radix 组合：Message／Bubble 展示消息，Trace／Collapsible 展示工具活动与独立子 Agent，Item／Button 展示审批。源码来自官方 radix-rhea registry，仅替换 cn、组件路径与 Lucide 占位图标，保留 MIT 许可。来源和依赖在 [demo 说明](../../../../.scratch/desktop-shadcn/demo/README.md)记录。

Message Scroller 使用固定版本 @shadcn/react 0.3.1，不引入模型 SDK。按主会话和子 Agent 的身份分别挂载 Provider，条目 ID 沿既有步骤身份；默认从顶部打开，只有读者仍在底部时跟随新增内容。删除原步骤数变化时的强制滚动，不同时维护两套滚动控制。

思考显示复用官方 [Chain of Thought 的 Radix 模式](https://ui.shadcn.com/docs/ai-elements/radix/chain-of-thought) 的 Trace／TraceCollapsible 原语，不新增包装组件或依赖。按拥有者后续批注，thought 分支用 durationSeconds 生成 `Thought for [time]s` 标题，展开区直接展示 text 的连续模拟思考文本并保留段落，不再生成带勾选图标的摘要清单。仅离线同步样例在用户输入后装配数据，不从消息正文推断真实模型思考，也不改变原始 reference-data.json。默认收起，沿用按会话／流／步骤隔离的展开状态，其他工具、审批与子 Agent 不进入思考组。工具摘要行使用 TraceIcon 展示扳手，独立子 Agent 仍为 Sparkles。正文内联 code 为 13px、正常字重，命令与工具文件字号保持当前值。

左栏工作区及主／子消息流中的思考、工具折叠区使用 180ms 高度与透明度动画。工作区复用已有 Collapsible／Trigger／Content，保持 section 结构和筛选期间强制展开、原展开状态翻转的语义。Radix 实际通过 data-state 标记开合，demo 局部样式匹配此属性；不改官方 Trace 源文件中的 data-open 类。退出动画交给 Radix Presence，开始收起时内容即 inert／aria-hidden，防止焦点进入退出区域；沿用系统减弱动画规则，不增加独立测高或滚动控制器。

上述思考显示与工具跳右栏的选择已由拥有者后续请求部分取代，当前可变 demo 删除思维链，Read 路径打开文件预览，其他工具就地展开；详见[工具调用详情](2026-10-16-demo-trace-tools.md)。其他输入、布局、审批与滚动决定继续沿用本篇。

输入区按 Context → 模型 → Effort → 发送排列。Context 使用只读 meter 和可见百分比，不采用官方 Context 模式的 Hover Card，因为拥有者已删除悬浮说明，当前只要求显示器；无额外点击详情或依赖。Session 记录模拟 usedTokens／maxTokens，不估算草稿或伪造真实模型容量。Effort 复用现有 Select，Low／Medium／High 默认 Medium，按会话保留，沿用核实时禁用与无菜单位移。普通新会话及新增工作区两个入口均继承 Effort、上下文从零开始；提交保持这些字段。容器不足时操作区换行，极窄栏的 Context 百分比、模型入口和 Effort 保持顺序，发送另排靠右，不挤出操作区。正式接线需要真实用量和模型配置，本轮不调用后台。

独立 Effort Select 与极窄换行选择已由拥有者后续批注替换，当前实现见[顶部标签与模型菜单](2026-10-16-demo-header-model-menu.md)；模拟数据和会话继承继续沿用本篇。

上述 Context 的只读 meter 与可见百分比选择已由拥有者后续请求替换，当前实现见[原生 Context 与环形入口](2026-10-16-demo-context-component.md)；Effort、模拟数据和其他范围继续沿用本篇。

官方模式按已有交互组合：审批批准／拒绝后直接消失，不追加工具完成行；子 Agent 保持独立入口并打开右栏，不改为就地嵌套；保留文件差异跳转及紧邻文件名的增删数。活动摘要按 Read files、ran commands、edited files、wrote files 的顺序，只列实际出现的类型，不显示数量和文件名；独立子 Agent 不进入摘要。没有新增反馈、重试、下载、滚动跳转、悬浮说明、模型调用或后台连接；三栏布局、字号和交互沿前版。整个 demo 使用官方默认 Neutral 明暗配色；主消息流和子 Agent 消息流采用官方组件类，移除旧气泡、Trace 和审批卡的视觉覆盖。窄栏优先保留子 Agent 名称，附注可截断；长路径在可用宽度内换行，审批命令独立横向滚动。

拥有者后续要求全局统一默认配色。以 theme.css 集中声明 [shadcn/ui Neutral token](https://ui.shadcn.com/docs/theming)，Tailwind 直接引用标准语义变量；原稿 reference.css 保留为来源快照，旧背景和文字变量在 :root 与 html.dark 两处映射到同一主题，避免深色的旧选择器盖回蓝灰配色。删除消息流的重复配色和焦点环补丁，所有区域与 Portal 弹层共用主题；原尺寸、字号、圆角和滚动布局不变。桌面背景改用 muted，浅色窗口阴影去掉蓝色倾向；macOS 交通灯、diff 与状态色保留语义。

## 备选方案

- 安装旧 AI SDK Elements：可直接获得组件文件，但官方已明确迁移到 shadcn/ui；本轮采用当前推荐的组合来源。
- 整套复制官方聊天示例：可快速复现展示，但会加入反馈／重试、模型客户端、就地子 Agent 和审批结果行，超出拥有者范围。
- 只把旧 div 改名为 AI Elements 包装：依赖最少，但不构成官方组件替换，也继续承担自写折叠与滚动逻辑。

## 后果

demo 增加 7 个官方源码组件及一个隔离的滚动依赖，根依赖、正式 Desktop 与冻结稿保持原版本。消息流使用可访问 log、Radix 折叠和官方滚动行为；对上滚阅读、切换会话与隐藏侧栏的核对仍属于浏览器验收。组件来源、工程和浏览器证据见[本轮验收](../../../../.scratch/desktop-shadcn/evidence/2026-10-16/ai-elements/verification.md)，原生样式及区域隔离另见[样式验收](../../../../.scratch/desktop-shadcn/evidence/2026-10-16/ai-elements/native-style-verification.md)。产品外观交拥有者审阅，暂不迁移正式 GUI。
