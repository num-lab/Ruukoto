# 持久工作流运行与协调器

Status: ready-for-agent

## 目标与边界

落实[规格 A3、A4、A7、A8、A9](../spec.md)的执行基础，按[实施计划](../implementation-plan.md)一、二、四、五节建立宿主持有的运行、步骤与尝试；先使用假 Agent，不绕过[04](04-step-capabilities.md)的权限接线直接放开业务工具。

## 实施与交付

1. 在 core 定义运行、步骤、尝试、问题和不可变定义版本，状态与事件同事务；保留任务/工作/Agent/操作的现有归属，schema 与协议版本单调升级。
2. 在 runtime 新增协调器，接入 02 的脚本进程和队列；固定来源、脚本、参数与模型，发起任务结束后依靠运行自身授权继续工作。
3. 按稳定步骤键与输入摘要幂等登记，记录宿主结果交付顺序；复用已完成结果，恢复未执行工作，检测脚本重放分歧与缺失资料。
4. 实现来源会话共享并发、尝试数和时限计费、显式暂停/恢复/取消。通过真实事务竞争验证抢位、取消与启动、预算调整与排队的顺序。
5. 贯通已有任务和工具操作效果分类；已执行写操作结果缺失、格式失败或停止未核实不得变成自动重试。普通任务/普通委派的恢复行为单独回归。

6. 实现运行派生的短期宿主操作任务和具名执行登记，真实持有工作副本操作的 worker、账本与占用；改造 executeWorkCopy 的依赖入口以支持它，保留普通 Driver 路径，不伪造仍活动的原发起任务或删除停止核实。宿主任务不创建模型会话，不计 Agent 尝试，执行时限仍计费。

主要落点为 packages/core/src 的 schema/store/types/session-identity、packages/runtime/src 的新协调模块、runtime、subagents、orchestrator；涉及控制面共享类型但不提前实现完整 UI。

## 验收与交接

[02](02-script-isolation.md) 已于 2026-10-13 完成四格实验、固定入口与独立工程审查，前置解除；入口与回收契约见[隔离决定](../../../.agents/notes/implemented/architecture/2026-10-13-workflow-script-isolation.md)，原始证据由 02 持有。本单尚未开始。新增最窄的状态机、重放和并发测试；配合 `test/01-concurrency.test.ts`、`test/03-lifecycle.test.ts`、`test/04-crash-recovery.test.ts`、`test/05-overflow-db.test.ts`、`test/86-subagent-recovery.test.ts`、`test/94-task-ending.test.ts` 与 `npm run check:static`。

直接读取 SQLite 与事件断言持久事实，构造已生效写操作和记录缺口，验证没有第二次外部效果；只检查状态字段不算恢复验收。core/runtime 文档及决定锚点同步。本单验收待执行，交付后由 04 接入真实步骤工具。

专门覆盖原发起任务已经结束后，运行仍能通过自己的宿主操作任务创建与汇总副本；在该阶段取消且 worker 停止未核实时，记录和占用保持可核实，后续操作不能并发重入。
