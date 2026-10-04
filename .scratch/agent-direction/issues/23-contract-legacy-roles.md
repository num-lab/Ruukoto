Status: ready-for-agent

# 23 — 清理固定角色和迁移期兼容写入口

**What to build:** 两个产品日常运行完全使用新的工作区、主 Agent 和通用 SubAgent 路径，旧形态只保留必要的历史读取兼容。

**Blocked by:** [06 — 在工作区管理配置与资料授权](06-workspace-settings.md)；[17 — 汇总并验证并行改动，保留冲突成果](17-integrate-worktree-results.md)；[21 — 把旧开发资料迁入 Coding Agent](21-migrate-coding-instance.md)；[22 — 把旧主会话和服务状态迁入 Personal Agent](22-migrate-personal-instance.md)

依据：[已确认规格](../spec.md) 与 [ADR 0017](../../../docs/adr/0017-two-agent-products.md)。

## 验收标准

- [ ] 普通委派和 PR 评审全部走通用 SubAgent，核心不再引导或接受固定 coding/chat 新任务。
- [ ] 用户入口、配置和界面不再提供旧角色或旧项目写入路径，产品定位与实际运行一致。
- [ ] 清理前核实所有旧写调用方已迁移；每批变更保持检查通过，不靠一次全局破坏式改名完成。
- [ ] 保留读取旧历史、资料来源和群权限边界所必需的标识与兼容读取，不为删除旧类型而删除数据。
- [ ] 完成相关端到端检查、类型检查及仓库要求的验证；同步本次行为涉及的运行说明和图解，验证记录区分模拟结果与真实环境结果。

## Comments

### 2026-10-04：issue 20 留下的具体清理面

issue 20（核心群聊退役）实施时按“旧类型、工具类别和角色行的收缩留给 23”保留了以下项，执行本单时逐批核对：

- `AgentRoleId` 中的 `chat`、tasks/agent_roles/inbound_events 的 CHECK 约束、`qq_group` 会话类别（schema 收缩）；
- chat 工具类别（tool-availability）、`session-factory.ts` 的 chat 群聊提示、Driver 与上下文装配的 `qq_group` 分支及 `qqRecalledFilter` 参数、`qq/adapter.ts` 的 `filterRecalledQqMessages`（已无注入方）；
- `QqStartGateResult` 只剩 gatePrivate 一个用户；`QqStore` 的群写方法（`registerInbox`/`linkInboxTask`/`bindInboxSession`/`createPendingOutbox`/`insertGroupSession`/`listUnlinkedInbox` 等，生产无调用方，播种测试在用）与 `qq_config` 的 `max_reply_chars`/`queue_ttl_ms` 字段（退役后无消费者）；
- 旧安装的 `agent_roles` chat 行与 `qq-*` 项目/会话行（读取兼容是否仍需，按 21/22 迁移结论定）。
