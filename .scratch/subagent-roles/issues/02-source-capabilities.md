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

本单原实施与独立审查见[工程证据](../evidence/02-implementation.md)、[实现审查](../02-implementation-review.md)与[当时内容清单](../evidence/02-implementation-inputs.sha256)；`d12eb63` 是原实施基点。05 接手时 01–04 已提交到 `5f9da45`，随后回开本单修复结果消费的来源缺口。当前返工、调用方及文档已汇总主区，[本轮独立审查](../evidence/05-final-independent-review.md)无未解决实现阻断，精确输入由其新清单固定。下一责任归 05 联合验收；未提交、推送或部署本轮返工。

## 验收与证据

05 在 `5f9da45` 发现的 R14 来源消费阻断已修复：等待、普通结果/消息装配、发送、消费和唤醒共用截至目标任务的实际依赖核实，缺记录不猜造来源，后来复用不扩大旧报告依赖；定时收尾保留具体失败，GitHub 固定宿主评审保持原可信入口。原通过结论在该范围由本轮新证据取代，其余历史证据保留。非作者六文件 35/35 及原真实缺 execution 反例已转为拒绝且不注入、不重放；最终 Linux 消费组合 121/121，macOS 真实 native 31/31，恢复及旧夹具的组合假绿也已修复并复验，详见 [05 记录](../evidence/05-acceptance.md)。本单工程返工闭环，产品及联合完整检查继续归 05，保留 ready-for-human。

两产品、普通/工作流同源工具对照和默认真实 bash、显式缺工具/MCP 启动前拒绝、权限只收紧、来源/资料/记忆撤销、旧 MCP 缓存复用拒绝、上下文重建、审批账本及固定评审回归已有证据。平台替身不记外部业务成功，旧冻结验证的 macOS native 负例不替代 03/05 的脏目标与双平台隔离验收。schema 43 是原实施时版本，现行版本归 04；缺失快照不得补造。

运行 npm run check:static，相关回归至少选 test/62-tool-availability.test.ts、test/80-subagent-delegation.test.ts、test/111-workflow-capabilities.test.ts、test/113-workflow-source-capabilities.test.ts；审批/工具修改按 pre-push-checks 补 07/08/10/63/64 的明确文件，业务与上下文按实际调用方补定向用例。个人业务替身与真实 MCP/IM 必须区分，不能以共享配置解析通过宣称身份传播通过。

实现须独立审查；真实平台与模型证据交 05，缺前提保留待验。

宿主固定评审必须覆盖 test/45-github-events.test.ts、test/46-github-recovery.test.ts 和 62 的只读 MCP/禁消息断言；用户角色覆盖不能增加其 bash 或改变来源资格，旧 fixed-review 生命周期保持。

## Comments

2026-10-15：来源消费返工及非作者最窄复验通过，原结果、Task、尝试和字节保留；修正依赖旧记录的测试夹具，恢复 ready-for-human。05 继续最终联合检查、真实模型及拥有者体验，不继承本单为整体通过。

2026-10-15：05 独立真实 Runtime/Driver 反例确认缺 execution 的完成结果仍会注入父模型并经 agent_wait 返回；回开本单返工，规格和验收标准不变，恢复后复验受影响的来源消费、等待/回报、GitHub 和调度路径。

2026-10-14：工具来源共用是 Q1 的必要接线，不以保留普通子代理旧白名单缩减目标。

2026-10-15：实施者接手，01 当前工程状态取代本单原有“前置未完成”说明；权限、工具、上下文与消息唤起沿持久执行快照共用复核，不重复请求已确认授权。

2026-10-15：实现、文档与工程审查通过，转 ready-for-human；真实平台、模型和产品体验保留交 05，目标快照与新接口不提前宣称完成，03 已接可实施交接。
