# 隐藏宿主工作流回报输入

Status: resolved

## 目标与边界

落实[改进规格 E5](../experience-spec.md)与[计划第一节](../experience-plan.md#一隐藏内部回报输入)。拥有者 Q5、Q9 确认只隐藏内部提示，保留用户可见的最终总结和可追溯记录。不能按正文匹配隐藏，不能删除或改写历史；唯一报告交接由 [10](10-agent-wait.md)实现。

## 方案

1. 复用 `getWorkflowDeliveryRun(store, taskId)` 派生可信输入用途；任务与历史控制视图携带分类，避免重复的存储身份列。
2. 用 JSONL 任务标记关联 entry 与原 taskId，分支依据可信来源继承；分类随历史首屏和分页到达，早于输入历史补种，`Runtime.readHistoryEntry` / `TuiApp.loadEntry` 的单条补读同样处理。
3. 同步 `EventFlow.task/addHistory`、`TuiApp.seedInputHistory` 与 sticky prompt，重连及翻页不再展示内部输入；保留最终 assistant 内容和诊断原文。
4. 保持现有 sdk.prompt、上下文分组、搜索与压缩，验证真实用户同文输入及伪造 requestId 不被隐藏；绑定缺失保留普通展示并报告实际关联缺口。

影响 Runtime 的任务/历史查询、core 历史关联、control 视图/协议、TUI 投影及 fixtures；检查搜索结果或历史详情重新进入聊天投影的所有调用方。文档落点为 tui、agent-context、core/control 对应实际变动；身份与记录保证见[等待及输入分类笔记](../../../.agents/notes/implemented/architecture/2026-10-14-agent-wait-and-report-ownership.md)。

## 进展与交接

工程实现及[独立实现复审](../experience-review-09.md)完成，无未解决阻断。实现检出基点 `0307617057ae0586e7717863cfd44389f02394e3`，方案基点及独立方案审查仍由[总计划](../experience-plan.md)、[方案审查记录](../experience-plan-review.md)持有；最终实现对象见[输入哈希](../experience-evidence/09-inputs.sha256)。提交对象包含实现、文档与验收记录。

Runtime 以持久送达绑定派生 TaskView，用原任务标记及分支允许集分类历史首屏、分页和单条补读；EventFlow 统一隐藏内部 user 输入，↑ 历史和置顶只取可见投影。缺任务、跨会话或已知内部条目缺标记时保留独立普通历史行和关联诊断；损坏标记明确报错。协议升到 23，schema 不变；最终 assistant 总结、JSONL、模型请求、搜索及压缩保持原语义。决策与模块说明已同步，独立上下文只读审查，根工作区保持唯一写入者。

拥有者已完成实际对话体验验收，确认工作流回报不会再以用户消息形式展示，本单工程及适用产品验收通过。10 的前置已满足，等待、消费和唯一报告交接仍由 10 持有；本轮不实施 10，也不将 11 的联合真实环境证据记为通过。

## 验收与证据

工程验收及产品体验验收通过。2026-10-14 拥有者在本次会话确认：“已完成验收，确认工作流回报不会再以用户消息形式展示”。该结论归属本单的输入展示体验，不扩展为 11 的真实模型、真实 IM 或组合场景验收。macOS 离线验证用真实 Runtime、Driver、控制协议与 SQLite，本地模型/IM 服务为替身；已证明实时、重连、分页、分支及二级分支、单条补读先到与较旧详情后到均不泄出内部输入，↑ 与置顶只取拥有者要求，最终总结正常显示，同文用户及伪造请求键可见，完整请求与原 JSONL 可追溯。缺关联原文经后到引用/终态事件仍保留；新回归在隔离撤去修复时失败。

```sh
npx tsx --test test/01-concurrency.test.ts test/11-history-read.test.ts test/13-tui-state.test.ts test/14-tui-app.test.ts test/16-context-memory.test.ts test/34-event-flow-view.test.ts test/36-event-flow-state.test.ts test/66-control-seam.test.ts test/94-task-ending.test.ts test/102-branch-session.test.ts test/115-workflow-final-delivery.test.ts test/116-workflow-notification-recovery.test.ts test/118-workflow-entries.test.ts
npx tsx --test test/13-tui-state.test.ts test/14-tui-app.test.ts test/36-event-flow-state.test.ts
npx tsx --test test/66-control-seam.test.ts
npm run check:static
npx tsx .agents/skills/maintain-notes/scripts/check-note-anchors.ts
git diff --check
```

第一组 204/204 通过，见[相关回归](../experience-evidence/09-tests.log)；返工后的 TUI 三文件 62/62 通过，见[最终 TUI 复核](../experience-evidence/09-tui-final.log)；控制面最终 22/22 通过，见[最终控制复核](../experience-evidence/09-control-final.log)。计数含重叠，不相加。[静态门禁](../experience-evidence/09-static.log)通过；锚点无悬空，差异检查及改动文本唯一末尾换行通过。仅文档和工单证据补齐后另核实 notes/docs 门禁。

实现者未跑全量 `npm run check`、Linux、真实模型或真实绑定 IM；它们不计为实现者检查通过。拥有者已确认本单实际对话体验；真实服务与组合场景继续由 11 验收。协议 23 的后台与客户端须同步更新。

## Comments

2026-10-14：内部提示目前还污染输入框历史，已并入范围；SDK custom_message 迁移超出修复所需，不作为首选。

2026-10-14：实现者完成工程及文档交付。独立审查发现关联降级原文被后到任务事件删除，已修复并用隔离负例证明回归；工单转 ready-for-human，产品体验保留待验。

2026-10-14：拥有者确认已完成验收，工作流回报不会再以用户消息形式展示。工单转 resolved；10 的前置解除，11 的联合真实环境证据仍独立待验。
