# 后台已有、定稿 demo 未体现的能力

本清单依据 2026-10-16 的实际控制面与 runtime 实现。拥有者要求这些能力暂不新增 UI，后续逐项实现；后台存在不表示 desktop 当前允许调用，也不表示完成真实环境验收。当前会话模型、默认模式、提交、队列、审批、历史、文件差异与 SubAgent 对话按定稿 demo 迁移。

| 暂缓 UI 的能力 | 实现依据 | 已有能力的边界 |
| --- | --- | --- |
| 会话分支 | `packages/control/src/server.ts` 的 `branch_session`；runtime `branchSession` | 会话历史分支，不是 Git 分支 |
| 手动压缩、状态及中断 | `compact_session`、`get_session_compaction`、`interrupt_session_compaction` | Code 空闲会话限制仍适用 |
| 会话使用量 | `get_session_usage` | provider token 统计，不是费用估算 |
| 完整上下文、预算与 prompt 审计 | `list_selection_records`、`read_prompt_snapshot` | 只迁当前 demo 的三分类 Context 明细，不开放原文与完整审计界面 |
| Todo | `get_session_todos` | 从真实历史投影 |
| 全文历史搜索 | `search_history` | 索引、筛选与游标；工作区树的本地名称筛选不属于全文搜索 |
| Workflow 管理与运行控制 | server 的 workflow 控制入口；runtime `saveWorkflowDefinition`、`startWorkflowOwner` 等 | 定义、步骤、日志、问答、暂停、恢复与取消 |
| 模型目录、凭据、默认及摘要模型、连接测试 | `get_model_config`、`save_model_config`、`test_model_connection` 等 | 与输入框内当前会话模型选择器分开 |
| 项目 instructions、web search、Jev 配置 | server 对应配置入口；runtime `setProjectInstructions` 等 | 不加入本轮设置窗口 |
| 跨项目资料授权 | `create_data_grant`、`revoke_data_grant`、`list_data_grants` | 与文件路径授权不同 |
| 长期记忆管理 | server memory 入口；runtime `ownerSaveMemory` 等 | 保存、修订、撤销与恢复 |
| Skill 与 SubAgent role 目录 | `list_skills`、`list_subagent_roles` | 只有目录读取，不声称已有安装或编辑能力 |
| Credential、MCP 配置与探测 | server credential / MCP 入口；runtime 对应配置方法 | 配置与工具列表探测，不是插件市场 |
| QQ、Telegram 配置与运行状态 | server QQ / Telegram 入口 | 配置、启停、QQ inbox / outbox 记录 |
| Schedule、Notification 管理 | server schedule / notification 入口 | 查询、详情、取消；没有任意通知发送或重定向入口，Code 取消 schedule 另有限制 |
| 长期操作授权 | `service_grant_list`、`service_grant_get`、`service_grant_revoke` | 查询、使用记录、撤销，没有同类创建或扩权入口 |
| 工作区组织迁移 | `preview_workspace_migration`、`apply_workspace_migration` | 迁移组织归属，不移动会话历史 |
| 当前任务模式与授权切换 | `switch_mode` | 不等同于会话默认模式 |
| 关闭 SubAgent、取消工作委托 | `subagent_close`、`work_cancel` | 本轮仅展示 demo 已有的独立 Agent 活动与历史 |
| 原始工具参数与 Artifact 浏览 | `get_tool_op_params`、`read_artifact` | 不新增 Artifact 浏览或参数展开机制 |
| 独立多任务取消、委托详情 | 旧 renderer 的 composer / inspector / conversation | 定稿 demo 未保留这些入口，不沿用旧布局 |
| 手动未知操作核实、待恢复输入与损坏记录诊断 | `CodeWrites`、SubmissionGuard、pending store | 保留幂等、核实、落盘与恢复安全逻辑；不恢复已被拥有者删除的提示卡 |
| Personal 完整会话与审批操作界面 | desktop Personal IPC allowlist 仍收窄 | 当前只迁移连接配置与占位；不扩成完整聊天 |

## 本轮补齐的 demo 接线

- 附件：系统选择器读取选中文件快照，主进程分块上传；`submit`／`continue` 携稳定引用，普通文件经 `read_artifact` 读取，图片沿现有视觉通路。
- 长 diff 的 `more`：`read_tool_result` 按字段和 UTF-8 字节偏移返回内容及总长，右栏连续加载；缺字段与空内容保持区别。
- 演示状态选择器只用于 fixture，不迁移为正式设置或后台写入口。

拥有者已于 2026-10-16 明确选择本轮补齐附件与 `more` 的最小后台支持；其余清单项不新增 UI。

## 可变 demo 的右栏试验

拥有者随后授权[浏览器、文件树与文件预览 demo](issues/04-inspector-tools-demo.md)。浏览器采用前端隔离 iframe，文件树及内容使用独立静态样例；没有读取真实工作区、调用 Artifact 或新增后台能力。此试验不改变正式 Desktop 的浏览器／文件读取契约，表内业务能力继续暂缓；后续迁移需另行确认正式接线。

## 当前 demo 迁移

拥有者于 2026-10-16 明确要求[按当前 demo 更新 Desktop](issues/05-current-demo-migration.md)，取代上节 demo-only 限制。迁入真实 Thinking、模型内 Effort、三分类 Context、隔离 iframe 浏览器、登记工作区只读文件树和预览；Context 只开放 list_prompt_requests／get_context_breakdown，文件仅开放有界只读接口。表内其他后台能力继续暂缓。

本轮 [Trace 与执行状态正式迁移](issues/09-desktop-current-demo.md)开放既有 get_tool_op_params 补读完整工具参数，保存 Write 原有差异计算结果；Thinking 只显示执行状态，思考正文不展示。表内其他能力不新增 UI。
