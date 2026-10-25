---
name: pre-push-checks
description: 在 ruukoto 提交或推送前，按改动面选出能证明本次改动的最小检查集；明确要求、诊断 CI 或确实跨全仓时才跑全量 npm run check。改动 packages/、apps/、test/、docs/、.agents/notes/、verification/、deploy/ 或 package.json 后使用。
---

# 按改动面选检查

本仓库没有默认的本地全量基线。**每处行为改动都要有最窄的、会因该回归而失败的检查**；只有改动真正触及的面才扩大范围。CI 拥有穷尽覆盖与平台矩阵。

全量 `npm run check` 的实测见[开发耗时记录](../../../docs/development-baselines.md)，只在三种情况跑：拥有者明确要求、正在诊断 CI 失败、或改动确实横跨全仓以致没有更窄的可信集合。

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
| CI 系统前提、`scripts/setup.mjs`、`scripts/check-environment.mjs` | `npx tsx --test test/98-development-tools.test.ts`，核实缺前提负例；CI 平台命令在对应系统验证，Linux 原生执行另跑 `test/101-native-execution.test.ts`、`test/101-native-linux-scope.test.ts` 及受影响用例；本地证据不代替 GitHub Node24 双平台结果 |
| `packages/` 或 `apps/` 某模块的行为 | 该区的定向用例，文件名从 [开发说明的映射表](../../../docs/development.md#日常反馈) 查；跨模块契约变化时加调用方的用例 |
| PA HTTPS/WSS、配对、来源权限与服务器维护 | `npx tsx --test test/personal-remote.test.ts test/personal-remote-auth.test.ts test/personal-remote-maintenance.test.ts test/personal-desktop-events.test.ts test/desktop-personal-native.test.ts test/desktop-personal-settings.test.ts test/desktop-personal-settings-pages.test.ts test/38-desktop-personal.test.ts`；按影响加 `test/personal-maintenance.test.ts test/personal-settings.test.ts test/personal-cli.test.ts` 与原问题/工具/MCP/应用数据/服务来源用例。真实Serve身份、原始grants、撤销/重启、旧 v1 固定 systemd 停存启及各阶段崩溃另记证据，缺前提不记通过；部署检查保留默认强杀和abort超时负例 |
| Personal `settings` 机器入口、配置协议与托管档案接线 | `npx tsx --test test/personal-settings.test.ts test/personal-settings-operations.test.ts test/personal-cli-settings-updates.test.ts test/personal-settings-blockers.test.ts test/personal-model-updates.test.ts test/personal-mcp-updates.test.ts test/personal-mcp-publication.test.ts test/personal-search-updates.test.ts test/personal-managed-skills.test.ts test/personal-durable.test.ts test/personal-configuration-controls.test.ts test/personal-cli.test.ts test/personal-skills.test.ts test/personal-mcp-config.test.ts test/personal-mcp.test.ts test/personal-mcp-recovery.test.ts`；`ruukoto settings` 的 stdin/stdout 版本、未知 op、档案锁冲突和错误 revision 由独立审查者执行负例；CLI/入口变动再按入口制品行检查，真实服务环境另记缺口；配置在线模型外验用显式开关运行 `verification/smoke/smoke-personal-configuration.mts` |
| `apps/ruukoto/src/personal-*.ts`（正式 `ruukoto`；`personal:durable` 为兼容入口） | `npx tsx --test test/personal-durable.test.ts test/personal-questions.test.ts test/personal-app-data.test.ts test/personal-memory.test.ts test/personal-memory-controls.test.ts test/personal-skills.test.ts test/personal-history.test.ts test/personal-command-config.test.ts test/personal-command-work.test.ts test/personal-tools.test.ts test/personal-tools-config.test.ts test/personal-tools-controls.test.ts test/personal-tool-io.test.ts test/personal-tool-fifo.test.ts test/personal-artifacts.test.ts test/personal-media.test.ts test/personal-browser.test.ts test/personal-browser-integration.test.ts test/personal-mcp-config.test.ts test/personal-mcp.test.ts test/personal-mcp-recovery.test.ts test/personal-mcp-controls.test.ts test/personal-cli.test.ts test/personal-configuration-controls.test.ts test/personal-services.test.ts test/personal-work.test.ts test/personal-work-tools.test.ts test/personal-work-controls.test.ts test/personal-work-notes.test.ts test/personal-delegations.test.ts test/personal-reports.test.ts test/personal-scheduler.test.ts test/personal-scheduler-authority.test.ts test/personal-scheduler-integration.test.ts test/personal-scheduler-browser.test.ts test/personal-scheduler-controls.test.ts test/personal-scheduler-entries.test.ts test/personal-service-operations.test.ts test/personal-telegram.test.ts test/personal-telegram-permissions.test.ts test/personal-qq.test.ts`；真实模型用 `verification/smoke/smoke-personal-durable.mts`，须显式开关与模型配置（见[操作手册](../../../docs/usage.md#25-个人-agent-引导与管理)）；Pi 依赖变动另跑构建和 `test/71-product-entry.test.ts`、`test/122-workflow-code-acceptance.test.ts`，正式入口制品与最终组合验收分开记录，生产接管另验 |
| 个人会话后台、共享目录认领 | `npm run build:worker` 后跑 `npx tsx --test test/personal-background-processes.test.ts test/personal-command-work.test.ts test/personal-tools.test.ts test/personal-durable.test.ts test/personal-scheduler-integration.test.ts`；Linux在隔离目录另跑 `npx tsx --test --test-name-pattern=真实Linux test/personal-background-processes.test.ts`，模型和原IM另验；旧业务格式精确拒绝 |
| 个人 bin/main/dev、根 start 与 app 制品 | 构建后跑 `npx tsx --test test/personal-entry.test.ts test/71-product-entry.test.ts test/32-dev.test.ts test/99-workspace-boundaries.test.ts test/personal-cli.test.ts`；另在隔离新档案和实际解包 workspace 核实菜单/serve、旧档案/双进程拒绝、开发无 IM 及退出/重载停止、worker 与双 Pi 解析，不能据此解除最终验收或生产阻断 |
| `packages/core/src/` 的 schema、存储、会话身份 | `npx tsx --test test/01-concurrency.test.ts test/03-lifecycle.test.ts test/04-crash-recovery.test.ts test/05-overflow-db.test.ts`，另加直接断言该表或该状态机的用例 |
| `packages/agent/src/` 的工具、审批、权限 | `npx tsx --test test/07-real-tools.test.ts test/08-approvals.test.ts test/10-access-modes.test.ts test/63-approval-gate.test.ts test/64-tool-op-ledger.test.ts` |
| Coding 工具发现、正文与预览 | `npx tsx --test test/search-tools.test.ts test/web-fetch.test.ts test/present-tools.test.ts test/background-wait.test.ts test/desktop-inspector-tools.test.ts`；按影响加24/25-MCP、58/62/64、125等待链；依赖、worker与桌面构建沿对应行，真实模型和客户端另验 |
| Code 实例 MCP 存储、协议、CLI/TUI 与桌面 | `npx tsx --test test/24-mcp.test.ts test/25-mcp-write.test.ts test/29-cli-entry.test.ts test/33-config-tui.test.ts test/desktop-settings-mcp.test.ts test/desktop-settings-mcp-backend.test.ts test/113-workflow-source-capabilities.test.ts test/subagent-source-capabilities.test.ts`；schema 按 core 行加旧库原样拒绝，导入加 76/85；旧 MCP `--project` 及 wire 归属参数须在写入和联网前拒绝，Cua、容器与构建按对应行 |
| Cua 管理与部署入口 | `npx tsx --test test/cua-configuration.test.ts test/desktop-settings-mcp.test.ts test/desktop-settings-mcp-backend.test.ts test/personal-settings.test.ts test/desktop-personal-settings-pages.test.ts`，按改动加配置 TUI、CLI、Personal controls 与暂停恢复回归；`ruukoto-code mcp cua` 复用配置向导，原生权限预检须构建及平台身份用例，真实捕获和人工恢复另验 |
| Cua stdio、双端持续连接与恢复 | `npx tsx --test test/cua-mcp.test.ts test/cua-code.test.ts test/personal-cua.test.ts test/mcp-transport.test.ts`，再按实际改动加24/25-mcp、Personal MCP配置/恢复/控制及工作/报告消费者；stdio夹具在Node24.15执行，Mac停止适配需`npm run build:native`及原生身份回归，Linux适配在`ssh tx`隔离目录用夹具核实。真实模型与双产品正式入口另记外部验收 |
| 个人文件检索、独立只读 worker | `npm run build:worker` 后跑 `npx tsx --test test/personal-file-search.test.ts test/personal-tools.test.ts test/personal-tools-controls.test.ts test/personal-tool-io.test.ts`；定时工具快照加实际影响的 scheduler 用例，macOS/Linux 分别核实原生范围与停止，真实模型单记证据 |
| Coding 文件检索、rg 执行前提 | `npm run build:worker` 后跑 `npx tsx --test test/file-search.test.ts test/07-real-tools.test.ts test/62-tool-availability.test.ts test/64-tool-op-ledger.test.ts test/98-development-tools.test.ts test/101-native-execution.test.ts`；原生边界在 macOS/Linux 分别验，宿主须已有 rg，真实模型闭环另记 |
| Coding 持久提问、答案入队与两个客户端 | `npx tsx --test test/owner-questions.test.ts test/owner-question-tools.test.ts test/owner-question-clients.test.ts test/owner-question-import.test.ts test/12-reconnect-pending.test.ts test/66-control-seam.test.ts test/114-workflow-owner-input.test.ts`；TUI/Desktop按影响加13/14/15、41和composer。真实模型用 `RUN_MODEL_CHECK=1 RUN_OWNER_QUESTION_MODELS_FILE=/path/models.json npx tsx --test test/owner-question-model-acceptance.test.ts`，另验真实客户端；旧档案不自动迁移 |
| Coding Scheduled 的存储、来源、协调器与桌面 | `npx tsx --test test/code-scheduler-core.test.ts test/code-scheduler.test.ts test/code-scheduled-sources.test.ts test/desktop-scheduled.test.ts`；按面加问答、后台、工作流、产品与协议回归，Linux 用新临时档案核实 queued 重启恢复和取消真实后台。真实模型用 `RUN_MODEL_CHECK=1 RUN_CODE_SCHEDULER_MODELS_FILE=/absolute/models.json npx tsx --test test/code-scheduler-model-acceptance.test.ts`，只复制显式文件并清除临时凭据；桌面双壳体验另验 |
| Coding 会话后台、独立占用与恢复 | `npm run build:native`、`npm run build:worker` 后跑 `npx tsx --test --test-concurrency=1 test/background-processes-core.test.ts test/background-processes.test.ts test/background-processes-recovery.test.ts test/background-process-clients.test.ts test/native-macos-identity.test.ts test/100-worker-stop.test.ts test/101-native-macos-helper.test.ts`；Linux另跑 `test/native-linux-identity.test.ts`、`test/101-native-linux-scope.test.ts` 并真实 `ssh tx` 验证。占用/工具/控制面加01/03/04/05、62/64/66/125-resource，入口/制品加71；真实browser用 `RUN_BACKGROUND_BROWSER_CHECK=1 RUUKOTO_BROWSER_BINARY=/path/native RUUKOTO_BROWSER_CHROME=/path/chrome npx tsx --test test/background-browser-acceptance.test.ts`，真实模型用 `RUN_MODEL_CHECK=1 RUN_BACKGROUND_MODELS_FILE=/path/models.json RUN_BACKGROUND_MODEL=provider/model RUUKOTO_BROWSER_BINARY=/path/native RUUKOTO_BROWSER_CHROME=/path/chrome npx tsx --test test/background-model-acceptance.test.ts`，客户端另验；旧档案不自动迁移 |
| 浏览器管理器、宿主工具与截图 | `npx tsx --test test/browser-lifecycle.test.ts test/browser-tools.test.ts test/62-tool-availability.test.ts test/111-workflow-capabilities.test.ts`；权限、Runtime、实例锁及 CLI 导出再按对应行选回归；真实环境探针与真实模型分别记证据；显式入口为 `RUN_MODEL_CHECK=1 RUN_BROWSER_MODELS_FILE=/path/models.json npx tsx --test test/browser-model-acceptance.test.ts`，另需浏览器路径 |
| `packages/agent/src/script-worker/` 与脚本打包 | `npm run build:script` 后跑 `npx tsx --test test/104-workflow-script.test.ts test/100-worker-stop.test.ts`；依赖或整体构建变化另跑 `npm run build` |
| `personal-command-worker.ts`、原生 `dependencyRoots` 或 `build:worker` | `npm run build:worker` 后跑 `npx tsx --test test/personal-command-worker.test.ts test/101-native-execution.test.ts test/101-native-linux-scope.test.ts test/native-linux-identity.test.ts test/71-product-entry.test.ts`；新个人入口真实 Linux 验证独立空依赖、快速退出与原 scope 停止，不能将 worker 退出当作效果回执或停止证明；构建命令变化另跑 `npm run build` |
| 工作流状态、协调器、输出校验与宿主操作 | `npx tsx --test test/105-workflow-runtime.test.ts test/106-workflow-host.test.ts test/107-workflow-runtime-wiring.test.ts test/108-workflow-import.test.ts test/109-workflow-cold-recovery.test.ts test/110-workflow-workcopy.test.ts test/111-workflow-capabilities.test.ts test/112-workflow-real-steps.test.ts test/113-workflow-source-capabilities.test.ts test/workflow-role-integration.test.ts`；触及普通任务、委派或导入再加对应回归 |
| Coding 工作流定义、模型与 CLI/TUI 入口 | `npx tsx --test test/117-workflow-library.test.ts test/118-workflow-entries.test.ts test/120-workflow-cli.test.ts test/29-cli-entry.test.ts test/62-tool-availability.test.ts test/65-slash-commands.test.ts test/66-control-seam.test.ts test/workflow-interface-version.test.ts`；界面另跑 13/14/15/33，触及回答或 IM 再加下行回归 |
| 工作流侧栏、键盘与客户端未决提交 | `npx tsx --test test/13-tui-state.test.ts test/14-tui-app.test.ts test/15-tui-pty.test.ts test/126-workflow-sidebar.test.ts test/12-reconnect-pending.test.ts test/65-slash-commands.test.ts test/66-control-seam.test.ts`；展示字段与协议另加 108/118/120，拥有者体验另验 |
| 工作流业务回答、最终送达与调度归属 | `npx tsx --test test/114-workflow-owner-input.test.ts test/115-workflow-final-delivery.test.ts`；再加 `test/66-control-seam.test.ts`、`test/77-im-approvals.test.ts`、`test/84-im-final-delivery.test.ts`、`test/88-parent-delivery.test.ts`、`test/89-im-entries.test.ts`、`test/93-im-approval-lifecycle.test.ts`、`test/37-scheduler-outbox.test.ts` |
| 主 Agent 等待、目录让出与报告认领 | `npx tsx --test test/125-agent-wait.test.ts test/125-agent-wait-core.test.ts test/125-agent-wait-resource.test.ts test/125-agent-wait-report.test.ts test/125-agent-wait-recovery.test.ts test/125-agent-wait-attention-report.test.ts`；再加 `test/88-parent-delivery.test.ts`、`test/115-workflow-final-delivery.test.ts`，原生停止需两平台，真实模型与 IM 另作外部验收 |
| Coding 四输入工作流组合 | `npx tsx --test test/122-workflow-code-acceptance.test.ts`；真实模型另用 `RUN_MODEL_CHECK=1 RUN_WORKFLOW_MODELS_FILE=/path/models.json npx tsx --test test/123-workflow-model-acceptance.test.ts`，缺前提不记通过 |
| `packages/agent/src/` 的上下文、模型、压缩 | `npx tsx --test test/18-model-selection.test.ts test/60-context-prefix.test.ts test/61-context-compaction.test.ts` |
| `packages/runtime/src/`、`packages/control/src/` 的任务生命周期 | `npx tsx --test test/01-concurrency.test.ts test/66-control-seam.test.ts test/94-task-ending.test.ts` |
| `packages/tui/src/cli.ts` 的管理命令与产物导出 | `npx tsx --test test/29-cli-entry.test.ts`；触及产品入口再加 `test/71-product-entry.test.ts` |
| `packages/tui/src/tui/`、`packages/tui/src/config-tui/` | `npx tsx --test test/13-tui-state.test.ts test/14-tui-app.test.ts test/33-config-tui.test.ts`；改终端交互再加 `test/15-tui-pty.test.ts` |
| 桌面设置模型、Skills、MCP 与共用容器 | `npx tsx --test test/desktop-settings.test.ts test/desktop-settings-models.test.ts test/desktop-models-layout.test.ts test/desktop-settings-mcp.test.ts test/desktop-settings-mcp-backend.test.ts test/desktop-settings-skills.test.ts`；Personal 页面加 `test/desktop-personal-settings-pages.test.ts`，协议与维护按PA HTTPS/WSS行；双壳构建、签名和真实环境证据按桌面行 |
| 双壳安全存储、私有凭据桥、启动或单实例 | `npx tsx --test test/desktop-personal-credential-storage.test.ts test/desktop-mygo-credentials.test.ts test/desktop-startup-security.test.ts test/38-desktop-main.test.ts test/38-desktop-build.test.ts test/desktop-mygo.test.ts`及MyGo `cd apps/desktop/mygo && go test -race ./...`；两壳正式构建和签名检查后，真Keychain重开/锁定/拒绝/损坏/更新授权、另一签名读取、注入/调试/资源替换负例另记OS证据。macOS需Clang，MyGo构建显式CGO；开发namespace不得读取正式凭据，Code后台与终端沿实际影响回归 |
| `apps/desktop/` | `npx tsx --test test/desktop-terminal.test.ts test/38-desktop-main.test.ts test/38-desktop-personal.test.ts test/38-desktop-build.test.ts test/39-desktop-recovery-guide.test.ts test/40-desktop-creation.test.ts test/41-desktop-stream.test.ts test/42-desktop-inspector.test.ts test/43-desktop-demo.test.ts test/desktop-attachments.test.ts test/desktop-agent-display.test.ts test/desktop-context.test.ts test/desktop-composer.test.ts test/desktop-inspector-tools.test.ts test/desktop-tool-activity.test.ts test/desktop-workspace-files.test.ts test/desktop-browser-security.test.ts test/desktop-mygo.test.ts`，MyGo 另跑 `cd apps/desktop/mygo && go test -race ./...`、`npm run desktop:mygo:build`；`npm run desktop:build` 与签名检查；真实 Electron、CSP/HMR、明暗和进程生命周期另记外部验收；共用控制面加 12/66/72，开发入口加 32/71 |
| `packages/view/src/` | `npx tsx --test test/36-event-flow-state.test.ts test/37-view-browser.test.ts`；PA纯wire类型加`test/personal-desktop-events.test.ts test/desktop-personal-native.test.ts`；TUI抽取回归加13/14/34/19，命令恢复加`test/37-command-history.test.ts`，重载分类加`test/32-dev.test.ts` |
| `packages/channels/src/qq/`、`packages/channels/src/telegram/`、`packages/channels/src/scheduler/` | `npx tsx --test test/26-qq.test.ts test/37-scheduler-outbox.test.ts test/38-telegram-owner.test.ts test/89-im-entries.test.ts` |
| 子代理角色定义与快照 | `npx tsx --test test/subagent-role-library.test.ts test/subagent-definition-core.test.ts test/subagent-role-runtime.test.ts test/subagent-role-driver.test.ts`；再加 80/83/62、GitHub 45/46、实际导入与 core 生命周期回归 |
| SubAgent、worktree、Coding 旧实例导入 | `test/80`–`test/95` 里对应的那篇，加 `npx tsx --test test/91-release-acceptance.test.ts` |
| `test/` 的夹具或助手 | 用该助手的用例。**只断言落盘布局的用例（直读 SQLite／裸 SQL）是本仓库的刻意做法**，不要以「只测行为」为由改写 |
| `apps/ruukoto/src/service-helper.ts` | `npx tsx --test test/service-helper-transport.test.ts test/personal-services.test.ts test/personal-service-operations.test.ts test/78-linux-service-management.test.ts test/79-standing-permissions.test.ts`；78 仅覆盖 helper，79 保留存储规则；传输进程检查在 macOS/Linux 分别执行，调用关闭不替代 helper 操作单元停止证明 |
| `.agents/notes/` 的笔记 | `npm run verify-notes`；改了笔记的被引路径再加 `npx tsx .agents/skills/maintain-notes/scripts/check-note-anchors.ts` |
| `docs/` 的文档 | `npm run check:docs`；内容与代码是否一致门禁查不出，按 [写作 skill](../../../.agents/skills/writing-docs-for-human/SKILL.md) 的触发条件逐篇核对 |
| `AGENTS.md`、skills、`docs/agents/` | 落点检查：被链接的目标存在，被引用的命令与 `package.json` 一致 |
| `scripts/` 的门禁或生成器 | 该脚本自身，加一个故意失败的负例证明它会红 |
| `scripts/test-app.mjs` 的分批与退出 | `npx tsx --test test/124-test-app-runner.test.ts`；macOS 独占批次结束后才执行其余文件，非独占批次最多两文件并行，保持完整分配与失败透传 |
| `verification/foundation/` | `npm run test:foundation` |
| `verification/smoke/` | 该 smoke 入口；需要 Docker、凭据或真实平台时先确认前提，缺前提报告「不可用」，不记为通过 |
| `deploy/` | 相关 README 的步骤能否仍被执行；服务 helper 加 `test/service-helper-stop.test.ts`（Linux 真实进程与系统命令桩）和 78 helper／79 旧存储规则回归；改 systemd 单元时加 `npm run build`、替换实际账户与 Node 路径后的模板核实，并按实际账户演练原生前置与 scope 停止 |
| `package.json` 的 scripts、依赖、构建入口 | `npm run build`，加 `npm run lint` 与 `npm run typecheck` |

`.scratch/` 的工单与证据不改行为，不需要跑检查；其中的验证记录要区分模拟结果与真实环境结果。可执行的 [desktop shadcn demo](../../../.scratch/desktop-shadcn/demo/README.md) 例外：运行 `npm --prefix .scratch/desktop-shadcn/demo run check`，并检查明暗、窗口尺寸与受影响交互；不将模拟结果记为真实 Electron 验收。

## 3. 静态门禁的位置

`npm run check:static`（lint + typecheck + verify-notes + check:docs）已由 pre-commit 钩子执行，耗时见[开发记录](../../../docs/development-baselines.md)。提交前不必手工再跑一遍。

## 4. 报告

只报实际跑过的命令与结果。不要用「看起来没问题」代替证据；缺前提时明确写缺什么。
