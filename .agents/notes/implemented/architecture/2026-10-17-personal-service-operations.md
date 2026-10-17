# Agent Note: 个人服务操作以持久消费事实阻止写入重放

Status: implemented

## 问题

个人 durable 已能只读检查服务，但服务重启跨 SQLite 与 systemd；消费批准后进程可能在任何时刻退出。原生 unsafe 工具恢复会给模型错误并继续，不能阻止模型换键重试；旧审批与操作账本又依赖旧 Runtime，直接复用会违背[迁移方案](../../proposed/architecture/2026-10-17-personal-pi-durable.md)。

## 决定

可信宿主 API 创建独立 background 服务工作，来源固定为已进入主会话的拥有者输入。服务模式在创建时固定，默认 auto-review；confirm/auto-review 无有效长期授权时人工批准，full_access 免逐次审批，语义沿用[完全访问](../../implemented/feature/2026-10-12-full-access-current-account.md)。模型没有服务写工具。单次审批只决定原操作，Telegram 原入口与长期授权按[权限决定](2026-10-17-personal-telegram-permissions.md)接入，不提供自由范围本机授权。

消费、开始事实与恢复 checkpoint 同 commit，helper 调用只发生在该 commit 后的当前 invocation。恢复发现开始且无结论，只核实与停止，不重新调用 restart。可信结果和原始证据同 commit；保存失败由 Harness 关闭，重开保留未知。以原生 Task 持有执行状态，document 只记审批、来源、外部效果及停止证据。

未知工作保留目标占用；同一拥有者输入的服务操作串行，同目标的其他来源也不能绕过。其他目标与主聊天继续。拥有者可以核实已生效/未生效并附证据，但必须另有匹配本机/操作/命令单元的停止证明才能结束；取消不能把未知改成未执行。停止仅回收固定命令单元，不撤回 PID 1 已接收的作业。传输、固定 argv、修订和 helper 单次认领沿用[服务 helper](../../implemented/architecture/2026-10-03-service-management-helper.md)。

仅查命令单元不存在不能证明安全停止：restart helper 可能已经检查停止标记、尚未派发。claim 因此保存受保护的 Linux PID、starttime、进程组和 boot 身份。stop-op 先核实启动器与其进程组结束，再核实命令单元；已发送的跨连接 D-Bus 请求仍可能迟到，因此只有原 `--wait` 成功的持久回执、实际观察到命令单元的回执、跨 boot 或停止先手认领可使后来的 not-found 成为退出证明。回执绑定原操作和启动器身份；活跃、未知或旧 claim 保持未核实。个人端只信显式启动进程退出证明，缺该证明的旧 helper 不能释放目标。

## 既有笔记审计

按服务、效果未知、批准消费和长期授权检索 proposed/implemented/rejected。迁移提案、[只读检查](../../implemented/architecture/2026-10-17-personal-service-inspect.md)、[后台工作](../../implemented/architecture/2026-10-17-personal-background-work.md)、服务 helper、长期授权和完全访问为部分重叠，互链并保留各自决定；工具工作进程、MCP、应用数据、通知、工作流和旧 Runtime 的命中归其他消费者，本切片不改变。没有完全吸收或过时提案需要删除。

## 备选方案

- 直接把 restart 接入子模型工具：真实消费者最近，但同时需要子工作权限与来源装配、模型暂停和工作收尾。先交可独立验证的服务宿主 API，避免以空工具阶段的停止结论证明外部写入安全。
- 复用旧 ApprovalGate/ToolOpLedger：覆盖面成熟，但引入旧 Store/Task 权威和兼容层，与迁移目标冲突；只复用无状态 helper 传输。
- 使用 unsafe 工具恢复：框架自动避免原调用重放，代码更少；模型仍能换参数或请求键，不能满足未知效果暂停的硬要求。

## 验证

见[窄工单](../../../../.scratch/personal-pi-durable/issues/06-service-operations.md)。重点是效果完成至结果提交间强杀后的零重复调用、批准单次消费、修订与来源核实、停止未核实占用以及存储失败恢复。

## 后果

SQLite 与 systemd 无原子提交，已开始但实际未派发也会保守暂停。服务工作仍由可信宿主 API 发起，Telegram 可查询、审批及管理长期授权；[CLI 配置](2026-10-17-personal-service-configuration.md)提供首次启用，模型写工具和完整 A5/A6/A11 仍待总方案验收，后续装配不能从可配置请求参数取得权限。操作事实按请求键分开的 document 保存，列表使用原生 Task 游标分页；冲突检查扫描原生记录，历史规模显著增长时再增加仅持有活动操作引用的索引。保守停止核实可能需要实际观察命令单元或跨 boot 后才能解除；不把人工效果说明当成停止证明。收益是消费后崩溃不重放，代价是已开始但未派发也可能暂停。
