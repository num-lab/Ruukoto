# 工作流人工等待与最终回报

Status: resolved

## 目标与边界

落实[规格 A4、A7、A10](../spec.md)，依[实施计划](../implementation-plan.md)四、五、六节接入可信拥有者回答、工具审批和双产品最终回报；业务回答不得作为工具批准。

## 实施与交付

1. 保存问题与回答、匹配的运行/步骤/入口代次和请求键；在事务中处理回答与取消的竞争、重复回答和过期状态，重启后可查询和继续等待。
2. 工具审批仍使用已有任务/操作/权限版本，问题等待走独立业务状态；到限、回答、批准和取消不得互相替代。
3. 工作流子结果只送协调器；最终结果提交后以稳定键送达。为 dev 新增经来源核实的内部汇总唤醒，main 沿原拥有者 IM 目标回报。
4. 定时来源等待名下完整工作流，取消级联，最终只有调度回报路径；入口换代不改发，发送效果未知不重发。
5. 保留暂停、取消及未核实停止的可查询事实；业务问题的通知失败不能伪装成已回答或自动批准。

主要落点为 runtime 的 parent-delivery/orchestrator/内部提交、control 协议与服务、channels 的 IM 控制解析/审批/调度归属、已有 outbox。

## 验收与交接

依赖 [04](04-step-capabilities.md)。新增回答绑定、恢复与通知去重用例；相关回归为 `test/66-control-seam.test.ts`、`test/77-im-approvals.test.ts`、`test/89-im-entries.test.ts`、`test/93-im-approval-lifecycle.test.ts`、`test/37-scheduler-outbox.test.ts`、`test/51-generic-scheduler.test.ts` 与 `npm run check:static`。

同步 control/channels/scheduler/runtime 说明。离线平台替身与真实 IM 证据分开；真实发送、日常聊天可用和回答体验在 07 验收。

## 当前交接

实施者于 2026-10-13 接手，核实 04 已 resolved 且真实步骤默认接线成立。范围沿已确认计划，属于可信身份、持久状态及跨模块契约的重流程。独立只读方案核实无阻断；补入整项工具审批停计、dev 汇总实时/重启结果登记、终态固定送达代次、调度 ask 不提前关闭及计划取消级联的检查。

回答采用运行/步骤/问题版本及问题建立时的运行代次、原入口钉版与稳定请求键；后续无关运行事件不改变问题代次，取消/暂停/来源失效仍拒绝消费。最终汇总任务由持久绑定识别，不以 request_id 前缀认可信身份；main 汇总不带普通 IM sourceEventId，由原入口的独立稳定发送键回报。定义管理与完整 CLI/TUI/IM 运行控制仍由 06 持有。

## 实施结果

- core 保存问题建立代次、回答原键回执、固定终态代次和最终汇总绑定；schema 38/协议 21 按既有策略拒绝旧格式，不迁移或回填授权。
- 控制面 `workflow_get`、`workflow_question`、`workflow_answer` 提供事实查询、UTF-8 分页和独立业务回答。`ImWorkflows` 只解析原始 `/workflow-question` 与 `/workflow-answer`，同事务保存回答、控制事件和回执；问题通知用独立 outbox 槽，失败/未知发送仍待答。
- 首次回答、问题通知、最终模型输入和发送都重核当前来源及依赖资料；工具批准消费也复核运行资格。纯人工问题/工具审批整项停计，自动审查和并行活动工具仍计时。
- 子步骤继续只回协调器；dev/main/scheduled 终态只建一项无工具汇总，绑定与入队同事务核实，冷启动补记原任务。main 使用原 IM 事件与稳定槽回报，宿主事实和失败项先于模型摘要；取消正文不追加模型结果。`delivery.status=reported` 只表示汇总及发送登记，平台状态另查 outbox。
- 调度等待名下全部运行、停止事实和最终汇总，不要求步骤 wake；安全重试恢复的历史失败尝试不污染整项状态。计划取消逐项核实最新版本并级联，自身步骤取消先提交意图再异步停止，当前工具可返回；已提交 interrupted/canceled 终态、取消意图与真实停止结论一起保留。

决定见[业务回答与整项最终送达](../../../.agents/notes/implemented/feature/2026-10-13-workflow-owner-input-and-delivery.md)。文档已同步 workflows/runtime/core/control/channels/scheduler、操作手册、README、开发测试导航和 pre-push-checks。

## 验证证据

macOS、Node 24.15.0、真实 SQLite/控制面/Driver/MCP 与两平台适配器；模型及 IM 服务均为本地替身。

1. `npx tsx --test test/114-workflow-owner-input.test.ts test/115-workflow-final-delivery.test.ts test/116-workflow-notification-recovery.test.ts`：18/18 通过。覆盖约束、原键重放/异参冲突、回执故障整笔回滚、回答/取消顺序、资料撤销、普通聊天、无工具最终汇总、原键冷恢复、双平台身份、长摘要失败事实、定时多运行/重试/取消、自身取消、未知发送和入口换代。
2. `npx tsx --test test/07-real-tools.test.ts test/08-approvals.test.ts test/10-access-modes.test.ts test/37-scheduler-outbox.test.ts test/51-generic-scheduler.test.ts test/63-approval-gate.test.ts test/64-tool-op-ledger.test.ts test/66-control-seam.test.ts test/77-im-approvals.test.ts test/84-im-final-delivery.test.ts test/88-parent-delivery.test.ts test/89-im-entries.test.ts test/93-im-approval-lifecycle.test.ts test/94-task-ending.test.ts`：200/200 通过。
3. core 的 01/03/04/05 及 104–116 工作流相关文件共 157 项：首次宽并发运行暴露 104 静态模块停止核实一次失败和 109 三处过期模型调用数断言；104/109 独立复核 40/40 通过，109 已改为等唯一最终汇总并增加一次模型调用。最终以 `--test-concurrency=4` 复核，156 项通过，115 自身取消例在脚本停止/任务结果尚未收尾时过早断言；该例已改为等完整调度收尾，最终单独复核 115 全部 9/9 通过；其余 156 项的被检内容未改变。
4. `npm run check:static` 通过；`git diff --check` 通过；笔记锚点检查无悬空引用。开发说明通过压缩已有测试范围行保持 9500 字符预算，未提高常驻预算。

未运行全量 `npm run check`、Linux 环境、真实模型或真实 QQ/Telegram。真实发送、完整发起/查询/回答路径及主观产品体验仍由 06/07 持有，不把替身记为真实产品通过。

## 独立实现审查

两个只读独立上下文分别承担回答/审批/来源与最终送达/调度，亲读规格、计划、当前 diff、测试和同步文档。前者亲跑 114/116 9/9、105 计费回归 1/1，以及控制面非法字段/版本/分页与 schema 37/39 拒绝共 23 个负检查；后者亲跑 115/116 12/12，另以真实 Driver 复现并验收自身取消死锁、恢复后的重试终态、长摘要仍保留宿主失败事实和取消正文仅宿主事实。

审查发现的自动审查误停计、问题依赖资料漏复核、自身取消死锁、历史失败尝试污染调度状态、模型摘要挤掉失败事实和取消正文泄入旧结果预览均已修复；两部分结论通过，无未解决实施阻断。作者最后复核 115 全部 9/9、`npm run check:static` 和 diff/锚点检查通过；测试只修正等待完整收尾的检查点，不改变验收要求。

## 工程与产品验收

工程要求均有上述离线证据，独立实现审查无未解决阻断，工程验收通过。完整产品主观体验不属于本单独立验收，依已确认分工在 07 执行；前提为 06 定义库与完整交互入口接线，随后分别提供真实模型和真实 IM 证据。下一责任人为 06 的实施者，从本单的控制协议、问题模型与最终送达接线继续，不重复实现这些归属。

## Comments

### 2026-10-13 — 独立方案核实

独立上下文亲读规格、实施计划四至六节、04 工单及 core/runtime/control/channels 当前源码，确认前置和方案可执行，无需要拥有者重新决定的取舍。核实仅针对方案，未写文件或执行测试；实现验收仍待独立审查，真实模型/IM 与产品体验留在 07。

### 2026-10-13 — 工程交付

可信回答与整项送达已实施，两部分独立审查通过。最终 115 回归 9/9 与静态门禁通过，已保存全部有效证据和初次失败的修正范围；本单 resolved，未提交、合并、部署或进行真实平台验收。下一单为 06 定义库与完整入口。
