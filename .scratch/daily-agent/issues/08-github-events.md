Status: ready-for-agent
Depends on: 05

# GitHub 事件编排

## 目标

在 main → coding 委派稳定后，接入 GitHub PR 事件，自动生成 review 草稿并通知 owner。

## 实现顺序

第一阶段继续使用拥有者手动触发；本工单后续再实现 webhook。Webhook 只创建 coding review 子任务和草稿，不默认发布评论。

## 实现范围

- webhook secret、事件类型/action 校验、delivery id 去重和快速 2XX 响应；
- 事件先落盘，再异步创建 coding 子任务；
- 复用现有 GitHub 读取和草稿机制，记录 PR head/base 修订；
- coding 结果通过 main 摘要和 outbox 通知 owner；
- GitHub comment、merge、自动修复和发布凭据仍受现有可信入口/审批约束；
- 结果未知不自动重发。

## 验证

- 重复 delivery 不重复评审；
- webhook 处理不阻塞入口响应；
- PR 修订变化会使旧草稿失效；
- PR 文本不能修改权限、角色或发布策略；
- 未经 owner 确认不会发表评论。
