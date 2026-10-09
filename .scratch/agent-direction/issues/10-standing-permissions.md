Status: resolved

# 10 — 保存、使用和撤销限定的长期授权

**What to build:** 拥有者为具体操作和目标授予持续权限，后续任务可在有效范围内执行，撤销后恢复审批。

**Blocked by:** [09 — 通过 IM 检查并管理 Linux 服务](09-linux-service-management.md)

依据：[已确认规格](../spec.md) 与 [ADR 0017](../../../docs/adr/0017-two-agent-products.md)。

## 验收标准

- [x] 拥有者可以创建、查看和撤销一条明确的操作与目标授权，例如重启指定测试服务。
- [x] 新任务命中有效范围可执行，换目标或操作必须重新审批；撤销后下一次执行不再放行。
- [x] 执行前重新核实授权版本与范围，模型、子任务消息和普通平台文本不能自行创建或扩大授权。
- [x] 单次批准不因长期授权机制而跨任务复用；不默认开放任意 root 操作，不放宽既有特殊审批规则。
- [x] 完成相关端到端检查、类型检查及仓库要求的验证；同步本次行为涉及的运行说明和图解，验证记录区分模拟结果与真实环境结果。

## Comments

### 2026-10-03：实施计划

基于 HEAD `c1e52f3` 制定。09 已完成 main 的 `service_inspect` / `service_manage`、固定 root helper、白名单与策略/单元修订复核、原 IM 审批及单次执行保护。其全量检查为 838 项中 837 通过、1 跳过；Linux `ssh tx` 的模拟平台加真实服务冒烟三轮各 14/14，真实 QQ/Telegram 仍未实测。本单直接复用这些能力。

首版只保存一类长期操作授权：允许当前 Personal Agent 在本机对指定白名单服务执行 `restart`。拥有者从正在等待的服务审批中明确选择“批准本次并保存长期授权”，后续独立任务命中精确范围时可执行，撤销后恢复人工审批。授权仅属于原 main、原 IM 入口及拥有者绑定；共享主会话不使另一平台继承授权。范围还固定策略和单元定义修订，任何不匹配都不能自动执行。

这项授权可以替代服务操作的本次人工决定，执行仍走 09 的 root helper 与同一批准消费边界。ADR 0019 的“所有模式逐次审批”需要补充这个明确例外，与 ADR 0017 的长期操作授权目标衔接；没有有效授权时，包括 full_access 在内仍逐次审批。应用数据破坏性变更、通知外发、MCP 写操作及其他工具的特殊审批规则继续按原范围判定，不能将本单授权用于它们。

#### 实施步骤

1. **在受保护核心库保存不可变的限定授权及版本。**

   增加 `standing_permissions` 表及类型，核心库从 v22 迁移到 v23（实施时核实版本）。记录授权 ID、版本、main 会话及原资料身份、本机身份、精确 `.service` 单元、固定 restart、策略/单元修订、原平台 actor 与钉版 NotifyTarget、来源审批及控制事件、创建时间、撤销时间和原因。存续范围不包含创建任务的 taskId/toolOpId 或请求时服务状态；这些只属于每次执行的快照和审计。

   授权范围创建后不修改；修改通过撤销后新建完成。撤销使用授权 ID 与期望版本的条件更新，递增版本并保留记录，重复撤销不再次变更。同一 main、同一拥有者入口和同一机器/单元/动作最多一条未撤销授权，使用数据库约束防止重复有效范围；入口唯一键使用稳定的 channel/account/chat/actor，配置及策略/单元修订只参与使用资格核实，不进入唯一键。过时代次先明确失效，再允许重新创建。创建和撤销分别与持久审计事件在一个核心库事务提交，来源审批也要唯一，旧命令重投不能重新建授权。

   授权存放于后台保护的核心库，不放入应用数据空间、记忆、项目指令、技能、grantedPaths 或 root 策略文件。root 白名单仍是部署能力上限，长期授权只能在它内部减少重复人工决定。资料授权 `data_grants` 与现有 CLI `grant` 的 history/artifact/memory 语义不适用于本单，不复用其范围模型。

   为每次批准记录增加可空的授权 ID/版本来源，并扩展 `decisionSource` 为 `standing_permission`。升级后的旧批准来源保持原值、新关联列为空，不把历史单次批准、旧 grantedPaths 或完全访问任务转换成长期授权。迁移保留历史、产物、审批、工具操作和 IM/outbox 来源关系。

   主要落点：`src/core/types.ts`、`src/core/db.ts`、`src/core/store.ts`。范围匹配、版本条件更新及失效逻辑集中实现，不新增通用 RBAC、通配授权、授权编辑、自动续期或同步机制。

2. **通过拥有者控制消息创建、查看和撤销，复用 08 的事务与去重。**

   在 `src/runtime/im-approvals.ts` 增加以下整条匹配的文本命令：

   ```text
   /approve-standing <完整审批ID> <权限版本>
   /service-grants [页码]
   /service-grant <完整授权ID> [偏移]
   /revoke-service-grant <完整授权ID> <授权版本>
   ```

   创建只接受一条当前 pending 的 `service_manage + service_operation + restart` 审批，范围完全来自原不可变记录，不接受用户或模型提供的新主机、单元、动作、修订或持续范围参数。宿主同时核实活动 main/任务、原入站归属、完整 ID、审批及任务的当前 permissionVersion、当前 IM actor 和固定目标，并重读可同步核实的服务部署策略。已决定、已消费、过期、无活动 waiter 或非服务范围的请求都不能产生授权。

   `/approve-standing` 明确表示保存持续授权并批准这一次。经现有 `ApprovalGate.resolve(..., { txExtra })` 的事务接线，把授权创建、当前决定及授权关联、审计、控制事件终态和原入口回执一起提交，成功后才唤醒 waiter。任何一步失败都回滚，不能在创建时审批或任务已经失效的情况下保存可用授权。原 `/approve` 仍只批准一次，绝不隐式保存长期授权。

   当前操作也关联新授权 ID/版本，并在消费时重读；它不能成为撤销授权后仍有效的独立批准。服务审批 notice 和详情提供单次批准、长期批准两种准确说明：完整机器/目标/动作、root 提权影响、绑定入口、修订条件、持续至撤销或失效，以及查看/撤销命令。创建回执区分“授权已保存、本次批准已接受”和实际执行成功；存在该目标的历史效果未知操作时展示操作 ID，并要求拥有者核实后再明确授权，不能用宿主自动续建代替。

   新命令复用原始 `commandText`、身份核实、`(source, external_id)` 去重、同键异命令拒绝、同步事务终态及固定目标 outbox；仍以现有 `im_approval` 控制类别登记，补充其文档含义，不扩展普通任务派发或增加第二套控制账本。main 等待审批或忙于执行时命令直接处理，零模型调用、零普通任务。自然语言、转发/引用、模型输出、子任务消息、群消息和伪造工具参数不能创建或扩大授权。

   列表和详情有界分页，展示完整范围、来源、授权版本、存续条件及撤销/失效原因。使用授权要求原目标代次完全一致；查看和撤销可在当前可信入口核实稳定的 channel/account/chat/actor 后查看旧配置代次，并明确标为入口已失效，这个目录权限不能用于放行旧授权。入口停用或换拥有者后，已认证控制面仍可管理遗留记录：增加有界 list/get 与带版本 revoke 接口，以及 `ruukoto service-grant list/show/revoke` 的薄 CLI 接线；创建首版仍经原 IM 待审批请求，不增加配置页面或自由范围创建 API。

   所有管理命令只通过宿主可信入口。控制面沿用拥有者令牌认证，拒绝未认证访问及错误产品；查询/撤销应答丢失后读取原记录核实，不自动换键写入。回执复用 outbox 的限流与效果未知规则，撤销命令重投不能恢复或重建授权。

   主要落点：IM 审批模块、`src/runtime/runtime.ts`、ApprovalGate 的决定接线、`src/control/server.ts`、`src/control/protocol.ts` 和 `src/cli.ts`。命令基础共用，不把各入口的身份验证压缩成模型提供的一个“owner=true”。

3. **每次执行重新授权并单次消费，撤销与未知结果沿统一边界处理。**

   `service_manage` 仍先通过 helper 检查真实目标，取得本次策略/单元修订和状态。宿主按当前 main、任务来源、actor、钉版目标、本机、单元、restart 及两项修订查找候选授权，模型不能指定授权 ID或版本。任务开始时缓存的授权、之前的工具结果、消息中的授权 ID 和其他平台的授权都不是执行依据；TUI 提交、调度、GitHub 或子任务消息不能因共用 main 而继承原 IM 授权。

   有匹配授权时，通过 ApprovalGate 的窄服务授权路径，为本次新 taskId/hostOpId/permissionVersion 和不可变执行快照创建独立的已批准记录。在同一同步事务中重读授权版本与未撤销状态，核实完整范围、活动任务及取消状态、main 身份、原 IM 固定身份和可同步复核的部署策略，再消费这次批准并登记授权使用与 `task.approval_consumed`。长期授权本身不被消费，原单次批准也不被重复使用。每次授权使用记录准确的授权 ID/版本、本次审批/任务/操作及决定来源。

   现有 `Store.createConfirmation` 会无条件发布 `task.awaiting_confirmation`，因此自动授权需增加窄的初始已批准持久化路径，并复用公共消费检查；不能先虚构等待事件、待批 IM 通知或“拥有者刚刚批准”再立即放行。命中有效授权的任务保持 running，不启动自动审查。没有匹配项时走现有人工路径，auto-review 对服务范围仍为 ask_owner。候选授权在实际消费前失效时重新判定并进入人工审批，不使用旧缓存执行。

   `/approve-standing` 的当前请求同样在公共消费处核对关联授权。撤销先提交，本次尚未消费的放行失效；消费先提交，该操作已开始，撤销只影响后续操作。旧的独立 `/approve` 不受另一条长期授权的撤销影响。这个顺序以核心库同步事务的消费提交为边界，不承诺撤销能够取消 PID 1 已收到的重启作业，SQLite 与 systemd 之间仍没有跨系统事务。

   继续使用 09 的固定 helper 协议、root 白名单、修订复核、操作 ID 持久认领、受管单元、产物及原入口 owner_reply。无需 helper 读取授权数据库，也不新增执行账户 sudo 权限或服务管理动作。策略或单元不匹配时零自动管理请求，观察到失配的旧授权明确失效；IM 重绑、停用再启用、拥有者/账号变化和凭据代次变化也使原授权失效并递增版本。暂时离线不等于绑定变化，后台正常重启保留有效授权；旧未消费批准仍按原规则失效。

   效果未知必须阻止换 ID 自动重试。在 `ToolOpLedger.markEffectUnknown` 的统一事务路径中，依据已消费的服务审批范围，使同一 main、本机、单元和动作的所有有效长期授权失效，递增版本并保存 `effect_unknown` 与操作 ID；覆盖直接异常、停止、后台恢复和结果落盘失败后的恢复，不能只在工具 catch 中处理。后一项任务即使使用新 hostOpId 或另一入口，也必须恢复人工审批；重新建立授权需要拥有者显式决定，旧未知记录保留，不被改写成成功。发送 outbox 的未知结果单独处理，不能当作服务重启未知来撤销授权。

   当前服务工具只对超时/中止和明确 `launched:true` 的失败即时标未知；消费后的 `protocol_error`、应答 ID 不符及 `capture_failed` 等缺可信应答异常可能按普通报错收尾。本单自动放行前统一修正这个相关边界：只有可信的请求前拒绝证明或确定管理命令结果才记已知结论，其余消费后无可信结果均标效果未知并触发授权失效。helper 自身的错误也必须如实区分未派发与可能已派发：`spawnSync(systemd-run)` 的 `run.error` 或信号不能直接作为零效果或确定退出码，只有可证明命令根本未启动时才报告 `launched:false`；缓冲超限等启动后的异常按可能已派发处理，现有协议足以表达。

   扩展批准来源、事件及 TUI 详情，准确显示“本次使用长期授权 <ID> v<版本>”，避免现有非 auto_review 一律显示“拥有者”的文案误导。随新增来源与线上事件语义提升控制协议版本（当前 v9），旧客户端明确提示升级；持久历史中的旧来源与事件保持可读。主要落点为 ApprovalGate、服务工具、Store、ToolOpLedger、Driver/Runtime、核心视图与 TUI 状态/详情；不另建审批闸门或自动重试层。

4. **验证保存、跨任务使用、撤销及真实 Linux 效果。**

   新增 `test/79-standing-permissions.test.ts`（实施时核实编号），复用 test/77 的双平台桩、test/78 的服务 helper 替身和真实 Runtime/SQLite，以及现有审批/账本故障注入。重点验证新的授权事实和外部执行次数，不能只断言回复文案或照搬范围匹配函数。

   QQ、Telegram 分别完成：普通审批申请 → 查看完整范围 → 显式长期批准 → 当前操作一次 → 另一项独立任务命中并执行一次 → 查看授权及两次独立消费 → 撤销 → 下一次恢复审批且未批准时零执行。两次 taskId、hostOpId、批准记录均不同，只有长期授权相同；原单次批准无法用于后一任务。执行结果与授权管理回执均返回各自固定原入口。

   扩展 `.scratch/agent-direction/smoke-09-linux-service-management.mts` 的可复用场景，或新增 `.scratch/agent-direction/smoke-10-standing-permissions.mts`，在 `ssh tx` 用隔离后台、真实 helper 与可控测试服务验证同一流程。保存授权及版本、每次使用/消费、命令单元与实际执行身份、前后 InvocationID、starts 恰好增加次数和 outbox 证据；撤销、失效及拒绝时计数不增加。测试服务需要重新安装，09 留下 helper/策略/操作目录不代表该服务仍在线，也不代表日常后台已经升级本单代码。

   模拟消息平台加真实 Linux 服务与真实 QQ/Telegram 演练分别登记。真实平台由绑定拥有者在测试账号/bot 主动操作，避免与日常实例同账号并发；没有真实入口时保留未实测项。开发机断连后授权保存、消费和撤销都在服务器完成，不依赖跨端同步。本单仍使用当前 main 服务工具，不提前实现 11 的通用 SubAgent 或 18 的异步最终汇报。

#### 验证与验收

除上述完整路径外，必须覆盖以下边界：

- 换为另一条真实白名单服务时恢复人工审批；非 restart 动作当前不在协议内，明确拒绝，不能命中旧授权。bash、HTTP/MCP、应用数据破坏性变更和通知外发的原审批规则分别保留，full_access/auto-review 也不扩大本单范围。
- 普通平台文本、引用/转发、模型输出、子任务消息、群、错误 owner/account、跨平台、错误版本、部分 ID、非服务审批及已处理请求不能创建授权；创建、列表、详情和撤销零额外模型调用、零普通任务，不因 main 等待而死锁。
- 同消息重投、同键异命令、不同消息重复长期批准、TUI/IM/自动审查抢先、撤销后重投旧创建消息均不重复建授权或执行；创建/决定/关联/控制回执任一步中途写失败全部回滚。
- 撤销与消费按两种事务顺序验证，当前长期批准也参与复核；候选读取后撤销、取消或权限版本变化时不能使用旧候选。授权使用、独立批准和消费事件中途失败全回滚，后台不能在落库失败后继续启动 helper。
- 两平台的重绑、启停、同 owner 重新绑定、凭据 A→B→A/删除、旧连接与旧收件目标；策略与单元修订变化、后台换库/main 身份变化；旧授权失效不复活，另一平台原本独立的授权不因普通绑定失效而受影响。
- 后台重启保留有效授权但不恢复旧待批或已批准未消费操作；已消费在途、协议错误、ID 不符、产物失败、迟到结果及核心结果写入失败按真实证据结算。效果未知使该目标所有有效授权失效，新任务和新操作 ID 都不能自动重试，其他服务的授权继续有效。
- 授权列表/详情有界、旧代次原因可见；入口停用后通过已认证控制面及 CLI 查看/撤销，未认证访问拒绝。新批准来源在事件、详情与 TUI 显示正确，旧历史可查，协议版本不符明确拒绝。
- v22 → v23 迁移不产生任何授权、不改旧批准事实，迁移后的旧审批/产物/入站/outbox 仍可读取；执行账户不能写授权库、调用 helper 或读取拥有者/后台材料，长期授权不升级任务模式。

实施后的检查顺序：

```bash
npx tsx --test test/79-standing-permissions.test.ts test/78-linux-service-management.test.ts test/77-im-approvals.test.ts test/63-approval-gate.test.ts test/64-tool-op-ledger.test.ts
npx tsx --test test/08-approvals.test.ts test/10-access-modes.test.ts test/22-auto-review.test.ts test/25-mcp-write.test.ts test/28-main-data.test.ts test/37-scheduler-outbox.test.ts test/38-telegram-owner.test.ts test/40-qq-private.test.ts test/43-inbound-notification-store.test.ts test/44-task-tool-policy.test.ts test/58-plan-mode.test.ts test/66-control-seam.test.ts test/71-product-entry.test.ts
npm run typecheck
npx tsx --test test/67-visual-docs.test.ts
npm test
```

按实际修改补跑 CLI/TUI 状态与详情的现有检查，Linux 另复跑真实服务冒烟与身份边界检查。全量结果按当次运行登记，出现环境性失败时重新对照干净基线，不沿用旧工单结论。

同步 `docs/runtime.md`、`CONTEXT.md` 的长期操作授权、创建/查看/撤销、使用范围、失效与效果未知规则，更新 ADR 0019 的阶段边界及 `deploy/systemd/README.md` 的验收说明。对每个实际修改的 `src/`、`deploy/` 文件按仓库约定执行 `grep -l <文件路径> docs/visual/*.html`，同步命中图、表和正文，重点核查控制协议、入站、工具调用、任务生命周期、存储及部署页面，并运行 test/67。

完成时逐条登记五项验收证据，区分离线协议测试、模拟平台加真实服务、真实消息平台及未实测内容。本次只保存计划，工单状态及验收勾选保留。

### 2026-10-03：实施与验证记录

按计划交付。核心库 v22 → v23（`standing_permissions` 不可变限定授权 + 版本化撤销/失效，confirmations 加授权关联两列与 `standing_permission` 决定来源）；IM 命令 `/approve-standing`、`/service-grants`、`/service-grant`、`/revoke-service-grant`（创建只接受 pending 的服务 restart 审批，范围完全取自原记录，授权/决定/关联/审计/控制终态/回执同一事务）；闸门窄路径（候选逐项核实后在单事务重建完整范围核验、创建独立已批准记录、公共消费；任务保持 running、不启动审查、命中前无候选回落人工）；`service_manage` 消费后无可信结果分类统一（只认可信的请求前拒绝与确定命令结果为已知结论，其余一律效果未知）并经 `ToolOpLedger.markEffectUnknown` 使同目标所有入口授权失效；真实 helper 修正 `systemd-run` spawn 如实性（仅 ENOENT/EACCES/ENOTDIR 报未派发，启动后错误与被信号杀死报可能已派发、不猜退出码）；控制协议 v10（旧客户端明确拒绝）；控制面 `service_grant_list/get/revoke` 与 `ruukoto service-grant list/show/revoke`（入口停用后仍可管理遗留，创建首版仍只经原 IM）；TUI 详情显示"本次使用长期授权 <ID> v<版本>"。文档同步：CONTEXT.md（长期操作授权/IM 审批控制消息）、docs/runtime.md（新章节 + IM/服务段落）、ADR 0019（阶段边界例外）、deploy/systemd/README.md（派发如实分类）、docs/visual 八个页面（storage-layout/control-protocol/inbound-events/once-only/tool-call-path/deployment/task-lifecycle 及锚点），test/67 通过。

**离线与模拟平台证据（test/79，双平台桩 + helper 替身 + 真实 Runtime/SQLite）**：23/23——存储层（创建/版本化/条件撤销幂等/双唯一约束/候选与分页/使用记录/effect_unknown 定向失效扩散所有入口）、v22→v23 迁移（不产生授权、旧批准关联列为空、旧审批/产物/入站/outbox 可读）、模块级（命中授权零等待零通知、独立批准记录与事件、撤销/版本/修订/取消意图回落人工、消费后协议错误与产物失败标未知并使授权失效、可信请求前拒绝不失效）、双平台全流程（创建→本次执行→第二任务自动放行一次→目录/详情两次消费→撤销→恢复人工审批）、创建边界（自然语言/引用/非服务审批/部分 ID/版本错误/重投/同键异命令/已决定重复长期批准零建授权零执行）、跨平台不继承与 TUI 提交不继承、入口绑定变化失效且另一平台不受影响、目标效果未知两平台授权一并失效、后台重启保留授权、控制面 list/get/revoke。联检批次：78/77/63/64 共 59 项、08/10/22/25/28/37 共 121 项、38/40/43/44/58/66/71 共 53 项、67 visual-docs 全过；全量 `npm test` 862 项 861 通过 1 跳过 0 失败，`npm run typecheck` 通过。code-review 两轴复核后修复：等待型消费事件补授权关联字段、notice 与详情补批准前历史未知操作核实参照、详情/撤销入口谓词去重；剩余两轴 findings 均为 judgement call（测试夹具跨文件沿用 77/78 模式）。

**模拟消息平台 + 真实 Linux 服务（ssh tx，真实 helper/sudoers/systemd/测试服务/隔离后台/真实 CLI）**：`smoke-10-standing-permissions.mts` 两轮 14/14（第一轮暴露并修复 CLI 入口注册与 smoke 断言缺陷后复跑通过；第三轮最终代码复跑 14/14）——approve-standing 保存+批准本次（真实重启、InvocationID 变化、starts 恰 +1）、第二任务零新审批自动放行恰好一次（两次 taskId/hostOpId/批准记录不同、同授权）、授权行与 `standing_permission.created` 审计事件各一、`/service-grants`/`/service-grant` 两次消费回执、真实 CLI list/show/revoke（错误版本拒绝、v1→v2、重复撤销幂等）、撤销后恢复人工审批拒绝零执行、真实杀掉在途 systemd-run 后 helper 如实报可能已派发（op effect_unknown=1、授权 v2 effect_unknown、事件带操作 ID、starts 恰 +1 不描述为零执行、不自动重试）、失效后新任务恢复人工审批、执行账户 helper EACCES/策略写/令牌读拒绝。日常后台全程未被波及。

**未实测**：真实 QQ/Telegram 平台（需绑定拥有者在测试账号/bot 主动演练）；真实平台的限流/重投放障。其余平台语义全部由模拟平台桩覆盖。

**保留的范围不外扩**：长期授权只有本机白名单服务 restart 一类；bash、HTTP/MCP、应用数据破坏性变更、通知外发与各工具特殊审批规则逐次审批不变；full_access/auto-review 无授权时仍逐次审批（auto-review 对服务范围仍为 ask_owner）；不默认任意 root 操作；单次批准不因本机制跨任务复用。
