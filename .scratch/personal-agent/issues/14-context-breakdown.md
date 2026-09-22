Status: resolved
Depends on: 04, 05

# 完善 `/context` 命令，查看上下文窗口各部分占比

## 目标

增强现有 `/context` 命令，在当前 session 中查看最近一次模型请求的上下文窗口预算分解和各部分占比，帮助拥有者判断上下文空间主要被哪些内容消耗。

## 当前情况

2026-09-22 当前工作区：

- [TUI](../../../src/tui/app.ts) 已有 `/context`，通过 `list_selection_records` 读取最近一条选择记录，以文本显示预算、估算总量、消息数量和排除原因。
- [SelectionRecord](../../../src/core/types.ts) 已保存 `estimates`、`budget`、`estimatedTotal`、模型和调用序号；[context-selector](../../../src/agent/context-selector.ts) 已将系统提示、工具定义、项目指令/记忆/继续来源、当前任务批次和历史轮次分别估算。
- 现有记录没有直接保存完整 context window、输出/思考预留、下一批工具结果预留和安全余量；仅使用 `estimatedTotal / budget` 不能准确表达“占整个上下文窗口的比例”。
- 当前 `cmdContext()` 将查询结果当作数组，但控制服务返回 `{ records }`；增强命令时需修正响应解包并覆盖接口契约。

## 实施范围

- 保留 `/context` 命令名称和当前 session 作用域，将输出从摘要扩展为可滚动的悬浮层；无当前 session、没有模型请求记录或记录缺失时给出明确提示。
- 默认展示最近一次模型调用；支持在同一 session 的请求记录中选择其他任务/调用后查看其分解，复用已有记录列表和悬浮层组件。一次调用的多项内容按当时实际送入选择器的视图统计，不在查看时重新读取当前历史、记忆或项目指令。
- 以模型 `contextWindow` 为总窗口分母，分别展示：系统提示、工具定义、项目指令、长期记忆、继续来源、当前任务、当前任务工具批次、历史轮次，以及未分类/其他估算项。每项显示估算 token、占总窗口百分比和占输入预算百分比；百分比由后台统一计算，避免 TUI 重复实现舍入逻辑。
- 同时展示输入预算 `budget`、已估算输入 `estimatedTotal`、尚余输入空间，以及输出上限、思考预留、下一批工具结果预留和安全余量。明确区分“输入占比”和“总上下文窗口占比”，不把输出预留误报为已发送输入。
- 扩展选择记录或读取接口保存上述分母和预留配置的快照，确保模型切换、思考强度变化、配置调整或后台重启后仍能还原当时数据。旧记录缺少字段时显示“无法计算总窗口占比”，仍可显示已有的输入预算和分类估算。
- 继续沿用上下文选择失败、中断、工具结果截取和实际 usage 未回填的状态；展示估算值时标明“估算”，不得把 provider 返回的总 usage 推算成各部分精确用量。若模型或 SDK 没有可靠窗口值，后台返回明确不可用原因。
- 长列表和详情支持滚动/分页，终端控制序列经现有展示清理；查看只读，不提交任务、不重新调用模型、不改变上下文选择或历史原文。请求按 session 和记录归属校验，不能通过任意路径读取数据。

## 工程建议（待评估）

- 占比计算放在后台，TUI 只负责渲染。分母固定为记录创建时的 `contextWindow`；分类项互斥，已用输入、各项预留与剩余空间合计应等于总窗口，仅允许显示舍入误差。校准系数对所有分类使用同一口径，不作为重复计数或合计不一致的理由；思考已计入输出上限时不得再重复预留。
- 输入预算占比的分子使用选择器记录的分类估算，分母为 `budget`；排除的历史/工具结果单独显示数量和原因，不计入已使用占比。
- 不新增独立统计服务或实时采样链路；先复用 `SelectionRecord` 和 `list_selection_records`，仅补齐缺失快照字段及一个有界的 breakdown 视图。

## 验收标准

- `/context` 能显示最近一次模型请求的分类 token、总窗口占比、输入预算占比、预留项、已用/剩余预算和合计。
- 同一 session 选择不同任务/调用后，详情与对应记录匹配；跨 session、重连和后台重启不串用或改变历史数据。
- 模型切换、思考强度变化、较小上下文窗口、上下文截取和思考/输出预留均使用请求当时的快照计算；旧记录缺少快照时如实降级。
- 没有请求记录、窗口值缺失、记录损坏、未认证或记录不属于当前 session 时返回明确错误，不触发模型请求。
- 估算值、provider usage 和未分类项的含义清楚，百分比舍入不会制造虚假的精确结论；详情滚动不超出协议帧限制。
- 复用现有 mock provider、SelectionRecord 和 TUI 测试设施，运行 `npm run typecheck` 与受影响测试。

## Comments

### 2026-09-22：创建工单

用户要求新增 `/context` 命令以查看当前上下文窗口各部分占比。核对发现 `/context` 已存在，因此本工单记录为增强现有命令：补充请求选择、窗口分母、预留项和比例展示，不创建第二个同名命令。

关联 [10：模型选择](10-model-selection.md) 和 [13：prompt 详情](13-prompt-inspector.md)。本工单不依赖完整 prompt 快照，可以基于分类统计与预算快照独立交付。

### 2026-09-22：实现完成

- 快照：`SelectionRecord.windowSnapshot`（contextWindow/maxTokens/thinkingBudget/toolResultReserve/safetyMargin）在发送前最终检查时随记录落盘（`selection_records.window_snapshot`，幂等补列）；旧记录为 NULL 时降级为"无法计算总窗口占比"，仍显示输入预算与分类估算。
- 分解：`selectionBreakdown()`（context-selector.ts）按记录创建时的快照计算八类互斥分类 + 未分类项的 token、占总窗口与占输入预算百分比（一位小数，后台统一舍入）；已用 + 尚余 + 预留 = 总窗口。窗口值不可靠时返回明确不可用原因；分类合计超过估算总量或快照与预算不一致时报 `selection_record_corrupt`。输入预算口径与选择器共用 `inputBudgetFor()`。
- 端点：`get_context_breakdown`（session_id + record_id，校验记录归属会话；未认证连接在 auth 前被拒绝）。修正了旧 `cmdContext` 把 `{ records }` 响应当数组解包的问题。
- TUI：`/context` 打开悬浮层，默认展示最近一次调用的分解（ScrollView 滚动，↑/↓/j/k/PgUp/PgDn）；`l` 打开记录列表（复用 `list_prompt_requests` 游标分页与 SelectList/OverlayBox），Enter 切换详情，Esc 返回/关闭。估算值、usage 未回填、排除原因、有界视图等状态沿用原文展示；正文经 `sanitizeForDisplay`。
- 测试：`test/21-context-breakdown.test.ts` 7 个用例（工作示例字面占比、未分类项、缺快照/窗口值不可靠降级、损坏记录报错、合计不变量、较小窗口快照、归属校验、未认证拒绝）；`test/14-tui-app.test.ts` 新增 2 个 `/context` 悬浮层用例（默认最近一次、列表切换、Esc 关闭、无记录提示）。
