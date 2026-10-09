Status: ready-for-agent

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

## 逐篇映射（建议，待复核）

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

- [ ] 25 个编号都能用 `rg "ADR 00xx" .agents/notes` 找到。0014 指向替代篇，并在 Comments 里记明原篇的删除理由。
- [ ] `npm run verify-notes` 通过，notes 之间的相对链接全部有效。
- [ ] 逐篇对照原 ADR：每条决定、每个已记录的边界都在新 note 里有着落。对照结果按篇记在 Comments。
- [ ] `docs/adr/` 已删除，`docs/agents/domain.md` 已更新。

## Comments

2026-10-09：拥有者确认逐篇映射表，状态改为 ready-for-agent。
