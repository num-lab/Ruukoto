Status: ready-for-agent

# 01 — 为 ruukoto-code 添加 `/compact [prompt]`

实现 TUI 手动上下文压缩，主动生成摘要并接受仅本次生效的可选指引。行为以[规格](../spec.md)为准，技术取舍见[提案笔记](../../../.agents/notes/proposed/feature/2026-10-11-manual-context-compaction.md)。拥有者已于 2026-10-11 确认范围与计划；本单未开始实现，无待决产品问题。

## 已核实基础

| 位置 | 已有能力与本单要处理的限制 |
| --- | --- |
| `packages/tui/src/tui/commands.ts`、`app.ts`、`state.ts` | 命令表同时负责派发/补全/帮助；`/branch` 从原始 line 取参数，命令历史绑定发起会话。普通 arg 会折叠内部空白。 |
| `packages/agent/src/context-assembly.ts`、`driver.ts` | 自动压缩仅在任务模型调用前运行，assembly 生命周期属于任务，没有空闲会话入口。 |
| `packages/agent/src/context-selector.ts` | `planCompaction` 有水位、尾部、收益及冷却门槛；`prepareContextGroups` 把最后一轮当当前任务。不能只去掉高水位判断就当作手动规划。 |
| `packages/agent/src/compaction.ts`、`session-factory.ts` | 可复用滚动摘要、指纹与摘要模型调用；prompt 目前固定。pi compaction 已被拦截，不能改用它写会话文件。 |
| `packages/core/src/history.ts`、`store.ts`、`types.ts`、`db.ts` | 已有严格历史快照、压缩点落盘与事务；压缩点 `taskId/callIndex` 必填，缺少手动来源。当前 schema 为 33。 |
| `packages/runtime/src/runtime.ts` | 任务队列只串行任务；模型配置保护只统计活动任务。手动操作须加入会话占用、provider 使用统计与后台停止。 |
| `packages/control/src/client.ts`、`ops.ts`、`protocol.ts`、`server.ts` | 请求默认超时 60 秒，摘要默认超时 180 秒；应采用快速接收与结果核实。当前协议版本为 17。 |
| `packages/runtime/src/branch-session.ts`、两个产品的导入实现 | 分支与导入会复制压缩点；新增来源字段及新表需要同步处理。 |

`Runtime.getContextBreakdown` 读取选择记录关联的压缩点。按拥有者选择，本单不把它改成当前压缩状态查询。

## 实施计划

### 1. 手动规划与摘要调用

- 在 agent 层复用已有消息分组、配对清洗、压缩点视图和摘要调用，增加明确的手动规划入口；自动 `planCompaction` 的行为保持原样。压缩到最后一个完整 assistant 批次之前，原文尾部整批保留，不增加固定保留旧请求或旧清单的字段。
- 严格只读取得空闲会话的消息与有效旧点；优先复用 `snapshotSessionHistory`、`readHistoryPrefix`、已有会话 header/身份核实与消息转换。旧终态孤儿记录沿现行视图规则处理；坏完整行、无法核实的尾记录和文件身份变化明确失败。
- 手动路径要按已完成历史规划与估算，不能把最后一个已完成任务误当作仍在执行而强行保留中间批次。需要参数区分时只在现有选择器输入增加必要的模式表达，不复制一套选择器；不改变正常任务的必留规则。
- `generateRollingSummary` 接收本次可选指引，补在固定规则后；完整输入计入摘要预算。支持旧摘要加新增段、只有旧摘要的重新聚焦，以及无需摘要三个分支。固定摘要提示明确要求保留未完成工作，提示版本随实际变更递增。
- 手动路径先生成并校验完整结果，再提交新点；不沿用自动失败后的只清理降级。按同一历史与配置估算前后视图，不把两次不同主模型调用的用量当作压缩收益。

交付条件：低于自动阈值的普通历史也能产生摘要；单个长任务的中间过程可压缩；prompt 实际进入摘要请求；工具批次完整，空输入/重复请求规则可测。

### 2. 会话级执行、持久结果与兼容

- 在 Runtime 增加本功能的会话级编排入口，由 `apps/ruukoto-code/src/product.ts` 注入资格，共享代码不按产品名分支。后台核实普通开发身份、可读历史、模型与任务状态；不创建普通任务或启动工具 worker。
- 首次异步等待前占住会话；在 `submit`（含继续）、队列启动与手动接收的最终写入点共同核实，覆盖 preparing/loopActive 等任务启动窗口。拒绝已有 queued/running/awaiting_confirmation 或正在启动的会话。占用持续到唯一终态，不锁工作目录。
- 按 `core/branch.ts` 的请求核实模式增加最小专用持久记录，例如 `compaction_requests`，不复用分支表或虚构任务。记录请求键、规范化参数及指纹、会话、固定模型、源历史/旧点标识、状态、压缩点结果及失败码。状态只需在途、成功、无需压缩、失败、取消、中断；本功能不设任务队列。
- 同键同参返回原状态，同键异参拒绝；接收后快速应答。结果查询与取消按原请求和会话核实。失败/取消保存终态但不替换旧点；成功事务校验操作仍在途、源历史和预期旧点仍匹配，然后写新点、请求终态与会话事件。提交和取消竞争只允许一个终态。
- 后台停机 abort 并等待在途摘要后关库；启动恢复把遗留在途记录标为中断，不重发模型请求。若成功事务已提交，保持成功。持久事件和查询支持另一客户端、断线重连及退出重进核实。
- 摘要选定 provider 纳入 `applyModelConfigChange` 的使用中检查，同时核实配置应用与压缩接收的竞争。操作参数固定后，会话默认模型/模式后续修改不改变本次调用。
- 压缩点允许区分任务来源与手动请求来源，调整 `taskId/callIndex` 的可空性和手动请求引用；旧记录仍保持原来源。来源引用可随分支/导入保留，不能要求目标存在原操作回执，不能授予取消原操作的资格。
- schema 与控制协议按实施时现值单调升级，保留历史压缩点与索引。`branch-session.ts` 复制已提交有效点，不复制在途请求；分支操作只读源历史，可以与压缩并行。`apps/ruukoto-code/src/legacy-import.ts`、`packages/channels/src/personal-import.ts` 的 `TABLE_POLICY` 明确排除操作回执，兼容新增压缩来源字段与回退账本。

交付条件：同会话竞争不产生两个摘要或与主任务重叠；取消/重启不替换原点、不自动重调；提交后应答丢失可核实成功；旧库、分支与导入保留可用压缩点。

### 3. 控制面与 TUI

- 在 `TuiOps`、服务端分派与 Runtime 之间接通接收、查询和取消操作，例如 `compact_session`、`get_session_compaction`、`interrupt_session_compaction`；仅传 ID 与本次 prompt，不接收客户端历史、压缩边界或文件路径。保留现有认证、请求结果分类及协议版本核对。
- 注册 `/compact [prompt]`，沿 `/branch` 保留参数内部空白；不走 `taskInput`。快速接收后用会话事件与查询驱动命令结果，不能把 180 秒摘要绑在默认 60 秒的请求上。
- 保存发起会话、请求键与实例身份，应答丢失先查原请求；只有证明未接收才按原键重发，不能把不确定结果恢复成普通任务草稿。明确拒绝保留输入；新任务因压缩占用被拒绝时同样保留草稿。
- `/interrupt` 在当前会话存在在途压缩时取消该操作，否则保持既有任务中断行为。压缩期间允许查看与切换，切走后不串结果；不强制切回发起会话。
- 命令结果显示规格规定的状态和统计，成功说明 `/context` 仍为最近一次调用。不新增 `/context` 当前状态区域，不改写选择记录；其现有渲染在未来调用引用手动点时须能显示真实手动来源，不能假设 taskId 永远非空。

交付条件：帮助、补全、中文与多行参数、错误保留输入、切走/重连后的结果一致，命令与 prompt 不进入会话消息历史，主模型请求数不增加。

### 4. 回归、文档与交付

- 在现有压缩测试与真实 Runtime/SQLite/JSONL 设施上补最小手动用例；较长的跨层并发/重连场景可集中为一个按功能命名的测试文件，避免为每个字段拆测试。
- 同步 `docs/usage.md` 命令表及摘要数据去向/取消/失败/`/context` 说明；按实际改动更新 `docs/modules/agent-context.md`、`runtime.md`、`control.md`、`tui.md`、`core.md`、`products.md`，核对导入文档是否受影响。README 保持现有导航，不复制命令表；不增加模块，无需改架构地图。
- 提案随实现移至 implemented，源码入口添加笔记锚点，旧自动压缩笔记的手动能力后续项改为已实现引用。保留自动规则与手动规则的区别；不把提案提前写成运行文档现状。
- 完成下述定向验证与一次真实 TUI 交互核对，将实际命令、环境、模拟/真实边界与未验证项追加在 Comments。只有功能和必要兼容都完成才改为 resolved。

## 验收标准

- [ ] `/compact`、中文/含空格/多行 prompt、全空白参数的派发、帮助与补全正确；不适用产品/身份后台拒绝。
- [ ] 低于自动阈值仍摘要；单个已完成长任务的中间过程被覆盖，最后完整批次及尾部原样保留；下一任务使用新点且工具配对合法。
- [ ] 无 prompt 使用固定规则；有 prompt 仅进入本次摘要调用，后续自动压缩没有残留指引；预算包含指令，配置模型与会话模型分支正确。
- [ ] 覆盖不推进时，有 prompt 改写旧摘要，无 prompt 无模型调用；空会话/无可压缩内容无模型调用，结果不误报成功。
- [ ] 摘要报错、超时、空输出、输出触顶、预算不足、模型不可用、坏历史和提交失败均有明确终态，旧有效点不变，无只清理降级。
- [ ] 忙会话和排队/启动窗口拒绝；压缩与新提交、继续、队列启动、重复命令、配置修改竞争有确定结果；其他会话不被会话占用阻塞。
- [ ] 同键并发只有一次调用，同键异参冲突；应答丢失、事件缺口、重连和退出重进核实原操作；后台重启不重调摘要模型。
- [ ] `/interrupt` 与成功事务竞争只产生一个终态；停机在关库前收尾；取消后原点不变，已提交成功不误报取消。
- [ ] 切走后结果仍归原会话；命令回显和结果可核实；`/context` 继续显示原选择记录，不伪造主模型调用，后续调用能展示手动点来源。
- [ ] 操作前后 JSONL 逐字节相同，历史可找回；无新增普通任务、工作委托或工具执行。手动点重启后可用；分支独立继承，导入兼容。
- [ ] 自动压缩原有阈值、保护尾部、清理豁免、失败冷却、停止联动与前缀稳定用例继续通过。

## 验证计划

以下是待执行检查，不是已通过记录；依改动批次运行，不默认全量 `npm run check`。

| 改动面 | 定向验证 |
| --- | --- |
| 摘要与上下文 | `npx tsx --test test/18-model-selection.test.ts test/60-context-prefix.test.ts test/61-context-compaction.test.ts`，并运行新增手动集成用例 |
| 持久请求、schema、停止与恢复 | `npx tsx --test test/01-concurrency.test.ts test/02-idempotency-reconnect.test.ts test/03-lifecycle.test.ts test/04-crash-recovery.test.ts test/05-overflow-db.test.ts test/94-task-ending.test.ts` |
| 控制、命令、反馈与产品 | `npx tsx --test test/12-reconnect-pending.test.ts test/13-tui-state.test.ts test/14-tui-app.test.ts test/37-command-history.test.ts test/65-slash-commands.test.ts test/66-control-seam.test.ts test/71-product-entry.test.ts`；终端输入行为变化时加 `test/15-tui-pty.test.ts` |
| 分支与导入 | `npx tsx --test test/102-branch-session.test.ts test/85-legacy-instance-import.test.ts test/86-personal-instance-import.test.ts test/91-release-acceptance.test.ts` |
| 静态与人类文档 | `npm run check:static`、`git diff --check`；新笔记锚点按 maintain-notes 检查 |

优先离线模拟摘要模型，使用真实 SQLite、JSONL、控制连接和必要的后台进程故障注入。取消、覆盖、重连和配对必须断言最终状态与实际调用次数。真实模型质量/费用另行记录，不能以 mock 用例宣称已验证；Linux 专属问题按仓库约定使用 `ssh tx`。

## Comments

### 2026-10-11：grilling 确认与计划登记

原始请求：为 ruukoto-code 添加 `/compact <prompt>` 主动压缩命令，prompt 可选并指引摘要，先开 issue 和制定计划。

Q1—Q8 采用推荐：忙时拒绝；prompt 单次补充；主动摘要并跳过自动门槛；仅 Coding Agent TUI 普通会话；失败/取消不换点；压缩期间拒同会话提交，可切走、可中断；保留最后完整回复批次；无新增覆盖时只在有 prompt 且存在摘要时重写。Q9 选择只在命令结果展示，`/context` 保持原行为。Q10 确认完整复述与四步实施计划，授权登记规格、工单和 proposed 笔记。

本次仅只读核实实现基础并登记计划，没有实现命令、修改运行文档或执行功能测试。

### 2026-10-11：登记检查

`npm run verify-notes`、`npm run check:docs`、`git diff --check` 通过。另核对三份新增文档的 10 个相对链接及计划中的 21 个测试路径均存在，新文件无行尾空白。语义自检确认范围与 Q1—Q10 一致，备选方案和已知代价齐全；功能验收仍待实施，不将文档检查记作功能通过。
