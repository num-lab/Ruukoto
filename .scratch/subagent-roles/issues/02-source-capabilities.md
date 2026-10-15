# 普通委派与工作流共用来源能力和上下文

Status: ready-for-human

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

独立方案审查已通过，无未解决阻断。2026-10-15 接手时核实 HEAD 为 `d12eb63`，01 的定义与快照工程已验收，本单前置成立；用户本轮直接指定本单，按已确认范围实施。原规划基点与方案结论见[独立审查](../plan-review.md)。root 汇总 runtime/core/执行边界，Driver/上下文与 MCP/资料测试在独立工作副本完成后汇总，主工作区保持一个写入者。实现、文档和工程验收已完成，无未解决审查阻断，见[工程证据](../evidence/02-implementation.md)、[实现审查](../02-implementation-review.md)与[最终内容清单](../evidence/02-implementation-inputs.sha256)。02 已保存每次执行的可信来源、实际工具和收紧策略，下一实施入口为 03 的当前目标快照与副本基线，04 接新派发接口；未提交或推送。

## 验收与证据

工程验收通过，独立实现审查无未解决阻断；产品与必要真实环境验收待 05，因此保留 ready-for-human。两产品、普通/工作流同源工具对照和默认真实 bash、显式缺工具/MCP 启动前拒绝、权限只收紧、来源/资料/记忆撤销、旧 MCP 缓存复用拒绝、上下文重建、审批账本及固定评审回归已有证据。平台替身不记外部业务成功，旧冻结验证的 macOS native 负例不替代 03/05 的脏目标与双平台隔离验收。schema 43 拒绝旧库，不补造缺失快照。

运行 npm run check:static，相关回归至少选 test/62-tool-availability.test.ts、test/80-subagent-delegation.test.ts、test/111-workflow-capabilities.test.ts、test/113-workflow-source-capabilities.test.ts；审批/工具修改按 pre-push-checks 补 07/08/10/63/64 的明确文件，业务与上下文按实际调用方补定向用例。个人业务替身与真实 MCP/IM 必须区分，不能以共享配置解析通过宣称身份传播通过。

实现须独立审查；真实平台与模型证据交 05，缺前提保留待验。

宿主固定评审必须覆盖 test/45-github-events.test.ts、test/46-github-recovery.test.ts 和 62 的只读 MCP/禁消息断言；用户角色覆盖不能增加其 bash 或改变来源资格，旧 fixed-review 生命周期保持。

## Comments

2026-10-14：工具来源共用是 Q1 的必要接线，不以保留普通子代理旧白名单缩减目标。

2026-10-15：实施者接手，01 当前工程状态取代本单原有“前置未完成”说明；权限、工具、上下文与消息唤起沿持久执行快照共用复核，不重复请求已确认授权。

2026-10-15：实现、文档与工程审查通过，转 ready-for-human；真实平台、模型和产品体验保留交 05，目标快照与新接口不提前宣称完成，03 已接可实施交接。
