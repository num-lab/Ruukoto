# Agent Note: 服务 helper 中断在调用进程关闭后返回

Status: implemented

## 问题

[服务检查](../../implemented/architecture/2026-10-17-personal-service-inspect.md)与[服务操作](../../implemented/architecture/2026-10-17-personal-service-operations.md)共用 `callHelper`。超时和取消目前发出 SIGKILL 后立即拒绝，调用方拿到失败不代表调用进程已关闭，尾部输出也可能遗漏。将它用于[长期子工作](../../implemented/architecture/2026-10-17-personal-background-work.md)会让取消收尾早于实际调用结束。

## 决定

中断先保存首次失败原因并停止原进程组，统一在 child `close` 后结束 Promise。原始输出继续按既有限额收集，失败码和最终捕获一起返回；启动失败保留类型化错误。先检查已取消 signal，安装监听后再检查一次，覆盖 spawn 期间取消。调用进程不关闭时继续等待，不能把信号送达当退出证明。

这只核实本次调用进程与其 stdio 关闭，不证明 systemd 操作单元或所有后代结束，也不解决后台 SIGKILL 后 detached helper 的恢复。服务写入仍按原操作身份调用 stop-op，未知效果继续保留占用；子 Agent 外部工具须另有持久执行身份及恢复核实才能接入。

## 既有笔记审计

按 helper、服务检查、后台工作、停止核实检索 proposed/implemented/rejected。[迁移方案](../../proposed/architecture/2026-10-17-personal-pi-durable.md)、上述检查/操作/后台工作与[固定服务 helper](2026-10-03-service-management-helper.md)部分重叠，保留各自执行归属及停止规则。本片只收窄传输完成时机，没有完全吸收或过时提案。

## 备选方案

- 信号发出后立即返回：响应快且保留既有超时上限，但调用方可能在进程仍运行时收尾，输出也未收齐。
- 等待固定延迟再返回：有明确等待上限，但延迟不是退出证明；等 close 才能证明调用进程已关闭。
- 同时开放子工作只读工具：可直接推进迁移能力，但 detached helper 的崩溃恢复尚无停止证明，不能靠只读可重放豁免工作占用要求，另行设计后接入。

## 验证

真实子进程在延迟停止窗口内取消/超时仍保持 pending，关闭后返回原码与完整有界捕获；启动前与 spawn 期间取消不遗留进程；超限和 spawn 失败不挂起。macOS/Linux、旧/新服务调用方回归与撤去修复的隔离反例由[实施工单](../../../../.scratch/personal-pi-durable/issues/15-helper-exit.md)记录实际证据。

## 后果

调用方不会在调用进程关闭前拿到中断结果，且保留关闭前的输出；代价是无法结束的调用会持续等待，不新增运维解除入口。调用关闭不是外部操作停止证明，后台强杀与权限不同的后代仍须持久身份和受控 helper 核实；本片不授权下放工具或切换正式产品。
