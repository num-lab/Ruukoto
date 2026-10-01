Status: ready-for-agent

# 19 — 把现有 GitHub 评审迁移到通用 SubAgent

**What to build:** 现有 PR 事件通过通用 SubAgent 完成只读评审，main 仍向固定拥有者汇报，逐步退出固定 coding 路径。

**Blocked by:** [11 — 主 Agent 委派通用 SubAgent 并收到结果](11-subagent-delegation.md)

依据：[已确认规格](../spec.md) 与 [ADR 0017](../../../docs/adr/0017-two-agent-products.md)。

## 验收标准

- [ ] 同一 PR webhook 从登记、去重、通用子任务评审到原有固定通知完整可用，不再新建固定 coding 评审任务。
- [ ] 保持只读工具与资料限制，不执行 PR 代码，不因此取得评论、合并或任意发布权限。
- [ ] 旧报告、原始修订、失效状态和来源仍可查看，重复事件及重启不产生重复评审副作用。
- [ ] 沿用已有 PR 通知授权，不等待 GitHub comment 对话能力，也不重复实现已经退役的旧 GitHub REST 模块。
- [ ] 完成相关端到端检查、类型检查及仓库要求的验证；同步本次行为涉及的运行说明和图解，验证记录区分模拟结果与真实环境结果。
