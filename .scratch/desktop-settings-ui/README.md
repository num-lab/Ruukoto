# Desktop 设置页基础控件 Demo

独立的设置页 UI 原型，用统一样式展示现有 Desktop 的真实设置结构。导航与字段对应 `apps/desktop/src/renderer/settings-dialog.tsx` 及各设置页面，覆盖外观、模型、Skills、MCP、电脑、Web 搜索、PA 远程连接和已存档会话；配置有差异的模型、Skills、MCP、电脑在左栏分为 Code 与 PA 两组分别管理。

源码不依赖现有 Desktop 页面或旧 demo，也不读取或修改真实配置。示例名称与地址均为虚构数据，操作只改变内存，刷新后恢复；连接测试、配对、文件选择、保存和删除不会调用真实后台。

## 运行

在仓库根目录执行 `npm --prefix .scratch/desktop-settings-ui run dev`，打开终端显示的本地地址。首次检出可执行 `npm --prefix .scratch/desktop-settings-ui ci`。

`npm --prefix .scratch/desktop-settings-ui run check` 执行 TypeScript 检查和生产构建。

## 组件

- `SettingsShell`、`SettingsNavItem`、`SettingsNavSection`、`SettingsPage`：分类导航（含 Code / PA 分组标题）、独立内容滚动与页面标题。
- `SettingsGroup`：组标题、可选说明和组级动作。
- `SettingsCard`：卡片容器，直接子项之间显示分隔线。
- `SettingsRow`：标题、必要说明、右侧控件与整行附注；窄窗口换行。
- `SettingsList`、`SettingsListItem`：一张 `SettingsCard` 承载整张列表，每项使用 `SettingsRow`，支持右侧操作、当前项详情和空状态。
- `SettingsLinkRow`：一级设置页的二级页面入口；Provider 示例直接在一级页管理列表，仅新增时进入二级页。
- `SettingsSubpage`：独立返回栏、页面标题和内容区，承接复杂设置。
- `SettingsSelect`、`SettingsSwitch`、`SettingsSegmented`、`SettingsInput`、`SettingsButton`：可独立使用的操作控件。

样式变量集中在 `src/styles.css`。各示例页不自行定义卡片、行和控件样式。原型使用原生控件，不增加 UI 框架。
