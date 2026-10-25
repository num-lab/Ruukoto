# Web Search 改为实例级全局开关

Status: in-progress

## 目标与边界

- 删除按项目配置 web search 的机制（projects.web_search 列、set_project_web_search、事件字段、项目级 UI），全实例共用一个显式全局开关，保留「停用立即阻止、启用下一任务生效」语义。
- 开关存 core meta kv（`web_search` = `{version, state}`），乐观并发 + `web_search.changed` 事件，快照同步桌面/TUI。
- 删列并 `SCHEMA_VERSION` 51→52（旧数据目录按既有政策被拒绝）。
- 拥有者确认：显式全局开关；删列 + bump 版本。2026-10-25 会话批准计划。

## 方案

见 2026-10-25 会话批准的计划（core → runtime/control → agent → view → TUI/CLI → desktop → 测试 → 文档）。决定与备选（凭据即开关、保留死列被否）落 `.agents/notes/implemented/simplification/2026-10-25-web-search-global-toggle.md`。

## 进展与交接

- 当前角色与阶段：实施者，已完成编码、测试与文档（2026-10-25）。
- 下一角色与动作：独立实现审查；真实桌面/TUI/Tavily 属外部验收。
- 当前内容：分支 develop，改动未提交（core/runtime/control/agent/view/tui/desktop、测试与文档）。
- 阻塞与恢复条件：无。

## 验收与证据

- `npm run check:static` 通过（lint、typecheck 全工作区、verify-notes、check:docs、md-wrap、doc budgets）。
- 定向测试通过：23/13/30/33/44/62/66/74/75/76 共约 200 例（含新增 store 全局开关幂等/冲突/事件用例、配置中心根菜单分区用例、全局停用三段语义改写）；desktop 系列 260 例通过。
- 实施中修正：control 服务端逐字段重建快照，需显式透传 `webSearch`；配置中心输入框预填后光标在开头，测试按键按前插语义编写。
- 未执行（外部验收）：真实 Electron/MyGo 界面交互、真实 Tavily 连接、旧数据目录迁移体验（schema 52 拒绝旧库）。

## Comments

- 2026-10-25：拥有者批准方案，工单建立。
- 2026-10-25：实施完成。
