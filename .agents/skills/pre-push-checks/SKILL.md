---
name: pre-push-checks
description: 在 ruukoto 提交或推送前，按改动面选出能证明本次改动的最小检查集；明确要求、诊断 CI 或确实跨全仓时才跑全量 npm run check。改动 packages/、apps/、test/、docs/、.agents/notes/、verification/、deploy/ 或 package.json 后使用。
---

# 按改动面选检查

本仓库没有默认的本地全量基线。**每处行为改动都要有最窄的、会因该回归而失败的检查**；只有改动真正触及的面才扩大范围。CI 拥有穷尽覆盖与平台矩阵。

全量 `npm run check` 约 200 秒（应用测试 macOS 167 秒、Linux 495 秒），只在三种情况跑：拥有者明确要求、正在诊断 CI 失败、或改动确实横跨全仓以致没有更窄的可信集合。

已通过的检查不因为「接下来要提交」而重跑。证据只对被检内容有效；相关内容改变后复核受影响部分。作者自检与[独立验收](../development-workflow/SKILL.md#4-独立审查与返工)各有责任，前者不能替代后者。

## 1. 先看改动面

```sh
git status --short --branch
npm run change-scope -- --base <已核实的基点引用>
```

基点要自己核实后用参数传入；`change-scope` 不猜测也不抓取基点。输出是带版本号的 JSON，`paths.committed` 是相对 merge base 的已提交路径，`staged`／`unstaged`／`untracked` 描述当前工作区。合并了变动的基点之后重跑一次，重新判断合并后的范围能影响什么。

## 2. 按面选证据

| 改动面 | 跑到哪一级 |
|---|---|
| `packages/` 或 `apps/` 某模块的行为 | 该区的定向用例，文件名从 [开发说明的映射表](../../../docs/development.md#日常反馈) 查；跨模块契约变化时加调用方的用例 |
| `packages/core/src/` 的 schema、存储、会话身份 | `npx tsx --test test/01-concurrency.test.ts test/03-lifecycle.test.ts test/04-crash-recovery.test.ts test/05-overflow-db.test.ts`，另加直接断言该表或该状态机的用例 |
| `packages/agent/src/` 的工具、审批、权限 | `npx tsx --test test/07-real-tools.test.ts test/08-approvals.test.ts test/10-access-modes.test.ts test/63-approval-gate.test.ts test/64-tool-op-ledger.test.ts` |
| 浏览器管理器、宿主工具与截图 | `npx tsx --test test/browser-lifecycle.test.ts test/browser-tools.test.ts test/62-tool-availability.test.ts test/111-workflow-capabilities.test.ts`；权限、Runtime、实例锁及 CLI 导出再按对应行选回归；真实环境探针与真实模型分别记证据；显式入口为 `RUN_MODEL_CHECK=1 RUN_BROWSER_MODELS_FILE=/path/models.json npx tsx --test test/browser-model-acceptance.test.ts`，另需浏览器路径 |
| `packages/agent/src/script-worker/` 与脚本打包 | `npm run build:script` 后跑 `npx tsx --test test/104-workflow-script.test.ts test/100-worker-stop.test.ts`；依赖或整体构建变化另跑 `npm run build` |
| 工作流状态、协调器、输出校验与宿主操作 | `npx tsx --test test/105-workflow-runtime.test.ts test/106-workflow-host.test.ts test/107-workflow-runtime-wiring.test.ts test/108-workflow-import.test.ts test/109-workflow-cold-recovery.test.ts test/110-workflow-workcopy.test.ts test/111-workflow-capabilities.test.ts test/112-workflow-real-steps.test.ts test/113-workflow-source-capabilities.test.ts test/workflow-role-integration.test.ts`；触及普通任务、委派或导入再加对应回归 |
| 工作流定义、模型与 CLI/TUI/IM 入口 | `npx tsx --test test/117-workflow-library.test.ts test/118-workflow-entries.test.ts test/119-workflow-im-controls.test.ts test/120-workflow-cli.test.ts test/29-cli-entry.test.ts test/62-tool-availability.test.ts test/65-slash-commands.test.ts test/66-control-seam.test.ts test/workflow-interface-version.test.ts`；界面另跑 13/14/15/33，触及回答或 IM 再加下行回归 |
| 工作流侧栏、键盘与客户端未决提交 | `npx tsx --test test/13-tui-state.test.ts test/14-tui-app.test.ts test/15-tui-pty.test.ts test/126-workflow-sidebar.test.ts test/12-reconnect-pending.test.ts test/65-slash-commands.test.ts test/66-control-seam.test.ts`；展示字段与协议另加 108/118/120，拥有者体验另验 |
| 工作流业务回答、最终送达与调度归属 | `npx tsx --test test/114-workflow-owner-input.test.ts test/115-workflow-final-delivery.test.ts test/116-workflow-notification-recovery.test.ts`；再加 `test/66-control-seam.test.ts`、`test/77-im-approvals.test.ts`、`test/84-im-final-delivery.test.ts`、`test/88-parent-delivery.test.ts`、`test/89-im-entries.test.ts`、`test/93-im-approval-lifecycle.test.ts`、`test/37-scheduler-outbox.test.ts`、`test/51-generic-scheduler.test.ts` |
| 主 Agent 等待、目录让出与报告认领 | `npx tsx --test test/125-agent-wait.test.ts test/125-agent-wait-core.test.ts test/125-agent-wait-resource.test.ts test/125-agent-wait-report.test.ts test/125-agent-wait-recovery.test.ts test/125-agent-wait-attention-report.test.ts`；再加 `test/88-parent-delivery.test.ts`、`test/115-workflow-final-delivery.test.ts`、`test/116-workflow-notification-recovery.test.ts`，原生停止需两平台，真实模型与 IM 另作外部验收 |
| 工作流双产品组合 | `npx tsx --test test/121-workflow-personal-acceptance.test.ts test/122-workflow-code-acceptance.test.ts`；真实模型另用 `RUN_MODEL_CHECK=1 RUN_WORKFLOW_MODELS_FILE=/path/models.json npx tsx --test test/123-workflow-model-acceptance.test.ts`，缺前提不记通过 |
| `packages/agent/src/` 的上下文、模型、压缩 | `npx tsx --test test/18-model-selection.test.ts test/60-context-prefix.test.ts test/61-context-compaction.test.ts` |
| `packages/runtime/src/`、`packages/control/src/` 的任务生命周期 | `npx tsx --test test/01-concurrency.test.ts test/66-control-seam.test.ts test/94-task-ending.test.ts` |
| `packages/tui/src/cli.ts` 的管理命令与产物导出 | `npx tsx --test test/29-cli-entry.test.ts`；触及产品入口再加 `test/71-product-entry.test.ts` |
| `packages/tui/src/tui/`、`packages/tui/src/config-tui/` | `npx tsx --test test/13-tui-state.test.ts test/14-tui-app.test.ts test/33-config-tui.test.ts`；改终端交互再加 `test/15-tui-pty.test.ts` |
| `apps/desktop/` | `npx tsx --test test/38-desktop-main.test.ts test/38-desktop-personal.test.ts test/38-desktop-build.test.ts test/39-desktop-recovery-guide.test.ts test/40-desktop-creation.test.ts test/41-desktop-stream.test.ts test/42-desktop-inspector.test.ts`，`npm run desktop:build` 与签名检查；真实 Electron、CSP/HMR、明暗和进程生命周期另记外部验收；共用控制面加 12/66/72，开发入口加 32/71 |
| `packages/view/src/` | `npx tsx --test test/36-event-flow-state.test.ts test/37-view-browser.test.ts`；TUI 抽取回归加 13/14/34/19，命令恢复加 `test/37-command-history.test.ts`，重载分类加 `test/32-dev.test.ts` |
| `packages/channels/src/qq/`、`packages/channels/src/telegram/`、`packages/channels/src/scheduler/` | `npx tsx --test test/26-qq.test.ts test/37-scheduler-outbox.test.ts test/38-telegram-owner.test.ts test/89-im-entries.test.ts` |
| 子代理角色定义与快照 | `npx tsx --test test/subagent-role-library.test.ts test/subagent-definition-core.test.ts test/subagent-role-runtime.test.ts test/subagent-role-driver.test.ts`；再加 80/83/62、GitHub 45/46、实际导入与 core 生命周期回归 |
| SubAgent、worktree、旧实例导入 | `test/80`–`test/95` 里对应的那篇，加 `npx tsx --test test/91-release-acceptance.test.ts` |
| `test/` 的夹具或助手 | 用该助手的用例。**只断言落盘布局的用例（直读 SQLite／裸 SQL）是本仓库的刻意做法**，不要以「只测行为」为由改写 |
| `.agents/notes/` 的笔记 | `npm run verify-notes`；改了笔记的被引路径再加 `npx tsx .agents/skills/maintain-notes/scripts/check-note-anchors.ts` |
| `docs/` 的文档 | `npm run check:docs`；内容与代码是否一致门禁查不出，按 [写作 skill](../../../.agents/skills/writing-docs-for-human/SKILL.md) 的触发条件逐篇核对 |
| `AGENTS.md`、skills、`docs/agents/` | 落点检查：被链接的目标存在，被引用的命令与 `package.json` 一致 |
| `scripts/` 的门禁或生成器 | 该脚本自身，加一个故意失败的负例证明它会红 |
| `scripts/test-app.mjs` 的分批与退出 | `npx tsx --test test/124-test-app-runner.test.ts`；macOS 独占 100/101-helper 后才执行其余文件，保持完整分配与失败透传 |
| `verification/foundation/` | `npm run test:foundation` |
| `verification/smoke/` | 该 smoke 入口；需要 Docker、凭据或真实平台时先确认前提，缺前提报告「不可用」，不记为通过 |
| `deploy/` | 相关 README 的步骤能否仍被执行；改 systemd 单元时加 `npm run build`、替换实际账户与 Node 路径后的模板核实，并按实际账户演练原生前置与 scope 停止 |
| `package.json` 的 scripts、依赖、构建入口 | `npm run build`，加 `npm run lint` 与 `npm run typecheck` |

`.scratch/` 的工单与证据不改行为，不需要跑检查；其中的验证记录要区分模拟结果与真实环境结果。

## 3. 静态门禁的位置

`npm run check:static`（lint + typecheck + verify-notes + check:docs，约 8 秒）已由 pre-commit 钩子执行。提交前不必手工再跑一遍。

## 4. 报告

只报实际跑过的命令与结果。不要用「看起来没问题」代替证据；缺前提时明确写缺什么。
