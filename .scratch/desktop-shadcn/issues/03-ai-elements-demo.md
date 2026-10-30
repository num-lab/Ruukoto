# Demo 消息流采用 AI Elements

Status: ready-for-human

## 目标与边界

拥有者要求先在 demo 中把消息流组件换成 shadcn/ui 的 AI Elements。仅修改独立 demo、其依赖锁与本轮说明／证据；正式 desktop、后台及已批准的冻结副本保持原版本。消息、工具活动、审批与 SubAgent 采用当前官方 Radix 组合模式，消息流采用 shadcn/ui 原生样式，整个 demo 使用默认 Neutral 明暗配色，保留当前布局、字号、交互和已有内容，不增加反馈、重试、下载、跳转或悬浮说明。

## 方案

从官方 radix-rhea registry 复制 Message、Bubble、Trace、Collapsible、Item 与 Message Scroller 所需源码，复用现有 cn、Button 与 Radix。Message／Bubble 展示用户与助手消息；Trace 组织工具折叠组和独立子 Agent 跳转；Item 组织直接批准／拒绝后消失的审批。审批不会按官方演示追加完成行，SubAgent 不改为就地嵌套。

Message Scroller 由 @shadcn/react 提供滚动行为，删除旧的追加消息强制滚动；按会话与主／子消息流隔离，默认从顶部打开，仅在读者仍在底部时跟随新消息，不添加滚动按钮。保留内联路径打开 diff、按实际类型生成的活动摘要、紧邻增删数、模型／模式位置、核实前锁稿与核实后发送。

## 验收与交接

独立方案审查无阻断。demo check 覆盖类型、首屏与原约定、组件来源及生产构建；浏览器验证消息、工具展开、文件跳转、独立子 Agent、批准／拒绝、发送／核实／滚动、主题与窄窗。冻结哈希与正式文件哈希须保持不变；完成后独立复审并交拥有者审阅，暂不迁移正式 GUI。

## 进展

官方资料已核实：AI Elements 现为 shadcn/ui 组合模式，旧 AI SDK Elements 正在迁移。采用现有源码组件而非引入整套模型客户端；独立审查指出应移除旧强制滚动，并保留已确认的审批消失与子 Agent 跳转。

## 当前结果

7 个官方原语已接入，demo check 与独立源码／实现审查通过。浏览器覆盖消息、Trace 展开与 diff、SubAgent、审批消失、锁稿／发送、底部跟随／上翻保持、会话切换、焦点、明暗与窄窗。证据见[本轮验收](../evidence/2026-10-16/ai-elements/verification.md)，决定见[组件与滚动选择](../../../.agents/notes/implemented/feature/2026-10-16-demo-ai-elements.md)。正式 64 个文件与冻结哈希未变；下一步由拥有者审阅 demo，未自动替换正式 GUI。

拥有者进一步明确只调整消息流样式。旧气泡、Trace 和审批卡覆盖已移除，主／子消息流采用官方默认 Neutral；其他区域样式逐项对比一致，正式 GUI 与冻结稿保持原版本。复核与截图见[原生样式验收](../evidence/2026-10-16/ai-elements/native-style-verification.md)。

拥有者指出窄栏内联路径换行居中；已修复为真正的行内链接，保留差异跳转，验收见[路径换行修复](../evidence/2026-10-16/ai-elements/inline-path-fix.md)。上一轮样式验收不覆盖续行对齐。

本轮按三条批注移除审批标题圆点和外框，内联代码上下内边距由 3.2px 减为 1.6px；字号、审批区占位及交互保持原样。demo check、check:static 和明暗主题计算样式核对通过，截图见[深色](../../git-history-cleanup/archive.md?path=.scratch%2Fdesktop-shadcn%2Fevidence%2F2026-10-16%2Fai-elements%2Fapproval-refinement-dark.png)与[浅色](../../git-history-cleanup/archive.md?path=.scratch%2Fdesktop-shadcn%2Fevidence%2F2026-10-16%2Fai-elements%2Fapproval-refinement-light.png)。

审批卡改用 Item 的 muted 背景，保留无边框与原间距。输入区模式／模型两处 SelectContent 单独取消位移和缩放，保留淡入淡出、最终偏移与设置菜单原动画；浏览器分别打开两菜单，核对 enter 位移为 0、scale 为 1，截图与测量见[本轮效果](../../git-history-cleanup/archive.md?path=.scratch%2Fdesktop-shadcn%2Fevidence%2F2026-10-16%2Fai-elements%2Fcard-menu-refinement.png)和[计算样式](../evidence/2026-10-16/ai-elements/card-menu-refinement.json)。demo check、根 check:static 通过，正式 GUI 未改。

本轮隐藏审批命令的横向滚动条，保留可聚焦的命令区与横向滚动；正文采用 text-pretty，文件路径优先在目录分隔处换行，过长单段仍可应急断行，链接名称和跳转保持一致；删除右栏子 Agent 元信息行及其废弃样式。837×827 与 760×500 下 PassTimeline.tsx 均保持一整段，无横向溢出；命令右移 40px 时高度仍为 44px。效果与测量见[排版截图](../../git-history-cleanup/archive.md?path=.scratch%2Fdesktop-shadcn%2Fevidence%2F2026-10-16%2Fai-elements%2Fflow-refinement.png)和[验收记录](../evidence/2026-10-16/ai-elements/flow-refinement.json)。

活动摘要改为 Read files、ran commands、edited files、wrote files，只显示实际出现的类型，首个短语首字母大写；不再列文件数、文件名或子 Agent。Read/Grep 归入读取，Run/Build/Bench 归入命令，Edit/Edited 归入编辑，Write 归入写入；未分类活动保持原回退，不臆断为命令。既有摘要用例先对旧实现失败，更新后通过，覆盖四类、别名／重复项、缺类和未知类型，SSR 首屏为 Read files, edited files。内联 code 改为 font-normal，主／子消息实测均为 400。效果见[截图](../../git-history-cleanup/archive.md?path=.scratch%2Fdesktop-shadcn%2Fevidence%2F2026-10-16%2Fai-elements%2Fsummary-typography.png)与[计算样式](../evidence/2026-10-16/ai-elements/summary-typography.json)。

拥有者进一步要求整个 demo 使用 shadcn/ui 默认 Neutral 配色，替代此前仅限消息流的换色范围；布局、字号、圆角与交互保持现状。已统一主界面、侧栏、输入区和 Portal 弹层，移除蓝灰背景与局部重复配色，明暗及尺寸核对见[全局配色验收](../evidence/2026-10-16/ai-elements/neutral-palette.md)。

## 本轮增量方案

按最新批注，仅在 demo 主消息流加入一个思考摘要样例，采用官方 Chain of Thought 的 Trace → TraceCollapsible → 内层 TraceLine 组合，默认收起，鼠标及键盘可切换；复用按会话／流／步骤隔离的展开状态。样例为离线同步任务的高层步骤摘要，不从现有正文推断模型思考，不改变原始 reference-data.json，不调用模型或后台。已有工具组、子 Agent、审批和滚动保持当前行为；不新增状态预览、来源、图片或嵌套详情。内联 code 字号从 14px 调为 13px，保持正常字重和路径跳转。

影响范围为 demo-data.ts 的 Step 与样例装配、app.tsx 的共享步骤渲染、现有检查脚本、demo 说明和当前笔记／验收记录；不新增依赖或包装组件。检查覆盖样例顺序、默认收起／展开内容、无样例时不渲染、会话隔离；浏览器核对键盘切换、明暗及窄栏、文件跳转和 13px 字号。正式 GUI、后台、冻结稿、原稿快照及其他样式保持原样。

独立方案审查已直接读取需求、源码及官方 Radix 模式，结论无阻断；明确仅调整 renderProse 的 code 字号，保持命令与工具文件字号。

本轮实现与独立复审完成，无阻断；demo check、根 check:static 通过，浏览器覆盖展开／收起、键盘、会话隔离、窄栏、明暗、13px 和文件跳转，其他区域尺寸／背景及正式文件保护核对通过。仅模拟摘要，未接后台或迁移正式 GUI；效果与范围见[本轮验收](../evidence/2026-10-16/ai-elements/chain-of-thought.md)，下一步由拥有者审阅。

## 思考文本批注修订

最新三条批注要求标题为 Thought for [time]s、展开显示连续思考文本而非摘要清单、工具摘要前加扳手。仅改 demo：thought Step 用 durationSeconds 和 text 取代 summary／items，标题从秒数生成，展开区用可换行的普通段落承载模拟思考文本，删除三个勾选步骤；复用当前 Trace 折叠、默认收起与会话隔离。工具活动主／子流的摘要行均使用 TraceIcon 加 Wrench，独立子 Agent 的 Sparkles 保持原样。原内联 code 的 13px、其他布局、主题、滚动、审批及正式 GUI 不变。

影响 demo-data、共享 renderSteps、原 SSR 检查、README 和当前笔记；不引入依赖、模型调用或后台。检查覆盖时长字段驱动标题、默认收起／展开完整文本、没有思考数据时不显示、工具标题含扳手；浏览器核对点击／键盘、工具展开、窄栏换行和暗色截图。前轮三条摘要的验收只代表历史版本，新记录覆盖本次修订。

增量方案独立复审无阻断；确认用普通段落避免 TraceTitle 截断，标题测试使用另一时长，工具图标检查定位到触发器内部。

三处批注已实施，独立复审无阻断；demo check、check:static 通过，浏览器确认时长标题、分段文本、扳手、折叠与窄栏换行。80 文件保护与 CSS 核对通过；效果和范围见[本轮验收](../evidence/2026-10-16/ai-elements/thought-text-wrench.md)，下一步由拥有者审阅，未迁移正式 GUI。

本轮按批注在顶部会话与右栏相邻 tab 之间增加 1×12px 短竖线，使用主题 border 色，绝对定位且不接收点击，不增加 DOM 或布局占位；首个／单个 tab 无分隔线，设置分类不受影响。纯样式走轻量路径，demo check、check:static 通过，浏览器核对明暗、原尺寸／间距不变、切换／关闭与单标签。效果见[深色](../../git-history-cleanup/archive.md?path=.scratch%2Fdesktop-shadcn%2Fevidence%2F2026-10-16%2Fai-elements%2Ftab-dividers-dark.png)、[浅色](../../git-history-cleanup/archive.md?path=.scratch%2Fdesktop-shadcn%2Fevidence%2F2026-10-16%2Fai-elements%2Ftab-dividers-light.png)和[测量](../evidence/2026-10-16/ai-elements/tab-dividers.json)；80 文件保护核对通过，正式 GUI 未改。

## Context 与 Effort 控件

最新需求：模型 selector 左侧增加 context 显示器，右侧增加 Effort selector。仅 demo：右侧操作区按 Context → 模型 → Effort → 发送排序。Context 以小图标与已用百分比显示上下文占用，提供 meter 的可访问名称与 token 用量，无悬浮提示或额外详情。复用现有 shadcn Select 增加 Low／Medium／High，默认 Medium，菜单在上方弹出，沿用 composer-menu 的无位移效果；核实期间与模型选择一起禁用。Session 保存 effort 和模拟 context 用量，新会话继承 effort、context 从零开始；原样例快照不改，不声称模型真实容量或 Effort 支持。

保留当前主题、字体、左右顺序和其他交互，不引入依赖、后台或模型调用。右侧控件所需空间增加时延续现有容器换行；极窄栏 Context／模型／Effort 保持同排、发送按钮下一排靠右，模型名可省略，不使整页横向溢出。影响 demo-data、newSession、composer 渲染、局部 CSS、SSR 检查和 demo 说明／当前笔记。验收覆盖初始顺序、百分比来自数据、Effort 的选择／会话隔离／继承、核实时禁用、窄栏、明暗与菜单位置；正式 GUI、后台、冻结稿和其他官方源码原语不变。

独立方案审查指出普通新会话与新增工作区的首个会话都需初始化新字段，均纳入实施。最窄布局覆盖双侧栏开启的 144px 操作区；极窄时仅隐去 Context 装饰图标并收紧 padding／gap，保留百分比、可访问名称和可操作模型入口。

本轮实施和独立复审完成，无阻断。demo check、check:static 通过；浏览器覆盖 Effort 会话隔离、两个新建入口继承、Context 归零、核实时禁用、菜单方向／无位移、明暗及 144px 最窄操作区。局部 CSS 优先级问题已修正并重新构建／实测，临时视口已恢复。效果和边界见[本轮验收](../evidence/2026-10-16/ai-elements/context-effort.md)；仅模拟控件与用量，正式 GUI、后台和冻结稿未改，下一步由拥有者审阅。

## 原生 Context 与环形入口

最新请求明确采用 shadcn/ui Context，入口参照附件灰色环形图标，不显示百分比数字。此要求替代上一轮 Context 的只读 meter 裁剪；仅此处按官方 Radix Context 模式接入 Hover Card 和 Progress，其他控件不新增悬浮说明。复制官方 radix-rhea 的 hover-card／progress 源码，复用现有 radix-ui，不增依赖；Progress 当前 registry 源码未将 value 传入 Root，补这一行使读屏数值与视觉进度一致，并单独记来源差异。

入口为现有模型左侧的 icon Button，双圆形 SVG 显示轨道与已用弧线，按当前 usedTokens／maxTokens 驱动，无旋转动画；窄栏仍保留图标。Hover Card 按官方组合显示 Context、已用／总 token 与 Progress，不显示百分比文本，不加费用、模型信息或操作按钮。保留可访问名称和用量描述，支持焦点打开详情；不改变模拟数据、Effort、模型或提交行为。测试覆盖入口无文字／图标随 0、16、50、100% 数据变化、原生 Progress 的 aria 值、详情用量、焦点／关闭、明暗及最窄布局。影响新原语、app、局部 CSS、SSR、说明／笔记；正式 GUI、后台、冻结稿不变。

独立方案审查无阻断；确认 Progress value 透传的必要性，入口用 type=button 和始终存在的 token 可访问描述，0 值弧线隐藏，删除窄栏隐藏环形图标的旧规则。

本轮实现与独立源码／实现复审通过，无阻断；demo check、check:static 通过。浏览器覆盖无数字环形入口、原生详情及 Progress、键盘聚焦／Escape／指针离开、0 用量、明暗与 144px 最窄布局，临时视口已恢复。效果与范围见[本轮验收](../evidence/2026-10-16/ai-elements/context-ring.md)；仅 demo，模拟数据及正式 GUI／后台不变，下一步由拥有者审阅。


## 顶部标签与模型菜单批注

最新四条批注要求右侧 tab 移到窗口顶部、Thought／子 Agent／工具摘要之间的间隔稍减、Effort 收进模型菜单，以及宽度不足时模型入口显示 Brain 图标。仅改 demo：顶部 header 分为会话区与检查器区，后者与右侧栏共用宽度约束及 200ms 过渡；右侧 tab、关闭和加号移入该区，右栏开关始终可用。收起时隐藏的 tab 区同时 aria-hidden／inert，快捷键收起会把其中焦点移回开关；原 tab 数据、切换／关闭／新增、文件与子 Agent 跳转不变。

复用已有官方 DropdownMenu，将模型与 Effort 放入两个命名的 radio group，保留模型认证禁用、每会话选择和核实期间禁用，弹出方向与无位移效果沿用输入区约定。触发器在 composer 容器不超过 320px 时仅显示 Brain，保持「会话模型」可访问名称与当前模型／Effort 描述；宽栏仍显示模型名。Context 环形入口及详情、模式选择和发送保持现状。标注区域内部行距从 24px 减至 16px，其余消息／审批间隔不变。

影响 app、局部 CSS、现有 SSR 检查、demo README、决定与验收记录；不改 fixtures、依赖、原稿快照、正式 Desktop、后台或冻结稿。检查覆盖右侧 tab 在 header 内且不在 aside、收起不可聚焦、宽度同步、焦点归还、模型／Effort 切换及会话隔离、核实时禁用、320px 两侧布局与最窄输入区、菜单位置／动画及明暗。先独立方案审查，再实施、demo check／check:static 和浏览器验收，最后独立复审。

独立方案审查无阻断；确认仅缩小相邻 Trace 与 activity 内部间隔、顶部右区与下方 aside 实测边界对齐，并覆盖新位置的焦点归还、两个命名 radio group 与容器断点。

四处批注已实施，独立复审无阻断；demo check、check:static 与 80 文件保护通过。浏览器覆盖顶栏对齐／调宽、tab 生命周期、收起焦点、菜单选择／会话隔离／继承／核实禁用、键盘及明暗，321／319px 断点与 144px 最窄输入区均通过。原生 radio 圆点被旧全局 SVG 尺寸覆盖的问题已局部修正为 8px 并复测。最终视口与样例已恢复；效果和数据见[本轮验收](../evidence/2026-10-16/ai-elements/header-model.md)，仅 demo，下一步由拥有者审阅。

## 功能键保持同排

拥有者指出输入框底部功能键不应换行。本轮为局部响应式样式修正，走轻量路径：删除 480px 下两行与左右组占满整行的覆盖，始终 nowrap，左侧模式文字可省略，右侧 Context／模型／发送不收缩；模型 Brain 紧凑断点调整为 480px。220px 以下仅收紧 gap，模式入口保留下拉箭头、选项文字视觉隐藏且保留辅助技术文本，144px 最窄内容区仍容纳五个入口。不改 React、数据、菜单与发送行为、正式 Desktop 或后台。影响局部 CSS、README 与当前布局笔记，验收覆盖当前宽度、宽／窄布局、长模式名称与两菜单／Context 操作、明暗、demo check 和 check:static。

同排修正已完成；当前 349px、宽栏 622px 与最窄 144px 内容区均保持五控件同排，明暗、模式值读屏／选择、模型菜单、Context 和草稿启用发送核对通过。demo check、check:static 与独立只读复核通过，80 文件保护未变；临时视口、默认模式和草稿已恢复。效果和测量见[本轮验收](../evidence/2026-10-16/ai-elements/composer-single-row.md)，正式 GUI 未改。

## Context 详情布局

拥有者给出附件，要求详情采用顶部百分比／紧凑用量、中间分段条、底部 System prompt／Tool definitions／Messages 三行色块和用量的布局。仅调整可变 demo 的详情，保留无数字环形入口、Hover Card 交互及 Progress 数值语义；总量保留 32K／200K，分类补 1.5K system、5.3K tools、25.2K messages 样例，两种新建入口各项归零。三类使用灰／紫／蓝，其他区域配色与布局不变，不改正式 Desktop、后台、冻结稿、官方原语或依赖。

影响 app 的无状态详情渲染、demo-data 分类字段与两处新建初始化、局部样式、现有 SSR 检查、README 和[决定](../../../.agents/notes/implemented/feature/2026-10-16-demo-context-details.md)。独立方案只读核对无阻断，指出原生 Indicator 平移后的可见末段需要对齐色标，以及 Portal 内内容需要单独渲染检查；均纳入实现。验收包括分类合计／百分比、0／16／50／100% 与截图式紧凑格式、灰紫蓝对应、焦点打开／Escape、窄窗与明暗、会话切换及两个新建入口、入口无数字和输入区同排。

详情改版已完成，demo check、check:static 与独立实现复核通过；浏览器核对分类、三色条、焦点／Escape、两种新建归零、切回原会话、明暗和 760×500，85 个受保护文件不变。效果与源码哈希见[本轮验收](../evidence/2026-10-16/ai-elements/context-details.md)，临时视口和验收样例已恢复；仅 demo，下一步由拥有者审阅。

## 输入区图标与 Context 收紧

拥有者最新两条批注和文字要求：附件入口圆形、底色稍浅、加号略粗；四种模式左侧增加对应图标，空间不足仅显示图标；Context 详情缩小且环形入口对着弹层偏左。按局部视觉修订实施：附件仍为 26px 按钮，只加圆角／局部浅色混合与 2px 笔画；模式复用原 Select，菜单与入口共享提问／盾牌／闪电／清单图标映射，320px composer 以下隐藏文字及箭头并保留可访问名称／值；删除 220px 以下裁剪整个 SelectValue 的旧规则。Context 收紧到 280px、12px 内边距／字号／区块间隔、8px 分类行距，沿用 start／-16px 原生定位与碰撞避让。无新功能、状态、数据、依赖或官方原语改动。

独立只读方案与实现复核无阻断，已亲跑原 SSR 回归通过。工程和浏览器验收覆盖四种图标／模式选择、可访问当前值、附件形状／颜色／笔画、Context 缩小和偏左对齐、明暗及最窄输入区同排；正式 Desktop、后台、冻结稿和模拟数据保持原样。

本轮 demo check、check:static、独立只读复核及浏览器检查通过；四种模式选择、280px 详情偏左对齐、明暗和 144px 操作区符合要求。效果与范围见[本轮验收](../evidence/2026-10-16/ai-elements/composer-controls.md)，仅 demo，原生文件选择器未重复验收，下一步由拥有者审阅。
