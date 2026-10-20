# Agent Note: Demo Context 采用原生组合与环形入口

Status: implemented

## 问题

拥有者明确要求 Context 改用 shadcn/ui 组件，入口参照附件的灰色进度环，不显示百分比数字。此前[AI Elements 试验](2026-10-16-demo-ai-elements.md)因通用的删除悬浮说明要求，把 Context 裁剪为只读 meter；最新请求取代其中 Context 的选择，其他区域仍不增加悬浮说明。

## 决定

按官方 [Radix Context 模式](https://ui.shadcn.com/docs/ai-elements/radix/context)组合 Hover Card 与 Progress，直接复制 radix-rhea 源码、规范 cn 导入并复用既有 radix-ui，无新依赖或独立 Context 包装层。官方 Progress 当前源码未将 value 传给 Root，补这一行使 aria 数值、状态与填充一致；其他源码不改，MIT 许可保留。

入口仍在模型左侧，使用 type=button 的图标按钮、灰色轨道及已用弧线，不显示数字或旋转。弧线由现有模拟 usedTokens／maxTokens 驱动，0 值透明以避免圆头残点；SVG 隐藏于读屏，按钮保留可访问名称和始终存在的 token 描述。详情仅有 Context、已用／总 token 和原生 Progress，无可见百分比、费用或其他动作。Hover Card 使用官方焦点与指针行为，窄栏始终保留环形入口，不改变 Effort、模型、提交或模拟数据。

## 备选方案

- 保留原只读 meter、仅换图标：最少代码，但没有满足明确采用 Context 组件的最新请求。
- 引入旧 AI SDK Elements Context：有现成环形入口，但增加模型／用量依赖和不需要的费用统计；当前官方模式已由 Hover Card 与 Progress 组合承载。

## 后果

仅独立 demo 增加两个官方原语及入口 SVG；正式 GUI、后台、冻结稿和模拟会话数据不变。SSR 检查 0／16／50／100% 的弧线与 Progress 可访问数值，浏览器检查详情、焦点、明暗及窄栏。来源和使用见 [demo 说明](../../../../.scratch/desktop-shadcn/demo/README.md)，外观仍交拥有者审阅。

顶部标签与模型／Effort 菜单的后续调整见[对应决定](2026-10-16-demo-header-model-menu.md)，不改变本篇 Context 行为。

详情内容随后按附件改为[百分比、分段条与分类明细](2026-10-16-demo-context-details.md)，取代本篇详情不显示百分比的约定；无数字环形入口及 Hover Card／Progress 选择继续成立。
