# Agent Note: 取消整项工作并保留身份与成果

Status: implemented

原出处：ADR 0020「补充：整项取消」

## 问题

[工作委托与执行任务分存](../architecture/2026-10-03-work-delegation-subagent-task.md)后，一次任务取消不能停止同工作全部排队和活动执行，迟到结果也可能再次唤醒父模型。拥有者和主 Agent 需要停止整项工作，并保留身份、记录和成果供查阅或另行复用。

## 决定

1. **取消用独立列，一次写入。** `work_delegations` 增加 `canceled_at`、`canceled_by`（`owner` 或 `agent:<任务ID>`）、`cancel_reason`（schema v26 只补列，旧行三列为空），条件 `canceled_at IS NULL`，重复取消幂等返回原记录与当前任务状态。工作状态由字段与任务状态派生（已取消/进行中/空闲），不新建状态机，不改写已结束任务的 completed/failed/canceled 结果。
2. **发起者：拥有者与主 Agent。** 拥有者走控制面 `work_cancel`（协议 v13）与 `ruukoto work cancel <工作ID> [--reason R]`；主 Agent 用 `subagent_cancel(work_id, reason?)`（普通 dev 会话与 main 都装配，回报唤醒轮次也允许——取消只收窄能力，与[显式关闭](2026-10-04-subagent-reuse-close.md)同一口径）。SubAgent 自身（无此工具，verifyHost 拒绝）和其他父会话的工作一律拒绝。
3. **一个事务登记，停止在事务外完成。** 事务内写取消字段、该工作的 queued 任务直接转为 canceled（`errorMessage` 记 `work_canceled`）、running/awaiting 任务写 `cancel_requested=1`，并追加 `work_delegation.canceled` 事件（区分 `canceledTaskIds` 与 `stoppingTaskIds`）；提交后对每个活动任务调用现有 `cancelTask` 停止路径（`Promise.allSettled`）。登记事务与委派登记同为同步事务、天然串行：先登记的任务必然在取消清单内，后登记的字段已写入即被委派检查拒绝；同键同参重放仍返回原记录。无法回收的执行按现有逻辑保留占用，SubAgent 记 unverified。
4. **单任务取消窗口修复（根因，所有取消调用方共享）。** 取消落在「任务已转 running、`currentTask` 尚未设置」的窗口时旧代码会被吞掉：`cancelTask` 先在事务内写 `cancel_requested=1` 再 `requestStop`，`Driver.runInner` 开头读到该标记直接 `finalize(canceled)`、不调用模型。已知上限：超时取消若正好落在该窗口，终态记 canceled 而非 timeout，不另外存原因（ponytail 注释）。
5. **迟到结果保存为事实，不送达父模型。** 终态结果照常经 `setTaskResult` 登记（`subagent_task.*` 事件、`subagent_result` 与 `work show` 可查）；取消提交后不再自动送进任何父模型：编排器唤醒前重读工作、队列循环对 `wake:<childId>` 启动前检查所属工作（直接取消该 wake，覆盖排队中、后插入与巡检补发的全部唤醒）、dev 注入查询加 `canceled_at IS NULL`、启动巡检待唤醒清单排除已取消工作。选「不注入」而非「以迟到结果名义注入」，用一条规则排除主 Agent 据此重启工作的可能；需要时由主 Agent 主动 `subagent_result` 读取。main 正在运行的唤醒轮次不级联取消。
6. **身份与成果保持。** 取消不关闭 SubAgent（任务结束后按占用核实记 idle 或 unverified，之后仍可按[复用规则](2026-10-04-subagent-reuse-close.md)承接其他工作）；工作目录、会话 JSONL、产物、resultRef 与工作记录都不删除。历史 coding draft 没有 `work_id`，不纳入工作取消；此类旧任务仍按 `ruukoto cancel <taskId>` 的单任务口径处理；效果未知的已有操作只标记、不重放，沿用账本既有停止口径。

## 备选方案

把迟到结果以特殊说明继续注入，可使父模型及时看到子执行结局；但仍可能诱使它重启已取消的工作。按[工单 14](../../../../.scratch/agent-direction/issues/14-cancel-work.md)「与结果回传」取舍，取消后统一不自动注入，结果保留可由主 Agent 主动查阅。

## 后果

取消只作用于所属工作，不影响其他委托，不关闭或销毁 SubAgent，也不级联停止正在运行的 main 唤醒轮次。宿主需要同时守住登记、启动、唤醒和 dev 注入四条路径；停止失败按既有逻辑保留占用和 unverified，效果未知不重放。超时取消恰落在 running/currentTask 窗口时终态为 canceled，未另存 timeout 原因。

## 验证

[工单 14](../../../../.scratch/agent-direction/issues/14-cancel-work.md)记录 test/82 8/8、npm run typecheck 通过，全量 npm test 891 项中 890 通过、0 失败、1 跳过；smoke-14-cancel-work.mts 在 macOS 与 ssh tx Linux 各 7/7，真实 Runtime、CLI、SQLite、JSONL、Docker worker 验证整项取消、排队零模型请求、活动容器停止、迟到结果可查且不注入、重启取消保持。模型与消息平台模拟。
