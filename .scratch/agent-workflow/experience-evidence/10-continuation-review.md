# 工单 10 E8 续接与来源闭包追加独立审查

本记录追加于首次实现审查及最后增量审查，保留旧结论的对象、时间与哈希，不覆盖初审返工记录。基点为 40dcee7，对象是当前未提交 E8 追加实现：部分结果后的介入问句、后续主轮接管整组报告、实际当前输入证明、provider 失败回退、认领清理后的来源闭包及坏输入失败语义。审查者直接读取有效工单、规格、计划、implemented 笔记、实际源码和测试；作者消息只作导航。根工作区全程只读，独立 probe、候选补丁和记录写在 /tmp。最终实现、测试、相关文档及原日志 SHA-256 见 /tmp/10-continuation-source-review-manifest.json。

## 结论

本次追加范围没有未解决源码阻断。固定等待组未齐时，父轮介入问句可以完成普通对话，不能提前完成结果报告；旧消费保留。后续 Q 即使只等第二目标，也须接手完整已就绪原组，由实际 agent_wait toolResult.reportTargets 提供全组事实与报告权。P 已消费的 first 不改写为 Q 消费；Q 的最终报告凭本轮完整输入证明登记。provider 未接受有效响应时不消费第二项，不借 P 的旧消费完成 Q 报告；整组释放后原 canonical 按原请求键及输入唯一补报。

报告来源由保护库中的持久认领事件与当前任务 JSONL 重建，释放或失效清理 claim 不再使 first 从 Q 解绑。每次模型请求、最终登记与实际 owner_reply 发送均核实原来源、回复目标及子任务依赖。缺引用、损坏 JSON、缺失或不完整转交输入返回明确的 agent_report_input_invalid；本轮自身等待消费还核对 consumption.entryId 的实际工具条目包含该成员，不强制普通 targets 必须成为 reportTargets，不扩大后备或普通注入标记的格式校验范围。

## 源码与实际边界

直接核实 RuntimeAgentWait.result/reserve、core.claim/consume/complete、ParentDelivery.reportReady/wakeTerminal 和 Runtime.agentReportInput：终态预留不拆旧组；整组就绪后有界接管最多 20 项；toolResult.targets 保持本次集合，reportTargets 承载完整报告集合；所有外部消费成员需要本任务实际输入证明。完成标记已落盘的冷恢复只补原结果与 proof，缺 END 时保留最终 entry 并记未送达，均不重新调用模型。

agent_report.changed 事件的 task_id 由 claimTaskId 或 fallbackTaskId 持有，未认领报告不会绑定普通 origin 任务；认领和后备归并仍先核父会话、同来源与条件更新。新查询只恢复该任务曾经持有的来源，不赋予其他任务读取资格。当前 JSONL 范围限定任务 START 至下一 START/END，匹配实际 SDK call ID；跨任务复用 ID 不会引用旧结果，同轮复用逐条匹配实际目标及消费 entry。sameAgentReportSource 保持项目、原任务、会话、调度运行和钉版回复目标一致。

实际发送链没有旁路：Scheduler.sendOne 在 claim 与 channel.send 之前调用 Runtime.verifySources；owner_reply 调用 verifyAgentReportSources(taskId,true)，再核全部恢复报告的原回复目标。永久 attention 回归使用真实 Runtime/Driver、SDK 会话输入和 TelegramAdapter，复制受保护冷恢复档案，在 provider 已取得 Q 整组输入的窗口追加完成证明并撤销仅 first 使用的记忆；冷恢复清除整组 claim 后，普通 owner_reply 被实际发送器记 canceled，Q 私有最终正文的 FakeBotAPI 请求数为零，模型调用数不增加。这是本地适配器回归，不是实际 IM 送达验收。

## 亲跑证据与初审闭合

亲跑最终根工作区 npx tsx --test test/125-agent-wait-attention-report.test.ts test/125-agent-wait-core.test.ts test/125-agent-wait-recovery.test.ts test/125-agent-wait-report.test.ts：55/55，通过，零跳过。独立日志 /tmp/ruukoto-agent-wait-source-review-root-final.log；包含 attention 5 例、core 19 例、recovery 22 例、report 9 例。覆盖 P 介入问句、Q 仅等 second 的整组唯一回报、provider 失败原 canonical 补报、实际冷恢复拒发、报告核心仲裁及最窄调用方。

初审真实 fixture 中，缺引用与非法 JSON 正确拒绝，但 null 根/元素抛未分类 TypeError，缺 START、工具条目或完整 reportTargets 会被当作空闭包；原 9 类 probe 实际 2/9 通过，日志 /tmp/ruukoto-agent-wait-source-review-input-integrity-expanded-before.log。持久事件绑定和 JSON 边界校验修后，独立 foreign 9 类与自身消费输入 2 类共 11/11，通过；日志 /tmp/ruukoto-agent-wait-source-review-input-integrity-combined-final.log。新增接受条目循环中 false reportTargets 另有一条实际 TypeError 红例，存在性条件改为 !== undefined 后亲跑 1/1 通过，修前/修后日志分别为 /tmp/ruukoto-agent-wait-source-review-falsy-input-before.log 和 /tmp/ruukoto-agent-wait-source-review-falsy-input-final.log。

最小永久补丁复用既有 takeover 冷恢复 fixture，不新增 helper、依赖或生产层；原 completed/no-END 两例保留，追加 foreign 9 类坏输入、own entry 缺失/缺成员两例和 falsy 非数组一例，严格断言 agent_report_input_invalid。候选亲跑 22/22、零跳过后由实施者合入，最终根 55/55 已再次覆盖。补丁 /tmp/10-agent-wait-input-integrity-regression.patch。自身消费条目事后损坏的检查是同一个实际引用边界的窄补强；没有发现正常写入/恢复需要扩展到其他历史格式，不把它另记为 E8 新的需求阻断。

## 文档与既有审查范围

直接读取 core/runtime/agent-tools/channels 模块文档及 implemented 等待笔记，部分结果问句、完整 reportTargets 接管、保留旧消费、持久来源绑定、typed 坏输入拒绝与实际发送复核均与代码一致；相关提交前检查引用的测试路径真实存在。与上一增量清单相比，46 个既有文件哈希未变，清单逐项标出；原资源/工具拒绝、导入、schema/协议、TUI 和其他未变路径继续引用 10-implementation-review.md 与 10-delta-review.md，不宣称本次重审全仓。新增生产面集中在 agent-wait-tools/subagent-tools、core.agent-wait、runtime.agent-wait/runtime/parent-delivery，相关测试及上述四篇模块文档和决定笔记已复核。

读取实施者的最终自然证据 JSON 与日志：两产品原父轮均 interrupted，Q completed，只有一份可见合并结果和共享报告 proof，包含两份真实结果；3/3 中两例为实际 API、一例为离线代理。自然输入只提出业务要求，没有显式规定 agent_wait 工具名；该记录证明新输入中断后 Q 接手，不能扩称自然 API 已走父轮主动完成介入问句后的续接分支。Coding 的最终正文仍附过程说明，不记严格单段体验通过。读取最新 Linux 日志为原生 14/14，受控模型日志 3/3；这些不是本审查者亲跑。

实施者最终全量日志为 macOS 独占 38/38、应用 1393 通过/5 跳过、foundation 9 通过/1 跳过；应用批次加载早于永久追加 12 例，因此永久恢复由最终独立根回归及实施者 22/22 显式补验，不能写成这 12 例已在该全量内。静态日志包含正常命令及门禁结果；最终追加静态的归档由实施者绑定，本次没有重复运行。

## 未覆盖与交接

本审查没有亲跑全量、原生 worker、Linux 矩阵、真实 API 或实际 IM。实际 IM 原绑定送达、自然业务续接主观体验、严格单段汇报和 08 组合操作继续交拥有者及 11 联合验收；当前源码审查结论支持交 ready-for-human，不能代替产品验收记 resolved。schema 40 / 协议 24 继续使用独立新档案及配套客户端，保留旧档案。本审查及交接不授予提交、推送、部署或发布授权。
