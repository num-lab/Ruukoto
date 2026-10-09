Status: resolved

# 09 — 通过 IM 检查并管理 Linux 服务

**What to build:** Personal Agent 用专用账户检查指定测试服务，经 IM 批准实际执行需要授权的管理操作，并向原入口汇报。

**Blocked by:** [08 — 在绑定拥有者的 IM 私聊完成审批](08-im-approvals.md)

依据：[已确认规格](../spec.md) 与 [ADR 0017](../../../docs/adr/0017-two-agent-products.md)。

## 验收标准

- [x] 完成服务状态或日志检查、提出指定管理操作、IM 审批、真实执行和结果返回的完整链路。（smoke-09 A：检查 → 提出 restart → 原入口通知/详情/批准 → 真实重启 → 原入口结果，一次性通过）
- [x] 提供真实可验证的主机执行及必要提权边界，不能仅向 main 开放 bash 就宣称具备服务器管理能力。（main 无 bash；执行账户无新增 sudo/Polkit；唯一入口=root 拥有的 helper + sudoers 固定 argv；smoke-09 B 真实账户边界全拒证据）
- [x] 授权固定操作和目标，控制面、后台凭据和其他任务权限仍受保护，越界及权限不足明确失败。（白名单策略 + 固定动作 + 修订指纹绑定审批；smoke-09 C 与 test/78 篡改/越界全拒）
- [x] 开发机器离线不影响此服务器侧流程；执行中断或结果未知不自动重发管理操作。（smoke-09 远端自包含执行；D 阶段 kill -9 恢复效果未知不自动重发；helper 同 ID 持久认领）
- [x] Linux 验证使用可控测试服务，保留可复跑证据；模拟平台测试与真实服务操作验证分别说明。（smoke-09 三轮幂等 14/14；分类见下方实施完成评论）
- [x] 完成相关端到端检查、类型检查及仓库要求的验证；同步本次行为涉及的运行说明和图解，验证记录区分模拟结果与真实环境结果。

## Comments

### 2026-10-03：实施计划

基于 HEAD `f522cce` 制定。08 已完成：两平台的拥有者审批命令、固定原入口、单次批准消费、凭据及绑定变化失效、通知 outbox 和重启恢复均可复用。08 的真实后台及 Linux 冒烟使用模拟消息平台，真实 QQ/Telegram 演练仍未实测；09 的验证记录应继续区分这两类证据。

首版完成一个可以复跑的服务器事务：拥有者在 IM 请求检查 `ruukoto-service-test.service`，main 查询状态并提出重启，经原入口批准后在服务器真实执行，再由当前 main 任务向原入口返回执行结果与操作后的状态。只增加 `service_inspect` 和 `service_manage` 两个结构化工具，后者的 action 首版固定为 `restart`。工单允许状态或日志检查，状态查询已经满足本单需要；日志、其他管理动作、远程主机管理及 10 的长期操作授权等到相应需求再加入。

已确认的执行边界是：main 当前没有 bash；受限编码容器不能管理宿主 systemd；现有 systemd 工作进程启动器只接受 `full_access`，其执行 UID 也没有服务管理权限。对 `ssh tx` 的只读检查确认，后台与执行账户分别为 `ruukoto-backend`（UID 999）和 `ruukoto-exec`（UID/GID 986），后台当前只能经 sudo 调用两个固定的 exec 包装入口，执行账户无免密 sudo 权限，不能读取拥有者令牌、后台凭据及核心库，也不能修改部署代码、后台单元或访问 Docker socket。部署说明中的 UID 1002 是示例，不能覆盖实际身份。

因此新增一个仅可信后台可调用的受保护服务 helper，服务检查以固定执行账户运行，重启通过该 helper 的受限 root 分支完成。这个 root 能力单独逐次审批，包括 `full_access`；后者继续代表执行账户已有权限，不能把后台的新提权能力视为执行账户已有权限。该边界与 ADR 0003/0004 的账户隔离及 ADR 0017 的明确服务器授权一致，也沿用现有应用数据破坏性操作、通知工具始终审批的做法。

#### 实施步骤

1. **建立固定目标的部署策略与受保护执行入口。**

   在 `deploy/systemd/` 增加一个独立服务 helper，采用 Node 标准库与系统已有的 systemd/sudo，不增加依赖或通用执行框架。安装到 root 拥有、后台和执行账户不可写的固定路径；sudoers 只给后台调用这个入口的权限，执行账户不新增 sudo/Polkit 权限。helper、策略、操作标记目录及其父目录的属主与写权限都要验证，不能从模型参数或保留的环境变量获得可执行文件、配置路径、UID/GID 或 systemd 选项。

   策略使用固定的 root-owned 文件，例如 `/etc/ruukoto/services.json`，记录本机身份、执行 UID/GID、精确单元及允许动作。默认只列 `ruukoto-service-test.service`，由拥有者在可信部署流程修改；模型不能增删目标。目标必须是精确规范的 `.service` 名，拒绝别名、模板实例、路径、通配符、空白、以选项开头的值及额外参数。拒绝把后台、控制面、Docker、执行工作进程及本 helper 的操作单元列作管理目标。目标 unit 和 drop-in 由可信部署身份维护，首版测试服务的启动程序也由 root 管理。

   helper 只接受固定的检查、重启及停止本次命令单元的协议。检查返回白名单内服务的 `Id`、`LoadState`、`ActiveState`、`SubState`、`MainPID`、`InvocationID`、`Result` 和启动时间等固定字段；不输出整个 unit、环境变量或任意日志。检查命令显式降到策略中的执行 UID/GID，重启分支以 root 执行固定的 `/usr/bin/systemctl --system restart <unit>`。调用全部使用绝对可执行路径和结构化 argv，并清理环境；不能提供 shell 字符串或自由 systemctl 参数。

   宿主操作 ID 派生独立的短命命令单元，例如 `ruukoto-service-op-<hostOpId>.service`，由 `systemd-run --pipe --wait` 启动，设置 `KillMode=control-group` 和有界运行时间。helper 严格校验 ID 为现有 `op_` 加 24 位小写十六进制的形态；停止协议只能停止由同一操作 ID 派生的命令单元，不能接受管理目标或任意单元名。重启分支在调用 systemd 前，先在固定 root-owned 操作目录中以原子 `mkdir`/排他创建认领一次执行权；同一 ID 已有标记就拒绝再次启动。标记持久保留，不随 transient unit 回收而删除，也不因失败而自动解除；它只证明已认领，不能作为服务已重启的证据。无需新增核心数据库表或另建执行状态机。

   服务重启使用正常的 `systemctl restart` 等待命令完成，不加 `--no-block`；`systemctl --wait` 的长期服务语义不适合这里。上文 `systemd-run --wait` 等待的是本次命令单元退出。服务原本不活动时 restart 会启动它，这个影响必须在审批中明确展示；systemd 的依赖传播也仍按可信 unit 定义生效。[systemctl v255 文档](https://github.com/systemd/systemd/blob/v255/man/systemctl.xml)、[systemd-run v255 文档](https://github.com/systemd/systemd/blob/v255/man/systemd-run.xml)

   主要落点：新的服务 helper、`deploy/systemd/sudoers.d.ruukoto`、后台部署配置及 `deploy/systemd/README.md`。复用身份及受保护入口的部署方式，但不能复用现有 exec 启动器来把 confirm 任务改成 full_access。

2. **将 main 的服务工具接入统一审批，固定本机、动作和单元。**

   新增集中的 `src/agent/service-tools.ts`，在 `ToolCategory`/工具可用性表中登记服务类别，仅向 main 开放。Runtime/Driver 装配同时要求产品为 `ruukoto`、运行于 Linux、服务管理有显式部署配置；普通 dev、coding、chat、QQ 群及 `ruukoto-code` 都不能获得该能力。发送给模型与实际调用使用同一任务工具集合，调用时继续核实 main、任务、会话及原资料身份。main 系统提示说明两个工具及审批边界，编码任务继续按现有委派路径处理。

   模型只提供白名单服务名与固定动作；主机身份、taskId、hostOpId、执行身份及策略版本由宿主注入。`service_inspect` 无写入效果，可以直接执行；`service_manage` 的 restart 始终调用 `ApprovalGate.request`，新 scope 在 auto-review 中归入 `ask_owner`。不增加自然语言批准、不切换任务权限，也不创建长期授权。

   在 `ApprovalScope` 增加 `service_operation`，固定本机身份、规范单元、restart、策略修订、单元定义修订，以及任务和宿主操作 ID。请求前通过 helper 获取可信状态与修订；修订应覆盖策略和 unit/drop-in 的身份、内容及已加载配置，拒绝 `NeedDaemonReload` 或来源不可信的配置。只保存摘要和必要身份，不把秘密配置正文放进审批。活动状态、PID、InvocationID 属于观察结果，不作为修订指纹，避免服务正常状态变化使批准无故失效。

   宿主生成的审批说明包括准确目标、提权身份、动作影响、请求时状态及超时后可能无法确认效果。执行参数来自审批保存的不可变快照。消费事务内复用 main/任务/权限版本、IM 固定身份的复核，并核实可同步检查的部署配置修订；helper 在发送任何 restart 请求前再次核实本机、白名单、策略和已加载单元修订。变化时明确拒绝，已经消费但 helper 明确证明尚未请求 systemd 的情形记为已知未执行，重新操作需要新审批。SQLite 消费与 systemd 操作之间不存在跨系统事务，不能声称检查与外部效果整体原子。

   08 的审批 notice、列表/详情、决定回执和单次消费直接复用；不另建服务审批页面、命令组或通知表。等待审批期间，拥有者的控制命令仍直达宿主，不被 main 的普通消息队列阻塞。相关落点为 `src/core/types.ts`、`src/agent/tool-availability.ts`、Driver、Runtime、`src/agent/session-factory.ts` 和新工具模块；按实际需要扩展 scope 展示，保持 TUI/CLI 审批可用。

3. **接好受管执行、结果证据及中断恢复。**

   复用 `ManagedProcessRegistry`：在任何异步启动前登记 starting，占位停止路径要覆盖迟到创建的单元；启动后登记具体 systemd 单元。停止先阻止后续启动，再回收已创建单元，并等待 helper/launcher 退出。只有成功查询并确认命令单元及 cgroup 已退出才释放占用；权限错误、systemd bus 不可达或查询失败不能当作已退出。现有 exec-stop 以 `is-active` 非零推断停止的方式不能直接搬到本 helper。

   操作停止只清理命令执行单元。systemctl 已向 PID 1 提交的重启作业可能继续，不能靠杀掉命令客户端宣称撤回，也不能自动停止目标服务作为回滚。使用原审批消费与 `ToolOpLedger`：未消费的请求中断为已知未执行；状态查询中断为无写入效果；restart 已消费且无确定结果为效果未知。权限/校验明确在请求前拒绝时报告未执行；已提交后的非零退出可能包含“服务已停止但启动失败”的部分效果，不能统一描述为零执行。

   在静态账本规则中登记 `service_inspect=no_effect`、`service_manage=approval`，复用停止和后台恢复的结算路径。同一 hostOpId 不再次进入启动流程，helper 的持久单次标记补上跨进程和瞬态单元回收后的重复保护。后台重启、取消、超时、断线、核心结果写入失败及产物写入失败都不能自动重发 restart；换操作 ID 重试也不能成为宿主的自动恢复策略。拥有者先核实未知结果，再明确发起新的操作并重新批准。

   stdout/stderr 原始字节先进入 `ArtifactStore`，再生成有界模型视图；正常回收后标记 complete，中断或写入失败保持 partial。记录操作 ID、命令单元、实际执行身份、退出码、前后状态及观察时间。新宿主工具的产物引用必须接到 Driver 的 `task.tool_result`，当前引用读取来自路由器，不能只保存正文却遗漏事件引用；采用最小接线，不重构所有宿主工具。

   正常重启返回“管理命令结果”和“随后观察到的服务状态”；命令退出 0、服务 active 与业务健康分别表达，不把 systemd 成功等同于应用健康。状态观察失败时保留已知命令结果并说明无法核实后状态。main 通过现有 owner_reply 回到原平台、账号和拥有者；服务工具不额外发结果通知。发送操作效果未知沿用 outbox 规则，与服务操作效果未知分别记录。

   主要落点：新服务工具模块、Driver 的工具意图/结果与停止接线、`src/agent/tool-op-ledger.ts`、现有产物及受管执行能力。缺少 Linux/systemd/helper/sudo 权限时明确失败，不能回退到后台身份执行自由命令，也不能向容器开放 systemd bus、Docker socket 或控制面目录。

4. **用隔离后台和真实 Linux 测试服务完成整条链路。**

   在 `deploy/systemd/` 提供可安装、可清理的 `ruukoto-service-test.service` 与最小启动程序：以专用执行账户运行，无网络、无业务凭据、`Restart=no`，每次启动保留 InvocationID/计数用于观察，代码由 root 拥有。systemd 自身的 InvocationID 和命令结果是主要执行证据，执行账户可写的计数文件只作为辅助观察，不能成为授权依据。

   新增 `.scratch/agent-direction/smoke-09-linux-service-management.mts`，在 Linux `ssh tx` 使用真实产品后台、隔离 profile/socket/SQLite、实际部署的 helper 和 systemd 测试服务，串起状态检查 → 提出重启 → 原入口审批通知/详情 → 批准 → 真实重启 → 原入口结果。模型、OneBot/Bot API 可以复用 08 的桩；必须明确标为模拟平台，systemd/提权/测试服务部分必须真实执行。测试代码和依赖全部位于服务器，关闭开发机连接后流程仍能完成，不通过开发机转发命令。

   部署演练使用独立、受保护的测试安装目录与隔离后台配置；不以日常 `/opt/ruukoto` 是否存在来假定已部署本单代码。测试只操作本单服务，保存 hostOpId、审批 scope/consumedAt、前后 InvocationID、实际启动次数、执行账户/提权边界及原入口 outbox 证据。准备安装、初始启动、修改测试 unit、daemon-reload 和清理步骤属于可信部署流程，不能暴露给模型工具。

   真实 QQ/Telegram 验证由绑定拥有者在测试账号/bot 上主动委托并批准/拒绝，核对实际消息 ID、身份、单次消费和结果；避免测试后台与日常后台同时消费同一账号。没有真实平台入口时记录未实测项，不能把模拟平台加真实服务演练写成真实 IM 验收。09 主路径在当前 main 任务内完成，通用 SubAgent 和异步最终汇报仍分别属于 11、18。

#### 验证与验收

新增 `test/78-linux-service-management.test.ts`（实施时核实编号）集中验证服务工具、helper 协议和真实 Runtime/Store 接线；复用 test/77、`test/helpers/fake-bot-api.ts`、`test/helpers/mock-onebot.ts` 与现有模型桩，不另建测试框架。跨平台离线测试可以使用受控 helper 替身验证协议与故障，但不能替代 Linux 真实执行。必须覆盖：

- QQ、Telegram 各自完成检查、申请、详情、批准、一次执行与原入口结果；拒绝时 restart 零次，等待审批期间命令零新增模型调用、零普通任务。Linux 至少完成一条模拟平台加真实服务的产品路径。
- main 以外的角色、错误产品、群入口、任务身份不符、计划模式及工具集合收窄不能管理服务；macOS、配置未启用、缺 helper、缺 systemd 与 sudo 权限不足明确失败。main 不获得 bash。
- 所有模式的 restart 逐次审批，auto-review 不自动批准；篡改动作/目标、额外 argv、选项注入、通配符、别名/模板、后台或执行单元目标全部拒绝。普通执行账户仍无法直接调用 helper、修改策略或读取控制面/后台凭据；另一个任务不继承本次授权。
- 批准后、执行前的 IM 绑定/凭据、权限、策略、目标定义及加载配置变化导致零管理请求；同一批准重复消费、平台重投及同 hostOpId 重复调用均不能再次重启。单次标记已创建但命令尚未启动的崩溃也不自动重放。
- 取消覆盖等待审批、消费后启动前、starting、执行中及迟到结果；查询失败不能释放占用，整个命令 cgroup 的退出需要核实。真实测试包含目标服务的重启请求已经提交、命令客户端随后中断的窗口，结果未知时启动次数不会因恢复而再次增加。
- 后台重启覆盖未批准、已批准未消费、已消费在途和结果已产生但本地落盘失败；区分已知未执行、已知失败/部分效果与效果未知。产物先捕获后截断，部分产物与引用可查，缺回执不能伪装成功。
- 正常重启的前后 InvocationID 变化，启动计数恰好增加一次；被拒及越界操作计数不变。最终回答的目标固定；服务执行失败、后状态查询失败和 outbox 发送未知分别保留真实结论。

实施后的检查顺序：

```bash
npx tsx --test test/78-linux-service-management.test.ts test/77-im-approvals.test.ts test/63-approval-gate.test.ts test/62-tool-availability.test.ts test/64-tool-op-ledger.test.ts
npx tsx --test test/08-approvals.test.ts test/22-auto-review.test.ts test/28-main-data.test.ts test/37-scheduler-outbox.test.ts test/38-telegram-owner.test.ts test/40-qq-private.test.ts test/44-task-tool-policy.test.ts test/59-system-prompt.test.ts test/71-product-entry.test.ts
npm run typecheck
npx tsx --test test/67-visual-docs.test.ts
npm test
```

Linux 另外复跑真实服务冒烟与执行边界检查，报告成功、拒绝、越界、权限不足、重复操作、修订变化及中断恢复的实际证据。08 的全量记录为 817 项中 815 通过、1 跳过、test/08 DNS 60s 超时；本单仍需运行规定检查，出现该失败时重新对照干净基线，不能直接沿用旧结论。

同步 `docs/runtime.md`、`deploy/systemd/README.md` 的工具范围、策略安装、提权身份、演练及恢复说明；领域说明沿用已有审批、批准消费与效果未知术语。用短 ADR 记录服务 helper 的受控 root 边界及所有模式逐次审批，与 ADR 0003/0004/0017 明确衔接。对每个实际改动的 `src/`、`deploy/` 文件按仓库约定运行 `grep -l <文件路径> docs/visual/*.html`，同步命中页面的图、表和正文，重点核查执行部署、工具调用、任务生命周期及存储说明，并运行 test/67。

完成时逐条登记六项验收，分别写明离线协议测试、模拟平台加真实 Linux 服务、真实消息平台的结果及未实测内容。本次只保存计划，保留当前工单状态及验收勾选。

### 2026-10-03：实施完成与验收登记

按计划四步实施，HEAD 起全部工作在 develop 工作区完成（随本评论一并提交）。

**实现**：`src/agent/service-tools.ts`（service_inspect/service_manage 宿主工具 + helper 客户端）；`deploy/systemd/ruukoto-service.mjs`（root 拥有的固定协议 helper）、`ruukoto-service-test.{sh,service}`（可控测试服务）、sudoers 增加第三固定入口；`service_operation` 审批范围、main 的 `service` 工具类别（装配另要求产品 ruukoto + Linux + 显式部署配置 RUUKOTO_SERVICE_HELPER/POLICY）、账本规则（inspect=no_effect / manage=approval）、Driver 装配与宿主产物引用接 `task.tool_result`、IM 通知为服务范围展示结构化说明（目标/提权身份/影响/请求时状态）。任何访问模式（含 full_access）restart 逐次审批；新增 [ADR 0019](../../../docs/adr/0019-service-management-controlled-helper.md)。

**验证记录（三类证据分列）**：

1. 离线协议测试（macOS，模拟 IM 平台 + 受控 helper 替身 [test/helpers/fake-service-helper.mjs](../../../test/helpers/fake-service-helper.mjs)）：`test/78-linux-service-management.test.ts` 22/22——双平台全流程、拒绝/重复决定零执行、非 main/群/错误产品/无配置/平台门、篡改目标全拒、auto-review 与 full_access 逐次审批、策略与单元修订变化失效、同 ID 重复启动拒绝、取消各窗口、跨重启效果未知不自动重发、产物 partial/complete 与事件引用。
2. 模拟平台 + 真实 Linux 服务（tx，`.scratch/agent-direction/smoke-09-linux-service-management.mts`，三轮幂等 14/14）：真实部署安装、主链路真实重启（InvocationID 变化、starts 恰 +1、批准消费一次、op 单元 journal 实录、实际执行身份落证）、执行账户三条越界全拒、同 hostOpId already_claimed、策略篡改 recheck 失效、改单元不 daemon-reload 修订拒绝、基础设施目标拒绝、op 已派发 kill -9 恢复效果未知不自动重发、拒绝零执行。日常后台全程未受影响；演练产物按真实部署保留（helper/策略/ops 目录/sudoers），测试服务已卸载。
3. 真实消息平台：**未实测**（IM 与模型均为桩），留待拥有者以测试账号/bot 主动演练。

**过程中发现并已修复的问题**：fd3 协议通道在 sudo 下全断（sudo closefrom=3，test/78 的 useSudo:false 替身天然测不到，由 smoke 首轮暴露）→ 协议改 stderr 前缀单行 JSON；helper 派发后意外失败误报「已知未执行」→ launched 如实按已派发上报、调用方记效果未知；执行身份未落证 → 应答与结果文本补记；IM 通知 JSON 截断可能藏住关键说明 → 服务范围结构化摘要；test/27、test/62 工具类别枚举随新类别更新。

**code-review**（Standards/Spec 双轴）：硬违规 0；judgement 项按仓库约定处理（替身镜像协议、failText 沿用 host-tools 命名）；scope creep 仅 helper 固定拒绝清单多含 dbus（防策略误配的硬化，helper 注释已注明）。已知设计保留：策略路径双来源（宿主环境变量 + helper 硬编码）fail-closed，以 README 约定维系。

**检查**：规定批次（test/78/77/63/62/64 + 08/22/28/37/38/40/44/59/71）全绿；`npm run typecheck` 通过；test/67 3/3；`npm test` 全量 838 项 837 通过 1 跳过（真实模型凭据门控，与既有基线一致；08 记录的 test/08 DNS 超时本轮未复现）。文档同步：`docs/runtime.md`（新「服务器服务管理」节 + 验证状态表）、`deploy/systemd/README.md`、docs/visual 命中页（tool-call-path/orchestrator/deployment）。
