Status: resolved

# 控制面接缝：错误分类收回客户端，TUI 经带类型的入口

## 目标

控制面请求失败时，由产生错误的地方写定「未发送 / 明确拒绝 / 应答丢失（连接仍在）/ 应答丢失（已断线）」，调用方不再各列一份码表。TUI 用到的 op 名、参数与返回形状只定义一次；真实客户端、demo 与测试替身都在同一个接缝上按它实现。来源：2026-09-26 架构审查的候选 07。

## 背景

2026-09-27 核对（main deaccf9；`src/control/` 自审查时的 c0d0253 起没有改动）：

- op 是自由字符串，返回形状由调用方断言。
  - TUI 39 处：app.ts 28、commands.ts 11；另有 SubmissionGuard 5 处、工作区入口 1 处。
  - 请求帧 `op: string`、应答 `result?: unknown`（protocol.ts:77、85）；服务端 `dispatch(): Promise<unknown>`（server.ts:198）。两端共享结果类型的只有 `connect`。
  - TUI 重复定义了服务端已有的类型：`ModelChoice`（app.ts:261，缺 `errorCode`）、`PromptRecordRow`（:1785）、`ContextCheckpointView`（:81）、内联 BoundedText（:2003、2283）、技能与记忆的内联形状（commands.ts）。
- 按错误码判断的地方有 9 处，各判各的，与「请求是否执行」不符：
  1. 断线时在途请求拿到的是 terminate 的原因码（`connection_closed`、`connection_error`、`unterminated_frame`、`frame_too_large`、`bad_frame`，client.ts:133–147）；`/mode` 与审批（app.ts:1683、2321）只认 `connection_unavailable | closed | request_timeout`，于是显示失败、不核实（违反 04-tui.md:61、12-session-mode-command.md:33）。
  2. 提交的「非明确拒绝」名单（submission.ts:147）没有 `bad_frame`，却有从不产生的 `invalid_frame`、`protocol_error`：坏帧断线时待核实记录被清掉。
  3. `response_too_large` 在 dispatch 已执行之后产生（server.ts:786），各处都当失败。
  4. 断线后 `/mode`、`/model`、审批在 catch 里立即查询，必然以 `connection_unavailable` 失败（connection.ts:217）。
  5. `connection_unavailable` 的文案是「请求未发送」，提交与工作区入口却按结果未知处理。
  6. `closed` 一码两义：发送前（client.ts:151）与主动关闭时的在途请求（:204）。
  7. 工作区入口（workspace.ts:114 + app.ts:1101）把 `unterminated_frame`、`frame_too_large`、`bad_frame` 当明确拒绝；`/model`（app.ts:2531）遇到任何错误都去查询；其余写操作只显示「失败」。
  8. server.ts:166 原样转发任何带 `.code` 的异常，包括 Node 系统码（ENOENT、ERR_SQLITE_*）。
- 超时默认 60 s（client.ts:150），服务端照常执行，迟到应答被丢（:125）。提交超时后只在连接迁移到 online 时核实（app.ts:894–897 → 1156）；连接一直在线，就一直挂着「待核实输入」。
- 连接层：
  - 认证阶段任何错误都进入 failed 并永久停止重连（connection.ts:88–92），包括认证超时。
  - 首次 `start()` 建连失败时不安排重连（:75–84），状态停在 connecting。
- 快照的已结束任务按结束时间升序取前 20 个（runtime.ts:2325–2328），拿到的是最早的 20 个，与注释相反；TUI 装快照时整张替换任务表（state.ts:86）。
- demo（demo-session.ts:427–584）顶替的是 ControlClient（index.ts:59），靠 `as unknown as ControlClient`（:583）接入：
  - 实现了服务端没有的 `get_tool_op`（:511），TUI 请求的 `get_tool_op_params` 落到 default。
  - `list_selection_records` 多出 `hasMore`、记录只有 6 个字段；`get_context_breakdown` 缺 `checkpoint`；模型缺 `errorCode`。
  - `onClose` 的形状是 `{reason, willRetry}`（应为 `{code, message}`）；`close()` 不通知监听者。
  - 未实现的 op（含 13 个只读 op）一律抛不带码的 Error「合成会话不支持写操作」；提交因此被判为待核实，记录写进真实的 `~/.ruukoto/pending`（index.ts:67）。
  - 19 号已在 fd0c75a 转绿，但不核对 op 名。
- `qq_status` 在没有 QQ 适配器时的回退形状缺 sessions、groups（runtime.ts:3084–3091），commands.ts:228、233 会抛 TypeError。
- 测试：12 号的 FakeClient 经 6 处 `as unknown as ControlClient` 注入；FakeTerminal 在 14、30、32 号各有一份；丢应答分支（app.ts:1683、2321）没有 TUI 层测试。

## 决定

### 错误分类

`ControlClientError` 带 `outcome`，由产生错误的地方写定：

| outcome | 含义 | 产生处 |
|---|---|---|
| `not_sent` | 未发送（已知未执行） | 连接层拒绝（connection.ts:218）、客户端关闭后再发（client.ts:151）、握手前提交（submission.ts:48）、建连阶段（client.ts:86、94）、参数无法序列化 |
| `rejected` | 后台明确拒绝 | 服务端错误应答（client.ts:129），下一行的三个码除外 |
| `unknown` | 应答丢失，连接仍在 | 超时；服务端回 `internal_error`、`response_too_large`、`mode_switch_unverified` |
| `disconnected` | 应答丢失，已断线 | terminate 时的在途请求（socket 关闭或出错、坏帧、超长帧、未换行残留、主动关闭） |

- 不是 ControlClientError 的异常按 `unknown` 处理。
- 服务端 server.ts:166 把不是小写蛇形的码（系统码）改成 `internal_error`，原码写进 message。
- 删掉 submission.ts:147、workspace.ts:114、app.ts:1101/1683/2321 的码表；错误码本身不变（CLI 输出、日志照旧）。

### 调用点

| 写操作 | not_sent | rejected | unknown | disconnected |
|---|---|---|---|---|
| 提交 / 继续 | 清记录、恢复草稿，注记「未发送」 | 照旧：清记录、恢复草稿；`request_conflict` 保留并提示 | 保留记录并当场核实这一条（与重连后的核实同一流程） | 照旧：保留，重连后核实 |
| 工作区入口 `create_session` | 照旧：等重连快照核实 | 照旧：回落正常启动 | 当场核实 | 等重连快照核实 |
| `/mode`、`/model`、审批 | 结果行 / 页脚「未发送」 | 冲突时刷新（`/model` 补上 `model_selection_conflict`，与 `/mode` 一致）；审批失效照旧；其余照旧报错 | 照旧：立即查询后台状态 | 不发必然失败的查询：提示「结果未知，重连后按后台状态显示，未自动重发」 |
| 其余写操作（中断、取消、恢复队列、`/new`、`/new-session`、`/new-project`、记忆撤销 / 恢复、QQ 启停） | 「X 未发送：…」 | 照旧「X 失败：…」 | 「X 结果未知：…；请先核实再操作（未自动重发）」 | 同左 |

- CLI `submit` / `continue`：明确拒绝时打印「提交被拒绝」，其余照旧提示用原 request-id 核实。CLI 其余命令与配置中心不改。

### 连接层

- 认证与同步阶段只有 `rejected`（令牌无效、协议版本不符等）进入 failed；其余按断线退避重连。
- 首次建连失败也进入退避重连。

### 带类型入口

- `src/control/ops.ts`：一张表写 TUI 用到的 35 个 op 的参数与返回形状。返回写服务端实际发回的完整形状，复用服务端导出的类型；服务端包了一层的照写（如 `interrupt` → `{accepted: true}`、`list_memories` → `{memories}`）。
- `ControlTransport`：ControlConnection 用到的 7 个成员（authenticate、handshake、onEvent、onClose、isClosed、close、按表的 request）。ControlClient 实现它，`request` 保持宽松签名，CLI 与配置中心照旧；`clientFactory` 返回它。
- `ControlConnection.request`、`CommandContext.request`、SubmissionGuard、工作区入口都按表。调用方删掉 `<T>` 与内联形状，删掉 TUI 的重复类型。
- 类型暴露的三处一并修：`qq_status` 回退形状、`checkpoint` 的可空性、`ModelChoice` → `ModelOption`。
- TuiApp 仍依赖 ControlConnection 具体类（只有一个实现）。服务端 dispatch、CLI、配置中心不按表。

### demo

- 实现 `ControlTransport`，按 op 分支由表约束。改正 `get_tool_op` → `get_tool_op_params`（toolOp 不带参数）、`list_selection_records` 完整记录且无 `hasMore`、`checkpoint: null`、模型补 `errorCode`、`onClose` 形状、`close()` 通知监听者。
- 未实现的 op 抛 `rejected` 的 ControlClientError「合成会话不支持：<op>」。
- 待核实记录写到系统临时目录，不碰 `~/.ruukoto/pending`。

### 测试替身

- `test/helpers/fake-control.ts`：实现 `ControlTransport` 的可编程假客户端，接在真实 ControlConnection 下。可以：按 op 设应答函数（按表定类型，未设定的 op 明确拒绝）、改写握手、记录请求、推送事件、模拟断线（在途请求得到 `disconnected` 并通知监听者）；每次重连给出新实例，共用同一组应答与快照。不模拟后台状态。
- 12 号的 FakeClient 改用它；FakeTerminal 提取到 `test/helpers/fake-terminal.ts`，14、30、32 号改为导入（配置中心的 33、53 号不动）；65 号的预设应答按表定类型。
- 14、30、32 号仍作连接真实后台的集成测试。

### 快照

已结束任务改为取最近的 20 个。

### 术语

CONTEXT.md 加「应答丢失」（本工单第 0 步）。不写 ADR：不难撤回，规则已由 ADR 0002「不自动重放执行结果不明的外部操作」覆盖。

### 不在本单

- `revoke` 版本号的正则放行 0（服务端明确拒绝）；`respond_confirmation` 返回完整参数（分类后应答超限按结果未知查询）；`/new-session`、`/new-project` 不带幂等键；`restore_memory` 重发会再生成修订（需服务端支持）；约 35 万汉字以上的输入，提交应答与 `find_task` 应答都会超限，记录永远待核实。
- 服务端 dispatch 按表类型检查；CLI 与配置中心改走表；配置中心的丢应答处理（它靠修订号冲突后重新加载）；配置中心认证或握手失败时 socket 不关闭（config-tui/index.ts:220–228）。
- demo 补 `get_confirmation_params`、`read_artifact`。
- 帧上限口径：服务端按字符数、客户端按字节数；请求超过上限时服务端直接断开，提交核实重发会引起约 0.5 s 一次的重连循环（由代码推出，未运行）。
- 04 移交的「审批变成 stale / superseded / canceled 时不发事件，TUI 靠重新拉快照移除」：属于事件模型，与候选 08（会话补读）一起看。

## 测试

1. 客户端分类（新增 66 号）：Unix socket 桩服务端逐一制造错误，断言每个产生处的 outcome；服务端系统码收口成 `internal_error`，原码留在 message。
2. 提交核实（12 号）：四类下待核实记录的去留；`bad_frame` 保留（回归）；超时后当场核实并关联原任务。
3. 连接层（12 号）：认证超时、认证中途断线 → 退避重连不 failed；`unauthorized` → failed；首次建连失败 → 退避后连上。
4. TUI 层（66 号，替身 + FakeTerminal）：`/mode` 断线 → 结果行结果未知、不发 `get_session`；`/mode` 超时 → 查询；审批断线 → 页脚文案；工作区入口 `bad_frame` → 等重连核实。
5. op 表与服务端一致：表里每个 op 名，服务端都不回 `unknown_op`。
6. 快照：一个会话 25 个已结束任务，快照取最近的 20 个。
7. demo（19 号）：不支持的 op 明确拒绝，文案不说「写操作」。

## 步骤

每步 `npm test` 与 `npm run typecheck` 通过后本地提交。

0. 本工单；CONTEXT.md 加「应答丢失」。
1. 快照：已结束任务取最近的 20 个，加测试。
2. 带类型入口（行为不变，`qq_status` 的 TypeError 修复除外）：`ops.ts`、`ControlTransport`；调用方改用表；删 TUI 重复类型；修类型暴露的三处；op 表与服务端一致的测试。
3. 测试替身：替身与 FakeTerminal 提取；12 号迁移；14、30、32 号导入；65 号预设应答定类型。
4. 错误分类：各产生处写定 outcome；服务端收口系统码；删码表；按「调用点」改提交、工作区入口、`/mode`、`/model`、审批；新增 66 号。提交前对抗式复核。
5. 连接层：认证与同步阶段只有 `rejected` 进 failed；首次建连失败退避重连。
6. 其余写操作与 CLI 的文案。
7. demo。
8. 文档：`docs/runtime.md` 的断线、应答丢失与 demo 说明；工单标记完成并追加交付记录。交付前跑变异检查。

不在 tx 上跑真实模型验收：改动在客户端，服务端只有系统码收口与快照排序两处，都由测试覆盖。

## Comments

### 2026-09-28：实现交付

分支 `control-seam`（基于 main deaccf9，#6 合并后）：

| 提交 | 内容 |
|---|---|
| b6b73d6 | 第 0 步：本工单；CONTEXT.md 加「应答丢失」 |
| b88f093 | 第 1 步：快照的已结束任务取每个会话最近的 20 个；02 号加测试 |
| f79005b | 第 2 步：`src/control/ops.ts`（35 个 op 的参数与返回形状）、`ControlTransport`；ControlConnection、斜杠命令上下文、提交核实、工作区入口按表请求；删 TUI 重复类型；类型暴露的问题一并修；66 号：op 表与服务端一致 |
| 3a5ffc4 | 第 3 步：`test/helpers/fake-control.ts`、`test/helpers/fake-terminal.ts`；12 号迁移（删 6 处强转）；14、30、32 号改为导入；65 号预设应答按 op 名定类型 |
| d1e733f | 第 4 步：`ControlClientError.outcome` 在各产生处写定；服务端 `errorReply` 收口系统码；删四份码表与两个不存在的码；提交、工作区入口、`/mode`、`/model`、审批按分类处理；66 号、12 号测试。提交前对抗式复核 |
| 7ecd6a5 | 第 5 步：认证与同步阶段只有明确拒绝进入 failed；首次建连失败退避重连；12 号测试 |
| fc6e1d5 | 第 6 步：其余写操作的 `writeFailure` 文案；`/qq enable|disable` 结果未知不宣称成功；CLI 提交按分类提示；65 号测试 |
| ebde555 | 第 7 步：demo 实现 `ControlTransport`、改正漂移、未列出的 op 明确拒绝、待核实记录写临时目录；19 号测试 |
| （本提交） | 第 8 步：`docs/runtime.md`、README；`views.ts`、`types.ts` 注释里的旧 op 名；本记录 |

验证：

- 每步 `npm test` 与 `npm run typecheck` 通过；最终 652 项，651 通过，1 项按开关跳过。
- 第 4 步提交前跑一轮对抗式复核（4 个视角，每条发现再由独立复核者尝试驳倒）：确认 5 个问题，均已在同一提交里修正并补测试，见下「偏差」4–6；另 9 条经核实不成立。
- 变异检查 22 处都能被发现：快照取最早 20 个、`internal_error` 当明确拒绝、断线在途请求标 `unknown`、关闭后再发标断线、超时标断线、连接层拒绝标 `unknown`、系统码不收口、未发送不清记录、连接仍在也等重连、`/mode` 断线仍查询、工作区核实不设上限、工作区坏帧当拒绝、认证超时也停止重连、首次建连失败不重连、写操作结果未知说成失败、demo 不支持的 op 不带分类、`/model` 断线仍查询、`/model` 冲突不刷新、审批连接仍在不查询、CLI 拒绝仍提示核实、当场核实全部记录、QQ 结果未知仍宣称已停用。第一轮 5 处未被发现：两处是变异本身写错（断线分支在前，改后一个分支等价），三处确实缺测试（`/model` 冲突、审批连接仍在的查询、CLI 文案），补了 66 号用例后全部发现。
- 不在 tx 上跑真实模型验收：改动在客户端，服务端只有系统码收口与快照排序两处，都由测试覆盖。

偏差：

1. op 表的返回类型从对应 Runtime 方法的返回类型推出（`R<"getSession">` 等），不手抄；服务端另包一层的照写。为让类型如实，`QqAdapter.status()` 与 `Runtime.qqStatus()` 去掉 `Record<string, unknown>` 注解（推断为完整形状 | 回退形状的联合）；`getContextBreakdown` 的 `checkpoint` 由 `Partial<ContextCheckpoint>` 改为去掉四个字段的 `Omit`（运行时不变）。
2. `ContextCheckpointView` 保留：它是 `contextBarLines` 入参需要的字段子集（54、61 号直接构造），不是协议副本。
3. 类型暴露的第四处：`/resume-queue` 给旧排队任务补配置时，会话没有模型选择会把 `null` 发给后台、被参数校验拒绝；改为本地提示「请先通过 /model 选择模型」，不发请求。
4. 工作区入口连接仍在的应答丢失只当场核实一次，重试仍应答丢失就回到正常启动并提示「结果未知…用 /sessions 查看是否已创建」。原先超时会每 60 s 无限循环，`internal_error` 这类立即返回的码不设上限会连环重发。
5. 工作区入口的本地前置检查「项目不存在」（workspace.ts:91）改抛 `rejected` 的 ControlClientError（复核发现：普通 Error 会被当作应答丢失，多试一次并误报结果未知）。不用 `not_sent`：连接在线时入口会一直等一次不会来的重连。
6. 提交的当场核实只核实这一条（复核发现：最初调用的是全部记录，两轮核实重叠时草稿会被恢复两遍）；上线时照旧核实全部。
7. 参数无法序列化改为发送前就以 `not_sent` 拒绝（错误码 `invalid_params`；原先 Promise 里抛出，等待者与计时器残留到超时）。提交结果新增 `not_sent` 一类（清记录、恢复草稿，注记「提交未发送」），`pending_verification` 带 `outcome`。
8. 其余写操作共用 `writeFailure(动作, 错误, 核实入口)`；只用于写请求，`/memory`、`/qq` 的只读子命令出错文案照旧。`/qq enable|disable` 结果未知时不再显示「已启用 / 已停用」。
9. 65 号的预设应答按 op 名定类型（名字写错过不了类型检查）；形状仍按各测试所需手写，不要求完整结构。
10. demo 的应答改为按 op 表定类型的应答表（与测试替身同一种写法），不再是字符串 switch；demo 内部的未知条目、任务、工具操作改抛 `not_found` 的明确拒绝。
11. `/skills` 显式传 `{}`（原先不传，客户端也补成 `{}`，线上帧不变）。40 号直接读 `runtime.qqStatus()` 的账号字段，加了一个断言适配器已启动的小助手。
12. 测试比工单多出：`/model` 断线与冲突、审批连接仍在的查询、CLI 明确拒绝的文案（spawn CLI 连测试后台）、工作区入口核实上限与本地前置检查、demo 里提交的端到端用例。

观察到的偶发失败（与本单无关，未修）：26 号「qq：登记后未入队的崩溃窗口…」在全量并发下出现过一次 `'queued' !== 'done'`：等到回复发出就断言入站登记已 `done`，两者之间有竞争；失败后用例不在 `finally` 里停后台，整个测试文件挂住不退出（全量运行随之卡住）。单独运行 28/28 通过，重跑全量通过。
