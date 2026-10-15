# 右栏：SubAgent 页与 diff 页

Status: resolved

## 目标与边界

实现[规格 R9 的右栏与 R11](../spec.md)：右栏标签页、SubAgent 页（工作委托与子会话历史）、按单次工具调用展示的 diff 页。不做 Accept／Reject。

## 方案

1. SubAgent 页：工作委托与 SubAgent 来自快照与 `work_list`、`work_get`。子会话历史复用 [04](04-code-tree-and-stream.md) 的会话流恢复流程：`read_history`，加上 `list_tasks`、`get_task`、`read_task_events` 与 `read_history_entry`，并同样在每次安装新快照时丢弃旧代次的结果；渲染复用 view 的流条目投影与中间对话流的组件。
2. diff 页：对话流中的 edit 与 write 工具条目都可以点击。判定分两层：先看条目在 view 中的结果状态，它决定显示什么；`entryId` 只决定能不能读取正文，不会盖过结果状态。
   - `running`：显示“运行中”，不发读取请求。
   - `error`：标为失败。有 `entryId` 时，可以用 `read_tool_result` 读取错误正文；没有时显示已有的摘要；摘要也没有时，显示“失败，详情不可用”。任何情况下都不显示 `patch` 或 `writeContent`，因为历史里的 `writeContent` 是从调用参数恢复的，不能证明内容已经写入。
   - `effect_unknown`：标为“效果未知”，规则同上：有 `entryId` 就读正文，否则显示摘要，再否则显示明确的状态提示；不显示差异。重启恢复后，任务已经中断而工具仍是效果未知时，可能既没有历史条目也没有摘要，这时仍必须看得到“效果未知”。
   - `done`，但还没有 `entryId`：显示“等待结果落盘”，不发读取请求；历史补齐、拿到 `entryId` 之后，才允许读取，不必等整个任务结束。
   - `done`，有 `entryId`：调用 `read_tool_result`。返回 `isError: true` 时，按失败处理。返回 `isError: false` 时，edit 显示 `patch`，write 显示 `writeContent`。自写组件逐行渲染 unified patch 的增行、删行与上下文行，`truncated` 为真时标明截断。所需字段为 `null` 或缺失时，显示“差异不可用”，不用调用参数的预览代替。判断字段时按 `null` 或缺失判断，不按真假值判断：`writeContent: ""` 加上 `writeTotalLines: 0` 表示写入了一个空文件，要如实显示为空文件。

   判定逻辑写成纯函数，成功判断与 TUI 展开工具结果时的判断一致。
3. 放行名单加入本单调用的 op：`work_list`、`work_get`、`read_tool_result`；子会话历史所需的 op 已由 04 加入。放行名单的测试随之更新，按 R20 同步 `docs/modules/desktop.md`。

## 进展与交接

- 当前：右栏、差异判定、文档、定向检查、独立实现审查与最终构建的真实 Electron 外部验收均通过，无未解决阻断；证据见下方链接。
- 下一步：本单无剩余实施或验收工作；拥有者已授权本地提交，未推送或发布。
- 基点：实施基于 `0c2d473`；规划基于 `develop` @ `4611eff`。依赖 04。
- 阻塞：无实施阻断。

## 验收与证据

工程与外部清单均通过，检查、独立审查、构建身份和环境限制见[实施验收记录](../evidence/07-implementation.md)。以下保留有效验收要求。

- **unified patch 解析**：对普通、多 hunk、截断，以及末尾没有换行的 patch，都输出正确的行类型。
- **结果显示判定**：
  - 失败的 Write：条目状态为 `error`，结果 `isError: true`，`writeContent` 却不为空；断言判为失败，不显示写入内容。
  - `effect_unknown`：显示“效果未知”。
  - 成功的 edit 缺少 `patch`：显示“差异不可用”。
  - 条目已经 `done`，但 `entryId` 为空：显示等待，不发读取请求；同一条目随后拿到 `entryId`，之后允许读取。
  - `effect_unknown` 且 `entryId` 为空：有摘要时显示摘要，没有摘要时显示“效果未知”；不显示等待，不发读取请求。
  - `error` 且 `entryId` 为空：显示失败与摘要，不显示等待。
  - 成功的 Write 返回 `writeContent: ""`：显示为空文件，不显示“差异不可用”。

人工检查（外部验收）：
- 委派一个 SubAgent 后，右栏能看到它的历史，含思考记录与工具条目；SubAgent 运行中桌面端重连后，历史不重复、不缺失。
- 编辑、截断编辑、写新文件三种 diff 显示正确。
- 失败的写入（例如写到一个已存在的目录），显示为失败，而不是写入内容。

## Comments

2026-10-15：拥有者完成 grilling 并确认整体方案，本单由规划阶段建立。

2026-10-15：按 [01 首轮方案审查](01-view-package.md#2026-10-15-独立方案审查)的交接事项，补充会话流恢复所需的 op、连接代次处理与对应验收。

### 2026-10-15 独立方案审查

对象：`43c16ac` 上的未提交方案修订，本单审查前内容的 SHA-256 前缀为 `ce840a753ab0`；对照规格 R9、R11、R19、R20、01／04 的现行交接及实际控制面、历史读取与 TUI 调用方。结论：需修订，暂不能交实施；以下 P2 交方案者补齐，不改变已确认的产品范围。本轮不构成工程或产品验收。

1. **P2：第 2 步不能直接把 `writeContent` 当成写入后的内容。** [历史读取](../../../packages/core/src/history.ts)从对应 assistant 调用参数恢复 `writeContent`，不以 `isError` 为条件。独立探针让真实 Write 写入一个已存在的目录：工具失败、目标仍是目录，接口却同时返回 `isError: true` 与 `writeContent: "never written\n"`。按当前方案只取正文展示，会把从未写入的内容当成写后结果。最小修订：沿用 [TUI 展开工具结果](../../../packages/tui/src/tui/app.ts)的成功状态判断，只有可确认成功的调用才显示实际 patch／写入内容；失败与效果未知保留对应状态、错误正文或摘要，不能解释为写入成功；成功但所需字段缺失时明确不可用。补一条失败 Write 仍带非空 `writeContent` 的负例，并覆盖效果未知状态。

规范轴依据：[错误处理规范](../../../.agents/skills/error-handling/SKILL.md)要求状态未知或不可信时可见，不在没有保证时声称成功。规格轴依据：[R11](../spec.md)要求 write 展示写入后的内容；调用参数本身不能证明已经写入。两个独立审查上下文均确认上述同一阻断；未发现越界功能或另需拥有者决定的取舍。

接口可用范围已核实：`read_tool_result` 只接受已落盘的 toolResult 历史条目 ID，不接受 `toolOpId`／`toolCallId`；没有条目或条目不是工具结果时返回 `entry_not_found`。它不要求整个任务结束，上述真实失败 Write 的结果就是在任务仍为 `running` 时读到的。[事件投影](../../../packages/tui/src/tui/event-flow.ts)在收到工具结果后可以处于 `status: done`、`entryId: null`，待历史及条目引用合并后才获得 ID。第 2 步应同时写明：运行中或尚无 ID 时显示等待状态，不发无效读取；历史补齐后允许读取，不必等待整项任务结束。验收应覆盖“工具已完成、历史尚未关联”到可读取的变化，避免只验最终静态历史。

其余前提成立：快照与 `work_get` 提供 SubAgent 的 `sessionId`，现有历史接口不排斥子会话；04 已补齐事件、任务详情、长正文分页与每次安装快照时的代次失效约定。真实 Edit 返回标准 unified patch，成功 Write 可还原调用时正文，不需要新增 op 或直接读取工作区文件。实施交接：按 R19 把 patch 解析单测写为纯函数测试，组件显示仍走人工验收；按 R20 同步 `docs/modules/desktop.md`，新增 op 随放行名单测试更新。这些是既有要求的落实，不另计阻断。

本轮验证：macOS、Node v24.15.0；`RUN_MODEL_CHECK=0 npx tsx --test --test-name-pattern='read_tool_result' test/11-history-read.test.ts` 为 1/1 通过；`RUN_MODEL_CHECK=0 npx tsx --test --test-name-pattern='真实工具：读取|真实 Write' test/07-real-tools.test.ts` 为 2/2 通过；`RUN_MODEL_CHECK=0 npx tsx --test --test-name-pattern='工具意图固定|工具实时事件和历史异步' test/36-event-flow-state.test.ts` 实际匹配 1 项，1/1 通过。另执行了失败 Write 的最小历史反例、真实工具失败且任务仍运行的接口探针，以及工具完成到历史关联的投影断言。真实工具探针使用替身模型和测试执行环境，不代表真实模型或原生沙箱验收；临时运行已关闭。

`npm run check:static` 与 `git diff --check` 通过；本单 8 个相对链接、单一状态字段、段落换行与末尾换行另行检查通过。

本轮仅更新本单状态与审查记录，未改实现或其他工单。未运行 Electron GUI、真实模型、Linux／Node 22 或全量 `npm run check`；桌面实现与外部验收均待后续交付。

### 2026-10-15 方案修订

方案者按首轮审查修订，拥有者确认的产品范围不变。

- **P2**：第 2 步改为按条目状态与 `isError` 决定显示内容：
  - 只有成功的调用才显示 `patch` 或 `writeContent`；
  - 失败的调用显示错误；
  - 效果未知的调用显示状态与摘要；
  - 成功但缺少字段的，显示“差异不可用”；
  - 还在运行或尚未关联条目的，显示等待，并且不发请求。

  验收补上了失败 Write 带非空 `writeContent` 的负例、`effect_unknown` 的情况，以及条目从没有 `entryId` 到可读取的变化。
- **实施交接**：patch 解析与结果判定写成纯函数测试；同步 desktop 文档与放行名单测试，见第 3 步。
- 方案者已在当前代码上核实：event-flow 的工具条目状态有 `running`、`done`、`error`、`effect_unknown` 四种（`event-flow.ts` 第 17 行）；TUI 只在 `done` 时显示写入内容或 patch，没有 `entryId` 时不发读取（`app.ts` 第 2596–2610 行）。TUI 在 `writeContent` 为空时会用调用参数补位；桌面端不这样做，因为参数可能只是有界预览。

### 2026-10-15 第二轮独立方案审查

对象：`43c16ac` 上的最新未提交方案修订，本单复审前内容的 SHA-256 前缀为 `64540d218136`。只复核首轮 P2 的修订及其影响；实现源码未变。结论：首轮失败 Write 误报写入内容的问题已关闭，但新增等待规则仍有以下一项 P2，交方案者修订。本轮不构成方案通过或工程、产品验收。

首轮关闭依据：第 2 步以 `done` 且 `isError: false` 限定 patch／写入正文展示，失败显示错误，验收包含失败 Write 仍带非空 `writeContent` 的反例；成功缺字段时不再用参数预览补位。纯函数测试、desktop 文档与放行名单测试的交接也已补齐。

1. **P2：无 `entryId` 的等待规则与失败／效果未知规则冲突。** 第 2 步第一条规定没有 `entryId` 就显示“等待结果落盘”，后两条又要求显示失败或效果未知，未明确重叠时的优先级。现有 [事件投影](../../../packages/tui/src/tui/event-flow.ts)在工具意图之后收到失败结果，会产生 `status: error`、`entryId: null` 与错误摘要；收到效果未知事件则产生 `status: effect_unknown`、`entryId: null`。独立使用真实 Store、[工具操作账本](../../../packages/agent/src/tool-op-ledger.ts)与 EventFlow 的探针还确认：重启恢复分类后，任务可以已是 `interrupted`，Write 的状态仍为 `effect_unknown`，没有历史文件、条目 ID 或摘要。若按第一条显示等待，已知的异常状态会被遮住，且历史结果未必会再产生。规范轴违反[错误处理](../../../.agents/skills/error-handling/SKILL.md)要求的未知状态可见；规格轴未兑现本次修订承诺的失败／效果未知展示。两个独立审查上下文确认同一问题。

最小修订：先保留 `effect_unknown`／`error` 的状态，缺 ID 时显示已有摘要，无摘要时保留明确状态提示；`entryId` 只限制是否读取正文，不覆盖结果状态。等待限定为工具仍在运行，或成功结果尚未关联历史。纯函数验收明确覆盖 `effect_unknown + entryId: null`、`error + entryId: null`，不能只用已有 ID 的效果未知样例。这也补明首轮审查“无 ID 等待”说明的适用条件，不增加产品范围。

非阻断措辞澄清：第 2 步“所需字段为空”应明确为字段为 `null`／缺失，不能用真假值判断。[历史读取](../../../packages/core/src/history.ts)允许成功 Write 返回 `writeContent: ""`、`writeTotalLines: 0`，这表示写入空文件，不是差异不可用。最小历史探针已验证该区别，实施时保留空内容即可。

本轮验证：macOS、Node v24.15.0；`RUN_MODEL_CHECK=0 npx tsx --test --test-name-pattern='分类器|配对：结果' test/64-tool-op-ledger.test.ts` 为 2/2 通过。独立执行了上述真实账本恢复到事件投影的组合探针、失败与效果未知事件的无 ID 投影断言，以及成功空 Write 的历史读取断言；临时数据库与文件已清理。未改变的历史接口、真实 edit／write 与事件合并沿用首轮证据，未重复运行。

`npm run check:static` 与 `git diff --check` 通过；本单 12 个相对链接、单一状态字段、段落换行与末尾换行另行检查通过。

本轮仅更新本单状态与审查记录，未修改方案正文、实现或其他工单。未运行 Electron GUI、真实模型、Linux／Node 22 或全量检查；这些仍不构成已完成的桌面验收。

### 2026-10-15 第二轮方案修订

方案者按第二轮审查修订，拥有者确认的产品范围不变。

- **P2 判定顺序**：第 2 步按 `running`、`error`、`effect_unknown`、`done` 四种结果状态分别规定显示内容。`entryId` 只决定能否读取正文，不会盖过结果状态。等待只用于两种情况：仍在运行，或已成功但尚未关联历史。失败与效果未知在没有 ID、也没有摘要时，仍显示明确的状态。验收补上了 `effect_unknown + entryId: null` 与 `error + entryId: null`。
- **措辞澄清**：字段按 `null` 或缺失判断，`writeContent: ""` 表示写入了空文件，验收已补上这个用例。

### 2026-10-15 第三轮独立方案审查

对象：`43c16ac` 上的最新未提交方案修订，本单复审前内容的 SHA-256 前缀为 `51e4f1ab32465`。重点复核第二轮 P2、空字符串澄清与对应验收；相关源码未变。结论：方案通过，无未解决阻断；04 实现完成后可交实施。本结论不代表工程或产品验收通过。

规范轴通过：第 2 步先按 `running`、`error`、`effect_unknown`、`done` 分支，`entryId` 只决定正文读取资格。失败与效果未知在没有 ID 或摘要时仍明确可见，第二轮的两个无 ID 反例不再命中等待；相应验收已补齐。首轮的失败 Write 成功误报问题保持关闭。

规格轴通过：成功结果仍需 `done` 与 `isError: false`，缺失字段与空字符串明确区分，成功写空文件已有验收；R9 的子会话恢复、R11 的逐次工具差异与截断标记、R19 的纯函数单测及 GUI 人工检查、R20 的 desktop 文档和放行名单测试交接均保留。未发现范围外行为或新的产品取舍。

本轮验证：按现行方案条件枚举四种条目状态与两种 ID 有无情况，共 8 组均恰好命中一个分支，失败与效果未知均不命中等待。这是方案条件检查，不是尚未实现的桌面函数测试。前两轮的真实工具、历史接口、账本恢复与事件投影证据仍适用，未重复运行；实际桌面判定函数与解析测试由实施者落实。

`npm run check:static` 与 `git diff --check` 通过；本单 12 个相对链接、单一状态字段、段落换行与末尾换行另行检查通过。

本轮仅更新本单状态与审查记录，保留方案者的修订。未运行真实 Electron GUI、真实模型、Linux／Node 22 或全量检查；04 实现、桌面工程验证与外部验收仍待完成。

### 2026-10-15 实施与验收

接手当前 `0c2d473` 后核实 04 已 resolved，原依赖阻塞据此解除。复用共享投影与完整会话恢复实现右栏工作委托、全部 SubAgent 子会话与通知定位；逐次 edit／write 差异按状态及 isError 判定，保留无 ID 的失败／效果未知、等待落盘、缺字段和空文件区别。三个 op 放行、既有工作查询类型、调用方、文档与决策提案同步完成。

桌面及控制面组合检查初次 131/131 通过，最终流恢复与右栏回归 18/18 通过，完整 check:static、打包及签名检查通过。独立实现审查关闭查询缓存遮住实时关闭／取消／新委托的缺口，并以撤去修复的内存负例证明回归有效；最终无未解决阻断。

另一执行上下文使用最终构建、真实临时 Runtime／ControlServer／Electron 和真实工具 worker 完成外部清单：子会话含思考和工具、运行中重连不重复不缺失，普通／截断编辑、新文件、空文件与失败 Write 显示正确。最终 app.asar 资源另经实际 Electron 启动并连接临时实例；明暗及原生 760×500 窗口检查通过。产品范围沿用已确认方案，无新增主观决定。模型为本地确定性替身，未验真实模型、原生沙箱、Linux／Node 22 或全量检查；未直接双击 .app。证据、构建摘要、独立审查与清理记录见[实施验收记录](../evidence/07-implementation.md)。未提交、推送或发布。

2026-10-15：拥有者授权本地提交本单实现、文档与验收证据；未推送或发布。
