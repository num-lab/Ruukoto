# Agent Note: GitHub PR 事件的宿主只读评审与固定通知

Status: implemented

原编号：ADR 0013

## 问题

拥有者需要由 GitHub PR 事件触发只读评审，并收到对应修订的一次汇报。原 daily-agent issue 08 依赖已经退役的专用草稿机制；如果接入 webhook 顺带恢复 REST 采集、草稿和发布状态机，就会重新产生两套 GitHub 能力。PR 资料又是外部内容，不能通过评审取得代码执行、评论、合并或发布权限。[两个 Agent 产品](../architecture/2026-10-02-two-agent-products.md)取消固定 coding 角色后，评审执行与资料、通知边界需要继续保留。

## 决定

- **webhook 只负责校验、登记和宿主编排。** 可信启动配置限制监听地址、端口、webhook 凭据、repository ID 和通知渠道；对原始字节执行 HMAC-SHA256 校验，再核对 delivery ID、事件/action、仓库与 PR 字段。请求上限 1 MiB，PR body 进入快照与模型输入前截取 4,000 字符并标注。归一化快照先登记，`(github, delivery ID)` 去重，持久化后即返回 2XX，异步评审不阻塞 HTTP 应答。GitHub 资料经[普通 MCP](../architecture/2026-09-23-mcp-client.md)读取，完整评审正文保存为普通 Artifact，修订与有效性写 `Task result`；[专用模块退役](../simplification/2026-09-23-retire-github-module.md)保持生效，不恢复 REST 采集、草稿表或发布状态机，也不提供 REST 回退。
- **每个修订由宿主建立全新的评审工作与 SubAgent。** 编排器创建固定 main 父任务，直接用 `hostReview: { sourceEventId }` 登记一项新工作、一个新 SubAgent，不经模型工具，也不占 main 的通用委派名额。角色/项目/会话/工作目录和 `confirm` 模式均由宿主固定；每个修订使用全新上下文，空闲后保留身份与历史，但宿主和主 Agent 均不能继续或复用这名评审 SubAgent，其上下文含不可信 PR 资料。拥有者或主 Agent 可以显式关闭。
- **工具和资料仅限只读评审。** 评审 SubAgent 的白名单为 `read / read_artifact` 加按任务开放的、本地 `effect=read` MCP；工具装配、模型发送前和实际调用门都按同一边界收窄。不执行 PR 代码，不接受正文里的提权或发布指令，不开放 bash、委派、write/unknown MCP。main 父任务没有工具，结果唤醒只开放 `subagent_result` 与只读 `coding_result`（历史查阅）。修改、评论、合并与其他写操作必须回到拥有者可信入口及既有审批流程，webhook 不能隐式授予。
- **MCP 配置与凭据跟随 main 项目核对。** 评审 SubAgent 会话位于 main 项目，GitHub MCP 配在 main 项目，并且只对宿主评审任务开放；main 自身、拥有者普通委派及开发会话 SubAgent 不因此得到 MCP。旧 coding 项目配置和凭据不自动迁移，拥有者须另建 scope 为 main 项目的只读凭据，再执行 `mcp configure --project`。旧配置不自动删除，拥有者可用 `mcp remove` 清理；未配置时评审如实说明无法取得资料。
- **通知授权来自拥有者启用 webhook。** 每个有效入站事件的一次 main 摘要发到配置中选定渠道的固定 owner；宿主在事件登记时钉版目标，摘要结果事务登记公共 outbox，`sourceKind=inbound_event`、逻辑键为事件 ID。该授权与 [Telegram/QQ owner 回复](2026-09-24-telegram-owner-entry.md)及[IM 工作最终汇报](2026-10-02-im-approval-and-final-report.md)分别核实，GitHub 工作不会产生第二份 owner_reply。模型不能选择目标、换键或额外发送；停用、目标变化、已观察到修订失效则取消未发送通知，在途发送保留事实，`effect_unknown` 不重发，明确限流按[同操作退回规则](2026-09-24-telegram-owner-entry.md)延迟。

## 修订依据与旧角色收尾

修订依据来自签名通过的 PR 事件快照，保存 head/base SHA、`updatedAt`、关闭与 draft 状态。按已观察到的 `updatedAt` 比较修订；同时间戳却不同修订也保守判过期。旧报告保持不可变，当前有效性由 `result_ref.review.staleReason` 表示。模型在 MCP 采集前后核对 head/base；无法核对或资料不全时明确说明。事件缺失、延迟或远端在采集后变化时，本地快照不保证最新，也不承诺旧草稿模块的发布前远端复核保证。

评审正文分页完整保存；历史分页失败不能误记完整报告，残缺产物标 `partial`，结果记录 `captureError` 并要求拥有者核实。出队门再次核对修订，排队期间已过期的评审取消且不调用模型、不登记通知。

最初宿主固定 main→coding 父子任务，issue 19 迁移到通用 SubAgent 时暂时接管已建出的 `deleg:<父任务>:review` 旧 coding 评审，避免重复创建；issue 23 随固定角色退役删除这条接管分支。旧排队子任务取消，旧运行子任务在恢复中记中断/效果未知，结果补记后仍可经 `coding_result` 与产物查阅，但不新增评审通知。崩溃窗口中旧子任务已创建、事件仍 registered 的情况，旧任务收尾后可建立新的只读 SubAgent 评审；它不重放结果未知的写操作。历史修订、有效性与正文都保留。

## 备选方案

- **恢复专用 REST 采集、草稿与发布状态机。** 原规格基于现成的 GitHub 草稿流程，复用它可以直接回到旧路径。未选，是因为拥有者已确认退役，资料、报告和结果改用 MCP、普通 Artifact 和 Task result；恢复会重新引入专用业务分支，webhook 也不应取得发布权限。来源：[daily-agent issue 08](../../../../.scratch/daily-agent/issues/08-github-events.md)「已确认决策」及[专用模块退役](../simplification/2026-09-23-retire-github-module.md)。
- **跨修订复用评审 SubAgent。** 这样能保留 PR 背景上下文，也减少评审身份数量。未选，是因为旧 diff 与旧报告会混入新 head 的核对，且不可信 PR 上下文不能复用到拥有者的其他工作；每修订独立上下文保留明确依据。来源：[agent-direction issue 19](../../../../.scratch/agent-direction/issues/19-github-subagent-review.md)「默认取舍」。
- **自动把 coding 项目 MCP/凭据迁到 main。** 这省去拥有者重新配置步骤，升级后可直接读取。未选，是因为改写凭据 scope 是授权变更，宿主不能替拥有者扩大或改变范围；旧配置只留作历史，由拥有者另建 main 范围凭据。来源：issue 19「GitHub MCP 改配到 main 角色的项目」及 [issue 23](../../../../.scratch/agent-direction/issues/23-contract-legacy-roles.md)保留不收缩的读取兼容。

## 后果

事件、固定修订、完整或残缺的评审正文、当前过期原因、main 摘要和通知键都可追溯；重复 delivery 与后台恢复复用原工作、任务、产物与发送键。签名通过只证明事件来源，PR 正文仍是不可信资料，评审不包含代码执行或发布权限。

每个修订的新 SubAgent 与不可变产物增加保留记录；当前宿主评审可并行且没有独立并发名额，模型成本或持续积压成为问题时须加宿主评审并发上限。MCP 项目和凭据授权变更需要拥有者手动配置。未观察到新事件无法证明远端没变化，旧报告的“有效”只相对于已观察到的快照；真实远端连通与投递行为需要另行验收。

## 验证

[daily-agent issue 08](../../../../.scratch/daily-agent/issues/08-github-events.md)记录首次交付 `npm run typecheck` 与 `git diff --check` 通过，`npm test` 437 项中 436 通过、1 项真实模型检查跳过。`test/42`–`test/46` 用本地 HTTP、MCP、模型与通知模拟核对验签、有界请求、去重、五个恢复窗口、工具白名单、修订失效、目标变化、未知发送与残缺报告。

[agent-direction issue 19](../../../../.scratch/agent-direction/issues/19-github-subagent-review.md)记录 `npx tsx --test test/45-github-events.test.ts test/46-github-recovery.test.ts` 及相关回归、typecheck 通过：新工作/SubAgent 完整链路、不占名额且拒绝复用、只读 MCP 仅对评审开放、新旧结果过期、恢复不重复、通知授权不变。`.scratch/agent-direction/smoke-19-github-subagent-review.mts` 在 macOS arm64 与 tx Linux x64 各 8/8，真实部分为后台、控制面、SQLite/JSONL、Docker 受限 worker 和回环签名 webhook；模型、MCP 与通知平台模拟。该轮全量有 worktree 路径下 test/32 的既有预置断言失败，主检出路径通过，详见原工单。

[issue 23](../../../../.scratch/agent-direction/issues/23-contract-legacy-roles.md)另验证旧角色收尾、不重放、读取兼容与旧评审不再通知，smoke-23 在 macOS/Linux 各 5/5。真实 GitHub webhook 投递、真实 GitHub MCP 与真实 Telegram/QQ 均未实测；不能把回环入口和模拟平台冒烟表述为真实平台闭环。部署配置见[操作手册](../../../../docs/usage.md)。
