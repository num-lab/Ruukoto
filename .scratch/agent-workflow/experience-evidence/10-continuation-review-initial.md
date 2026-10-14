# 工单 10 E8 续接与来源闭包追加独立审查（初审）

对象：工单 10 当前未提交追加实现，基点 40dcee7；仅审正常父轮 first 消费后第二项 attention、Q 仅等待第二项时整组接管、provider 失败回退，以及报告权释放后的来源闭包。审查者从独立上下文直接读要求、源码和用例，根工作区全程只读。快照与日志 SHA-256 见 /tmp/10-continuation-source-review-initial-manifest.json。

结论：正常续接与完整输入的来源失效路径已核实；当前有坏输入边界阻断，返实施者处理，尚不能给追加范围通过结论。

已核实：RuntimeAgentWait 在原父轮终态且原组全部就绪时整组认领，toolResult.targets 保持 Q 的单个第二项，reportTargets 带完整原组；原 first consumption 保留 P 的 task/entry，不重写；ParentDelivery.reportReady 和 Runtime.agentReportInput 要求本轮完整 JSONL 输入才能用 Q 的最终 assistant proof 完成旧消费报告。provider 未接受输入不消费第二项，释放整组原 canonical 补报，原 requestId/input 保留。

亲跑 npx tsx --test test/125-agent-wait-attention-report.test.ts test/125-agent-wait-core.test.ts test/125-agent-wait-recovery.test.ts test/125-agent-wait-report.test.ts，42/42、零跳过，通过，日志 /tmp/ruukoto-agent-wait-source-review-host.log；亲跑现有 /tmp/ruukoto-agent-wait-e8-review/125-agent-wait-takeover-source-binding.test.mts，1/1、零跳过，通过，日志 /tmp/ruukoto-agent-wait-source-review-binding.log。完整输入的 source-invalid 冷恢复将整组报告记 undelivered，清 claim 后 Q 仍拒绝失效的 first 来源。

实际发送路径直接核实：Scheduler.sendOne 在领取 outbox 之前调用 Runtime.verifySources；owner_reply 进入 verifyAgentReportSources(taskId,true) 和 agentReportReferences，再核原回复目标。当前任务范围限定 START 到下一 START/END，同 SDK call ID 跨任务复用不会回读旧结果，同轮复用逐条扫实际结果。没有发现绕过这一核实的 owner_reply 发送路径。

阻断 1：报告权清理后，不完整的当前任务输入会被当作空闭包。真实 SQLite/SDK JSONL/Runtime 冷恢复 fixture 中，first 消费仍归 P、Q claim 因 first 来源撤销而清除；随后仅改 Q START.taskId、删除 Q 的实际工具 entry、删除 reportTargets、将 reportTargets 改为空数组或只保留第二项，verifyAgentReportSources(Q,true) 均返回 null。Q 不再直接关联 first；普通 owner_reply 的来源集合因此可遗漏已进入 Q 回答的 first。计划要求已消费资料持续绑定父轮、发送前重核，缺引用必须明确失败；不能把找不到本轮输入当作无报告来源。实施者需保留可核实的完整组绑定并拒绝缺失或不完整的输入证明。

阻断 2：合法 JSON 的 null 根值和 reportTargets:[null] 会抛未分类 TypeError，分别发生在 runtime.ts 当前 agentReportReferences 访问 result.reportTargets 和 target.reportOwnerTaskId。该异常未被 verifyAgentReportSources 的 HistoryReadError/AgentWaitError 分支捕获，损坏输入不能得到明确报告输入拒绝；应在 JSON 边界作最窄形态校验并转 AgentWaitError。

独立 probe 保存在 /tmp/ruukoto-agent-wait-e8-review/125-agent-wait-input-integrity-review.test.mts。扩展初审 9 例中 2 例通过（缺报告引用、非法 JSON 正确拒绝）、7 例失败，日志 /tmp/ruukoto-agent-wait-source-review-input-integrity-expanded-before.log。probe 只改隔离运行档案，不改根工作区；这些是保护历史损坏后的失败语义，不是声称正常输入会自发丢失字段。

未重跑全量、native/worker、Linux 矩阵或真实 API；实际 IM、自然需求与拥有者体验仍沿原工单待验。坏输入闭包阻断修复后，由独立审查者复跑对应 probe 与最窄宿主回归，再绑定最终源码快照。
