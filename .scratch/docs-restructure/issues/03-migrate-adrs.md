Status: resolved

# 把 docs/adr/ 迁移为 .agents/notes，删除 docs/adr/

依赖：02。范围见 [spec](../spec.md)。下面的逐篇映射已经拥有者复核（2026-10-09）。

## 规则

- 每篇 ADR 对应一篇 `implemented/<class>/<日期>-<slug>.md`。日期取 ADR 的「日期」行；0001–0008 没有日期行，取 git 首次加入的日期。
- `## 决定` 用现在时写出各段修订合成后的现状。仍有防坑价值的旧做法与旧理由写进自由节（例如「曾经的做法与改动原因」），不按日期写流水账。
- 补充段：本身是独立决定（有自己的工单、可以单独被取代）的，拆成单独的 note，日期取补充段的日期，与母篇互链；纯事实更新（改名、写入者调整、实施状态）并入母篇正文。
- 头块后写「原编号：ADR 00xx」；拆出的写「原出处：ADR 00xx「补充：…」」。
- 备选方案：先查 `.scratch/` 的 spec、tickets-draft、工单 Comments 和 grilling 记录。确实找不到就用 grandfather 注释，不编。
- 「冒烟记录」「实施记录」类内容压缩成 `## 验证`，写明命令、环境与结果，长记录链接到 `.scratch/` 的原文件。
- 指向 `../runtime.md` 的链接暂时保留，由工单 06 改指模块文档。
- 完成后删除 `docs/adr/`，把删除前的最后提交号记入 Comments；`docs/agents/domain.md` 改为「决策记录在 `.agents/notes/`，按 maintain-notes 维护；不创建 `docs/adr/`」，冲突提示也改指 notes。

## 逐篇映射（已于 2026-10-09 复核）

| ADR | 目标 note | 处理 |
|---|---|---|
| 0001 保留会话历史 | architecture/2026-09-19-preserve-session-history | — |
| 0002 后台运行任务 | architecture/2026-09-19-detach-terminal-from-task-runtime | 0017 的修订并入现状 |
| 0003 显式访问模式 | feature/2026-09-19-explicit-access-modes | 控制面拥有者认证同篇保留为自由节 |
| 0004 tool worker 与容器 | architecture/2026-09-20-tool-worker-per-task-container | 与工单 26 原生边界的关系保留为自由节 |
| 0005 自动审查 | feature/2026-09-22-auto-review-mode | — |
| 0006 MCP 客户端 | architecture/2026-09-23-mcp-client | — |
| 0007 退役 GitHub 模块 | simplification/2026-09-23-retire-github-module | — |
| 0008 MCP 写工具审批 | feature/2026-09-23-mcp-write-tools-approval | — |
| 0009 main 应用数据空间 | architecture/2026-09-23-main-app-data-space | — |
| 0010 调度器与 outbox | architecture/2026-09-24-scheduler-outbox | 第 4 条已被 0011 修订（限流退回）：写现状并链到 0011 |
| 0011 Telegram 入口 | feature/2026-09-24-telegram-owner-entry | IM 审批（issue 08）与最终汇报（issue 18）两段修订和 0012 重复，**拆出** feature/2026-10-02-im-approval-and-final-report，0011 与 0012 都链向它 |
| 0012 QQ 私聊共享 main | feature/2026-09-24-qq-private-shared-main | issue 08/18 修订移到上面那篇；架构工单 10「启动配置停用即停用」并入现状 |
| 0013 GitHub PR 评审 | feature/2026-09-24-github-event-review | issue 19、23 的修订并入现状 |
| 0014 QQ 群聊结果 | 由 issue 20 退役取代：新写 simplification/2026-10-02-retire-core-group-chat（群消息忽略、旧资料只读、`chat_result_*` 保留、群资料隔离） | 0014 原设计里独有的防坑理由并入新篇自由节，**原篇删除，不建对应 note** |
| 0015 新闻 | feature/2026-09-25-scheduled-news | — |
| 0016 有损压缩 | architecture/2026-09-26-lossy-context-compaction | — |
| 0017 两个产品 | architecture/2026-10-02-two-agent-products | **拆出** feature/2026-10-05-ruukoto-keeps-dev-sessions、process/2026-10-09-dev-launchers；「入口改名」并入现状 |
| 0018 旧工作区归属 | architecture/2026-10-03-legacy-workspace-org-attribution | — |
| 0019 服务管理 helper | architecture/2026-10-03-service-management-helper | 状态行里 issue 10 的例外**拆出** feature/2026-10-03-standing-permissions |
| 0020 工作委托 | architecture/2026-10-03-work-delegation-subagent-task | **拆出** feature/2026-10-04-subagent-reuse-close（12）、feature/2026-10-04-cancel-work（14）、feature/2026-10-05-subagent-messaging（13）、architecture/2026-10-05-subagent-restart-recovery（15）；架构工单 12 的写入者统一并入现状 |
| 0021 worktree | architecture/2026-10-04-subagent-worktrees | **拆出** feature/2026-10-05-integrate-worktree-results（17） |
| 0022 旧实例导入 | architecture/2026-10-04-legacy-instance-import | — |
| 0023 个人实例导入 | architecture/2026-10-05-personal-instance-import | — |
| 0024 图片暂存 | architecture/2026-10-07-inbound-image-staging | — |
| 0025 Plan 会话模式 | feature/2026-10-08-plan-session-mode | — |

合计 25 篇 ADR 产出 34 篇 note（24 篇母篇、1 篇 0014 的替代篇、9 篇拆出篇）。

## 验收

- [x] 25 个编号都能用 `rg "ADR 00xx" .agents/notes` 找到。0014 指向替代篇，并在 Comments 里记明原篇的删除理由。
- [x] `npm run verify-notes` 通过，notes 之间的相对链接全部有效。
- [x] 逐篇对照原 ADR：每条决定、每个已记录的边界都在新 note 里有着落。对照结果按篇记在 Comments。
- [x] `docs/adr/` 已删除，`docs/agents/domain.md` 已更新。

## Comments

2026-10-09：拥有者确认逐篇映射表，状态改为 ready-for-agent。

2026-10-10：补齐剩余 22 篇 note，连同本次开始时已有的 12 篇，共 34 篇 implemented（24 篇母篇、0014 的替代篇、9 篇拆出篇）。三个并行迁移任务先落骨架再填写；逐篇对照原文，并对入口相关五篇做独立复核。以下记录每篇原 ADR 的去向及决定、边界的覆盖结果。

| 原 ADR | 对照结果 |
|---|---|
| 0001 | [完整历史](../../../.agents/notes/implemented/architecture/2026-09-19-preserve-session-history.md)保留历史与模型上下文分离、原文检索、Jev 和记忆清理边界；有损处理的修订互链到 0016。 |
| 0002 | [后台任务](../../../.agents/notes/implemented/architecture/2026-09-19-detach-terminal-from-task-runtime.md)合成双产品运行位置，保留终端断连不停止任务、会话串行、重启中断、拥有者恢复及未知效果不重放。 |
| 0003 | [显式访问模式](../../../.agents/notes/implemented/feature/2026-09-19-explicit-access-modes.md)保留任务固定权限、默认 confirm、模型不能提权、控制面拥有者认证与系统身份分离，互链后续审批例外。 |
| 0004 | [工具工作进程](../../../.agents/notes/implemented/architecture/2026-09-20-tool-worker-per-task-container.md)保留完整工具执行在边界内、按任务容器、专用执行账户、单次批准和 HTTP 钉址；原生替换目标、实测失败与接入门槛有独立自由节。 |
| 0005 | [自动审查](../../../.agents/notes/implemented/feature/2026-09-22-auto-review-mode.md)保留独立无工具调用、确定性策略、失败转人工、输入与时限、审查落盘、竞争及单次消费边界。 |
| 0006 | [MCP 客户端](../../../.agents/notes/implemented/architecture/2026-09-23-mcp-client.md)保留可信配置、凭据范围、任务钉版、schema 校验、端点钉源、连接回收与未知不重发；写工具扩展互链到 0008。 |
| 0007 | [GitHub 专用模块退役](../../../.agents/notes/implemented/simplification/2026-09-23-retire-github-module.md)保留单一 MCP 路径、旧资料只读、审批失效、按证据定终态、导出与幂等迁移；旧保证不自动延续的代价明确记录。 |
| 0008 | [MCP 写工具审批](../../../.agents/notes/implemented/feature/2026-09-23-mcp-write-tools-approval.md)保留本地副作用声明、审批范围、消费前复核、不可变参数、full_access 与 auto-review 区别、已知错误和效果未知的定性及真实写工具验收前提。 |
| 0009 | [main 应用数据](../../../.agents/notes/implemented/architecture/2026-09-23-main-app-data-space.md)保留独立库身份、六工具、同事务审计、有界查询与子进程截止、完全访问仍确认破坏性操作、双库回执恢复及权限范围。 |
| 0010 | [调度器与 outbox](../../../.agents/notes/implemented/architecture/2026-09-24-scheduler-outbox.md)保留三表、IANA/DST、漏过周期合并、恢复顺序、发送事实和固定授权；现状纳入 0011 的限流退回例外并互链。 |
| 0011 | [Telegram 入口](../../../.agents/notes/implemented/feature/2026-09-24-telegram-owner-entry.md)保留入站 confirm、按原任务回答回复、固定目标、凭据代次与脱敏、限流和启动停用；issue 08/18 修订移入 [IM 审批与最终汇报](../../../.agents/notes/implemented/feature/2026-10-02-im-approval-and-final-report.md)，母篇互链。 |
| 0012 | [QQ 私聊](../../../.agents/notes/implemented/feature/2026-09-24-qq-private-shared-main.md)保留共享 main、登录及在线核实、原平台钉版回复、群资料隔离与副本上限；审批/汇报互链拆出篇，架构工单 10 的启动停用并入现状。两篇 IM 母篇均纳入 0024 已交付的图片扩展。 |
| 0013 | [GitHub 事件评审](../../../.agents/notes/implemented/feature/2026-09-24-github-event-review.md)合成 issue 19/23：宿主登记全新 SubAgent、只读 MCP、main 项目凭据、固定独立通知、修订失效与旧评审收尾；旧接管仅保留为历史原因。 |
| 0014 | [核心群聊退役](../../../.agents/notes/implemented/simplification/2026-10-02-retire-core-group-chat.md)吸收原设计独有的映射、固定摘要接收、撤回时间窗、来源复核、独立发送账本与群资料隔离。原内建角色决定已被 issue 20 完全取代，防坑理由在替代篇中保留，因此删除原篇，不另建母篇。 |
| 0015 | [定时新闻](../../../.agents/notes/archived/feature/2026-09-25-scheduled-news.md)保留固定采集范围审批、宿主搜索、私人资料隔离、URL/发布时间过滤、快照与 outbox、失败不编造及重启不重搜的边界。 |
| 0016 | [有损上下文压缩](../../../.agents/notes/implemented/architecture/2026-09-26-lossy-context-compaction.md)保留完整历史、压缩点、分层压缩、水位、前缀稳定、摘要模型数据去向与失败行为；旧角色范围合成现状，chat 窗口明确未实施。 |
| 0017 | [两个产品](../../../.agents/notes/implemented/architecture/2026-10-02-two-agent-products.md)合成入口改名、固定角色退役、双产品及一层 SubAgent 现状；共享/更多渠道/外挂与原生隔离缺口明确。独立补充拆成 [保留开发会话](../../../.agents/notes/implemented/feature/2026-10-05-ruukoto-keeps-dev-sessions.md)和[开发启动入口](../../../.agents/notes/implemented/process/2026-10-09-dev-launchers.md)，各与母篇互链；实施流水按机制归并并链接对应决定。 |
| 0018 | [旧工作区归属](../../../.agents/notes/implemented/architecture/2026-10-03-legacy-workspace-org-attribution.md)保留原 projectId 资料/配置身份、仅展示组织字段、严格认领、只读预览、修订与单事务应用、回退及异常目录/角色排除边界。 |
| 0019 | [服务管理 helper](../../../.agents/notes/implemented/architecture/2026-10-03-service-management-helper.md)保留 root 固定入口、协议/目标限制、修订绑定、单次认领、停止与效果未知；issue 10 拆成 [长期授权](../../../.agents/notes/implemented/feature/2026-10-03-standing-permissions.md)，限定原入口/main/本机/服务/restart，复核、撤销及未知失效互链。 |
| 0020 | [工作委托](../../../.agents/notes/implemented/architecture/2026-10-03-work-delegation-subagent-task.md)保留三类对象、动态身份、两级幂等、事务登记和资料权限，写入者统一并入现状；拆成 [复用关闭](../../../.agents/notes/implemented/feature/2026-10-04-subagent-reuse-close.md)、[工作取消](../../../.agents/notes/implemented/feature/2026-10-04-cancel-work.md)、[工作内通信](../../../.agents/notes/implemented/feature/2026-10-05-subagent-messaging.md)、[重启恢复](../../../.agents/notes/implemented/architecture/2026-10-05-subagent-restart-recovery.md)，完整保留来源并集、竞争、迟到结果、异步重核与占用核实，各与母篇互链。 |
| 0021 | [SubAgent worktree](../../../.agents/notes/implemented/architecture/2026-10-04-subagent-worktrees.md)保留首次钉定目标、容器内 Git、共享 Git 只读、祖先目录占用、macOS UID/inode 例外及副本保留；拆成 [成果汇总](../../../.agents/notes/implemented/feature/2026-10-05-integrate-worktree-results.md)，保留完整差异、冲突零写入、事件窗口、幂等和并发/增量上限，main 修改已开放，两篇互链。 |
| 0022 | [开发实例导入](../../../.agents/notes/implemented/architecture/2026-10-04-legacy-instance-import.md)保留目标离线、源只读快照、allow-list、原 ID/字节、失败历史、降级及不重放、记忆/凭据边界、修订与回执、续跑/回退及单事务 INSERT 取舍。 |
| 0023 | [个人实例导入](../../../.agents/notes/implemented/architecture/2026-10-05-personal-instance-import.md)保留全新目标、角色/群/应用资料、原访问模式、平台偏移与调度交接、最小凭据、转换后 manifest、回退阻挡和旧实例停用责任。 |
| 0024 | [入站图片暂存](../../../.agents/notes/implemented/architecture/2026-10-07-inbound-image-staging.md)保留暂存/拒绝幂等、格式/大小/次数上限、任务提升事务与文件窗口、24 小时清理、历史引用及发送前恢复、审批排除、模型能力拒绝和两方向导入边界。 |
| 0025 | [Plan 会话模式](../../../.agents/notes/implemented/feature/2026-10-08-plan-session-mode.md)保留持续手动选择、提交固定 Plan/auto-review、继续按当前选择、禁止任务内切换、历史不回填及非全面只读；补充可信字段、入口、幂等和迁移现状。 |

备选方案从各篇链接的 `.scratch/` spec、工单、tickets-draft 和 grilling 记录恢复。长期授权、工作内通信、SubAgent 重启恢复、成果汇总四篇找不到当时明确备选，使用 grandfather 注释；QQ 共享和整项取消只记找到的真实备选，不补造第二项。开发会话保留与开发启动入口没有独立登记的历史测试通过结果，明确保留证据限制。其他历史验证压缩成 `## 验证`，标明原命令、环境、结果和模拟范围，并链接原工单；本次未重跑应用测试或平台冒烟。

删除前 `docs/adr/` 的最后变更提交为 `4935ebad19123b97039e9883f40a39d3aee1a768`（2026-10-09）；可用 `git show 4935ebad19123b97039e9883f40a39d3aee1a768:docs/adr/<原文件名>` 查回原文。目录已删除；domain.md 明确决策记录只在 notes，禁止新建 docs/adr，冲突提示改指 notes。

验收：34 个目标文件与映射集合完全一致，头块原编号覆盖 0001–0025，正文无空节；35 篇 notes（含既有 proposed）共 366 个本地 Markdown 链接全部存在，无链接指向旧 ADR。`npm run check:static` 通过，包含 lint、应用及 foundation typecheck、`verify-notes`（35 篇、0 归档）；`git diff --check` 通过。

当前实现缺口保留在 note：启动配置停用的 QQ/Telegram 入口会作废入站、取消排队任务，但公共 outbox 仍可能保持 `pending(sender_unavailable)`，不能把入站停用扩展成所有待发操作都取消。其余旧 ADR 引用按工单 04、06、07 继续迁移；冻结图解中的旧链接按 05 约定保留。

2026-10-10 提交前：同步纳入文档与历史工单指向新 notes 的链接，暂存改动中的 536 个本地链接目标全部存在。macOS、Node 24.15.0 上 `npm run check` 通过：构建、lint、应用/foundation typecheck、35 篇 notes 校验及全部离线测试；应用 1020 通过、1 跳过、0 失败（166.78 s），foundation 9 通过、1 跳过、0 失败（2.48 s）。跳过项是未启用的真实模型检查；未运行真实平台或容器冒烟。
