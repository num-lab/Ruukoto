# 原生 Context 与环形入口验收

仅修改独立 demo：按最新请求采用官方 [Radix Context 模式](https://ui.shadcn.com/docs/ai-elements/radix/context)的 Hover Card／Progress 组合，入口为灰色轨道与已用弧线，不显示百分比数字。此要求替代[上一轮只读 Context](context-effort.md)，Effort、模型、模拟用量与提交行为保持原样；正式 GUI、后台和冻结稿未改。

新增 hover-card／progress 源自官方 radix-rhea registry；除 cn 导入外，Progress 仅增加 value 到 Root 的透传，修复原始源码的 aria 数值与填充不一致。独立审查逐字核对来源差异并亲跑 demo check，无阻断。决定及前版取舍关系见[笔记](../../../../../.agents/notes/implemented/feature/2026-10-16-demo-context-component.md)。

`npm --prefix .scratch/desktop-shadcn/demo run check` 与根 `npm run check:static` 通过。SSR 检查入口为原生 Hover Card 的 type=button、无可见文字、无旋转、常驻 token 描述；0／16／50／100% 数据驱动弧线及 Progress aria-valuenow／填充，0 值弧线透明以避免圆头残点。

浏览器在原生 974×827 核对：入口 18×18px，静态灰环，没有数字；聚焦时打开 Context、32,000／200,000 tokens 及 Progress，详情也没有百分比文本。进度条 aria-valuenow 为 16，详情在入口上方相隔 8px；Escape 可关闭，指针停留详情时按原生行为保持展开，移出后关闭。新会话描述为 0／200,000，弧线透明，详情进度为 0。明暗主题均核对。760×500 双侧栏、144px 操作区下，环形图标仍为 18px，模型／Effort／发送均在范围内，无页面横向溢出；临时视口已恢复，测试会话已重载清除。

截图见[深色入口](context-ring-dark.png)、[深色详情](context-ring-details-dark.png)、[浅色详情](context-ring-details-light.png)、[最窄布局](context-ring-minimum.png)，测量见[数据](context-ring.json)。本轮用量仍为模拟值，未接真实模型或执行 Electron 验收；外观交拥有者审阅。
