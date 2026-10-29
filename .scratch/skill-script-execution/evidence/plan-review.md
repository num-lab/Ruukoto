# 技能脚本执行方案审查与检查

## 对象与依据

日期：2026-10-29。对象为[工单](../issues/01-execute-without-source.md)、[决策提案](../../../.agents/notes/proposed/feature/2026-10-29-skill-script-execution.md)及 HOME 发现、个人技能历史两篇已有笔记中的提案互链；基点为 `5c55e96b5de38f068eabb0aa58b7885e9e085781`，本任务文件未提交。原需求和逐项确认由工单记录，实施与真实执行不在本轮交付范围。

聊天中的独立只读预审已核实方案可行，并要求补齐最终 LaunchSpec.mode、run_command 当前权限说明、原 cwd/输出归属和 Personal 原请求快照绑定；以上已写入落盘方案。预审不替代本文件针对最终落盘内容的独立审查。

## 独立方案审查

审查者为独立只读上下文 `/root/review_skill_script_plan`，日期 2026-10-29；结论：方案通过，无阻断项，无需新增拥有者决定。其亲读工单、提案、两篇互链笔记及原技能工单，核对技能加载/展开、Coding 装配/路由/worker、原生保护、Personal 原请求/快照/命令接纳和恢复，以及测试与 smoke 入口；亲验旧笔记 diff 的空白检查通过，未重复文档检查，未执行实现测试或外验。

核实范围包括最终 LaunchSpec.mode 而非任务表面模式、逐技能真实根及 HOME/祖先拒绝、原权限不收窄、坏根隔离与停止后替代、原请求 snapshotEntry 绑定、旧展开/旧无字段命令精确核实，以及不读源码的真实执行与模型请求分层验收。文档落点完整，两篇旧笔记只增加提案互链。

非阻断实施提醒：复用 `assertNativeFileLinks` 时使用最终授权集合，避免逐技能预检把两个已开放、同权限技能根之间的合法硬链接误判为范围外。该提醒落实既有文件别名保护语义，不改变确认范围。

审查者计算的内容 SHA256 如下，覆盖全部未提交方案及旧笔记修改。审后仅回填工单状态/进展/审查评论和本证据记录，方案、验收及其他三篇笔记未改变；这些回填不构成新的技术审查对象。

| 被审内容 | SHA256 |
| --- | --- |
| `.scratch/skill-script-execution/issues/01-execute-without-source.md`（审查时 plan-review） | `a230291e463e04172317a391d6be1065f2c9a10917ff609206b929b27bd5cc1b` |
| `.agents/notes/proposed/feature/2026-10-29-skill-script-execution.md` | `2bc1e5f6ef99d172c941bb9bddda942c28c3e31c3955e7a827adc3169b42da82` |
| `.agents/notes/implemented/simplification/2026-10-28-home-skills-discovery.md` | `f461e04909027d1240150b891d7e2dbaaea9b46f3fd1db260ca6c0f56d75ccf6` |
| `.agents/notes/implemented/architecture/2026-10-18-personal-memory-skills-history.md` | `b7a849703bcc366c1fe8f39367e6cb26674f67433372c9ffd53cfa63deded7c1` |
| 本记录（审查前检查记录） | `59ecd54433ffe6541680b014d8e47d5b7eb3deb90b234f6623fac698198522ac` |

## 检查

方案者在 macOS 当前工作区亲验：`npm run verify-notes` 通过，224 篇笔记及 1 篇归档封印有效；`npm run check:docs` 通过，283 份文档链接/段落、1449 个源码文档引用与 8 份常驻预算有效；`git diff --check` 通过。审查回填后重新执行相同文档/笔记与空白检查，均通过。

`npm run check:static` 的 lint 通过，根 TypeScript 检查失败，后续 workspace 类型检查及该命令内的笔记/文档检查未运行。错误包括 `packages/core/src/store.ts` 的 cancelRequested 参数不匹配、`packages/runtime/src/runtime.ts` 的 isExecutableQueueHead 缺失，以及 TUI/View/测试夹具未补 queueOrder/queueRevision。启动本任务前这些队列相关 `.ts` 文件已有其他任务未提交变更，本任务只编辑 Markdown；失败保留为当前工作区静态缺口，不修其他任务代码，也不据单独文档检查宣称完整静态检查通过。

未执行实现用例、真实模型或平台执行验收，不据方案可行声称行为已实现。

## 交接

工单已更新为 ready-for-agent，无方案阻断或尚待拥有者决定的范围问题。下一角色为实施者，先核实当前检出与其他队列任务的静态缺口，再实施并完成独立实现审查。实现工程验收与真实模型/平台证据继续待验证。
