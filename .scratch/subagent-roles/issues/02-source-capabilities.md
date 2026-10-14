# 普通委派与工作流共用来源能力和上下文

Status: planning

## 目标与边界

实现[规格 R1、R3、R5–R8、R14](../spec.md)，使普通委派和工作流同源角色获得一致基础能力，包含 shell、适用个人业务与 MCP；宿主身份和实际授权分别核实。拥有者已确认 Q1、Q3–Q6、Q11、Q12。依赖 01 的定义快照与存储契约；保护目标与真实副本由 03 接线。

## 方案

1. 按[计划第二节](../implementation-plan.md#二共同的来源能力与上下文)提取已有来源能力保存/复核机制到普通委派；保留各自生命周期、单层委派和三个共享名额。不能只放开工具名，不能把子 Task 冒充 main。GitHub hostReview 沿其可信入口和已完成来源资格，不套 workflowSource 的活动来源前提；共用计算但继续固定只读 MCP、禁消息，不参与角色默认选择。
2. 统一角色工具要求、来源可委派能力、产品配置和宿主限制。显式工具全部预检，MCP 发现失败或缺工具明确阻止启动；省略列表继承实际集合。装配、发送前和调用门共用同一结果。
3. 权限只继承/收紧；permissions.protect_source 作为宿主约束传至执行层，完全访问或原地目标与保护要求冲突就拒绝。单次批准、长期授权与其他任务模式不继承；审批和效果记在真实执行任务。
4. 普通子代理装配适用项目指令、技能与获准资料并留存；父聊天不自动复制。内部对话/等待只用持久快照，来源撤销、配置变化与缺失记录在后续调用仍复核。
5. 同步 agent-tools/agent-context/runtime/execution 及受影响业务模块文档，更新工具说明与诊断；新增跨层错误按 error-handling。

关键调用面：tool-availability.ts、driver.ts、tool-router.ts、context-assembly.ts、runtime.ts、subagents.ts、workflow-steps.ts、orchestrator.ts 的固定评审，以及 app_data/scheduler/service/history/memory/MCP 的宿主身份回调。复用既有提供者与导出方向，不复制业务工具实现。

## 进展与交接

独立方案审查已通过，无未解决阻断；实现前置 01 尚未完成，当前不标可实施。规划基点和当前 HEAD 为 `ec45979fc94f9828cd902620752c059867b4de15`，分支 `Eitrous/agent-workflow`；本单为未提交规划文件，内容由[审查输入清单](../evidence/plan-inputs.sha256)固定，方案结论见[独立审查](../plan-review.md)。下一角色在 01 接口稳定后核实前置并转 ready-for-agent，按本单实施；不需要重复请拥有者确认。需与 03 对齐 source protection 和实际执行工具集合。

## 验收与证据

工程待验证，产品待验收。两产品、普通/工作流同源对照工具快照；普通首次调用只给 request/key、工作流默认步骤只给正文，用真实 Driver 实际执行 bash；显式工具少一个就启动失败，实际操作账本为空；confirm 不提升、full_access 可收紧；资料撤销、MCP 配置变化、跨项目/来源资格和单次批准负例；项目指令、技能与角色正文可重建。

运行 npm run check:static，相关回归至少选 test/62-tool-availability.test.ts、test/80-subagent-delegation.test.ts、test/111-workflow-capabilities.test.ts、test/113-workflow-source-capabilities.test.ts；审批/工具修改按 pre-push-checks 补 07/08/10/63/64 的明确文件，业务与上下文按实际调用方补定向用例。个人业务替身与真实 MCP/IM 必须区分，不能以共享配置解析通过宣称身份传播通过。

实现须独立审查；真实平台与模型证据交 05，缺前提保留待验。

宿主固定评审必须覆盖 test/45-github-events.test.ts、test/46-github-recovery.test.ts 和 62 的只读 MCP/禁消息断言；用户角色覆盖不能增加其 bash 或改变来源资格，旧 fixed-review 生命周期保持。

## Comments

2026-10-14：工具来源共用是 Q1 的必要接线，不以保留普通子代理旧白名单缩减目标。
