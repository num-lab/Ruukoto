# 桌面设置页拆出「电脑」与「Web 搜索」独立设置项

Status: in-progress

## 目标与边界

- 新增设置类别「电脑」（托管类别，Code/PA 页签）：CUA 配置与人工恢复从双端 MCP 页完全迁出；MCP 页只留 HTTP 服务。数据仍是 MCP 服务存储，只改 UI 归属。
- 新增设置类别「Web 搜索」（普通类别，仅 Code）：管理 Tavily 凭据（专用受限 op）与按项目启停 `web_search`（`set_project_web_search` + 本地快照项目列表）。
- 非目标：PA 的 web search（维持远端 CLI 配置，不改远端协议）；通用凭据写 op（`add_credential`/`remove_credential`）仍不向桌面开放。
- 拥者确认：2026-10-25 会话中选择「凭据 + 项目开关」「双目标完全迁出」「仅 Code」。

## 方案

见 2026-10-25 会话批准的计划（后端 op → 设置壳 → Code/PA 电脑页 → Web 搜索页 → 测试 → 文档）。理由与边界决定落决策笔记 `.agents/notes/implemented/feature/2026-10-25-desktop-computer-websearch-settings.md`。

## 进展与交接

- 当前角色与阶段：实施者，已完成全部编码与验证（2026-10-25）。
- 下一角色与动作：独立实现审查，然后拥有者外部验收（真实桌面交互、真实 Tavily 连接）。
- 当前内容：分支 develop，基点 8f18fc71，全部改动未提交（见 git status：desktop 渲染层与主进程白名单、runtime/control 新 op、agent 常量导出、测试与文档）。
- 阻塞与恢复条件：无。

## 验收与证据

- `npm run check:static`（lint、typecheck 全工作区、verify-notes、check:docs、md-wrap、doc budgets）通过。
- desktop 设置系列 7 个测试文件 90 用例通过（含新增 `desktop-settings-computer.test.ts` 8 例、`desktop-settings-web-search.test.ts` 7 例）；`test/66-control-seam.test.ts` 25 例、`test/23-web-search.test.ts` 与 `test/33-config-tui.test.ts` 34 例通过。
- 后端新增行为由 `desktop-settings-mcp-backend.test.ts`「Web 搜索凭据专用 op 只写固定 Tavily 绑定，项目开关按版本生效」覆盖（真实 Runtime + control server）。
- 未执行（外部验收）：真实 Electron/MyGo 界面交互、真实 Tavily API 连接、真实 Cua Driver 恢复流程。

## Comments

- 2026-10-25：拥有者批准方案，工单建立。
- 2026-10-25：实施完成。实施中修正：`node:assert/strict` 的谓词会把 getter 路径收窄成 null，测试改用局部变量断言；Web 搜索写入成功提示须在读回之后赋值。
