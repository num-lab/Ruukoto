Status: ready-for-agent

# 父级送达：一个模块回答「父级会收到这项工作的什么、何时收到」

## 目标

子任务结果与工作内消息怎样送到主 Agent（main 唤醒任务 / 普通开发会话的 dev 注入 / IM 来源的 owner 回复），以及已取消工作的迟到结果不送达，由一个模块负责。编排器在子任务终态时调用它一次，driver 向它取待注入并标已送达，队列循环问它唤醒是否放行，启动巡检在它内部。来源：2026-10-05 架构审查的候选 02。

## 背景

2026-10-06 核对（分支 session-identity，工单 08 之后）：

- 三条送达通道：
  - main 父会话的结果：编排器 `wakeParent`（`orchestrator.ts:677–713`）按 `wake:<childId>` 建唤醒任务；启动巡检 `sweepPendingResults`（:446–455）按 `listRoleTasksPendingWake`（`store.ts:921`）补发。
  - main 父会话的工作内消息：`SubAgentManager.deliverAsParentWake`（`subagents.ts:903`）按 `smsg:<消息ID>` 建唤醒任务；`flushPendingMessages`（:815）补登记。
  - 普通开发会话：结果与消息都在下一次任务开始时注入（`driver.ts:733–751`，经 `listUndeliveredSubAgentResults` 与 `listUndeliveredParentSubAgentMessages`，`store.ts:1184`、`:1272`），同事务标记已送达。
  - IM 发起工作的最终汇报（issue 18）挂在结果唤醒的终态上：`onWakeTerminal` → `enqueueWorkReport`（`runtime.ts:920–947`）；唤醒输入附 `workReportNotice`（:949）。
- 「送 main 唤醒还是 dev 注入」判定 7 处：`orchestrator.ts` 452、646、680 与 `subagents.ts` 831、864 的 `getAgentRoleBySession`；`store.ts:928` 的 SQL `EXISTS agent_roles`；`driver.ts:733` 的 `identity.kind === "dev"`（工单 08 后已用会话身份，其余 6 处未改，按 08 决定留给本单）。
- 「已取消工作不送达父模型」（issue 14）检查 9 处：`orchestrator.ts:650`；`runtime.ts` 923、951、2776（队列门：取消前已排队的 `wake:` 唤醒在此取消）；`subagents.ts` 750（拒绝发送）、824（冲刷记 work_canceled）；`store.ts` 931、1184、1272 三条 SQL。
- **缺口**：消息给 main 的 `smsg:` 唤醒任务不带 `work_id`，`cancelWork` 只取消 `listActiveTasksByWork` 的任务，队列门只认 `wake:` 前缀（全仓库没有其他 `smsg` 判断）。main 忙时收到 SubAgent 消息（唤醒排队）、随后取消该工作（如 main 本轮就调用 `subagent_cancel`），排队的消息唤醒仍会运行，把已取消工作的消息送进 main 的模型——与 `wake:` 已遵守的规则矛盾，也违背 agent-direction issue 24 验收「整项取消后的迟到同级消息不能重启工作」。82 号只测了排队的 `wake:`（:427），没有 `smsg:` 的用例。
- 测试 82、84-im-final-delivery、86-subagent-messaging 都经完整 Runtime + MockModelServer 与 `waitFor` 轮询。

## 决定（2026-10-06 访谈）

1. **范围：父级一侧全收**。结果与发给主 Agent 的消息的两条通道（main 唤醒、普通开发会话注入）、取消规则、启动补发、IM 发起工作最终汇报的到期判定都进本模块；送达方向按工单 08 的会话身份判定。发给 SubAgent 的消息投递（依赖 SubAgent 忙闲、名额、资格）留在 SubAgent manager（归 12）；main 自己 IM 任务的 owner 回复不是父级送达（归 10）。
2. **送达 = 进入父模型的一次调用**：main 在唤醒任务开始运行时，普通开发会话在下一次任务的注入时；此前只是待送达，工作取消即截住。建好的唤醒任务与 `delivered_at` 是投递登记，不是送达。CONTEXT.md 收录「送达」。
3. **缺口修复是本单第一步**：先写失败用例（main 忙时 SubAgent 发消息 → 取消工作 → 消息唤醒零模型调用），重构后统一的取消规则让它变绿；不在 develop 单独热修（develop 在 08、09 合入前保留该缺口）。

4. **模块与入口**：新模块 `src/runtime/parent-delivery.ts`（父级送达），依赖 store、建唤醒任务的函数与 kick。五个入口各对应一个现有调用点：
   1. 子任务结果已登记（编排器在结果事务后调用一次）：main → 建结果唤醒；普通开发会话 → 不动（结果行即待注入）；工作已取消 → 不建。
   2. 发给主 Agent 的消息已登记（manager 在消息事务内调用）：main → 建消息唤醒；普通开发会话 → 待注入。
   3. 普通开发会话的任务开始（driver）：取待注入的结果与消息，同事务标记已投递，交给上下文组装。
   4. main 唤醒任务即将运行（队列循环）：所属工作已取消 → 取消该唤醒；`wake:` 与 `smsg:` 同一判定（补上缺口）。
   5. 后台启动：补建缺失的结果唤醒与消息唤醒。

   另含最终汇报到期判定（决定 6）与唤醒输入的宿主说明。不进：结果登记本身（`setTaskResult`、事件、SubAgent 置 idle/unverified）留在编排器；发给 SubAgent 的投递留在 manager。不放进编排器：其另一半（入站派发）无关，独立模块不需 bridge 与角色引导即可测。
5. **唤醒任务的建立方式不统一**：结果唤醒仍是结果事务提交后经 `submit`（有模型门闩与执行入口检查，崩溃由启动按 `wake:` 键补发）；消息唤醒仍在消息事务内直接插入。两者都收进本模块。「消息路径绕过模型门闩」（消息唤醒与 `deliverAsTask` 同病）记入工单 12 一并处理。
6. **最终汇报的切分**：到期规则归本模块——工作未取消、由 IM 入口发起（经发起任务的来源事件追溯）、没有活动执行任务、其余执行任务的结果唤醒都已有结果；发送键 `<事件>#work:<工作>:<子任务>` 与正文取哪一轮回答也由本模块决定。IM 机制（钉版目标核对、按平台截短、写 `owner_reply` 发送操作）留在 Runtime，经一个回调调用，直到工单 10 移入 IM 入口表。
7. **被截住的消息唤醒**：消息行不改（投递登记一次写入不变，主 Agent 仍见「已投递（任务 X）」）；承载任务因工作取消而取消时，读取时补「（工作已取消，未送达）」，不加列。

### 行为变化

只有缺口修复一处：取消前已排队的消息唤醒（`smsg:`）在队列门按 `work_canceled` 取消、零模型调用，消息显示「（工作已取消，未送达）」。其余可达路径无变化。

### 测试

- 先写失败用例（决定 3），86 号新增：main 本轮阻塞时 SubAgent 发消息（`smsg:` 唤醒排队）→ main 本轮调用 `subagent_cancel` → 本轮结束后消息唤醒按 `work_canceled` 取消、零模型调用，`subagent_result` 显示「（工作已取消，未送达）」。步骤 1 改动前必须确实失败。
- 新增 `test/88-parent-delivery.test.ts`：模块在临时 Store 上，建唤醒用记录桩、kick 用探针，不起 Runtime 与模型服务。矩阵：父会话（main / 普通开发会话）× 结局（completed / failed / timeout / unknown）× 取消（无 / 结果前 / 唤醒排队后）× 来源（IM / TUI / GitHub 评审）→ 是否建结果唤醒、注入清单、`wake:` 与 `smsg:` 的放行判定、最终汇报是否到期及其键、启动补建缺失的结果与消息唤醒、承载任务被取消时的消息状态文本。
- 现有集成用例保留不删：82:181/427、84-im-final-delivery、86:233/582——它们是队列循环、driver 与编排器确实调用本模块的唯一证据。82:623 直接断言 store 查询，查询仍有效，保留。
- 交付时变异核对：去掉模块的 `smsg:` 分支 → 86 新例失败；去掉建结果唤醒时的取消检查 → 88 失败。

## 步骤

分支 `parent-delivery`，从 `develop` 切出。

1. 提交工单 09–16、审查索引、CONTEXT.md「送达」与工单 12 的补记。
2. 先补缺口：写 86 失败用例 → 模块骨架与入口 4（`wake:`/`smsg:` 放行判定）接入队列循环 → 转绿；88 的放行用例。
3. 入口 1、2、5（结果唤醒、消息唤醒、启动补建）；其余 6 处送达方向改用会话身份；建立侧的取消检查移入模块；88 相应用例。
4. 入口 3（普通开发会话注入）、最终汇报（决定 6）与唤醒说明、消息状态文本（决定 7）；88 相应用例。
5. 文档：`docs/runtime.md` 加「送达」与父级送达模块；按 `.skills/visual-docs/SKILL.md` 同步图解页；本单追加交付记录并标 resolved。

每步 typecheck 与全量 `npm test`（nohup + 退出码文件）通过后在分支本地提交，不 push；不在 tx 上跑真实模型验收；合入顺序 08 → 09，时机由拥有者决定。

## 相关 ADR

- ADR 0020 issue 14 补充段：迟到结果保存为事实但不送达父模型——只收拢，不改语义。
- ADR 0010：owner 回复发送键与「结果未知不换键重发」不动。

## Comments
