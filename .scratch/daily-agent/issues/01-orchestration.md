Status: resolved

# 角色、事件与子任务编排

## 目标

在现有 `Project → Session → Task → Driver` 上增加逻辑角色和父子任务，使外部事件、main、coding、chat 可以通过后台可靠通信。

## 依赖

无。复用现有任务队列、持久事件和会话恢复机制。

## 实现范围

- 角色配置：`main`、`coding`、`chat`；每个角色绑定 Project、Session、工作目录、模型和工具白名单。
- 任务字段：`agent_id`、`parent_task_id`、`source_event_id`、`deadline`、结果摘要和结果引用。
- 入站事件：来源、外部 id、actor、目标角色、正文/产物引用、接收时间、处理状态。
- 内部委派 API：只允许后台编排器创建子任务；模型不能调用 owner 控制面。
- 子任务完成、失败、超时和结果未知事件；main 的有界唤醒输入。
- 幂等键覆盖外部事件、子任务创建和内部结果回传。
- 重启恢复：事件已登记但尚未建任务时可继续；不自动重放未知外部副作用。

## 边界

角色配置决定工具和资料范围，不能由输入正文、项目指令或模型结果修改。跨角色传递只传固定字段和引用，不复制未授权的完整历史。

## 验证

- 重复事件只创建一个子任务；
- 父任务完成前子任务结果可查询；
- 子任务结果能唤醒 main；
- 后台重启不会重复创建或重放外部操作；
- coding、chat 不能读取 main 的 owner token 或未授权资料；
- 现有 TUI、任务队列和恢复测试全部回归。

## Comments

### 2026-09-23：实现交付

实现事实（相对工单的对应关系）：

- 角色配置：`agent_roles` 表（宿主引导写入，含项目/会话/工作目录/模型/工具白名单），角色定义静态固定在 `src/runtime/orchestrator.ts`（main=host_data+web_search；coding=全量；chat=空）。工作目录在数据目录的兄弟目录 `agent-work/<role>/`（避开保护根，沿用 qq-work 口径）。工具白名单按注册来源类别，Driver 三层强制：装配过滤、发送前最终检查（`role_tools_forbidden`）、调用门阻止。
- 任务字段：`tasks` 补列 `agent_id / parent_task_id / source_event_id / deadline / result_summary / result_ref`（schema v10 → v11，ensureColumns 幂等补列；pre-v6 重建路径同步覆盖）。
- 入站事件：`inbound_events` 表，`(source, external_id)` 唯一即幂等键；状态 registered → queued → done/failed；先持久化再建任务（请求键 `evt:<eventId>`）。
- 内部委派 API：`Orchestrator.delegate()`（进程内，不经控制面、非模型工具）；请求键 `deleg:<parentTaskId>:<key>`（幂等键在父任务内唯一）。控制面 ops 不接受编排字段（submit 的编排参数只经窄接口传入）。
- 子任务终态事件：`child_task.completed / failed / timeout / result_unknown`；结果一次写入（`result_summary IS NULL` 条件更新去重）。超时取消原因 `deadline_exceeded` 持久化在任务行，重启后巡检仍可判定。有界唤醒：固定模板 + 摘要 ≤1000 字符，请求键 `wake:<childId>` 幂等，只投向角色会话（父任务在拥有者交互会话时不注入，结果经 get_task 查询）。
- 重启恢复：已登记未建任务按原请求键重提；重启窗口内终态的角色任务启动巡检补记结果/事件/唤醒（interrupted 一律结果未知，不重放外部副作用）；角色会话队列暂停自动恢复（沿用 QQ 适配器口径）。见 docs/runtime.md 恢复第 7 条。

已知边界与延迟项：

- spec.md 运行模型提到的“是否需要拥有者”结果标志与“安全子任务自动重试一次”不在本工单实现范围，留待 issue 05（委派链路）评估。
- local 执行后端无文件系统隔离（ADR 0004 既定）：直接 read/bash 的越界拦截由容器后端提供；宿主层保证保护根（含 owner token 所在控制面目录）不可经 request_file_access 申请，且不产生审批单。
- 角色会话出现在 TUI 会话列表中（未做隐藏）；14-tui-app 的两处绝对数量断言改为相对断言。

验证（test/27-orchestration.test.ts，8 项，mock 模型 + 临时目录；重启用例为进程内 stop/start 同目录）：

- 角色引导绑定独立项目/会话/工作目录且白名单符合定义；
- 重复事件只创建一个子任务（含重复委派返回同一子任务）；
- 子任务完成：结果记录 + child_task.completed + main 有界唤醒；
- 父任务运行中子任务结果已可查询；
- 超时取消：child_task.timeout + 唤醒带超时摘要；
- 重启：已登记未建任务继续（不多建）、中断子任务记结果未知并唤醒、不重复创建不重放、角色身份稳定；
- 工具白名单：chat 空工具、main 无编码工具、coding 全量（按模型实际请求载荷断言）；
- 资料隔离：owner token 审批入口硬拒绝（保护根）且未进入 coding 历史；跨项目搜索不含 main 未授权内容。

`npm run typecheck` 通过；`npm test` 全量 242 项：241 通过，1 项跳过（真实模型门禁）。注：test/26-qq.test.ts 的“排队超过 TTL”用例在本机全量并行下偶发超时，基线提交同样复现，与本工单无关。

### 2026-09-23：提交评审与待修复问题

评审提交：`bbf684ee045c9c4a372658340073792961673a35`；比较基线：`a1bba722f73e7d6728866cf94d7f9cc60fca0abc`。以下代码行号均对应被评审提交。发现 3 项 P1、3 项 P2，尚未修复，因此将工单从 `resolved` 改为 `ready-for-agent`。前述交付记录保留为历史事实，不代表这些问题已解决。

1. **P1：自动释放未经核实的目录占用。** 位置：`src/runtime/orchestrator.ts:124–129`。

   启动时对所有暂停的角色会话调用 `resumeQueue()`，没有区分 `occupancy_unverified` 等暂停原因。该方法会释放终态任务的遗留占用；如果崩溃前的执行进程仍存活，coding 新任务可能与旧进程同时修改工作目录。此行为与 `docs/runtime.md:526–529` 要求拥有者核实旧容器或 cgroup 已停止后再释放占用的约定冲突，不能直接沿用无工具 QQ 会话的恢复前提。

   验证：在临时运行时为已结束的 coding 子任务保留占用、将会话设为 `paused / occupancy_unverified`，重新启动编排器后得到 `queueState: active`、`occupancyRetained: false`。该验证确认占用被释放，未模拟真实 Linux 孤儿进程。

   修复与验收：只有能够确认安全的暂停原因才可自动恢复；旧执行未核实时必须保留暂停与占用。补充遗留占用恢复用例，确认拥有者核实并恢复后才允许后续任务运行。

2. **P1：chat 会自动收到个人共享记忆。** 位置：`src/runtime/orchestrator.ts:155`；关联 `src/agent/driver.ts:268–271、400–417`。

   chat 经 `createSession()` 创建为默认 `dev` 会话，角色白名单只限制工具。Driver 的资料身份与记忆过滤仍只对 `qq_group` 施加限制，所以 `scope: personal` 且来源为 `owner_note` 的记忆会自动进入 chat 的模型上下文。空工具集合没有阻止这一读取路径，未满足本工单“角色配置决定工具和资料范围”的边界及日常助手规格中 chat 默认不能读取 main 个人数据的要求。

   验证：通过可信入口保存带唯一标记的个人共享记忆，再登记目标为 chat 的入站事件。实际 mock 模型 HTTP 请求中，chat 会话类别为 `dev`、工具数为 0，但包含该记忆标记和“个人共享”上下文。

   修复与验收：为 chat 明确执行资料范围约束，并覆盖自动上下文注入。回归测试应检查实际模型请求，确认未经开放的个人记忆不会进入 chat，同时保留 main 的正常记忆能力。

3. **P1：唤醒提交失败后永久丢失通知。** 位置：`src/runtime/orchestrator.ts:331–378、412–422`；关联 `src/core/store.ts:553–557`。

   `handleTerminal()` 先持久化结果，再提交父会话唤醒。若两步之间崩溃，或唤醒提交失败，结果已经非空；失败仅写日志，而恢复扫描只查询 `result_summary IS NULL` 的任务，后续启动不会补发。`wake:<childId>` 虽能去重，但缺少持久化的待投递状态，无法满足“子任务结果能唤醒 main”和内部结果回传的恢复要求。

   验证：让第一次 `wake:` 提交抛出临时错误，子任务结果正常保存；恢复提交能力并重新启动编排器后，仍没有对应唤醒任务，待结果扫描也返回 0 条。

   修复与验收：持久记录尚未完成的唤醒投递，恢复时沿用原幂等键重试。覆盖结果已落库但唤醒尚未提交、提交临时失败、重复恢复三个场景，最终只能产生一个唤醒任务。

4. **P2：委派幂等键没有在父任务范围内唯一。** 位置：`src/runtime/orchestrator.ts:217–219`。

   实现声明幂等键在父任务内唯一，但底层唯一约束实际是 `(session_id, request_id)`。同一父任务、同一个 `idempotencyKey`，只要把目标从 coding 改成 chat，就会落入另一个会话并创建第二个子任务，绕过同键异参冲突检查。

   验证：先向 coding、再向 chat 委派相同父任务、正文与幂等键，返回了两个不同的子任务 ID。

   修复与验收：在父任务范围内核实已有委派；同键同参返回原任务，同键更改目标角色或其他提交参数应返回冲突，不能产生第二个子任务。

5. **P2：带时区的截止时间会被错误比较。** 位置：`src/core/store.ts:543–549`；关联 `src/runtime/runtime.ts:653–654、702`。

   提交入口只检查 `Date.parse()` 能否解析，随后原样保存 deadline；巡检却直接按字符串与 UTC 时间比较。不同 UTC 偏移或日期表示的字符串顺序不等于实际时间顺序，可能提前取消任务或错过截止时间。

   验证：提交一个带 `-08:00` 偏移、实际尚有约 7 小时才到期的时间，`Date.parse(deadline) > Date.now()` 为真，但 `listOverdueTasks()` 已将该任务选为过期。

   修复与验收：入库前统一为 UTC 时间表示，或按时间值比较，并一致处理幂等参数。覆盖不同偏移表示的等价时刻，以及尚未到期、已经到期两侧边界。

6. **P2：升级破坏已有请求的幂等重试。** 位置：`src/runtime/runtime.ts:663–670`；关联 `src/core/store.ts:402–411`。

   提交摘要新增 `agentId / parentTaskId / sourceEventId / deadline` 四个字段，即使全部为 `null`，也会改变普通任务的摘要。旧版本已保存的摘要未迁移或兼容，所以升级前已接收的请求在升级后以相同参数重试，会被误判为 `request_conflict`。

   验证：按基线提交的算法计算普通任务的摘要并回填临时任务，再以完全相同参数调用当前 `submit()`，得到“request_id 已存在且提交参数不同”。这是旧摘要兼容性的定向验证，未执行完整的跨版本部署升级。

   修复与验收：兼容旧摘要格式或在可核实原始提交参数的前提下迁移，不能放宽同键异参校验。补充升级回归，确认旧请求同参重试返回原任务，异参仍冲突，新编排请求仍对编排字段做幂等校验。

评审验证结果：`npm run typecheck` 通过；`npm test` 共 242 项，241 项通过、1 项跳过；`test/27-orchestration.test.ts` 的 8 项测试全部通过。以上问题由额外定向验证发现，现有测试通过不能覆盖这些边界。定向验证使用 mock 模型与本地临时目录，未做 Linux 真实容器回归；评审时没有修改实现代码或新增持久测试。

### 2026-09-23：评审问题修复（3×P1 + 3×P2）

1. **P1 自动释放未经核实的目录占用 → 已修复**。`Orchestrator.start()` 只自动恢复 `queuePauseReason === "backend_restart"` 的角色会话；`occupancy_unverified` 保留暂停与占用，由拥有者核实后 `resume-queue`（docs/runtime.md 恢复第 7 条已同步）。回归：`test/27`“P1：occupancy_unverified…”——重启后保持 paused、占用保留、后续任务不运行，拥有者恢复后才执行。
2. **P1 chat 收到个人共享记忆 → 已修复**。新增受限资料身份 `role_restricted`（src/core/access.ts，口径与 qq_group 相同：仅本项目、不查授权、owner_note 不放行）；Driver 对 chat 角色会话以该身份判定，并在上下文注入处排除个人共享记忆与项目指令（`dataScopeRestricted`）。工具白名单管工具可见性、资料身份管资料范围，两条路径独立生效。回归：“P1：chat 不注入个人共享记忆与项目指令（main 正常注入）”——按 mock 模型实际请求载荷断言。
3. **P1 唤醒提交失败后永久丢失 → 已修复**。唤醒投递以唤醒任务的存在为持久记录：`Store.listRoleTasksPendingWake()` 找出结果已落库但父会话无 `wake:<childId>` 任务的子任务，启动巡检按原幂等键补发。回归：“P1：结果已落库但唤醒缺失时重启补发”——含重复恢复不重复投递；提交临时失败与崩溃窗口同属“唤醒行缺失”，由同一补发路径覆盖。
4. **P2 委派幂等键未在父任务范围内唯一 → 已修复**。`delegate()` 在串行链上先按 `parent_task_id + request_id` 查重：同键同参返回原任务；同键异参（含更换目标角色落到另一会话）抛“委派幂等键冲突”，不产生第二个子任务。回归：“P2：委派幂等键…”。
5. **P2 带时区截止时间误比较 → 已修复**。`normalizeIsoInstant()`（src/core/types.ts）在入库与幂等摘要前统一为 UTC ISO；巡检字符串比较即时间比较。回归：“P2：截止时间统一为 UTC 表示”——等价时刻不同时区写法去重为同一子任务，未到/已到两侧边界正确。
6. **P2 升级破坏旧请求幂等重试 → 已修复**。编排字段全空的提交附带 v11 前旧格式摘要（`legacyDigest`），`findMatchingSubmission` 新旧摘要均可核实；编排字段非空时不提供旧格式，同键异参校验不放宽。回归：“P2：旧提交摘要兼容”——旧摘要任务同参重试返回原任务，异参仍冲突。

修复后验证：`npm run typecheck` 通过；`test/27-orchestration.test.ts` 14 项全部通过；`npm test` 全量通过。
