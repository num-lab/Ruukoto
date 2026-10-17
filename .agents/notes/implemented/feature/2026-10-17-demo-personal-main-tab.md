# Agent Note: Demo 的 Ruukoto 主会话入口

Status: implemented

## 问题

demo 通过设置切换全局 Code／Personal 目标，Personal 只有连接配置占位且禁用右栏。拥有者要求把 Personal 改为工作区列表上方的 Ruukoto 入口，在共用顶部标签中显示单一主会话。

## 决定

顶部两组标签在当前页签或可用宽度变化时自动显露活动项，防止新开的主会话落在可视区外。工作区列表常驻，Ruukoto 入口打开固定身份的独立主会话，重复点击聚焦已有标签；关闭只移除标签，重开保留当前 demo 生命周期内的历史与草稿。Personal 与工作区会话的模拟提交、模型、附件和右栏标签按 session 身份分别保存，不创建额外 Personal 会话。

右栏沿用原开合和调宽，Personal 保留浏览器与 SubAgent，但不展示差异、文件树或 Code 的默认标签。文件与差异入口同样核实当前会话身份，不只隐藏按钮。Personal 初始对话为空，复用消息流与输入；不为展示效果编造聊天内容，不复用 Code 专用工具演示。

删除运行目标设置和不可达的 SSH 占位；连接配置与真实 Personal 界面不在本轮范围。当前决定只修改可变 demo，正式 Desktop 仍待后续迁移。后续单独设置入口由 [PA 远程连接设置](2026-10-17-demo-personal-connection-settings.md)持有，不恢复运行目标。

历史检索：[桌面提案](../../proposed/architecture/2026-10-15-desktop-client.md)的真实连接边界继续适用；[消息流](../../implemented/feature/2026-10-16-demo-ai-elements.md)、[右栏工具](../../implemented/feature/2026-10-16-demo-inspector-tools.md)与[页签布局](../../implemented/feature/2026-10-16-demo-header-model-menu.md)部分重叠，沿用其视觉与现有 Code 行为，不改冻结稿。

## 备选方案

- 保留全局目标选择改标签名，实现较少，但不能让工作区和 Personal 标签并存，违背入口要求。
- 把 Personal 伪装成工作区可复用全部查找，但会混入筛选、新建会话和文件路径映射；采用独立单一主会话，仅复用渲染和更新路径。
- 本轮直接接真实 Personal 后台可提供完整体验，但超出当前 GUI 设计范围；先在 demo 核对交互，再按后续授权迁移。

## 后果

Ruukoto 按钮位于工作区上方，设置不再出现目标切换；重复点击／关闭重开只有同一个主会话，草稿与模拟历史保留，切换中完成的发送不串到 Code。PA 右栏能展开，只有允许的入口，Code 文件与差异行为保持；明暗、窄栏与键盘可用。主会话按钮与固定数据有渲染／提交回归，浏览器覆盖去重、关闭重开、跨标签延迟发送、设置、PA 右栏和 Code 原差异／文件预览。工程与产品证据归[工单](../../../../.scratch/desktop-shadcn/issues/12-personal-main-tab.md)。

demo 的模型、连接和回复仍为模拟，不能当成真实 Personal 后台验收；刷新会重置内存状态。默认空主会话只展示已要求交互，内容布局需在用户输入后检查。
