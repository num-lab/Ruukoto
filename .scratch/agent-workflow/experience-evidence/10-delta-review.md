# 工单 10 最后增量独立审查

本记录补充 [首次独立审查](10-implementation-review.md)，保留旧审查的对象、时间和哈希，不覆盖旧记录。基点仍为 `40dcee7`；新增审查对象是报告启动闭包复核、按本父轮目标集合停车、未认领停车后备的取消收尾、统一后备最终登记，以及同任务复用 SDK 调用 ID 的消费匹配。当前实现、相关测试、docs/notes 的 SHA-256 见配套增量清单；工单状态和后续体验证据的更新不算实现改变。

## 结论与依据

新增范围没有未解决源码阻断。旧单目标后备恢复 queued 后须在 queued→running 之前复核本父轮固定等待闭包，未齐则 group_waiting 停车并继续处理拥有者输入，齐后复用原报告任务。停车集合与后续登记/归并集合一致；同原来源的另一父轮组保持独立。无 claim、真实已终态的未开始 queued/parked 后备只可按 undelivered 收尾，不能声称成功或抢父认领。所有可信后备统一通过最终登记入口保存真实 assistant entry/outbox 证明，原 workflowDeliveryKey / work 发送槽与专属 delivery.taskId 身份保留；来源、取消及实际发送复核仍然生效，状态/outbox 在同一结果事务内提交。

补审发现过停车范围过宽和 parked 取消仍抛 report_owned，真实 Db/Runtime 反例与源码修复均已核实。独立 `test/125-agent-wait-group-boundaries.test.ts` 证明固定等待组互不停车、原绑定保留，并覆盖无认领停车后备取消；`test/125-agent-wait-queued-group.test.ts` 证明原 queued 汇总不抢先、拥有者先处理、全部终态后使用原任务一次汇总并共享真实证明。

最后消费修复保留本任务 START 至下一 START/END 的范围，逐一检查同 SDK call ID 的非错误 agent_wait 工具条目，仅接受实际 reason=result；按已登记结果字段（非 null/undefined）、reportOwnerTaskId、固定子任务 ID 或工作流 runId/terminalVersion 匹配尚未消费的认领，consumption.entryId 指向实际包含该结果的原条目。没有改成只取最后一条，既有消费不重写，跨任务旧结果仍不可认领。新增 parent-repeated 冷恢复在修复前实际得到 pending 而非 reported（[修前日志](10-repeated-call-before-fix.log)）；修后消费关联到后续 result entry，并且零模型调用恢复原报告。

审查者亲跑 `npx tsx --test test/125-agent-wait-recovery.test.ts test/125-agent-wait-report.test.ts test/125-agent-wait-queued-group.test.ts test/125-agent-wait-group-boundaries.test.ts`，19/19 通过、零跳过；独立原日志 `/tmp/ruukoto-agent-wait-final-review-repeated-call.log`。同时直接读取最终循环、相关 caller、恢复与来源/取消路径，以及实施者的负例、平台及完整检查原日志。本审查没有修改根工作区，没有亲跑全量、Linux 原生或真实 API。

## 验证材料的有效范围

[全量日志](10-full-check-last.log)包含 build、静态与测试，macOS 独占 38/38、应用 1382 通过/0 失败/5 跳过、foundation 9 通过/0 失败/1 跳过；六项跳过均由真实模型默认门控关闭。此全量早于最后消费匹配修复，不能写成最终源码全量重跑通过；后续这部分由上述 19/19、实施者 [最终静态日志](10-static-final.log)和本增量审查覆盖。

直接核对 [Linux 原生日志](10-linux-native.log)：等待资源及双产品主机制 14/14，零跳过；[初始失败](10-linux-init-failure.log)为隔离目录外依赖不可见，实体化后 [初始化成功](10-linux-init-fixed.log)并实际运行通过，未借缺前提跳过。该记录证明所列原生路径，不代表 Linux 全仓或 CI Node 22.19/24.15 矩阵。

直接核对 [受控真实模型日志](10-model-final.log)：一个离线代理协议回归及两个实际 DeepSeek API 场景共 3/3，main/dev 均执行等待、收到结果后查询核实、attention 再等、新输入中断及同 proof 唯一补报。代理不改请求/响应正文，父提示明确规定工具名和顺序，因此证明受控机制，不证明自然需求下自发选择等待或拥有者体验。Linux 和真实模型记录早于最后纯宿主消费匹配及无认领停车取消修复，相应增量只按宿主回归声称通过。

[验证交接](10-verification.md)正确区分完整检查与最后定向增量、受控 API 与本地 IM 适配器，并保留原生负载失败、Linux 前提失败和真实模型重复汇总的失败记录。原生负载波动的系统原因尚未确定，最终成功不能被写成稳定性证明。

## 待验与交接

源码审查和上述工程证据可支持工单交 ready-for-human；不能记 resolved。自然需求下两产品自发等待与继续业务、真实 IM 原绑定唯一送达、拥有者体验及 08 组合操作由拥有者和 11 联合验收负责；未授权真实 IM 不外发，本地 FakeBotAPI 只算宿主/适配器回归。schema 40 / 协议 24 按既有严格兼容规则使用独立新档案和配套客户端，旧档案保留。没有提交、推送、部署或发布授权。
