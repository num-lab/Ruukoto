# 工作流常驻侧栏与逐层操作

Status: resolved

## 目标与边界

落实[改进规格 E1–E4、E10](../experience-spec.md)及[计划第三节](../experience-plan.md#三侧栏与请求状态)。拥有者于 2026-10-14 的 Q2–Q4、Q6、Q9 确认双产品 TUI、当前会话列表、历史、定义选择启动和运行控制；本单不改造 IM，不建设脚本编辑器。等待状态接 [10](10-agent-wait.md)。

## 方案

1. 在共享 TUI 复用 SelectList、TwoLineSelectList 和输入组件，建立侧栏层级、焦点切换、逐层返回、分页及窄屏窗口。处理与工作清单悬浮层、审批界面、聊天滚动共存；退出界面不取消运行。
2. 扩展 core 工作流启动与持久展示字段、Runtime 查询、control 结果、模型启动工具及 CLI 兼容调用方，提供固定名称、时间和简短说明；临时脚本有名称，旧无标题记录有回退。同步摘要、schema/协议、两方向导入及 fixtures。
3. 用图标和中文状态区分八种运行状态，步骤、人工问题、停止核实、效果未知及回报另列；默认活动与最近结果，历史可续读，选中项用稳定身份保留。
4. 操作层覆盖启动、答复、暂停、恢复、取消、预算、步骤和日志。复用 `packages/control/src/pending-requests.ts` 的 PendingRequestStore 扩展操作与恢复，发送前保存原键、参数、版本及 instanceId；写入失败不发送，损坏记录保留，新数据库不重发旧请求。断线或重启后只读核实原提交，未知效果不换键重发；原控制回执无查询入口时补最窄查询。
5. 替换 `tui/workflows.ts` 的常规命令解析流程及 `event-flow.ts` 的 ID 命令提示；命令帮助与诊断引导回到选择路径。机器 CLI 保留脚本能力，其测试按实际签名变化更新。

主要落点为 `packages/tui/src/tui/{app,commands,workflows,event-flow,session-list}.ts`、core/workflow/store、runtime 的 workflow-library/查询/启动、control ops/wire、agent workflow 工具及两个产品共享装配。复用导出和已维护依赖，不另建前端运行状态库。决定见[渐进交互笔记](../../../.agents/notes/implemented/feature/2026-10-14-workflow-progressive-controls.md)。

## 进展与交接

2026-10-14 实现完成，接手基点为 `70b2845`、当时工作区干净；10 的状态与等待接口及拥有者验收前置已满足。按有效规格与独立方案审查实施，根工作区唯一写入，后台展示字段、请求回执与 PTY 在独立工作副本汇总。两产品共享侧栏、原键恢复、调用方与文档已落地；工程验收通过，[独立实现审查](../experience-review-08.md)无未解决阻断。工程验收时为未提交快照，内容由[输入清单](../experience-evidence/08-inputs.sha256)固定。

2026-10-14 拥有者在本对话确认“已完成人工验收”，本单工程及适用产品验收通过。具体产品入口与逐路径结果未提供，不据此补记真实模型、真实 IM 或平台矩阵通过；这些环境与跨工单组合继续由 [11](11-experience-acceptance.md)持有，下一角色为联合验收者。

## 验收与证据

工程及产品验收通过。`test/14-tui-app.test.ts` 的键盘路径不输入 ID 完成启动、答复、暂停、预算、恢复和取消，并验证聊天、审批、焦点与缩放；`test/15-tui-pty.test.ts` 含三项真实 PTY 及一项 FakeTerminal 输入边界。新增 `test/126-workflow-sidebar.test.ts` 的 30 项覆盖分页、同名、八状态、原选择、旧问题、重复确认、应答丢失、重启、实例隔离、停止核实和问题约束；后台标题、范围、摘要、CLI 与导入另有定向回归。撤去分页键修复后的真实 PTY 红例保留，不以通过日志替代回归证明。

最终 `npm run check` 退出 0，覆盖构建、静态门禁、macOS 独占验证 38/38、应用回归 1441 通过/5 项真实模型门控跳过，以及基础验证 9 通过/1 项真实模型门控跳过。独立审查亲验与分阶段命令、原始失败、修复及最终日志见[验证交接](../experience-evidence/08-verification.md)，不把阶段数字冒充最终内容的全量结果。

文档同步 TUI/workflows/core/control、README、usage、development 与 pre-push-checks。产品验收依据为拥有者的人工确认，实现者自检和 PTY 结果仍仅作为工程证据；本次收尾只更新验收状态与交接记录，产品代码不变，不重复运行已通过的产品测试。

## Comments

2026-10-14：由产品验收反馈建立；原 06 工程验收不覆盖本次新交互要求。

2026-10-14：拥有者确认“已完成人工验收”，工单转 resolved；11 的联合及外部环境验收保持独立。
