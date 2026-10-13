# 工作流常驻侧栏与逐层操作

Status: ready-for-agent

## 目标与边界

落实[改进规格 E1–E4、E10](../experience-spec.md)及[计划第三节](../experience-plan.md#三侧栏与请求状态)。拥有者于 2026-10-14 的 Q2–Q4、Q6、Q9 确认双产品 TUI、当前会话列表、历史、定义选择启动和运行控制；本单不改造 IM，不建设脚本编辑器。等待状态接 [10](10-agent-wait.md)。

## 方案

1. 在共享 TUI 复用 SelectList、TwoLineSelectList 和输入组件，建立侧栏层级、焦点切换、逐层返回、分页及窄屏窗口。处理与工作清单悬浮层、审批界面、聊天滚动共存；退出界面不取消运行。
2. 扩展 core 工作流启动与持久展示字段、Runtime 查询、control 结果、模型启动工具及 CLI 兼容调用方，提供固定名称、时间和简短说明；临时脚本有名称，旧无标题记录有回退。同步摘要、schema/协议、两方向导入及 fixtures。
3. 用图标和中文状态区分八种运行状态，步骤、人工问题、停止核实、效果未知及回报另列；默认活动与最近结果，历史可续读，选中项用稳定身份保留。
4. 操作层覆盖启动、答复、暂停、恢复、取消、预算、步骤和日志。复用 `packages/control/src/pending-requests.ts` 的 PendingRequestStore 扩展操作与恢复，发送前保存原键、参数、版本及 instanceId；写入失败不发送，损坏记录保留，新数据库不重发旧请求。断线或重启后只读核实原提交，未知效果不换键重发；原控制回执无查询入口时补最窄查询。
5. 替换 `tui/workflows.ts` 的常规命令解析流程及 `event-flow.ts` 的 ID 命令提示；命令帮助与诊断引导回到选择路径。机器 CLI 保留脚本能力，其测试按实际签名变化更新。

主要落点为 `packages/tui/src/tui/{app,commands,workflows,event-flow,session-list}.ts`、core/workflow/store、runtime 的 workflow-library/查询/启动、control ops/wire、agent workflow 工具及两个产品共享装配。复用导出和已维护依赖，不另建前端运行状态库。决定见[渐进交互笔记](../../../.agents/notes/proposed/feature/2026-10-14-workflow-progressive-controls.md)。

## 进展与交接

当前角色为方案者；独立方案审查通过，产品未实施。基点、HEAD 与本轮文件范围由[总计划](../experience-plan.md)及其[审查记录](../experience-plan-review.md)持有。前置为 10 的等待/状态接口完成并验证；下一角色为实现者，按此前置接手实现。

## 验收与证据

工程待验证，产品待验收。必须新增会因旧命令界面失败的真实键盘用例：不输入 ID 完成整个路径；侧栏开着聊天；Esc 与焦点；窄屏/缩放；长列表/日志；同名及无名运行；人工回答失效；重复点击；应答丢失重连与客户端重启；取消但停止未核实的图标与文字。

最小回归为 `test/13-tui-state.test.ts`、`test/14-tui-app.test.ts`、`test/15-tui-pty.test.ts`、`test/65-slash-commands.test.ts`、`test/118-workflow-entries.test.ts`、`test/120-workflow-cli.test.ts`、`test/66-control-seam.test.ts`；触及存储/导入加 `test/108-workflow-import.test.ts` 和相关生命周期/导入用例。运行 `npm run check:static`。本记录尚无实现检查结果。

文档同步 TUI/workflows/core/control、README、usage、development 与 pre-push-checks。拥有者验收可读性、状态区分、逐层操作与聊天共存；实现者自检和 PTY 通过不替代该体验验收。

## Comments

2026-10-14：由产品验收反馈建立；原 06 工程验收不覆盖本次新交互要求。
