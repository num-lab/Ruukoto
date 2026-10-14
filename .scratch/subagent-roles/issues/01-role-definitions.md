# 子代理角色定义、选择与持久快照

Status: ready-for-agent

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

独立方案审查已通过，无未解决阻断；实现尚未开始。规划基点和当前 HEAD 为 `ec45979fc94f9828cd902620752c059867b4de15`，分支 `Eitrous/agent-workflow`；本单为未提交规划文件，内容由[审查输入清单](../evidence/plan-inputs.sha256)固定，方案结论见[独立审查](../plan-review.md)。下一角色为实施者，直接按本单提供 02–04 所需的快照/身份接口。不得仅登记角色名却从当前文件恢复正文。

## 验收与证据

工程待验证，产品待验收。新增最窄角色加载/持久回归，覆盖新增与覆盖、非法 frontmatter/未知字段、符号链接/多硬链接、读取中变化、无效同名覆盖、未知角色、角色复用冲突、任务登记幂等、文件编辑/删除后继续及冷恢复、记录损坏和导入。

运行 npm run check:static；定向导航为 test/80-subagent-delegation.test.ts、test/83-subagent-worktrees.test.ts、test/62-tool-availability.test.ts，以及实际触及的持久与导入用例。新字段触及 core 时按 pre-push-checks 补生命周期回归。只声明本单配置与快照已验证，不提前声明默认 bash 或工作流接线通过。

宿主固定评审另验 test/45-github-events.test.ts、test/46-github-recovery.test.ts：覆盖用户 general/reviewer 后仍使用宿主定义，已完成来源任务仍可按原资格登记，重启保持固定限制且不变成普通可复用身份。

实现须独立审查；最终产品验收交 05 验证用户能编辑/新增文件并看到明确错误。

## Comments

2026-10-14：拥有者完成 grilling 并确认整体方案，本单由规划阶段建立。
