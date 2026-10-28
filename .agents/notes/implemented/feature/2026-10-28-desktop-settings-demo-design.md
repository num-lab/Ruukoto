# Agent Note: 设置页改用 demo 验证过的导航与卡片体系

Status: implemented

本篇取代[设置容器](2026-10-21-desktop-settings-shell.md)中页内 Code/PA 页签与 shadcn Field 字段布局的部分；表单保护、票据与请求归属继续沿用。

## 问题

旧设置浮窗用纵向 Tabs 承载 8 个类别，模型、Skills、MCP、电脑四类再各自用横向页签切 Code 与 PA。两处决定分散、页签语义重复，且每种类别各写一套 `model-settings-*` 类名与 shadcn Field 布局，字段密度、控件宽度与分组标题在各页不一致。`.scratch/desktop-settings-ui/` 已用独立原型验证另一套结构：左栏按 Code/PA 分组的单层导航、组标题 + 卡片 + 行的设置页，以及同源控件。

## 决定

设置浮窗采用 demo 的结构与样式，作为唯一设置外观实现：

- 类别扩为 12 项：外观，Code 组的模型/Skills/MCP/电脑，PA 组的同名四项，Web 搜索、PA 远程连接、已存档会话。左栏用分组标签分隔 Code 与 PA，单层导航，不再有页内目标页签。
- `SettingsCategory` 直接编码目标（`code-*` / `pa-*`），`SettingsState` 删除 `selections` 与 `chooseTarget`，`scope()` 从类别推导 target 与实例。打开设置时按聊天目标落到对应组的第一页。
- 共享组件位于 `components/settings.tsx`（Shell、NavItem、NavSection、Page、Subpage、Group、Card、List、ListItem、Row）与 `components/controls.tsx`（Button、Select、Switch、Segmented、Input、Search、Tag、Notice），样式集中在 `settings.css`：按 demo 原值定义深色与浅色两套调色板、尺寸和控件值，不映射到 Desktop 主题变量。对话框尺寸受窗口约束（`min(1240px, 100vw - 200px)` × `min(860px, 100dvh - 120px)`），避免遮挡 macOS 红绿灯；其余外观按 demo 原值。旧 `model-settings-*` 样式与 `settings-ui.tsx` 删除。
- 各设置页改为“页标题 + 组 + 卡片 + 行”：Code/PA 页面各导出独立组件，不再接受 target/onTargetChange。详情编辑沿用列表行内展开，展开状态由页面 state 的 `editing/selected` 驱动，保证 SSR 与运行时一致；新增 MCP 服务进入二级页填写完整表单，保存或取消即结束，不再先在列表生成草稿再补齐字段。
- 字段校验错误随所属控件所在行显示（`SettingsRow.error`），不另起无标题行。
- Skills 页删除技能展开、正文、停用/移除入口；搜索框改为独立全宽控件，不再包在行里。MCP 页删除「重新读取 MCP 配置」按钮，列表项操作改为箭头图标。Select 宽度随内容且有上限，Segmented 图标固定 13px。
- `SettingsContentsProps.pages` 的键从 4 个 managed 类别改为完整 `SettingsCategory`，测试可替换任一页面。

## 备选方案

- 保留旧 Tabs 容器、只换视觉：类别与目标仍分两层，Code/PA 分组无法从导航直接进入，页面内仍需重复目标页签。
- 只迁移部分页面：同一次交互里出现两套行、卡片与控件，字段密度不一致，后续每页都要决定用哪套。
- 继续使用 shadcn Field/Select/Item：能复用组件库，但 demo 验证过的密度、宽度上限与分组语义要逐项重写覆盖，等于维护两套规则。

## 后果

设置交互的入口与分组方式变化：Code 与 PA 的模型、Skills、MCP、电脑各占一个左栏条目，页面内不再有目标切换。`settings-state` 的行为测试随之改写；`desktop-models-layout` 等 SSR 断言改按新结构与文案校验。真实 Electron/MyGo 的明暗、焦点与后端接入仍需产品验收，SSR 与静态预览只证明结构与样式。`test/desktop-settings-models.test.ts` 的「受影响提供方忙时拒绝写入」在本机与改动前 HEAD 同样失败，属既有环境问题，不计入本次回归。
