# Coding Agent 消息重排与引导

Status: in-progress

## 目标与边界

实施[已确认产品规格](../spec.md)，让普通 Code 主会话在桌面与 TUI 中重排待执行消息、显式引导当前任务，并将未赶上的引导按收到顺序放到普通队首。完整契约与备选由[决策记录](../../../.agents/notes/implemented/feature/2026-10-28-coding-message-control.md)持有；本工单只组织实施与证据。

拥有者于 2026-10-28 确认访谈并提交初版方案，2026-10-29 要求按过度设计审查结论修订，并随后授权接手实施；已提交初稿为 `081fe491`。本次从 SDK 门槛开始，尚未改产品代码；接手不授予提交、推送、切换档案或重启实例权限。

不改个人 Agent、SubAgent 会话、工作流步骤或活动 Scheduled 会话的交互资格；不增加消息编辑、批量操作、拖拽或模型工具。仅普通聊天输入可转引导；继续与问题回答保留原有独立执行、来源、回执及重排，不增加它们转引导的能力。

## 方案

### 实施顺序

| 步骤 | 改动与出口 | 主要落点 |
| --- | --- | --- |
| 1 | 用窄 SDK 契约检查核实源 Task ID、all、边界预留与取消竞争、同步停止守卫及历史刷新。清理限制及公开接口修补见 SDK 证据；受影响的接入方案复审后恢复实施，不改用正文匹配。 | `packages/agent/src/driver.ts`、`test/sdk-steering-contract.test.ts` |
| 2 | 增加队列顺序、修订与引导表，递增 schema 并沿用旧版拒绝／新数据目录规则，不新增迁移。所有入队来源与出队、取消、路由切换都使用同一顺序事实；加入异步核实后的队首复查。 | `packages/core/src/db.ts`、`store.ts`、`types.ts`、`packages/runtime/src/runtime.ts` 及内部提交调用方 |
| 3 | 普通新输入复用 submit 与既有 Task 接纳，队列转引导复用原 Task；持久路由关联源 ID 与目标 JSONL entry，处理停止、取消、恢复和队首回退。分支只补附件来源冻结；导入只登记新表排除并拒绝相关源记录。 | runtime 引导协调、`owner-attachments.ts`、core 存储／历史、`branch-session.ts` 与既有导入表策略 |
| 4 | 接入带源 Task ID 的 SDK user 消息，扩展当前任务必留输入、Jev、压缩与附件恢复；不新增 prompt 快照执行门槛。普通 Code submit 移除等待时自动 requestStop 的旧分支；显式引导使未消费审批失效并仅解除等待，保持同一 Task、资源和报告规则。 | `packages/agent/src/driver.ts`、`context-selector.ts`、`context-assembly.ts`、审批／附件装配，runtime submit／wait／恢复接口 |
| 5 | 接入重排、普通输入引导与队列转换；队列和路由事实进入现有快照、事件与 Task 查询，更新协议、校验、待核实操作白名单及双客户端恢复。新消息沿用 SubmissionGuard；不先建设所有动作共用的回执查询。通配 exports 可覆盖时不改 package.json。 | `packages/control/src/ops.ts`、`protocol.ts`、`server.ts`、`pending-requests.ts`、`submission.ts`、core 视图、共享 view，桌面 DESKTOP_OPS／host 与 TUI |
| 6 | 桌面排队区与显式引导；TUI `/queue`、`/steer` 与帮助补全。用源 Task ID 区分原要求和同文多条引导，按实际开始／接入位置显示，实时与冷恢复一致。特殊输入不显示转换动作，原答案卡保持有效；保留焦点、无障碍和未知结果恢复。 | `apps/desktop/src/renderer/composer.tsx`、`conversation.tsx`、`code-writes.ts`，`apps/desktop/src/main/submissions.ts`／桥接，`packages/tui/src/tui/app.ts`、`commands.ts`、共享 view |
| 7 | 同步用户文档、决策与命令检查说明，执行定向验证、独立实现审查和真实双客户端／模型验收。 | 下列文档与验证入口 |

实施保持单写入者；并行只读审查可以同时进行。上表是现有文件导航，实施者须按实际接口检索全部调用方，不能因清单未列到就漏改。不要另起通用消息平台、队列框架或迁移框架。

版本切换必须遵守规格中的新档案边界：旧 SQLite、JSONL、产物与凭据原地保留，先由原版本核实停止旧任务和受管进程；新数据目录不共用旧凭据目录，历史不会自动出现在新实例。不自行恢复 v53 兼容或以换档案解除旧电脑占用。

### 控制面与可见失败

新输入沿用 submit／SubmissionGuard、Task 请求键及 find_task，引导意图和固定目标纳入提交摘要。队列转换在事务内核实源 Task、目标和修订；同一转换已接纳时返回该源输入的现状，丢答沿原 Task 查询核实，不复制正文另建任务。原请求的固定目标已经变化时，只展示实际状态或冲突，不改绑目标或自动重发转换。重排采用带修订的顺序赋值，丢答读取实际队列，不自动重放相对上移／下移；不为纯顺序修改新建动作回执账本或通用查询接口。

目标结束属于正常队首回退，不作为失败；消息已开始、来源不符、队列版本冲突则不应用并返回实际状态。新输入丢答保留原请求和附件，按原键核实，不能换键重发。只有必要输入记录或路由归属不可核实时阻断受影响执行；可选 prompt 诊断快照缺失沿现有报告路径处理。

复用带 code 的错误模式，最少区分不存在、参数错误、不允许的会话／来源、已开始执行、队列冲突、请求冲突、后台停止及持久记录不可核实。只处理自身持有的状态；损坏或跨存储冲突暂停受影响会话，保留输入与证据，给出核实入口，不自动执行另一条路径。

### 文档落点

实现时同步 `docs/modules/runtime.md`、`core.md`、`control.md`、`agent-context.md`、`agent-tools.md`、`view.md`、`desktop.md`、`tui.md` 中实际改变的行为；不修改模块地图，除非实际增加架构模块。新增 TUI 命令须同步 `README.md`、`docs/usage.md`、`docs/development.md`、命令补全／帮助及 `.agents/skills/pre-push-checks/SKILL.md` 的相关检查入口。

相关 implemented 笔记本轮仅补提案互链，仍描述现行行为；实施后再同步有效事实并将本 proposed 转 implemented。模型可见的审批／等待结果按 agent-facing-text 验证真实快照，不把调研文字直接复制进提示。

## 进展与交接

- 当前角色与阶段：工程实现、定向验证、文档同步与独立实现审查均已完成，待真实双客户端＋真实模型验收。2026-10-29 接手基点为 `5c55e96b`。README 常驻预算由 3350 提至 3420：新增 `/queue`、`/steer` 两条命令说明属本层内容，无其他层可搬走。
- 当前内容：schema 54（`queue_order`/`queue_revision`/`task_guidance`）与协议 v45 落地；runtime 提供 `guidance` 提交、`steerTask`、`reorderQueue`、`getTaskQueueDetail`；控制面新增 `task_queue`/`queue_reorder`/`steer_task` 与 `session.queue_changed`/`task.guidance` 事件；普通 dev submit 不再自动 `requestStop(owner_input)`；共享 view 按 `ruukotoSourceTaskId` 归属投影、排除待接入源、已接入气泡按接入时刻定位；桌面有紧凑排队面板与发送为引导开关，TUI 有 `/queue`、`/steer`。新增 `test/queue-guidance-store.test.ts`、`test/queue-guidance-runtime.test.ts`；`npm run check:static` 与相关回归（并发、幂等重连、控制面穷举、SDK 契约、桌面/视图）全绿。
- 独立实现审查（code-review 双轴）已执行并修复：规范轴发现 TUI 面板 `as unknown as QueueDetail` 类型逃逸、桌面板可重排下标空间错误、store 重复 owner_questions 查询、吞错注释不完整、队列二次拉取；规格轴发现 R6 无运行目标时整个引导提交被拒（目标解析把源自身当目标）、排队输入仍按创建时间进气泡、回退项被加「引导回退」标签（违反规格"不为正常回退新增状态标签"）、受理后迟到达审批仍可挂起等待（R5 竞争）、首尾禁用下标错。修复：目标解析排除源且锚定仅限非排队任务；EventFlow 对 queued/未开始输入不落气泡、已开始按 `startedAt` 定位、附件暂存随气泡落位；approval-gate 对已受理引导的任务在登记同事务即时失效迟到审批；DESKTOP_OPS 补三个新 op；旧语义测试（普通输入中断等待）改为显式引导触发或按排队可见性断言。审查后 306+ 定向用例、`check:static`、`check:docs` 全绿。
- 下一角色与动作：真实双客户端＋真实模型验收（引导进下一请求、不重复执行、队首回退、审批/等待行为），缺前提不记通过。
- 阻塞与恢复条件：无待拥有者产品决定；真实环境验收仍待执行，门槛用例不替代产品验收。

## 验收与证据

### 实施后的工程验收

先新增最窄的 SDK、core/runtime 与客户端回归，再按实际改动面选择现有文件。下表是需要证明的集合，不是每次全量重跑命令。

| 对应要求／边界 | 证据与现有定向入口 |
| --- | --- |
| R1、R2、R6：任意排序、普通追加、回退队首 FIFO、重排与旧队首异步核实竞争、内部汇总位置、暂停整理不唤醒 | 新增队列定向用例；`test/01-concurrency.test.ts`、`test/03-lifecycle.test.ts`、`test/94-task-ending.test.ts` |
| R3、R4、R9：同文消息用不同源 Task ID、新写／转换重试不重复、源不独立执行、JSONL 与 SQL 崩溃窗口、SDK 残余清理、收尾竞争；prompt 快照失败不新增阻断 | 新增引导定向用例；`test/02-idempotency-reconnect.test.ts`、`test/04-crash-recovery.test.ts`、`test/history-recovery.test.ts`、`test/12-reconnect-pending.test.ts` |
| R1、R5：普通 Enter 不解除结果等待；显式引导解除等待但 Task 身份不变；pending／approved 失效与消费竞争、同批迟到审批、已消费操作继续、不停止后台或丢报告／占用 | `test/08-approvals.test.ts`、`test/63-approval-gate.test.ts`、`test/64-tool-op-ledger.test.ts`、相关 `test/125-agent-wait*.test.ts`、`test/background-wait.test.ts` |
| R8：原要求和多条引导一起必留、Jev 输入、压缩后恢复、同文多附件不串、目标权限不变、分支附件来源冻结；继续与答案不得转引导且原入口保持有效 | 新增当前任务输入集与资格断言；`test/60-context-prefix.test.ts`、`test/61-context-compaction.test.ts`、`test/68-context-format.test.ts`、`test/desktop-attachments.test.ts`、`test/102-branch-session.test.ts`；问答原用例按实际影响补跑 |
| schema／协议：新档案表约束；全部旧版与新版原样拒绝且不建表、不写版本、不联网；旧客户端明确版本不兼容 | 新增旧档案字节／SQL 不变断言；`test/05-overflow-db.test.ts`、`test/66-control-seam.test.ts`、实际 schema／导入用例 |
| R9 与界面：快照／事件同序、丢答核实、跨客户端冲突；原要求＋两条同文引导逐条保留，问题回答任务中的普通引导不被误替换成答案卡；A 回答后按重排次序显示 C、B，实时／重连／冷恢复一致 | `test/36-event-flow-state.test.ts`、`test/37-view-browser.test.ts`、`test/13-tui-state.test.ts`、`test/14-tui-app.test.ts`、`test/15-tui-pty.test.ts`、`test/40-desktop-creation.test.ts`、`test/desktop-composer.test.ts`、`test/desktop-message-actions.test.ts` |

每处行为变化配最窄有效用例，不能只断言 SDK 被调用；关键竞态选代表性负例验证断言，不要求逐条撤实现。静态检查运行 `npm run check:static`；worker、桌面构建及平台停止检查按实际影响运行，不因本功能新增跨实例导入验收流程。完整检查仍按仓库适用条件选择。

### 实施后的产品与真实环境验收

产品验收遵循规格中的双客户端清单。真实模型在显式开关及既有模型配置前提下核对：工具批次中的引导在下一请求出现，原要求仍在，带附件可读，连续纠正同批按序，没赶上后的下一任务确实是队首回退消息。真实长工具不被强停，真实审批与等待的行为符合 R5；操作效果计数须证明没有重复执行。原生停止涉及平台时，macOS 本机与 `ssh tx` 的 Linux 隔离环境分别验证，不能把模型替身或源码检查记作真实模型／真实平台通过。

### 本轮规划证据

本次 `npm run check:static`、规划文件相对链接／段落／行尾检查及独立复审通过，详见[当前审查记录](../evidence/plan-review.md)。产品行为与实现验收未执行，规划检查不等于本次新行为已验证。

初版在 2026-10-28 通过独立审查并提交为 `081fe491`；2026-10-29 按五项过度设计结论修订后，由 `/root/revision_review` 独立复审、`/root/lean_runtime_review` 运行时限定复审，均通过。实现审查与真实体验验收仍待后续实施。

### 接手后的 SDK 门槛

`npx tsx --test test/sdk-steering-contract.test.ts` 在 macOS、Node 24.15.0、Pi 1.3.0 上通过 10 条契约检查，独立修订复审无剩余阻断；尚未接线产品 runtime。新测试和交接材料的静态检查、独立核实及未覆盖项由[SDK 门槛证据](../evidence/sdk-contract.md)持有；不沿用上一轮的静态检查结论。

## Comments

2026-10-28：拥有者最后确认全部访谈取舍；Q10 以“队首、任务结束后立即发送”取代早期队尾／未送达建议。方案必须遵守现有暂停、停止和占用约束，未授权自动启动产品实施。

2026-10-28：独立审查发现初稿的自动迁移违反既有严格版本决定，已删除；补齐普通提交不再中断等待、输入身份和执行归属分离，以及聊天接入次序。复审无剩余阻断，交接实施者；既有不兼容切换规则没有翻转。

2026-10-29：拥有者要求修订过度设计。移除特殊输入转引导、跨实例引导导入、独立 guidance ID、prompt 快照执行门槛与逐条变异验证；保留持久接纳、队首回退、SDK 清理、审批竞争及多 user 投影。不预设通用动作回执账本，原 Task 查询与提交核实继续复用。

2026-10-29：拥有者要求由当前 Agent 接手工单。步骤 1 的正向契约成立，但实际 SDK 已取出未落历史的输入无法由公开清理撤回，触发工单原定的前提失败出口。保存窄用例与证据，退回 planning；未越过门槛修改产品、版本或实例。
