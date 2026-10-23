# 集中 Runtime 的模型配置职责

Status: resolved

## 目标与边界

拥有者通过 `/improve-codebase-architecture` 要求长文件优化及职责、命名、依赖清晰，并在 2026-10-23 选择候选 1「模型配置」。拥有者随后确认按方案实施并一并修复退出竞态。

将模型配置状态和完整应用过程从 Runtime 集中到 RuntimeModels，消除控制面经 Runtime 管理方法转发以及启动/重建重复。保持控制协议、配置格式、模型选择、审批、消息和任务行为；正式个人 durable 不在范围内。完整设计、备选及历史约束见[决策笔记](../../../.agents/notes/implemented/architecture/2026-10-23-runtime-models.md)。

已确认同时修复「模型配置未结束就关库/释放配置锁」及默认/摘要迟到写入的停止竞态。它是新增保证，不能记为纯代码搬移。共享快照 helper 的读取失败风险另行跟进。

## 方案

1. 新增 `packages/runtime/src/models.ts`，集中模型栈、配置读取与管理、修订/引用检查、应用门闩与回滚；依赖 Store、窄启动配置及三项宿主能力。
2. 将 `packages/runtime/src/runtime.ts` 的管理入口和内部选择核实改接新模块，保留 defaultSelection 只读 getter 及后台快照 modelInfo；压缩、任务提交、内部同键重试、Driver 集合和锁继续归 Runtime。
3. 同步 `packages/control/src/server.ts` 的九项调用与 `ops.ts` 的返回类型推导，保留 wire 契约。runtime 包的通配 exports 已覆盖新文件，无需调整包依赖或脚本。
4. 停止修复，在模块内区分门闩结束与完整管理操作结束；Runtime 先封闭新管理写入，等已受理操作收尾再销毁 Driver、关库和释放配置锁。
5. 迁移测试的私有实现访问，保留控制面及真实 Runtime 回归；同步 `docs/modules/runtime.md` 的职责和停止规则，核对 `docs/modules/control.md`、`docs/modules/agent-context.md` 的模型语义与 `docs/architecture.md` 的职责地图。没有新增包级模块，不增加地图行；同步两篇受影响的既有决定及代码锚点。

## 进展与交接

- 当前角色与阶段：实施者交付；职责提取、停止修复、调用方与文档同步完成，工程验收通过，独立实现审查无未解决阻断。
- 基点：develop / a4d2139e。本任务代码、测试、文档、implemented 笔记和证据随本工单同一提交交付，提交号以 Git 记录为准。
- 下一角色与动作：第一项已验收并按拥有者要求提交；继续第二项会话历史恢复，未推送或部署。
- 阻塞与恢复条件：无；2026-10-23 拥有者确认完整方案及停止修复。

## 验收与证据

工程验收：通过，执行记录与独立实现审查见[验证材料](../evidence/verification.md)。架构验收检查状态只有一个持有者、没有逐项转发层、调用方使用公开能力；行为验收保持原协议及配置语义。停止修复，分别验证重建成功、回滚、默认/摘要解析迟到的交错，以及门闩已释放但消息冲刷仍在途的窗口，检查 Driver、配置文件、SQLite 事件与配置锁的真实结果；保留内部提交只等门闩且使用原键的回归。

实施后的最小检查为 `npm run check:static`，以及 `npx tsx --test test/31-model-config.test.ts test/104-manual-compaction.test.ts test/86-subagent-recovery.test.ts test/98-media-model-pinning.test.ts`。模型管理控制面与默认选择接线另跑 `test/18-model-selection.test.ts`、`test/22-auto-review.test.ts`、`test/66-control-seam.test.ts`、`test/desktop-settings-models.test.ts`；若实际改动扩大，按[提交前检查](../../../.agents/skills/pre-push-checks/SKILL.md)重新选择，不能以本清单代替影响分析。

产品验收：不适用主观体验验收，因为不改页面、交互或配置选项；停止修复的等待行为由确定性用例验收。真实外部模型认证/连通性不在此次纯宿主编排验证范围，不将模拟 provider 结果记为真实平台验收。

方案审查：2026-10-23，独立审查者 `/root/tui_architecture` 直接读取源码、调用方、测试与方案；修正连接测试总时限说明，并补充门闩释放后仍在冲刷的停止验收后，复核无未解决阻断。被审内容为 a4d2139e 上新增的两份方案文件，见[审查快照](../evidence/01-plan-review.patch)，SHA-256 为 `1c6fe394cf46cc611e97607ef53247b4ac89b5d88324a51e2c44c9a0736ce47f`；审后仅更新本工单状态与验证记录，实施方案未变。

作者在 macOS / Node 24.15.0 执行 `npm run check:static` 通过；审查修订后重跑 `npm run verify-notes` 与 `npm run check:docs` 通过。这部分为方案阶段记录；实施阶段的 48 项核心回归、顺序修正后 7 项定向复核、最终 128 项客户端/控制面回归与完整静态检查均通过。独立实现审查发现的早等待问题已修复并复核通过；实际命令、版本范围和未覆盖项以验证材料为准。

## Comments

- 2026-10-23：拥有者选择候选 1。并行只读核对确认控制面是九项模型管理方法的唯一生产调用方；停止路径没有等待配置操作，门闩结束早于消息冲刷和模型事件。推荐在新模块中补齐完整操作生命周期，并将行为修正独立列为确认项。
- 2026-10-23：独立方案审查的两项意见已修订并复核通过；方案进入拥有者确认阶段。未将停止竞态的静态调用链证据记为已执行复现。
- 2026-10-23：拥有者回答「是」，确认实施方案及退出竞态修复，进入实施。
- 2026-10-23：实现审查发现配置收尾等待过早会推迟活动任务停止，已移到 requestStop 之后、dispose 之前并补真实在途任务回归；最终审查无阻断，工程验收通过。
- 2026-10-23：拥有者要求提交本项并进入第二项；代码与已验收实现一致，沿用既有定向回归，提交钩子复核静态门禁。
