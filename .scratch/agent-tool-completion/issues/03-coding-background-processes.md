# Coding 会话后台进程、目录占用与停止核实

Status: resolved

## 目标与边界

交付[共享规格第3节](../spec.md#3-后台进程)。拥有者确认跨消息保留，并接受首版先停后台再改同目录代码；不改为同会话绕过写占用。Coding切片由[会话后台决定](../../../.agents/notes/implemented/feature/2026-10-21-coding-background-processes.md)持有，[原提案](../../../.agents/notes/proposed/feature/2026-10-14-bash-background-lifecycle.md)的个人接入仍未落地。首版仅完全访问拥有者来源可启动；受限普通拥有者可查停原执行。不做PTY、自动重启或进程接管。

## 方案

1. core增加独立执行记录和可区分持有者的占用；状态、启动认领、交接、停止屏障和事件在事务内。endTask、失败/取消、目录冲突、重启及离线导入都核对新记录，不以终态Task释放独立占用。
2. Runtime持有会话后台管理，启动/停止串行认领；agent提供四工具及来源核实。先核实原Task临时worker停止，再在事务内无空窗转交占用、保存参考快照和当前轮观测阶段，随后收窄工具并launch；失败按共享规格保留或有证明地释放。独立worker复用现有输出协议与低层launcher，不从当前Task的worker摘PID。
3. Linux复用原scope/invocation身份；macOS补持久监督身份及后代停止回执。输出预算、短写/磁盘失败、管道继承、启动崩溃窗口和平台身份换代进入同一真实停止设计。平台证据不足不得降级交付。
4. 当前轮交接即进入内部对话，扩展Runtime.conversationAdmitted/initialPhase和参考提供者，使从未agent_wait的新会话也能接纳下一轮；同时改Driver的browser发送前resourcePhase限定、装配和调用门。只开放后台观测/停止、ask_user和符合来源的完全访问browser，禁止普通worker/MCP和目录访问；重取资源时明确报告后台占用冲突。
5. control/view/TUI/Desktop新增本会话后台清单、日志、停止和“结束本会话后台”；原始ID由程序管理。关闭屏障覆盖已接纳但未交接启动；存档和客户端断开保留原语义。应用关闭/恢复收齐停止，核实失败保留占用和可见状态。
6. 同步core/runtime/agent-tools/execution/control/view/tui/desktop、usage/development和所改入口的README/pre-push；实施时更新笔记状态及锚点。

## 进展与交接

- 当前角色：实施与独立验收完成；2026-10-21拥有者授权接手，并明确可使用 `/Users/eitrous/.ruukoto/agent/models.json` 的 DeepSeek 作隔离真实验收，未改动日常配置。
- 当前内容：四工具、无空窗占用交接、跨轮观测、独立日志、平台停止/恢复、控制协议及双客户端均已实现；schema49/协议36严格拒绝旧格式，不迁移或清空。实现及要求对应见[实施验收](../evidence/background/verification.md)。
- 工程验收：最终静态门禁、构建、相关回归与独立实现审查通过，无未解决阻断。真实macOS及Linux身份/强杀/后代探针已执行；真实browser和DeepSeek三轮链已通过，原型前提已解除。
- 交付：无剩余实施或验收阻断；拥有者在验收后明确授权提交，推送、合并和发布另行安排。源码调查及原方案审查只保留原适用范围，见[调查](../evidence/investigation.md)和[方案审查](../evidence/plan-review.md)。

## 验收与证据

工程验收：`npm run build`、`npm run check:static`、core与客户端29项、后台跨轮/故障恢复7项、最终macOS身份/旧受限/worker停止60项通过。Linux隔离实例核心/Runtime19项与平台27项通过，无跳过；原始命令、内容SHA与清理结果分别保留，后续平台无关分页/来源补修有当前窄测。未把桩模型的HTTP成功当作真实模型或browser验收。

真实browser完成服务启动→browser实际访问→下一拥有者轮查询→显式停止。真实DeepSeek使用指定配置中的 `deepseek/deepseek-flash` 完成启动→读取URL→browser访问随机页面短码→跨轮查询双流日志→停止/status核实→write重新取得目录，最终占用为空。实际请求快照、来源结果与工具定义保留，凭据副本在finally删除；toolSchemas改前11747、改后12944，systemPrompt均1505，后台观测时另为2027/1505。

产品验收：指定DeepSeek、真实browser、真实Python PTY及隔离Electron到真实后台完整链均通过。双客户端实际查日志、单停、退出保留及重开后显式结束/停止核实/占用释放通过；纯逻辑、历史假control视觉检查仍分别标注原范围。所有结论、命令、独立审查、未验证项和下一责任人由[实施验收](../evidence/background/verification.md)持有；不以构建或平台退出码推断外部业务效果。

## Comments

2026-10-21：拥有者明确接受首版后台运行时先停后改；窗口关闭/存档不作为停止证明，“结束本会话后台”提供显式关闭动作。

2026-10-21：拥有者授权接手本工单；实施者开始核实当前基点和真实平台前提，独立上下文并行复核方案适用性及Linux身份/停止。

2026-10-21：四工具、独立占用及恢复实现完成；真实browser组合暴露macOS全UID未知孤儿误判，经历史受管组/会话范围及启动期setsid竞态补修，独立反例与旧受限回归通过。拥有者指定DeepSeek真实三轮验收通过；静态、平台与模型原始证据归入工单，客户端完整链继续收尾。

2026-10-21：真实TUI与Electron完整后台链及清理核实通过；真实PTY暴露的查询提示残留和实时事件吞停止应答已补修，经最窄回归、独立复审及真实PTY精确断言重跑通过。工程与适用产品验收完成，状态resolved；未提交、推送或部署，未迁移日常档案。
