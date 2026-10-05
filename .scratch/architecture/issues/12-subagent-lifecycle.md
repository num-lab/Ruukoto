Status: needs-triage

# SubAgent 生命周期：状态转换与资格判定收进 SubAgent manager

## 目标

SubAgent manager 是 `sub_agents.state` 的唯一写入者，负责「执行终态 → idle/unverified 并冲刷」「启动恢复」「unverified → idle」；继续、复用、加入、收消息共用一个带原因的资格判定；计划模式规则搬进 manager（「只有一层」已归工单 08 决定 9）。来源：2026-10-05 架构审查的候选 05。

## 背景

2026-10-05 核对（develop d109dbe）：

- `sub_agents.state` 有 4 个写入点分布 3 个文件：`subagents.ts:578`、`:901`，`orchestrator.ts:572`，`runtime.ts:3114`；读者不信它，另查 `findActiveSubAgentTask`（`subagents.ts:852`、`:875`、`:1198`，`runtime.ts:3113`）。
- 守卫重复：宿主评审来源 `hasInboundSourcedSubAgentTask` ×4（345、739、775、1194）；已关闭 ×4（616、772、844、1189）；已取消 ×4（323/443、754、828）。
- 重启恢复拆三处：`runtime.ts:1356–1380`（排队委派任务定 interrupted）、`orchestrator.ts:161–176`（冲刷与恢复暂停的队列）、巡检 → `handleSubAgentTerminal` → idle/unverified。
- 「SubAgent 不能委派下级」只在 modify 分支检查（`subagents.ts:281`）；SubAgent 会话 `kind: "dev"`（:523），analyze 委派只靠工具层挡（`subagent-tools.ts:193` 的 `ownerOriginated`、`subagent` 类别为空）。
- `planMode` 参数（`subagents.ts:137`、:288）没有调用方传入，真实检查在工具里；mode/work_id 检查在工具（`subagent-tools.ts:~246–250`）与 manager（:289–296）各一份。
- 消息路径绕过模型门闩（工单 09 决定 5 移交）：`deliverAsTask` 与 `deliverAsParentWake`（`subagents.ts` 881、903）直接 `insertQueuedTask`，不经 `resolveSelection` 的门闩与执行入口检查；模型配置应用期间可能插入引用正被删除 provider 的任务，运行时失败、消息实际未送达。委派（`delegate`，:366）与 `submit` 都有门闩。两处一并处理。
- 「取消工作 + 消息待投递 + 重启」现在约需 60 行准备：startKit、两次真实委派加一次 join、SQL 写入消息与 `canceled_at`（`cancelWork` 会立即冲刷，崩溃窗口无法自然到达）、停止再 `Runtime.start`、`waitFor`。

## 待访谈

- 与候选 09 共享消息冲刷、与候选 08 共享「是不是 SubAgent」：先做 08/09，再评估本单剩余部分。
- 08 落地后：`delegate()` 的父会话判定已按会话身份收成一条（两种 mode），本单不再处理「只有一层」。
- 资格判定的原因集合与现有错误码（`invalid_state` / `forbidden`）的对应。

## 相关 ADR

- ADR 0020 issue 12/14/15 补充段：只收拢，不矛盾。

## Comments
