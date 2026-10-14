# 子代理角色定义、选择与持久快照

Status: ready-for-human

## 目标与边界

实现[规格 R2–R4、R7、R14](../spec.md)的角色文件、内置定义、选择和快照。拥有者已确认 Q2、Q5–Q7、Q10 及整体方案。模型和推理强度继承来源，不建设配置 TUI、项目自动发现或角色继承。完整来源能力与工作副本分别由 02、03 持有。

## 方案

1. 按[计划第一节](../implementation-plan.md#一定义加载与持久身份)复用 frontmatter 解析及 workflow-library 的宿主文件读取规则；内置 general/reviewer 同样解析，不对角色名硬编码权限。
2. 保存角色定义原文、规范化字段、摘要及 SubAgent 绑定；工作流启动固定可用目录与诊断。新角色目录的父模型输入、角色正文的子模型输入进入可重建记录，坏覆盖不能静默回落内置。
3. 普通委派新增 role，继续/复用/消息沿固定角色；异角色请求拒绝。新增字段与幂等摘要同步 Store、归档查询、schema 和两方向实例导入；SDK 会话签名覆盖角色内容，缺记录拒绝恢复。
4. GitHub hostReview 不选择用户可覆盖角色，继续从可信入口保存宿主固定定义；新记录明确区分该用途与角色引用，保留固定提示、只读 MCP、禁消息及原幂等/恢复，不能回落 general 或选择必需 bash 的 reviewer。
5. 同步模型目录、加载错误与有效角色信息的既有查询/诊断入口；未知或无效角色不建可执行任务，主会话和旧运行仍可处理错误。实施时更新 CONTEXT.md 的子代理角色术语、runtime/agent-context/core 文档及 usage 中文件入口。

调用面：packages/agent/src 的 skills.ts/session-factory.ts/driver.ts 可复用部分、packages/runtime/src 的 subagents.ts/workflows.ts/workflow-library.ts/orchestrator.ts、packages/core/src 的存储与导入，以及原工具 schema、控制面查询、fixtures。具体文件按源码职责落位，不新增重复配置或身份系统。

## 进展与交接

工程实现、文档、定向验证及[独立实现审查](../01-implementation-review.md)已通过，无未解决阻断；产品编辑文件与错误体验交 05，故保留 ready-for-human。规划基点为 `ec45979fc94f9828cd902620752c059867b4de15`，实施检出为 `4611eff3035179041063942f3c8f5e206b8de9bb`；基点后的浏览器接线不改变角色方案，拥有者专属限制继续保留。规划来源由[原审查清单](../evidence/plan-inputs.sha256)固定，方案结论见[方案审查](../plan-review.md)；实施对象由[内容清单](../evidence/01-implementation-inputs.sha256)固定，实际验证与未覆盖项见[工程证据](../evidence/01-implementation.md)。拥有者已授权提交本单改动，未推送。

下一实施入口为 02，前置快照契约已可用：core 的 SubAgentDefinitionSnapshot / SubAgentRoleCatalogSnapshot 与 sub_agents.definition，agent 的 parseSubAgentRole / validateSubAgentRole，runtime 的 loadSubAgentRoleLibrary / selectSubAgentRole、普通 role 参数和 WorkflowRun.roleCatalog。定义内容包含用途、原文、规范字段与摘要；继续、复用、消息和恢复使用已保存正文，坏记录可查但不执行。模型/思考强度继承实际来源；工具要求与权限策略已保存，来源能力、权限收窄、受限 reviewer、目标快照与新工作流接口仍由 02–04 完成。

## 验收与证据

工程已验收，产品待 05。新增 15 项最窄角色加载/持久/实际 Driver 回归，覆盖新增与覆盖、非法 frontmatter/未知字段及显式 null、符号链接/多硬链接、读取中变化、无效同名覆盖、未知角色、角色复用冲突、任务登记幂等、文件编辑/删除后继续及冷恢复、记录损坏和导入；首次响应后损坏还证明后续模型/工具被拒且父会话仍可用。

npm run check:static、build 和本单定向回归通过，含 80/83/62、core 生命周期、两方向导入、工作流、控制面与等待/上下文。具体批次及初次失败/修复过程见工程证据；两个显式真实模型等待用例未启用，不记通过。只声明本单配置与快照已验证，不提前声明默认 bash 或新工作流接口通过。

宿主固定评审的 45/46 已增加并通过用户 general/reviewer 覆盖回归：实际模型提示和工具仍为宿主定义，已完成来源任务可按原资格登记，重启保持固定限制且不变成普通可复用身份。

独立实现审查通过，null 权限漏检已按审查负例修复；最终产品验收交 05 验证用户能编辑/新增文件并看到明确错误。未运行全量、真实模型、Linux 隔离或外部业务/IM，schema 42 按现有政策拒绝旧档案，不回填角色或授权。

## Comments

2026-10-14：拥有者完成 grilling 并确认整体方案，本单由规划阶段建立。

2026-10-14：实施者接手，核实当前检出与规划基点差异；存储与运行时并行实施使用独立工作副本，汇总后的改动重新选定检查范围。

2026-10-14：定义、选择与快照层工程交付，独立上下文 /root/implementation_review 审查通过；02 可使用持久契约继续实施，产品与真实联合验收保留至 05。

2026-10-14：拥有者授权提交本单改动；提交沿用已审内容与验证证据，产品状态不随提交改变。
