# 主 Agent 等待与唯一结果交接

Status: ready-for-agent

## 目标与边界

落实[改进规格 E6–E9](../experience-spec.md)，完整契约见[计划第二节](../experience-plan.md#二等待工具与调度)。Q1、Q7、Q8、Q9 已确认可打断等待、后台继续、多个明确目标、需介入即返回，以及正常等待后主 Agent 继续执行并最终汇报。不能以仅通知完成、仅支持只读目标或让用户手动再发一轮来缩减目标。

## 方案

1. 先建立最窄 Runtime/Driver 机制验证，证明目录安全让出/重新取得、新输入与完成竞争、父轮与既有汇总的报告仲裁。使用真实目录占用与会话记录；验证不成立退回方案，不把替身结果当作可实现性证明。
2. core 登记等待事实、固定目标、结果消费及报告认领，状态与事件同事务；新增 schema/协议时同步两方向实例导入、身份映射与恢复，不迁移旧 JSONL。避免复用 `delivery.taskId` 把普通父轮变成无工具汇总身份。
3. 共享宿主工具 `agent_wait` 复用 Runtime 提交后事件及查询，先订阅再读取，覆盖已完成目标、人工问题和独立分支并存、超时与中止。SubAgent 按任务 ID 等待，工作流按运行及终态代次交付。
4. Driver/Runtime 在单写入者约束下提供等待阶段，停止核实后让出占用，恢复工作目录访问前重取并复核所有来源；新拥有者输入提交后打断旧等待，后台工作不级联取消。子任务仍持目录时通过不启动 worker、不访问工作目录的内部对话阶段处理新消息与 attention；改造队列领取、Driver 初始化、上下文快照装配及唯一工具调用门，未分类工具默认禁用。覆盖工具并发、SDK abort、队列与模式变化。
5. ParentDelivery 与普通 dev 注入/main 唤醒共享消费依据；为等待父轮认领、已排队汇总转交、已开始汇总拒绝二次认领、父轮失败/中断/重启补报定义事务路径。为曾被等待覆盖的 dev 普通子任务新增持久补报资格和原键恢复，不依赖用户再发一轮，不扩大未等待委派。多个目标一次总结，原 IM 目标及稳定键、调度汇总所有权不变。
6. TUI/control 提供可读等待对象、阶段及中断原因；模型工具说明及提示要求后台未完成时继续等待或明确请求介入，不能靠虚假的 final 结束用户工作。结果与新增模型输入均可从记录重建。

来源细则：多目标整批限同原始发起任务/事件与回复目标代次，定时来源同 schedule_run；同父轮后续等待不混入第二报告来源。认领/消费的来源与资料依赖闭包持久绑定父轮，每次后续模型请求、最终登记及实际发送重核，失效拒用/拒发。普通 owner_reply 与工作报告在结果事务内共用一份报告/outbox，不能在 `recordInboundTerminal` 与 `wakeTerminal` 各登记一份。

调用面包含 `packages/agent/src/{driver,subagent-tools,workflow-tools}.ts`、工具注册/可用性/账本/提示，`packages/runtime/src/{runtime,parent-delivery,orchestrator,workflow-steps}.ts`、core store/workflow/history/恢复、control、TUI、channels 的可信入站/owner 回复与 scheduler 收尾。保持 workspace 依赖和 exports；变更身份或消费列必须逐个检查普通委派、工作流、IM、调度及导入调用方。理由见[等待与报告归属笔记](../../../.agents/notes/proposed/architecture/2026-10-14-agent-wait-and-report-ownership.md)。

## 进展与交接

当前为方案者，独立方案审查通过，源码调查已确认阻塞 Promise 会造成目录与最终汇总互等；机制验证尚未执行。前置 [09](09-internal-report-visibility.md)；由实现者在前置完成后先做步骤 1。基点和本轮文件范围由[总计划](../experience-plan.md)、[审查记录](../experience-plan-review.md)持有。已有产品决定充分，技术验证失败只需先修订方案；改变目标才找拥有者。

## 验收与证据

工程待验证，产品待验收。每一项新增用例应在缺少对应机制时失败：真实修改工作流完成准备→修改→冻结→验证→汇总；非 Git 子任务在父等待期间执行；非 Git 子任务持同目录等待审批时新输入/attention 可处理但工作目录工具拒绝；三个名额仍不超额；新输入与结果同时到达；订阅前已完成；人工问题出现时其他分支仍运行；超时后再次等待；权限变化/目录替换；SDK 中止；停止未核实；父轮完成前后重启；Coding 新输入轮先结束、普通子任务后结束仍自动补报；一结果只被消费一次、一轮只发一次总结；已有汇总排队/开始/完成的三种竞争。

审查补充负例：对话阶段不读取被子任务修改的项目指令/技能、不启动 MCP；恢复后第二次模型请求前或实际发送前撤销资料仍被拒绝；跨来源批次及同轮追加不同来源拒绝；main 普通回复与多个同来源报告只登记一个实际外发操作。

新增普通子任务补报依据持久补报资格接入 09 的宿主输入用途分类；验证它不进入聊天、置顶及 ↑ 历史，最终 assistant 总结仍显示。

新增明确文件 `test/125-agent-wait.test.ts`，并按落点扩展 `test/112-workflow-real-steps.test.ts`、`test/115-workflow-final-delivery.test.ts`、`test/116-workflow-notification-recovery.test.ts`、`test/83-subagent-worktrees.test.ts`、`test/88-parent-delivery.test.ts`、`test/86-subagent-recovery.test.ts`。工具检查覆盖 `test/62-tool-availability.test.ts` 和 `test/64-tool-op-ledger.test.ts`；生命周期及协议覆盖 `test/01-concurrency.test.ts`、`test/04-crash-recovery.test.ts`、`test/66-control-seam.test.ts`、`test/94-task-ending.test.ts`；IM/调度与导入再按实际改动选对应测试，运行 `npm run check:static`。

原生执行单元停止与重建须在 macOS/Linux 实测；两个产品用真实模型验证主动选择等待、收到结果继续处理、用户新输入可打断。替身通过不能记为真实模型或 IM 通过。文档同步 runtime/workflows/agent-tools/execution/core/control/agent-context、受影响 channels/scheduler 及 usage/development/pre-push-checks。

## Comments

2026-10-14：不等待 `delivery.reported`，因为现有最终汇总排在父轮之后；模型提示“不要重复汇报”不能替代持久认领与恢复仲裁。
