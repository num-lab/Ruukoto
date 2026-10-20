# PR #29 合入 develop 并解决冲突

Status: resolved

## 目标与边界

拥有者于 2026-10-20 要求处理 PR #29 的冲突，包含完成合并提交并更新该 PR 分支。源分支 `codex/desktop-demo-ui` 为 `b1241e85`，目标 `develop` 为 `b776d8c9`。保留双方已实现的功能、保护检查与失败处理；不新增产品功能，不合并 PR 或部署日常实例。目录保护代码与双方产品入口同时参与合并，按开发流程执行独立审查。

## 方案

将 develop 合入 PR 分支，不改写历史。`approved-ops.ts` 保留两项独立新增的检查，分别服务桌面目录读取与原生依赖授权；调用方、导出及测试沿用双方。依据为[目录保护检查](../../../.agents/notes/implemented/bug-fix/2026-10-17-directory-protection-cost.md)与[批量原生依赖核对](../../../.agents/notes/implemented/bug-fix/2026-10-18-batch-native-protection-checks.md)。根脚本保留双 worker 构建、当前 native 验收入口与 MyGo 命令，锁文件保留双方依赖。文档同时保留桌面功能与新个人 durable 的入口约束；schema 按实际代码取 46，设计依据取双方并集。

完成 setup 后验证静态门禁、双方构建及合并涉及的调用链。合并横跨全部共享包与两产品，运行完整离线检查；另构建 Electron 并核实签名。独立审查核对冲突解法、自动合并调用链与验证结果。

## 进展与交接

12 个冲突文件已解决；开发说明的桌面测试清单原样移至桌面开发文档，修复合并后篇幅超限。全量检查另发现三项过期夹具／断言：demo 漏附件与存档事件、等待视图仍固定旧协议版本、Lucide 图标名称与别名不符；现按当前事件、协议与锁定依赖同步。无新增产品决定，无待拥有者决定的取舍。下一步由实施者完成正常合并提交并更新 PR，CI 验证远端最终提交。

## 验收与证据

本次冲突解决的工程验收通过，完整并发批次不记为绿色。环境为 macOS arm64、Node 24.15.0、npm 11.12.1。`npm run setup`、最终 `npm run build` 与 `npm run check:static` 通过；`npm run test:foundation` 为 9 通过、1 项真实模型按默认开关跳过；`npm run desktop:build` 与 `codesign --verify --deep --strict dist/mac-arm64/Ruukoto.app` 通过。

首次 `npm run check` 在文档预算门禁停止，代码构建、lint、typecheck 与笔记门禁通过；迁移桌面清单后文档门禁通过。随后 `npm test` 的 macOS 独占批次 44 通过，并行批次 2827 通过、22 失败、3 取消、19 跳过，基础验证未执行；三项确定性失败单独复现后修正，其余以原有限时串行复跑。最终 `RUN_MODEL_CHECK=0 npx tsx --test test/125-agent-wait-view.test.ts test/19-tui-demo.test.ts test/desktop-tool-activity.test.ts` 为 25 通过，未削减断言覆盖。

串行复现命令为 `RUN_MODEL_CHECK=0 npx tsx --test --test-concurrency=1 --test-name-pattern '完全访问来源的验证命令不能写回|冻结成果 snapshot_missing|编码六输入|确定性策略：写操作|审查超时：转人工|重连：快照与 get_task|GitHub webhook：登记去重|GitHub 修订：每个修订|GitHub 通知：换 owner|GitHub 修订：同时间戳|GitHub 通知结果未知|集成：Plan 固定|后台停止覆盖 SDK 中的 integrate|durable 通用工具：主子会话|durable 自动审查：failure|durable 本机入口：真实认证|追加说明：接纳、admission|完全访问父级派发 reviewer|受保护角色的结构化文件工具' test/112-workflow-real-steps.test.ts test/122-workflow-code-acceptance.test.ts test/22-auto-review.test.ts test/45-github-events.test.ts test/58-plan-mode.test.ts test/83-subagent-worktrees.test.ts test/personal-tools.test.ts test/personal-work-notes.test.ts test/subagent-workspace-snapshot.test.ts`，25 通过、0 失败、0 跳过。不修改等待预算或全量测试入口；同样负载下的完整并发通过仍未证实。初次检查、全量失败、确定性失败复现、修正回归、超时复跑与构建的原始日志保存在[证据目录](../evidence/)。

2026-10-20，merge_review 独立读取双方来源、12 个冲突及自动合并调用链，方案和静态实现审查无阻断。merge_verification 独立亲跑 `npx tsx --test test/protected-path-batch.test.ts test/desktop-workspace-files.test.ts`，19 通过、0 失败、0 跳过；确认两保护函数原样保留、目录测试清单完整迁移。其后独立复核三处夹具／断言增量及修正回归日志，无阻断。保护文件 SHA-256 为 `2b9caa271ce416d6083159d243c0d84bee6bd6c0150fdf13ce1918834e6b1c51`。

产品验收不适用：本任务恢复双方已经确定的实现，没有新的主观体验取舍。未重建 MyGo，未复验真实模型、IM、Linux 原生边界与桌面交互；本次离线证据不替代这些真实环境验收。
