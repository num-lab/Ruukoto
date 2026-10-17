# Agent Note: 个人委托显式封组并固定最终回报

Status: implemented

## 问题

[分析委托](../../implemented/architecture/2026-10-17-personal-analysis-delegations.md)保存跨轮成员，但成员空闲不能证明主 Agent 已完成整项安排。缺少汇总与原入口回报，拥有者仍须逐项询问；把最新主聊天回答当报告还会串线。主会话只有一个活动轮次，未知效果不能在 provider 内等待而阻塞其他聊天。

## 决定

主 Agent 用 report 显式完成分析安排，宿主同事务登记唯一报告 Task 与不可改写接纳证据。报告引用也是封组事实，共用委派和追加入口都拒绝新成员/说明。Task 原生等待全部成员，正常停止后的失败结果也如实进入汇总；停止未核实不生成报告。取消保留成员与报告事实，不关闭身份，不中止整个主会话。

报告 Task 等待整组原说明与追加来源的服务效果及停止核实，再用固定正文、自定义 entry 与稳定键 admission 主会话。报告是参考输入，只能查询，不能提供拥有者变更授权。结果取对应 Submission.answer，报告正文与发送意图同 commit 固定。Telegram 固定首次拥有者入口和原消息；pending 领取先复核取消与换代，sending 后按原发送尝试记录 sent/failed/effect_unknown，不自动重发未知。完整报告可分页查询。

provider 两次记录边界检查活动报告的原生 Submission、输入正文/entry、取消、入口及整组未知效果。未知效果先持久保存本次模型尝试的暂停 entry，再在真实请求前拒绝；让 main 释放该轮供其他聊天使用。原报告 Task 观察服务 document 等待效果和停止核实，只有带暂停证据的 unanswered 尝试才递增持久尝试号，生成新的只读汇总输入；普通模型失败终止可查。每个尝试固定键恢复，所有尝试共用唯一外发身份。报告发送前再次发现未知时，同一 Task 等待，不领发送。

新增扩展名阻止旧程序恢复新档案。恢复核对封组工具的原拥有者输入、精确委托、接纳 entry、Task、各次报告输入和暂停 entry、回答及外发关系；不能猜测来源或忽略缺失引用。

## 既有笔记审计

检索 durable、委托、汇总、最终回报及未知效果。[迁移提案](../../proposed/architecture/2026-10-17-personal-pi-durable.md)、[分析委托](../../implemented/architecture/2026-10-17-personal-analysis-delegations.md)、[模型工作](../../implemented/architecture/2026-10-17-personal-model-work.md)、[Telegram](../../implemented/architecture/2026-10-17-personal-telegram-entry.md)和[服务操作](../../implemented/architecture/2026-10-17-personal-service-operations.md)部分重叠，保留各自原语并互链。旧[IM 最终回报](../../implemented/feature/2026-10-02-im-approval-and-final-report.md)继续服务 Coding/旧个人底座；其否决模型宣告收尾是为了避免遗漏工具且由旧工作委托持有完整生命周期，新 durable 用显式宿主封组关闭所有接纳入口并等待全部已接纳成员。该取舍只适用于当前空工具分析，不代表已归属独立服务或未来通用工具。没有完全吸收或过时提案。

## 备选方案

- 原输入回答完成或成员全空闲立即汇报：无需新增动作，但截断跨轮安排；显式封组后再等待全部成员。
- 每项结果直接通知拥有者：已有明确结果，但没有主 Agent 整项汇总，不能冒充最终回报。
- 未知效果在 provider 内等待：可重用同一模型输入，但堵住主会话；原报告 Task 等待，只有持久暂停证据允许新的安全模型尝试，外发身份保持唯一。
- 原报告 Submission 无条件换键重试：能从 unanswered 恢复，但普通模型失败可能造成无界费用；仅明确未知暂停允许新尝试，普通失败可查终止。
- 取消时 main.abort：能停止报告，但会取消无关聊天；只撤回该报告的排队输入，在途结果保留但不得创建后续发送。

## 验证

多成员及全部已接纳说明收齐，失败不伪装成功；封组/接纳按事务顺序仲裁。汇总不串最新回答，取消/换代/停止未核实零后续发送；已开始发送保留真实效果，未知不重发。未知暂停跨重启恢复，效果与停止核实缺一时零请求，admission 后暂停只重做安全汇总且最终外发唯一。恢复坏关系在模型请求前拒绝，CLI/Telegram 可查报告及有界结果。

## 后果

汇总结果沿原委托自动回报，主聊天继续；代价是封组接纳与安全模型尝试的恢复核验。平台发送与 durable 提交不能跨存储原子，结果丢失需人工核实；只读汇总恢复可能增加模型费用。显式封组依赖主 Agent 安排 report，未封组委托继续可查而不擅自汇报；真实模型的执行习惯及拥有者交互须独立验收。实际检查与缺口见[实施工单](../../../../.scratch/personal-pi-durable/issues/14-delegation-reports.md)。
