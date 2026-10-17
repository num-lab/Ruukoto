# Agent Note: 个人 Agent 由 pi durable 持有运行状态

Status: proposed

拥有者已通过本次 Q1–Q18 访谈确认产品取舍，并在 Q19 确认完整方案；独立方案审查无未解决阻断。本文不表示已经迁移实现。有效要求与验收见[迁移规格](../../../../.scratch/personal-pi-durable/spec.md)，交接见[方案工单](../../../../.scratch/personal-pi-durable/issues/01-migration-plan.md)。

以 `f2e05fc` 复评后的[剩余工单与验收分工](../../../../.scratch/personal-pi-durable/remaining-work.md)承接本决定：当前真实流程先行验证，能力补齐后隔离验证正式制品，再执行完整验收及生产接管；不改变产品范围或降低恢复要求。

[档案与请求证据基础](../../implemented/architecture/2026-10-17-personal-durable-foundation.md)已作为隔离 API 实现；[服务检查](../../implemented/architecture/2026-10-17-personal-service-inspect.md)增加只读外部调用；[后台工作](../../implemented/architecture/2026-10-17-personal-background-work.md)提供空工具长期子会话及宿主生命周期 API；[模型工作入口](../../implemented/architecture/2026-10-17-personal-model-work.md)接通主会话的委派、查询和工作取消/身份关闭；[服务操作](../../implemented/architecture/2026-10-17-personal-service-operations.md)提供独立后台服务工作、单次审批及效果/停止核实。[Telegram 文本入口](../../implemented/architecture/2026-10-17-personal-telegram-entry.md)接入隔离向导的配对、固定来源与回复。[原入口服务权限](../../implemented/architecture/2026-10-17-personal-telegram-permissions.md)接通 Telegram 权限快照、宿主审批与限定长期授权。[子服务工作](../../implemented/architecture/2026-10-17-personal-subagent-service-operations.md)将受控 restart 接到原工作权限、取消与未知效果收尾。正式入口与其余能力仍按本方案推进，不能据此将迁移标为完成。

## 问题

[Linux 原生执行持久认领](../../implemented/architecture/2026-10-17-native-linux-execution-identity.md)补齐通用命令接入前的跨进程停止原语；[单次命令 worker](../../implemented/architecture/2026-10-17-personal-command-worker.md)提供自包含产物和显式运行依赖；[durable 受限命令](../../implemented/architecture/2026-10-17-personal-durable-commands.md)接入原工作、权限、未知暂停与本机核实；[完全访问命令](../../implemented/architecture/2026-10-17-personal-full-access-commands.md)补齐直接账户 scope、宿主回执及原工作恢复。

两个产品已经使用 pi SDK，但会话执行、任务队列、恢复、上下文压缩与工作流由 Ruukoto 持有。拥有者希望个人 Agent 采用 pi durable，减少今后维护自研执行底座的工作，同时保持 Coding Agent 的行为、数据与现有运行依赖。

Coding Agent 仍使用旧 runtime、agent、core、control、view 和 tui。仅迁移个人端不能删除这些共享实现；本次收益是个人端停止依赖和扩展它们，并退出个人端不需要的编码与兼容功能。不得以“全仓代码一定净减少”作为本方案的既得结果。

## 方案

个人端让 `@earendil-works/pi-durable` 持有 Conversation、Submission、Task、模型循环、工具任务、队列、恢复与压缩。宿主只保存个人业务事实和外部操作证据，不再用旧 Task 表或另一套状态机镜像 durable 的执行状态。Coding Agent 继续使用原有底座；共享仅保留确有两个调用方的传输、凭据、校验、原生隔离与操作协议等独立实现。

新个人端从空白档案开始，旧资料原地冻结归档；不导入旧历史、记忆、应用数据、日程、审批或在途执行，不新建旧格式兼容层。个人端保留 IM、引导式 CLI、定时任务、长期记忆、应用数据、技能/MCP、服务器管理和可复用的一层 SubAgent；退出开发会话、worktree 汇总、编码验证、旧工作流语言及定义库、GitHub 自动评审和旧客户端协议。

三种权限模式继续提供，默认自动审查；长期授权可查看、撤销。安全操作自动恢复，效果未知的写操作暂停所属工作，停止未核实保留占用。durable 的恢复不能代替外部副作用核实或 OS 进程停止证明；这些约束在宿主工具和工作控制中执行。

### 上游基线与责任

锁定已发布的 Pi `1.3.0`，tag commit 为 `71023aec1546d6d677a65669c5665c0927ce0dd0`。durable、pi-ai、chord 及实际直接导入的配套包在个人 app 独立声明版本；Coding 的 `0.85.1` 依赖保持。上游普通 dependencies 允许并存，仍需在真实安装和构建中验证解析路径，不跨版本传递 Pi 会话或 SDK 类型。

- [包声明](https://github.com/earendil-works/pi/blob/v1.3.0/packages/durable/package.json)与[发布记录](https://github.com/earendil-works/pi/releases/tag/v1.3.0)：框架仍属实验性，不能依赖未发布 main 的 API；本方案不使用 main 的 `compaction.modelOverrides`。
- [恢复规范](https://github.com/earendil-works/pi/blob/v1.3.0/packages/durable/docs/spec.md#52-effect-sandwich)：先记意图、执行效果、再记结果，不能保证任意外部效果 exactly-once。`requestId` 的去重范围是会话提交；默认不安全工具中断后返回错误，不等于宿主已阻止模型另起调用。
- [持久子代理示例](https://github.com/earendil-works/pi/blob/v1.3.0/packages/durable/test/examples/23-subagent-background.ts)：可复用会话与后台工作已有实现参考。宿主需要补充工作归属、权限与取消约束，不重造 Agent 执行循环。
- [SQLite 实现](https://github.com/earendil-works/pi/blob/v1.3.0/packages/durable/src/storage/sqlite/node.ts)：长期实例使用 SQLite；单进程拥有者锁由宿主负责。默认 WAL/NORMAL 的进程崩溃恢复不能被描述成最近提交抗断电保证。
- [模型请求实现](https://github.com/earendil-works/pi/blob/v1.3.0/packages/durable/src/harness/generation.ts)：`beforeRequest` 可以改写输入，普通异常又会被报告后继续，不能只因使用 durable 就声称输入可重建或失败必阻止请求。优先用持久 entries、documents 和 sections；额外改写必须在真正能拦截发出的边界保存输入证据。

以上是源码与规范核查，不是集成测试结果。上游提供执行、存储与扩展机制，IM、权限、业务调度、长期记忆和服务管理仍由个人产品负责。

### 维护边界

实现先放在已有 `apps/ruukoto` workspace，替换其对共享 CLI/Runtime 的装配。不会为了对称再复制七个包。必须共用的底层实现按已有 exports 暴露；只有直接依赖旧业务状态妨碍复用时才做最小提取，同时回归 Coding 调用方。

模型上下文和历史以 durable 存储为新个人端权威，不再双写旧 pi JSONL。该变化只适用于新个人端；Coding 和旧归档仍遵守原格式。外部产物、凭据和独立业务数据库有自己的写入边界，不能声称与 durable commit 跨存储原子。

长期 SubAgent 的持久身份与一次工作的执行分开：索引指向 durable Conversation，每次委派以 durable Task/Submission 承担恢复与结果。一个 SubAgent 同时只服务一项工作，取消收尾前不能重新占用。工作取消不得关闭身份、删除历史或波及其他工作。

### 既有笔记审计

按 pi durable、个人 Agent、两个产品、主会话、恢复、授权和模型输入检索 active notes；`rejected/` 当前不存在，未发现同题迁移提案。没有完全吸收或应删除的旧篇。

| 笔记范围 | 关系与处理 |
| --- | --- |
| [两个产品](../../implemented/architecture/2026-10-02-two-agent-products.md)、[同仓分包](../../implemented/architecture/2026-10-11-in-repo-workspace-packages.md) | 部分重叠：新个人端拟退出共同运行时与协议；两产品独立运行和 Coding 既有底座保留。互链，实施时再同步实际依赖图。 |
| [历史与上下文](../../implemented/architecture/2026-09-19-preserve-session-history.md) | 部分重叠：保留不可改写历史和可重建输入，拟改变新个人端的权威存储；旧档案与 Coding 的 JSONL 规则保留。 |
| [SubAgent 恢复](../../implemented/architecture/2026-10-05-subagent-restart-recovery.md) | 部分重叠：新个人端安全工作改为自动恢复；Coding 仍按旧恢复规则。 |
| [保留开发会话](../../implemented/feature/2026-10-05-ruukoto-keeps-dev-sessions.md)、[Agent 工作流](../../implemented/feature/2026-10-12-agent-workflows.md) | 部分重叠：个人端退出这些入口与语言；Coding 仍保留。 |
| [桌面客户端提案](2026-10-15-desktop-client.md) | 部分重叠：新个人端不兼容桌面控制协议，原个人目标需求由本次确认收窄；桌面 Code 能力继续。 |
| 工作委托、复用与关闭、整项取消、来源能力、角色快照、IM 审批与最终报告、长期授权、访问模式、自动审查、完全访问、服务 helper、原生隔离、通用调度、MCP、应用数据 | 沿用个人业务与安全要求，底层记录方式按本规格重建；不宣称旧实现可以不经拆分直接接入。 |
| 旧实例导入、工作区归属、会话分支、手动压缩、worktree 汇总、编码步骤/验证、GitHub 评审、工作流交互与等待让出 | 不作为新个人端实现来源；原有 Coding、旧归档及既有产品证据保留，本次不吸收这些机制。 |
| 浏览器、产物导出、后台 bash 生命周期提案和桌面其他界面细节 | 不改变其独立决定，不借迁移增删这些独立需求；个人端通用工具的适用性在实施的能力清单中核实。 |

## 备选方案

- 在旧 Runtime 内包装 durable：可以保留现有客户端和任务查询，但需要协调两套任务、恢复与历史记录，违背减少个人端底座维护的目标。
- 两产品一起迁移：长期可能删除更多旧底座，但改变 Coding 的行为和数据，超出拥有者确认的边界。
- 保留完整个人端兼容与旧数据导入：切换体验更连续，但要维护旧协议、历史读取与执行迁移；拥有者选择全新实例、只归档旧资料。
- 删除长期 SubAgent 或简化为单一权限模式：宿主代码更少，但拥有者明确要求保留可复用子 Agent、三种模式和长期授权，因此按 durable 执行原语重新装配这些业务规则。
- 先设选型去留验证：可先判断实验性框架收益，但拥有者已决定采用；验证用于证明实现与上线条件，不重新决定选型。

## 验收标准

[规格的验收矩阵](../../../../.scratch/personal-pi-durable/spec.md#验收矩阵)同时证明个人功能、故障恢复、权限和 Coding 不回归。个人端运行入口不能装配旧 Runtime/Driver/Task Store 或旧控制协议；不能以 SDK 已有测试替代宿主跨崩溃窗口的验证。

正式切换必须在保留能力全部达标后进行：停用旧服务自动重启，核实旧连接与执行单元停止，冻结档案并登记接管边界，重新配置新实例，拒绝旧积压自动执行。回退只回退代码，旧版本也使用新的空白档案并重新配置；原档案不重新投入执行，避免平台水位之外的库内入站、通知和计划自动恢复。

## 风险

框架 API 仍可能变化，固定版本只控制升级时点，不消除升级成本。两种 Pi 版本和两套产品运行机制会同时存在；减负要求个人端采用上游机制，而不是在其外围复制旧底座。

保留三种权限、长期授权、复用 SubAgent 与可靠外发意味着宿主仍有必须维护的业务代码。主要风险是未知效果被当成普通失败后重试、取消与子 Agent 复用竞态、旧入口在切换后继续运行，以及模型输入改写没有留下记录；这些均列为阻断切换的验收项。
