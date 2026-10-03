Status: ready-for-agent

# 01 — 从 v5 及更早的库升级时，重建 sessions 丢掉 workspace_project_id 列

**What to fix:** 打开 schema ≤ v5 的旧核心库时，`rebuildModeCheckedTables` 重建出的 `sessions` 表缺少 `workspace_project_id` 列。在那一次启动里，读写这一列的代码都会失败。

## 现状与证据

- `src/core/db.ts` 的打开流程在同一事务里依次执行：`SCHEMA_SQL` → `migrateFrom(version)` → `ensureColumns()` → `rebuildModeCheckedTables()`（仅当 `version < 6`）。
  - `ensureColumns()` 先给 `sessions` 补上 `workspace_project_id`（v20 → v21 由 agent-direction issue 07 加入）。
  - 随后 `rebuildModeCheckedTables()` 用 `sessions_new` 的列清单重建表，而这份清单没有这一列，于是重建后列丢失。
- 重建用的另外三张临时表（`tasks_new`、`schedules_new`、`notification_ops_new`）对照建表语句加 `ensureColumns` 的补列，都没有缺列，只有 `sessions_new` 漏了。
- 下一次启动时版本已等于 `SCHEMA_VERSION`，走 `ensureColumns()` 会把列补回来，所以问题只出现在升级的那一次启动：
  - 组织查询会失败；
  - 工作区迁移会失败；
  - 读这一列的 `rowToSession` 会失败。
- 来源：2026-10-03 可视化文档核查（storage-layout.html），核查代理实测过；主代理按代码复核了调用顺序与列清单。

## 验收标准

- [ ] `sessions_new` 与当前 `sessions` 全部列一致（含 `workspace_project_id`），重建时把旧数据该列按原值或 NULL 带过去。
- [ ] 加一条回归测试：构造 schema v5 的库并打开，确认首次打开后 `sessions` 就有 `workspace_project_id`，并且同一次启动内组织查询可用。
- [ ] 防止再犯：重建的临时表从建表语句派生列清单，或者测试逐表比对 `*_new` 与正式表的列集合，以后加列漏改会直接失败。
- [ ] 类型检查与仓库要求的验证通过；`docs/visual/storage-layout.html` 的「schema 版本与迁移」一节如有相关说法同步更新。
