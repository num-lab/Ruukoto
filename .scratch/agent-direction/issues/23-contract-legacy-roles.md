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
