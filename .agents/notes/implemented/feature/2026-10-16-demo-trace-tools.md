# Agent Note: Demo 工具调用详情采用嵌套 Trace

Status: implemented

## 问题

拥有者要求按所附官方 Trace 示例重做消息流，删除思维链，同时保留工具分组；Read 路径打开文件，Edit／Write 就地展示 diff，Bash 展示完整命令，失败调用标红并可查错误。此前[AI Elements 试验](2026-10-16-demo-ai-elements.md)只将工具行跳到右栏 diff，并装配独立思考样例。本篇部分取代这两项决定，其余消息、审批、滚动与布局范围继续沿用旧篇；正式 Desktop 与冻结稿不自动更新。

## 决定

可变 demo 删除 thought 类型、样例与渲染，主／子消息流共享 ToolActivity，复用官方 Trace。独立子 Agent 保留右栏入口；工具摘要折叠组内嵌套 Trace，每个有详情的调用再用 TraceCollapsible。每个调用键由会话、消息流、步骤、调用索引组成；演示详情使用独立流键，避免污染默认历史的展开状态。沿用 Radix Presence、180ms 开合、inert／aria-hidden 与减弱动画，不增加滚动或测高控制器。

任务执行中的尾部复用同一个活动组件，以 phase 明确区分 thinking／working。Thinking 只展示旋转环与状态文字，不装配思维链；Working 默认展开，显示已完成和显式 running 的工具，动词随状态变化。失败优先于 running；正在进行的 Edit／Write 只展示调用本身已记录的 diff，不回退到 Session 旧差异，也不显示完成统计。尾部使用会话／流／execution 固定键，排队输入加入历史后详情状态不随索引漂移。

演示状态以原任务执行中入口展示 Thinking，新增 Working 入口，不使用自动计时。执行预览只过滤待审批卡并追加尾部，不修改会话记录或伪造批准；离开执行场景恢复原审批。两种阶段同样支持停止与输入排队，切会话沿用清除演示状态，旧任务尾部与停止按钮不进入另一会话。旋转环与既有 Trace 原语遵守系统减弱动画；Message Scroller 继续拥有滚动行为。按拥有者明确要求增加此可见状态，与先前删除思维链正文不冲突，验收见[执行状态工单](../../../../.scratch/desktop-shadcn/issues/08-execution-summary.md)。

Read 行始终静态，只有文件路径是链接，调用现有 openFile 打开独立文件预览，缺失文件沿用预览提示。失败 Read 直接显示错误，不增加展开按钮。Edit／Write 使用调用自身 diff 或既有 diffFile 关联的记录，展开显示增删行；缺记录与空文件有明确结果，不从完整文件重建 diff。Bash 的展开区显示原始 command 与 output，其他已有活动保留动作名称和原始附注，不把 Build／Bench 的目标文件伪装成 shell 命令。

失败只由显式 error 字段判定，TraceLine 使用 error 状态、CircleAlert 与 Failed to 动作文字，详情用 destructive CodeBlock；分组关闭时仍显示失败数和红色状态。文本通过 React 转义，命令仅为展示。CodeBlock、CodeBlockContent、CodeBlockLine 及其变体复制自官方 radix-rhea registry，规范 cn 路径并翻译唯一注释；不复制未用的标题、操作、复制与 footer，也不安装高亮 hook 或新依赖。代码、结果、错误和 diff 采用原生 small／wrap／max-height，避免长行横向滚动。

默认对话继续使用原始只读样例，设置中的工具详情场景另行提供 Write、成功／失败 Bash 和失败 Read。样例返回新步骤，不修改 Session 或已有 diff。原始 reference-data.json、两份冻结稿、正式 Desktop 与后台保持不变。

历史检索中，AI Elements 为部分重叠并互链；顶部菜单记录只涉及输入和标签布局，正式端迁移记录约束已迁移的版本，均不被本篇替换。上下文压缩、SubAgent 快照与等待所有权里的同名 reasoning／trace 属后台机制，与此 demo 展示无关。

## 备选方案

- 取消分组，照搬示例的所有平铺行：外观最接近截图，但违背工具正常分组的明确要求；采用分组内嵌套的同款行与详情。
- Read 也用整行折叠或按钮：组成统一，但无法同时提供不展开与独立文件路径操作；保留静态行和链接，失败内容直接可见。
- 所有工具继续跳右栏：可复用已有 diff 页面，但不符合点击调用就地展开详情；右栏保留正文的差异入口，工具详情独立在流内展示。
- 安装整套 CodeBlock 及高亮器：完整复制最省手工提取，但会引入未使用依赖和复制控件；只取实际需要的官方展示原语。

## 后果

消息流增加单条调用开合层级，仍保留官方截断、焦点、语义主题和独立滚动。工具完整输入与结果必须由调用记录提供；本轮是内存模拟，不证明真实执行或正式端接线。工程和浏览器检查、独立审查及体验待验收由[工单](../../../../.scratch/desktop-shadcn/issues/07-trace-tool-details.md)持有，产品观感交拥有者审阅。

## 后续决定

[执行阶段连续反馈与reasoning批次](../bug-fix/2026-10-17-desktop-execution-activity.md)取代本篇相关展示决定；工具详情、安全身份、错误与续页生命周期仍沿用本篇。
