# Coding Agent 消息重排与引导

Status: ready-for-agent

## 目标与边界

实施[已确认产品规格](../spec.md)，让普通 Code 主会话在桌面与 TUI 中重排待执行消息、显式引导当前任务，并将未赶上的引导按收到顺序放到普通队首。完整契约与备选由[决策草案](../../../.agents/notes/proposed/feature/2026-10-28-coding-message-control.md)持有；本工单只组织实施与证据。

拥有者于 2026-10-28 确认访谈全部行为，最后一次确认包含排队区、审批／等待解除及多条引导同批输入；随后明确要求提交本轮方案。当前范围为规划材料及其 Git 提交，不实施产品代码、不推送或重启实例。

不改个人 Agent、SubAgent 会话、工作流步骤或活动 Scheduled 会话的交互资格；不增加消息编辑、批量操作、拖拽或模型工具。普通继续输入、问题回答、附件及来源不能作为简化代价丢弃。

## 方案

### 实施顺序

| 步骤 | 改动与出口 | 主要落点 |
| --- | --- | --- |
| 1 | 先用窄 SDK 契约检查证明公开 steer 接口保留稳定消息元数据、all 批次与中止清理行为；定义源 Task／目标 Task／路由与阶段。失败则修订方案并复审，不能改用正文匹配。 | `packages/agent/src/driver.ts`、新增定向用例 |
| 2 | 增加队列顺序、修订与引导表，递增 schema 并沿用旧版拒绝／新数据目录规则，不新增迁移。所有入队来源与出队、取消、路由切换都使用同一顺序事实；加入异步核实后的队首复查。 | `packages/core/src/db.ts`、`store.ts`、`types.ts`、`packages/runtime/src/runtime.ts` 及内部提交调用方 |
| 3 | 实现新引导／队列转引导的幂等接纳、完整输入来源、源独立执行收束、收尾封闭和队首批次回退；接入停止、恢复、分支、导入与取消。 | 新增窄 runtime 协调模块，复用 `owner-attachments.ts`、core 历史／问题／导入与分支接口 |
| 4 | 接入稳定 SDK user 消息；以 JSONL、选择记录和请求快照核实归属；扩展当前任务必留输入、Jev、压缩与附件恢复。普通 Code submit 移除等待时自动 requestStop 的旧分支；显式引导接入审批屏障及仅解除等待，保持同一 Task、资源和报告规则。 | `packages/agent/src/driver.ts`、`context-selector.ts`、`context-assembly.ts`、审批／附件装配，runtime submit／wait／恢复接口 |
| 5 | 增加拥有者控制面写操作、动作回执查询、队列与路由快照／事件字段；更新协议版本、参数校验与丢答核实。接入待核实 op 白名单、SubmissionGuard、桌面 DESKTOP_OPS／host 分发和 TUI 重连；核实通配 exports 能覆盖新模块，无需时不改 package.json。客户端不能指定内部来源或伪造接入阶段。 | `packages/control/src/ops.ts`、`protocol.ts`、`server.ts`、`pending-requests.ts`、`submission.ts`、`packages/core/src/types.ts`／`views.ts`、view 快照与 `state.ts`／`event-flow.ts`、桌面桥接及 TUI 恢复入口 |
| 6 | 桌面排队区与显式引导；TUI `/queue`、`/steer` 与帮助补全。分开输入身份与执行目标，原要求、同文多条引导和答案不按 targetTaskId 合并；答案卡只替换自身输入。待发消息移出聊天流，开始／接入后按实际证据排序，实时与冷恢复一致；保留焦点、无障碍和未知结果恢复。 | `apps/desktop/src/renderer/composer.tsx`、`conversation.tsx`、`code-writes.ts`，`apps/desktop/src/main/submissions.ts`／桥接，`packages/tui/src/tui/app.ts`、`commands.ts`、共享 view |
| 7 | 同步用户文档、决策与命令检查说明，执行定向验证、独立实现审查和真实双客户端／模型验收。 | 下列文档与验证入口 |

实施保持单写入者；并行只读审查可以同时进行。上表是现有文件导航，实施者须按实际接口检索全部调用方，不能因清单未列到就漏改。不要另起通用消息平台、队列框架或迁移框架。

版本切换必须遵守规格中的新档案边界：旧 SQLite、JSONL、产物与凭据原地保留，先由原版本核实停止旧任务和受管进程；新数据目录不共用旧凭据目录，历史不会自动出现在新实例。不自行恢复 v53 兼容或以换档案解除旧电脑占用。

### 控制面与可见失败

提供会话队列查询／重排、新输入引导、现有 queued 输入转引导，以及幂等动作结果查询；具体 op 名沿当前仓库命名。写操作携带稳定请求键；重排与转换携带所见队列修订，先按动作回执仲裁重试，再检查当前资格和修订。目标结束属于正常队首回退，不作为失败；消息已开始、来源不符、队列版本冲突则不应用并返回实际状态。新输入丢答保留原请求和附件，按原键核实，不能换键重发。

复用带 code 的错误模式，最少区分不存在、参数错误、不允许的会话／来源、已开始执行、队列冲突、请求冲突、后台停止及持久记录不可核实。只处理自身持有的状态；损坏或跨存储冲突暂停受影响会话，保留输入与证据，给出核实入口，不自动执行另一条路径。

### 文档落点

实现时同步 `docs/modules/runtime.md`、`core.md`、`control.md`、`agent-context.md`、`agent-tools.md`、`view.md`、`desktop.md`、`tui.md` 中实际改变的行为；不修改模块地图，除非实际增加架构模块。新增 TUI 命令须同步 `README.md`、`docs/usage.md`、`docs/development.md`、命令补全／帮助及 `.agents/skills/pre-push-checks/SKILL.md` 的相关检查入口。

相关 implemented 笔记本轮仅补提案互链，仍描述现行行为；实施后再同步有效事实并将本 proposed 转 implemented。模型可见的审批／等待结果按 agent-facing-text 验证真实快照，不把调研文字直接复制进提示。

## 进展与交接

- 当前角色与阶段：方案者；产品访谈已确认，源码事实已并行只读核实，独立方案审查与双客户端专项复审通过，无剩余阻断。
- 当前内容：审查基点及规划阶段 HEAD 为 `ebbfc255`（`fix(desktop): 输入框随内容自动增高`）；规划开始时工作区干净。本轮新增范围为 `.scratch/coding-message-control/`、新 proposed 笔记和四篇旧笔记的提案互链，无产品代码改动；最终交接快照及审查范围见[方案审查记录](../evidence/plan-review.md)。
- 下一角色与动作：实施者按步骤 1 开始 SDK 契约检查，失败则退回方案者修订并复审。工单已具备交接条件，本轮不自动开始实施，不将 ready-for-agent 解释为提交、推送或部署授权。
- 阻塞与恢复条件：无待拥有者产品决定；技术审查阻断须在本工单修订并复审，不能静默收窄已确认行为。

## 验收与证据

### 实施后的工程验收

先新增最窄的 SDK、core/runtime 与客户端回归，再按实际改动面选择现有文件。下表是需要证明的集合，不是每次全量重跑命令。

| 对应要求／边界 | 证据与现有定向入口 |
| --- | --- |
| R1、R2、R6：任意排序、普通追加、回退队首 FIFO、重排与旧队首异步核实竞争、内部汇总位置、暂停整理不唤醒 | 新增队列定向用例；`test/01-concurrency.test.ts`、`test/03-lifecycle.test.ts`、`test/94-task-ending.test.ts` |
| R3、R4、R9：同文不同消息、新写／转换幂等、源任务不独立执行、稳定 SDK 元数据、JSONL 与 SQL 各崩溃窗口、SDK abort 后清理、接纳与收尾竞争 | 新增引导定向用例；`test/02-idempotency-reconnect.test.ts`、`test/04-crash-recovery.test.ts`、`test/history-recovery.test.ts`、`test/12-reconnect-pending.test.ts` |
| R1、R5：普通 Enter 不解除结果等待；显式引导解除等待但 Task 身份不变；pending／approved 失效与消费竞争、同批迟到审批、已消费操作继续、不停止后台或丢报告／占用 | `test/08-approvals.test.ts`、`test/63-approval-gate.test.ts`、`test/64-tool-op-ledger.test.ts`、相关 `test/125-agent-wait*.test.ts`、`test/background-wait.test.ts` |
| R8：原要求和多条引导一起必留、Jev 输入、压缩后恢复、同文多附件不串、目标权限不变、继续与答案来源完整、分支／导入保真 | 新增当前任务输入集断言；`test/60-context-prefix.test.ts`、`test/61-context-compaction.test.ts`、`test/68-context-format.test.ts`、`test/desktop-attachments.test.ts`、`test/owner-questions.test.ts`、`test/owner-question-clients.test.ts`、`test/owner-question-import.test.ts`、`test/102-branch-session.test.ts`，再按实际导入改动加原导入文件 |
| schema／协议：新档案表约束；全部旧版与新版原样拒绝且不建表、不写版本、不联网；旧客户端明确版本不兼容 | 新增旧档案字节／SQL 不变断言；`test/05-overflow-db.test.ts`、`test/66-control-seam.test.ts`、实际 schema／导入用例 |
| R9 与界面：快照／事件同序、丢答核实、跨客户端冲突；原要求＋两条同文引导＋一个回答转引导逐条保留；答案卡只替换自身；A 回答后按重排次序显示 C、B，实时／重连／冷恢复一致 | `test/36-event-flow-state.test.ts`、`test/37-view-browser.test.ts`、`test/13-tui-state.test.ts`、`test/14-tui-app.test.ts`、`test/15-tui-pty.test.ts`、`test/40-desktop-creation.test.ts`、`test/desktop-composer.test.ts`、`test/desktop-message-actions.test.ts` |

每条新增回归须证明去掉对应修复或构造负例会失败，尤其不能只断言 SDK 接口被调用。静态检查运行 `npm run check:static`；worker、桌面构建及平台停止检查按实际影响运行。没有拥有者明确要求、CI 诊断或无法收窄的全仓影响，不跑完整 `npm run check`。

### 实施后的产品与真实环境验收

产品验收遵循规格中的双客户端清单。真实模型在显式开关及既有模型配置前提下核对：工具批次中的引导在下一请求出现，原要求仍在，带附件可读，连续纠正同批按序，没赶上后的下一任务确实是队首回退消息。真实长工具不被强停，真实审批与等待的行为符合 R5；操作效果计数须证明没有重复执行。原生停止涉及平台时，macOS 本机与 `ssh tx` 的 Linux 隔离环境分别验证，不能把模型替身或源码检查记作真实模型／真实平台通过。

### 本轮规划证据

工程验收：规划文件的 `npm run check:static` 已通过，文档修订后追加笔记／文档检查；完整结果与最终交接快照由[方案审查记录](../evidence/plan-review.md)持有。产品行为与实现验收未执行，因为本轮只制定方案。已有材料来自作者及只读调研子代理，覆盖当前 Task FIFO、SDK 1.3.0 时序、前端入口、等待／审批与来源；这些是设计依据，不是新增行为测试通过证据。

方案审查：2026-10-28，独立审查者 `/root/plan_review` 复审通过；客户端专项审查者 `/root/input_facts` 对投影与聊天顺序的限定复审通过。审查对象为本规格、决策草案、工单及所引用源码，原阻断和修正见[记录](../evidence/plan-review.md)。复审后仅同步交接状态、证据与措辞，不改变产品决定或关键技术契约。实现审查与真实体验验收均待后续实施，不提前给出通过结论。

## Comments

2026-10-28：拥有者最后确认全部访谈取舍；Q10 以“队首、任务结束后立即发送”取代早期队尾／未送达建议。方案必须遵守现有暂停、停止和占用约束，未授权自动启动产品实施。

2026-10-28：独立审查发现初稿的自动迁移违反既有严格版本决定，已删除；补齐普通提交不再中断等待、输入身份和执行归属分离，以及聊天接入次序。复审无剩余阻断，交接实施者；既有不兼容切换规则没有翻转。
