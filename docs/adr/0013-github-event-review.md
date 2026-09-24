# GitHub PR 事件只触发只读评审，结果复用任务、产物和通知 outbox

日期：2026-09-24

daily-agent issue 08 原规格依赖已由 ADR 0007 退役的 GitHub 草稿机制。拥有者确认沿用退役决定，接入 webhook 后由宿主创建固定的 main 父任务与 coding 子任务；GitHub 资料仍经普通 MCP 读取，评审正文保存为普通 Artifact，修订和有效性记录在 Task result 中。本 ADR 补充 ADR 0007 的运行时边界：允许校验、登记和编排 GitHub 入站事件，不恢复 REST 采集、专用草稿或发布状态机，也不提供 REST 回退。

PR 文本是外部资料。宿主固定角色、项目、会话、工作目录及 `confirm` 模式；coding 只获得 `read`、`read_artifact` 和本地配置标记 `effect = read` 的 MCP 工具，main 接收父任务没有工具，结果唤醒只获得 `coding_result`。评审不执行 PR 代码，不把正文中的指令用于改变权限或发布策略；修改、评论、合并和其他写操作须回到拥有者的可信入口及既有审批流程。

拥有者启用 webhook 配置时，同时授权把每个有效入站事件的一次 main 摘要发送给所选渠道的固定 owner。宿主在事件登记时固定目标及配置版本，结果事务登记公共 outbox，逻辑键为 `inbound_event + 事件 ID`；这项授权独立于 ADR 0011/0012 的 `owner_reply`，模型不能选择收件人、换键或额外发送。停用、目标变化或已观察到修订失效时，尚未发送的通知取消；在途发送保留实际结果，`effect_unknown` 不自动重发，限流沿用 ADR 0011 的同操作退回规则。

修订依据来自通过签名校验的 PR 事件快照，按 `updatedAt` 比较已观察到的 head/base SHA、关闭和 draft 状态；同时间戳而修订不同也保守判为过期。旧报告保留为不可变产物，当前有效性由 `result_ref.review.staleReason` 表示。模型须在 MCP 资料采集前后核对 head/base，无法核对或资料不完整时明确说明；事件缺失、延迟或远端在采集后变化时，不保证本地快照仍是最新修订。这保留了可追溯的评审依据，没有重新承诺旧草稿状态机的发布前复核保证。
