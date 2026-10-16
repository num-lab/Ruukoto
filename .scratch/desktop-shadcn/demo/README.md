# Desktop shadcn demo

以[原始 ui-demo.html](../../desktop-gui/ui-demo.html)为视觉基准，并按拥有者的浏览器批注逐轮调整，用 React 与官方 shadcn 组件重建。消息流采用当前官方 [AI Elements](https://ui.shadcn.com/docs/ai-elements) 组合，正式 Desktop 与前版冻结稿暂不随之修改。整个 demo 使用 [shadcn/ui 默认 Neutral](https://ui.shadcn.com/docs/theming) 明暗配色，定义在 `src/theme.css`；布局、字号和交互保留当前设计。原稿的主题变量保存在 `src/reference.css`，样例对话保存在 `src/reference-data.json`；两者直接从原稿提取。所有会话、连接、审批和差异均为内存模拟数据，刷新后重置。

首次运行：`npm --prefix .scratch/desktop-shadcn/demo ci`；启动：`npm --prefix .scratch/desktop-shadcn/demo run dev`。打开终端显示的本地地址。左下角「设置」打开悬浮窗口，左侧选择外观、运行目标或演示状态，右侧修改主题、Code／Personal 或预览场景，即时生效；⌘／Ctrl+B、J 分别收起左右栏，⌘／Ctrl+Shift+L 切换明暗。窄窗口初始收起右栏。

检查：`npm --prefix .scratch/desktop-shadcn/demo run check`，包含类型检查、首屏渲染、原稿样式来源核对与生产构建。组件源码位于 `src/components/ui/`，来自 [shadcn/ui](https://ui.shadcn.com/)，MIT 许可随源码保留。新增的 message、bubble、trace、collapsible、item、separator、message-scroller 来自官方 `https://ui.shadcn.com/r/styles/radix-rhea/<组件名>.json`，仅替换导入路径和图标占位；滚动行为使用固定版本 `@shadcn/react` 0.3.1。

主消息与子 Agent 消息使用独立的 Message Scroller，打开会话从顶部开始；读者仍在底部时跟随新消息，上翻阅读时保持位置，不增加跳转按钮。发送时保留输入框中的文字和附件，按钮显示加载中；模拟核实完成后才加入会话并清空草稿。执行中空输入时按钮显示停止图标，有输入时可排队。输入框 Enter 发送，Shift+Enter 换行；组合输入不发送，空输入 Enter 不触发停止。工作区筛选框展开／收起有过渡，Escape 清空关闭并返回筛选按钮，系统减弱动画时立即切换。空文件沿用普通内容区，截断内容点 `more` 展开。

消息流使用官方 [Trace](https://ui.shadcn.com/docs/components/radix/trace) 组合，不显示思维链。主／子消息流工具摘要前保留扳手，展开后各调用使用状态图标；Read 不展开，只有文件路径可点击并打开右栏文件预览。Edit／Write 点击后在消息流内展示增删 diff，Bash 点击后显示完整命令和结果；失败行标红，标题明确 Failed to，分组摘要保留失败数。失败 Read 直接显示错误，其余失败展开查看；缺失差异显示提示，空文件显示无内容差异。设置的「工具详情与错误」场景提供 Write、成功／失败 Bash 和失败 Read，不修改默认对话。正文内联 code 使用 13px、正常字重，正文文件路径仍可打开差异。

任务执行时在消息流末尾显示旋转环和状态标题：Thinking 只显示状态，Working 默认展开已完成与进行中的工具行。完成行使用勾选，进行中使用旋转环和 Reading／Editing／Writing／Running 等文字，沿用工具详情与错误行为。进行中的编辑只展示调用本身已有的差异；无记录时不借用旧 diff。设置中「任务执行中 · Thinking」和「工具调用中 · Working」可切换预览，停止后尾部消失，输入仍按执行中排队。预览期间隐藏待审批卡，回到默认场景恢复，不修改原审批或执行真实命令。切换会话不会带入上一会话的执行尾部；排队新增历史后当前详情仍保留。系统减弱动画时停止旋转。

工具详情使用官方 radix-rhea registry 的 CodeBlock、CodeBlockContent、CodeBlockLine 和变体，保留原语样式，规范导入并翻译注释；只复制实际使用部分，不装高亮 hook 或新增依赖。命令、输出和错误按文本转义；small／wrap／高度上限保持内容在窄栏内可读，命令不会执行。

输入区按 Context、模型菜单、发送排列。Context 采用官方 [Radix Context 模式](https://ui.shadcn.com/docs/ai-elements/radix/context)的 Hover Card／Progress 组合；入口仅显示灰色进度环，不显示百分比数字；悬浮或聚焦打开详情，顶部显示已用百分比及约数用量／容量，中间为灰／紫／蓝分段条，下方为 System prompt、Tool definitions、Messages 三行同色分类用量。详情宽 280px，字号和内边距均收紧为 12px；弹层从入口偏左开始，环形中心位于弹层左侧约 30px，视口边缘由原生组件避让。现有样例总量为 32,000／200,000，分类为 1,500／5,300／25,200；均为模拟值，不表示真实 prompt 统计或所选模型的容量；入口关闭详情时仍有可访问用量描述，窄栏保留图标。模型菜单内分组选择模型与 Effort，Effort 可选 Low、Medium、High，默认 Medium，按会话保留；普通新会话及新工作区的首个会话继承当前 Effort，上下文及三类用量从 0 开始。模型菜单在输入核实期间禁用，在入口上方弹出且无位移动画；不发送真实模型参数。输入框底部功能键始终同排；composer 内容宽度不超过 480px 时，模型入口只显示 Brain 图标，读屏仍能获得当前模型与 Effort。模式入口和菜单分别以提问、盾牌、闪电、清单图标表示 Ask for approval／Auto review／Full access／Plan；composer 内容宽度不超过 320px 时仅显示当前模式图标，并保留可访问的当前选项。空间更小时收紧间距，附件、模式、Context、模型和发送均可操作。

Context 新增的 hover-card、progress 同样来自官方 radix-rhea registry，仅规范 cn 导入；Progress 另补 Root 的 value 透传，保证读屏数值与填充一致。其他官方源码组件不变。

AI Elements 本轮范围和验收见[新工单](../issues/03-ai-elements-demo.md)。先调整并定稿本 demo，再按同一版组件、样式和布局迁移正式 desktop；模拟数据、工作区筛选与演示状态选项不迁入正式界面；设置窗口版式按定稿迁移，具体设置项只接已有业务。输入框左侧加号采用略浅的圆形底色和稍粗笔画，可选择本地文件，附件随会话草稿保留；仅保存文件名与大小，不读取或上传内容。命令与用途常驻审批卡，批准／拒绝无需先展开，决定后卡片消失。右侧 tab 与会话 tab 位于同一顶部栏，标签区与下方检查器同步调宽、收起；子 Agent 和工具摘要之间的间隔沿用 Trace 原生样式，正文与审批间距保持原样。左右侧栏内侧边界可拖动调宽，也可聚焦分隔柄后用左右方向键微调；宽度在本次页面中保留，刷新后重置。展开、收起带过渡，悬浮不弹出说明；右栏差异直接平铺，横向滚动代码时行号与增删标记固定；标签区下方有分隔线。Read 活动不显示行范围附注。附件已由新批注纳入界面范围，正式迁移须补齐真实附件通路；正式 Desktop 的浏览器、工作区文件读取、全局搜索与差异 Accept／Reject 仍不作为本次业务能力；可变 demo 的右栏试验见下文。范围、检查入口与证据见[工单](../issues/01-ui-demo.md)。

右栏加号的新标签页提供「浏览器」「文件树」。浏览器支持地址栏 Enter、前后退和刷新，默认打开本地可交互演示页；只接受不含账号密码的 HTTP(S) 地址，错误时保留原页面。外站在隔离 iframe 中显示，部分网站会拒绝嵌入；地址栏历史仅记录从地址栏或文件链接发起的导航，不读取网页内部导航或最终重定向地址。输入同源 demo 根入口时，父界面直接显示提示。普通右栏标签切换保留网页状态，切换会话保留地址和导航记录并重新加载；关闭浏览器标签后记录清除。

文件树按工作区展示只读样例，新工作区为空；可用 Enter／空格折叠目录，点击文件打开独立预览标签，同一文件去重并与 diff 共存。源码／文本显示固定行号，Markdown 可切换排版与源码，图片使用本地样例资源；空文件保持空白，不支持格式或缺失文件有明确提示。Markdown 使用 react-markdown 10.1.0，禁原始 HTML和远程图片，HTTP(S) 链接在内置浏览器打开，其他链接保留文本。目录展开按工作区保存，预览模式按标签保存；新开、切换或调宽后活动标签保持可见。所有文件均为内存 fixture，不读取真实目录。范围和验收见[右栏扩充工单](../issues/04-inspector-tools-demo.md)。

文本预览按文件扩展名使用 [highlight.js](https://highlightjs.readthedocs.io/en/latest/api.html#highlight) 语法高亮，覆盖现有 TypeScript／TSX、JavaScript／JSX、JSON、Markdown、Rust、Python、Swift 与 HTML／XML；未知格式保持纯文本。行号固定、内容横滚，Markdown 排版预览沿用原行为，切到源码时高亮。依赖仅加入可变 demo，不更新正式 Desktop 或冻结稿。

顶部两组标签的关闭键在悬停时叠加显示，邻近文字渐隐，不占标题宽度；键盘聚焦关闭键时也会显露。选中标签两端隐藏短分隔线，右栏展开时在会话与右栏标签区之间显示居中的短竖线。

左侧工作区会话列表，以及主／子消息流中的工具分组与调用详情折叠区，展开和收起均有 180ms 高度、透明度过渡；系统减弱动画时直接切换。筛选强制展开、展开状态隔离和消息流滚动行为保持原样。

当前上述调整已按拥有者授权迁入正式 Desktop，基准见 [v3 冻结稿](../approved-demo-v3/README.md)与[迁移工单](../issues/09-desktop-current-demo.md)。本目录继续作为可变 demo，后续调整仍需另行迁移；冻结稿不随本目录改动。
