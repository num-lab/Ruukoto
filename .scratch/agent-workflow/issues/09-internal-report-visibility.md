# 隐藏宿主工作流回报输入

Status: ready-for-agent

## 目标与边界

落实[改进规格 E5](../experience-spec.md)与[计划第一节](../experience-plan.md#一隐藏内部回报输入)。拥有者 Q5、Q9 确认只隐藏内部提示，保留用户可见的最终总结和可追溯记录。不能按正文匹配隐藏，不能删除或改写历史；唯一报告交接由 [10](10-agent-wait.md)实现。

## 方案

1. 复用 `getWorkflowDeliveryRun(store, taskId)` 派生可信输入用途；任务与历史控制视图携带分类，避免重复的存储身份列。
2. 用 JSONL 任务标记关联 entry 与原 taskId，分支依据可信来源继承；分类随历史首屏和分页到达，早于输入历史补种，`Runtime.readHistoryEntry` / `TuiApp.loadEntry` 的单条补读同样处理。
3. 同步 `EventFlow.task/addHistory`、`TuiApp.seedInputHistory` 与 sticky prompt，重连及翻页不再展示内部输入；保留最终 assistant 内容和诊断原文。
4. 保持现有 sdk.prompt、上下文分组、搜索与压缩，验证真实用户同文输入及伪造 requestId 不被隐藏；绑定缺失保留普通展示并报告实际关联缺口。

影响 Runtime 的任务/历史查询、core 历史关联、control 视图/协议、TUI 投影及 fixtures；检查搜索结果或历史详情重新进入聊天投影的所有调用方。文档落点为 tui、agent-context、core/control 对应实际变动；身份与记录保证见[等待及输入分类笔记](../../../.agents/notes/proposed/architecture/2026-10-14-agent-wait-and-report-ownership.md)。

## 进展与交接

当前为方案者已完成源码诊断与独立方案审查，未实施。基点 `09da9ef5ccef430ac37ba8abfcb814a7c6342aa1`；本轮未提交内容及独立审查由[总计划](../experience-plan.md)、[审查记录](../experience-plan-review.md)持有。下一角色为实现者，优先实施本单，无其他实现前置。

## 验收与证据

工程待验证；产品待验收。最窄回归必须证明实时、重连、分页、分支、↑ 历史和置顶提示均不显示内部输入，同时 JSONL 和模型请求仍有完整内容，最终总结正常显示；真正用户输入相同标题/请求键正常显示。

检查 `test/13-tui-state.test.ts`、`test/14-tui-app.test.ts`、`test/115-workflow-final-delivery.test.ts`、`test/66-control-seam.test.ts`、`test/11-history-read.test.ts`、`test/102-branch-session.test.ts`；运行 `npm run check:static`。增加单条补读先到、任务事件后到仍不闪现或污染 ↑ 历史的用例。这里记录的是计划，尚未运行实现检查。独立审查需确认无文案匹配或前端时序泄漏，拥有者核实实际对话体验。

## Comments

2026-10-14：内部提示目前还污染输入框历史，已并入范围；SDK custom_message 迁移超出修复所需，不作为首选。
