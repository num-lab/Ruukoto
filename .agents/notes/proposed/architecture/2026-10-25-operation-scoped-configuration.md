# Agent Note: 配置按受影响对象更新并保留旧操作归属

Status: proposed

## 问题

个人设置沿用最初停机持锁向导，在线读写、配置生效和整个后台生命周期被绑在一起。只读入口也可能抢锁，Skills 已能逐请求刷新却仍要求重启，坏模型环境阻止修改无关配置，命令目录和服务路径则永久绑定档案。Code 模型目录与 PA 计划范围还把显示名变化当作执行变化。

拥有者在 2026-10-25 确认解除这些用户限制，同时保留实际权限、单一写入者、原操作和历史恢复。本轮仅制定方案，当前实现仍由既有 implemented 笔记描述。目标、实施顺序和完整验收见[工单](../../../../.scratch/configuration-updates/issues/01-remove-global-restrictions.md)与[规格](../../../../.scratch/configuration-updates/spec.md)。

## 方案

配置保存由档案的当前写入者完成：在线经持锁后台，离线经同一档案锁。具体模块持有配置选择及生效规则；系统服务生命周期不再是普通保存的前置。原子文件替换与 SQLite 提交分开留意图、保存和生效事实，断线查询原操作，不重复保存或重发业务请求。

配置内容修订、执行资格和外部操作身份分别比较。显示名可以更新，旧模型请求、MCP 调用、IM 发送、命令和服务操作始终使用原选择；停用/撤销从尚未开始的相关执行生效，不能撤回已经发生的外部效果。增加能力不会扩大旧定时计划或旧授权的范围。

保留现有模块、SDK 配置更新能力、ManagedSkillsStore、配置 entries、控制认证和 remote 接纳接口。只增加现有记录缺少的配置版本与回执，不建立通用插件注册、任意配置脚本、多后台或新的任务状态机。renderer 展示后端的保存/生效结果，不重建一套安全判断。

同机命令/服务迁移在本能力静止后切换。旧终态历史按原配置验证，当前配置只决定新操作；仍需接触旧执行的核实继续依赖原机器/路径/helper。相关未决操作阻止该目标生效，不阻止其他配置，不用新环境的“未找到”证明旧操作结束。不在本期提供跨机器接管或全档案迁移。

MCP 展示变更只在不可变配置历史能够证明连续无实质变化时兼容。实际能力变更后改回不能使旧计划或批准重新有效。Code 仅放行明确不影响执行的字段和真实新增模型，未知高级字段保守保留现有受影响检查。

## 既有笔记审计

2026-10-25 按 personal/settings、停机、配置不可变、generation、模型门闩和计划范围检索 proposed/implemented/rejected。下列为部分重叠，保留其未被翻转的身份、授权、凭据与恢复约束，并加提案互链；实施时才标明实际取代范围。

| 既有归属 | 本方案拟改变的部分 |
| --- | --- |
| [Personal 设置](../../implemented/feature/2026-10-21-personal-settings.md)、[SSH 维护](../../implemented/feature/2026-10-21-personal-settings-ssh.md)、[个人页面](../../implemented/feature/2026-10-21-desktop-personal-pages.md)、[Tailscale 连接](../../implemented/architecture/2026-10-24-personal-tailscale-https.md) | 普通保存统一停存启、原模型/systemd/全局空闲要求；保留旧维护回执和认证 |
| [本机管理](../../implemented/architecture/2026-10-17-personal-local-management.md)、[技能历史](../../implemented/architecture/2026-10-18-personal-memory-skills-history.md)、[托管技能](../../implemented/feature/2026-10-21-managed-skills.md) | 只读/配置持锁入口和技能管理停机；保留每次模型请求的选择证据 |
| [Personal MCP](../../implemented/architecture/2026-10-17-personal-durable-mcp.md)、[定时工作](../../implemented/architecture/2026-10-18-personal-durable-scheduled-work.md) | 整配置换代阻塞、失效凭据阻止停用、展示名使计划失效；保留实际能力与原外部操作核实 |
| [命令配置](../../implemented/architecture/2026-10-17-personal-command-configuration.md)、[服务配置](../../implemented/architecture/2026-10-17-personal-service-configuration.md) | 永久不可变与所有历史对 current 的比较；保留旧执行身份及相关占用 |
| [工具与资料](../../implemented/architecture/2026-10-17-personal-tools-access-artifacts.md)、[Telegram 入口](../../implemented/architecture/2026-10-17-personal-telegram-entry.md) | 配置启动捕获与统一停机；保留目标、资料、配对代次与发送事实 |
| [RuntimeModels](../../implemented/architecture/2026-10-23-runtime-models.md)、[Code 模型设置](../../implemented/feature/2026-10-21-code-model-settings.md) | 受影响 provider 的差异分类；保留目录发布、回滚、引用和完整操作收尾 |
| [桌面设置提案](../feature/2026-10-21-desktop-settings-management.md) | Personal 停机保存范围；其余设置交付与尚缺外部验收继续原归属 |

命中的工作流、旧 scheduler/outbox、旧实例导入、旧 QQ/Telegram 入口、SubAgent、应用数据及权限笔记不改变其执行语义；本方案仅在具体调用方消费新配置时回归原规则。已有 owner-operation-scope 只收窄读取/操作核实，不覆盖配置切换。没有完全吸收或应归档的笔记，也没有需要删除的过时提案；本提案不宣称这些旧要求已经实现了变化。

## 备选方案

- 只删除停机与空闲检查：修改最少且立刻开放按钮，但旧闭包不会更新，活跃存储可能出现第二写入者，旧操作恢复会被新配置污染，因此拒绝。
- 保存后自动重启整个后台：可以继续复用启动装配和原维护流程，但仍打断无关工作、要求 systemd/旧模型环境，不能满足本次目标。
- 一次引入通用配置框架和任意多版本运行实例：可以统一各模块，但扩大接口、迁移和维护负担；现有模块已拥有绝大部分操作身份，按模块补选择与切换即可。
- 只做 Skills 和显示名，永久保留目录/IM 限制：风险较低、可先交付，作为前置切片采纳；不能把它当作整个任务完成，否则遗漏拥有者明确确认的迁移与在线配置目标。

## 验收标准

完整验收以[规格矩阵 A1–A12](../../../../.scratch/configuration-updates/spec.md#验收矩阵)为准。必须同时证明同 PID 在线应用、离线不启服务、无关工作不中断、旧请求/批准/结果不改发、相关未决仍阻止不安全切换、保存与生效故障可按原键核实。计划校验要使用真实实现，不能用测试自写的深比较代替。

新格式迁移保留旧历史并拒绝旧程序误读；新客户端不对旧后台静默回退停存启。旧未决维护仍可查询和恢复，部署升级与每次设置保存分别验收。独立方案审查和实现审查分开，替身不证明真实两壳、Linux、模型或 IM 行为。

## 风险

文件、durable 选择和内存对象之间没有跨介质事务，必须逐失败窗口记录可恢复事实；候选已保存未生效不能误报成功或自动覆盖回旧文件。新增请求证据或格式标记前须核对恢复全链，不能只改设置入口。

旧配置与历史的引用数量会增加，但只保留实际存在过并被恢复需要的版本，不增加物理回收功能。命令/服务安全边界可能等待旧环境核实；这项等待保留为相关目标的明确状态，不包装成全局只读。旧模型/provider 和 IM 句柄不能过早释放，停用也不能被解释成外部执行已停止。
