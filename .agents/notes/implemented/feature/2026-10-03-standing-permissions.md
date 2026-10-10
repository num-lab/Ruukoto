# Agent Note: 限定的长期服务授权替代重复人工决定

Status: implemented

原出处：ADR 0019「状态：阶段边界补充（2026-10-03，issue 10 交付）」

## 问题

固定 helper 提供的服务 root 能力在所有访问模式都需逐次人工审批，重复对同一白名单服务 restart 会重复要求拥有者决定。[两个产品](../architecture/2026-10-02-two-agent-products.md)要求具体操作和目标可保存可撤销的长期授权，同时不能把它扩大为任意 root 能力或跨任务复用单次批准。

## 决定

首版长期授权只允许原 Personal Agent main 从原 IM 入口，在本机对指定白名单服务执行固定 `restart`。范围固定 main 会话及原资料身份、原入口稳定 channel/account/chat/actor、原 NotifyTarget 配置代次、本机身份、规范单元、restart、策略和 unit 修订；不包含创建任务的 taskId/toolOpId 或请求时状态。共享主会话不让另一平台、TUI、调度、GitHub 或子任务消息继承授权。root 白名单仍是能力上限，执行账户权限与任务访问模式不改变，操作仍经过[服务管理 helper](../architecture/2026-10-03-service-management-helper.md)。

授权存入后台保护核心库 `standing_permissions`，范围创建后不可修改，修改必须撤销再新建。按稳定入口与 main/本机/目标/动作约束最多一条未撤销授权，策略和配置修订仅用于使用资格核实；来源审批唯一。撤销与失效递增行版本并保留原因，同版本重复撤销幂等，旧代次失效后不会复活。数据不放入应用数据、记忆、指令、技能、grantedPaths 或 root 策略文件，不把旧单次批准或 full_access 转成授权。

拥有者只从原 IM 平台 pending 的服务 restart 审批创建：`/approve-standing <完整审批ID> <权限版本>` 同时表示批准本次与保存授权，范围来自原不可变审批，不接受新的目标或动作参数。创建核实活动 main/任务、原入站归属、权限版本、当前可信 actor/目标与部署修订；授权、决定、关联、审计、控制事件终态与回执同事务提交，成功才唤醒。当前操作关联新授权并在消费处重读，不能在授权撤销后继续使用这次长期批准。普通 `/approve` 仍只批准一次。

`/service-grants [页码]`、`/service-grant <完整授权ID> [偏移]` 与 `/revoke-service-grant <完整授权ID> <授权版本>` 有界查询/撤销，复用[IM 控制消息](2026-10-02-im-approval-and-final-report.md)的原始全文解析、可信身份、来源幂等键、零模型/零普通任务和固定 outbox；自然语言、引用、转发、模型和子任务消息不能创建或扩大授权。查询/撤销可经当前可信稳定入口查看旧配置代次，但这不允许旧授权执行。入口停用后已认证控制面 `service_grant_list/get/revoke` 与 `ruukoto service-grant list/show/revoke` 可管理遗留，创建首版仅走原 IM 待审批，无自由范围 API。管理应答丢失先读原记录核实，不自动换键写入。

每次 service_manage 先经 helper 检查真实目标与修订，宿主选择候选，模型不能提供授权 ID。命中精确有效范围时，宿主在同步事务重建并核实授权版本、范围、活动/取消状态、main、原 IM 固定身份与部署策略，为本次新 taskId/hostOpId/permissionVersion 创建独立已批准记录，再经过公共消费并登记授权使用。每次批准单次消费，长期授权本身不被消费；任务保持 running，不虚构等待、审批通知或拥有者刚批准事件，不启动自动审查，决定来源为 `standing_permission`。候选消费前失效则恢复人工，所有模式没有有效授权仍逐次审批；应用数据破坏性变更、通知外发、MCP 写操作等审批规则不变。

撤销先提交使尚未消费的放行失效；消费先提交表示操作开始，撤销只影响后续，不承诺取消 PID 1 已收到的作业。策略/unit 不匹配、IM 重绑、停用再启用、拥有者/账号或凭据代次变化使授权版本递增并失效；暂时离线不等同绑定变化，正常后台重启保留有效授权，但旧未消费批准仍失效。旧独立单次 `/approve` 不因另一长期授权撤销失效。

消费后只有可信请求前拒绝或确定命令结果可记已知结论；协议错误、ID 不符、捕获/落盘失败等无可信结果都记效果未知。`ToolOpLedger.markEffectUnknown` 同事务使同一 main/本机/单元/动作所有入口的有效长期授权失效、增版本，保存原因与操作 ID，覆盖异常、停止、后台恢复和结果写失败。即使换新操作 ID 或入口也不能自动重试；拥有者核实后才能重新明确授权，原未知记录保留。outbox 发送未知独立处理，不误撤销服务授权。helper 对 systemd-run 的启动异常仅 ENOENT/EACCES/ENOTDIR 可证明未派发，其余启动后异常/信号报可能已派发，不猜退出码。

## 验证

[工单 10](../../../../.scratch/agent-direction/issues/10-standing-permissions.md)记录核心库 v22→v23 与控制协议 v10；旧批准来源保留、授权关联为空、不自动产生授权，旧历史仍可读。test/79 在双平台/helper 桩和真实 Runtime/SQLite 下 23/23，规定联检全过，`npm run typecheck` 与 test/67 通过，全量 `npm test` 862 项中 861 通过、1 真实模型门控跳过。

[smoke-10](../../../../.scratch/agent-direction/smoke-10-standing-permissions.mts) 在 `ssh tx` 使用真实 helper/sudoers/systemd/可控服务/隔离后台/CLI，模型和消息平台模拟，修复首轮缺陷后复跑两轮及最终代码一轮均 14/14。当前批准与下一独立任务各执行恰一次、taskId/hostOpId/批准记录各不同而同授权、查看/撤销 v1→v2 与重投幂等、失效后恢复审批零执行、真实杀掉在途 systemd-run 后效果未知且全入口授权失效、执行账户越界拒绝均有证据。真实 QQ/Telegram 平台与真实平台限流/重投放障未实测，不能从模拟结果推断。

<!-- agent-note-format: alternatives-not-recorded (pre-format Agent Note) -->

## 后果

有效精确范围内的重复服务操作不再要求重复人工决定，使用和撤销仍有逐次可核查的版本、独立批准与审计。代价是每次执行都要重建范围并复核入口/目标修订，效果未知后必须恢复人工并由拥有者核实；授权不跨入口共享、不自动续期、不支持编辑或通配范围。原 `.scratch/` 规格、工单与 tickets-draft 未记录独立备选，不补造历史取舍；未来若扩展动作或目标，需要另记决定。[操作手册](../../../../docs/usage.md)描述当前命令与范围。
