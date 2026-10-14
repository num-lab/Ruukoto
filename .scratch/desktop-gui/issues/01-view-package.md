# 抽出共用事件投影包 packages/view

Status: plan-review

## 目标与边界

实现[规格 R4](../spec.md)：新建 `@ruukoto/view`，承载控制面客户端共用的快照与事件投影，TUI 与桌面端都依赖它。本单只抽桌面端第一阶段需要的部分：`ViewState` 的快照安装、事件应用、历史与任务详情安装，以及会话、任务、审批、工作委托的选择器；`EventFlow` 的事件到流条目投影。渲染、命令、输入历史与工作流侧栏留在 TUI。

非目标：不改变 TUI 的可见行为，不改控制面协议。

## 方案

1. 新建 `packages/view`（package.json、exports `./*.ts`、typecheck），在 `scripts/workspace-boundaries.mjs` 的分层表加入 `view: ["core", "control"]`，并把 `tui` 的允许层加上 `view`。ESLint 对 `packages/view` 拒绝 `node:*`。
2. 去除 Node 与 pi-tui 依赖：`randomUUID` 改用 `globalThis.crypto.randomUUID`；`ACTIVE_TASK_STATUSES` 从 `core/types.ts`（运行时引 `node:crypto`）拆到 core 中不依赖 Node 的模块，`types.ts` 改为再导出；`sessionDisplayAttribution` 从 `control/workspace.ts`（引 `node:fs`）移到同类无 Node 依赖的模块；`event-flow.ts` 对 `workflows.ts` 的 `workflowStatus` 依赖拆出纯函数随之移动；`accessModeStyle` 返回 ANSI 的部分留在 TUI。
3. 把 `state.ts`、`event-flow.ts` 的投影部分移入 view，TUI 改为引用新位置；`command-history.ts`（`node:sqlite`）不移。
4. 只允许 view 对其他 workspace 包做值引用的模块列入 ESLint 允许名单，名单里的模块本身不得引 `node:*`。
5. 文档：新增 `docs/modules/view.md`，更新 `docs/architecture.md` 模块地图与依赖方向、`AGENTS.md` 仓库布局，就地同步[同仓 workspaces 分包](../../../.agents/notes/implemented/architecture/2026-10-11-in-repo-workspace-packages.md)的包表与依赖方向。

## 进展与交接

- 当前：方案已经拥有者确认，待独立方案审查；实现未开始。
- 下一步：方案审查者核对抽取清单是否覆盖桌面端 04–07 的需要，以及第 2 步的拆分是否引入新的循环依赖。
- 基点：`develop` @ `4611eff`。可与 02 并行。
- 阻塞：无。

## 验收与证据

工程待验证。`test/13-tui-state.test.ts`、`test/14-tui-app.test.ts`、`test/34-event-flow-view.test.ts`、`test/36-event-flow-state.test.ts`、`test/19-tui-demo.test.ts` 全部通过且断言不放宽；新增 view 单测覆盖 seq 去重、补发、正文按偏移拼接与工具意图／结果配对；新增 lint 负例证明 view 引 `node:*` 被拒绝。跑 `npm run check:static`。产品验收不适用：TUI 可见行为不变。

## Comments

2026-10-15：拥有者完成 grilling 并确认整体方案，本单由规划阶段建立。
