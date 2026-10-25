# Agent Note: Web Search 收窄为实例级全局开关

Status: implemented

## 问题

Web Search 最初按项目配置（issue 20：`projects.web_search` 列、`set_project_web_search` op、`project.settings_changed` 携带开关字段），拥有者实际从未使用按项目的差异：所有实例都保持默认启用或整体停用。桌面设置页拆出 Web 搜索类别后，按项目列表逐行开关只会放大没人用的粒度。

## 决定

- 全实例共用一个显式开关，存 core `meta` 表（键 `web_search`，值 `{version, state}`，缺省启用、版本从 1 起）：`Store.getWebSearch` / `Store.setWebSearch`（期望版本冲突抛 `version_conflict`；同值幂等不发事件），同事务追加 `web_search.changed` 事件。
- 控制面 op 改为 `set_web_search { enabled, expected_version? }`（[桌面设置拆出](../feature/2026-10-25-desktop-computer-websearch-settings.md)的 Web 搜索页、配置中心根菜单分区与顶层 `ruukoto web-search <on|off>` 共用）；`projects.web_search` 列删除并 `SCHEMA_VERSION` 51→52，按既有政策旧数据目录被拒绝。
- 快照（`ConnectSnapshot.webSearch`）与 `web_search.changed` 事件把状态同步到桌面 view 与配置中心；agent 侧任务工具集、SubAgent 预检与工具执行门全部改读全局开关，「停用立即阻止、启用下一任务生效」语义不变。`project.settings_changed` 只剩指令字段，`projects.settings_version` 只保护指令列表。
- 工作流配置摘要的 `webSearch` 输入改为实例开关状态；实例开关变化使运行中工作流来源核实失败（重新钉版），与 MCP 变更同语义。

## 备选方案

- 凭据即开关（删除全部开关机制，配 Key 即可用）：被否，失去不停用搜索的临时关断能力，桌面页只剩凭据管理。
- 保留 `web_search` 列不读不写：被否，违反优先删；删列 + schema bump 是仓库现行惯例（2026-10-24 实例 MCP 同法）。
- 开关挂 runtime 配置文件：被否，桌面/配置中心需要经控制面写并同步事件，meta 表 + 快照字段是既有路径。

## 后果

按项目差异的 Web Search 能力移除；`ruukoto project web-search` 命令改为顶层 `ruukoto web-search`，配置中心入口从项目屏移到根菜单分区。旧数据目录需新目录重建（schema 52）。`web_search.changed` 事件与快照字段的消费方：桌面 `ViewState.webSearch`、配置中心本地副本；旧后台缺省视为启用。测试：`75-workspace-settings`（store 开关幂等/冲突/事件）、`23-web-search`（全局停用三段语义）、`33-config-tui`（根菜单分区）、`desktop-settings-*` 系列；真实桌面/TUI 交互与真实 Tavily 属外部验收。
