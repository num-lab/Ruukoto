# Agent Note: 结构化提问登记后由可信回答续接

Status: proposed

## 问题

普通聊天能提问，但没有持久问题、选项、回答回执和唯一续接；重连、多个客户端或个人IM跨轮时容易错配。个人main的输入共用同一队列，工具等待回答会占住接收回答所需的执行通路。

## 方案

Coding 部分由[持久问题与可信续接](../../implemented/feature/2026-10-21-coding-owner-questions.md)落地；本篇保留个人 durable 的待实施方案和两端共享语义，个人入口不因 Coding 落地而取得新能力。

ask_user提交问题后立即返回pending，结束本轮，拥有者从专用问题卡片/原菜单回答后继续；不新增Task状态，不阻塞个人main。个人首版仍按单选或自由文本规划，Coding 的多选、推荐、说明与跳题由[题型扩展](../../implemented/feature/2026-10-21-owner-question-choice-types.md)取代；每会话一个待答批次，具体字段、预算、资格和状态位于[共享规格](../../../../.scratch/agent-tool-completion/spec.md#2-结构化提问)。

问题是业务澄清，不是工具批准。只向真实拥有者主会话开放，Plan可以用；子Agent向上级报告，工作流保留原ask。已登记问题与实际回答全文、来源和权限进入持久记录及模型请求证据，不能靠提示词或前端内存证明已经回答。

Coding将问题消费、答案、下一Task和事件放入原入队事务；个人将answer-admission与唯一续接Task同commit提交，再以固定键接回原Submission。两端复用协议含义，分别使用既有存储与来源核实。已确认回答的应答丢失按原回执恢复，避免answered与无后续执行之间的断链。

普通新消息仍是聊天，不能按“yes”或当前存在问题推断为回答。只有可信问题入口能消费，个人绑定原平台/账号/owner/代次；后续执行沿实际回答时的权限，不继承创建时的一次批准。取消、入口失效和双客户端竞争在消费事务仲裁。

## 既有笔记审计

按提问、workflow_questions、owner_input、main队列与渐进交互检索proposed/implemented；rejected目录不存在。[工作流回答与送达](../../implemented/feature/2026-10-13-workflow-owner-input-and-delivery.md)部分重叠，复用版本、幂等与真实来源原则，run/step记录不接管普通会话；[等待与报告](../../implemented/architecture/2026-10-14-agent-wait-and-report-ownership.md)部分重叠，沿用让出资源与独立新输入，不改变报告权；[渐进交互](../../implemented/process/2026-10-14-progressive-human-interaction.md)约束客户端；[个人原入口接纳](../../implemented/architecture/2026-10-17-personal-telegram-entry.md)和[个人本机管理](../../implemented/architecture/2026-10-17-personal-local-management.md)持有来源与恢复。以上互链保留原决定。审批、后台命令与Demo输入命中属无关机制，没有重复提案需吸收或驳回。

## 备选方案

- 普通文本提问：改动最少，所有入口都能显示；缺少稳定问题引用、选项与回答回执，不能给重连和双客户端明确保证。
- 工具Promise等待答案：模型可直接收到工具结果并继续原轮，接近普通函数；个人主聊天可能互等，也延长目录占用，因此使用持久非阻塞续接。
- 复用ApprovalGate：已有待处理UI和消费机制；回答不能授予执行权限，审批也不该因普通聊天失效而改变，故共享交互样式但不共用记录。
- 直接复用工作流问题表：已有版本和答案事务；其身份是run/step，给普通聊天造虚拟工作流会增加错误归属，因此只复用可抽取的纯校验和UI部件。

## 验收标准

- 创建重复、一个待答批次、双客户端回答、回答/取消竞争、丢答及重启续接都有最窄回归；事务失败不能出现已回答而没有唯一后续任务。
- 个人main在待答期间继续接受普通聊天；只有原宿主菜单回复可答，跨平台、换代及伪造来源不能消费。
- 题目、答案及原始来源可从历史/证据重建，回答不能消费工具审批；新模式只在新续接中生效。
- TUI/Desktop/个人CLI与IM按真实入口体验验收；具体计划见[工单](../../../../.scratch/agent-tool-completion/issues/02-coding-owner-questions.md)。

## 风险

新增跨客户端未决状态与一次续接仲裁；只返回pending会多一轮模型调用，但避开主会话互等。首版不把普通聊天自动关联为回答，也不支持多个并行待答批次；频繁出现必须并行的问题后才重访批次数量，不能自动猜答解除阻塞。
