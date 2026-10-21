# 共享界面投影

## 职责与边界

本篇的运行状态、历史或客户端协议适用于 Coding 与保留的旧格式实现；正式个人 Agent 使用[个人持久会话](personal-durable.md)，不接入旧 Runtime、Task Store 或控制协议。

`@ruukoto/view`（`packages/view/src/`）把控制面的快照、持久事件、历史页与任务详情投影为内存状态，供客户端共用。它可以在浏览器运行，不打开连接或文件，不持久化状态，也不渲染界面。连接与全局事件序号恢复归 [control](control.md)；命令执行、命令持久化、输入历史、工作流侧栏与终端样式归 [tui](tui.md)。

## 对外接口

| 入口 | 输入与用途 |
| --- | --- |
| `ViewState.applySnapshot` | 安装 `ConnectResult`；数据实例变化时丢弃全部会话视图 |
| `ViewState.applyEvent` | 应用实时或补发的 `PersistentEvent`；补发只恢复展示，不回滚快照中的任务与审批状态 |
| `installHistoryPage` / `appendEntryView` | 安装 `read_history` 历史页或 `read_history_entry` 单条历史内容 |
| `installTaskDetail` | 安装 `get_task` 的任务、工具、预览与响应中的 `seq` |
| `openSession` / 查询方法 | 获取会话投影，按会话选择任务、待审批与工作委托 |
| `EventFlow` | 按稳定身份投影正文、思考、工具、任务与本地提示条目，合并历史与任务事件 |
| `utf8ByteLength` / 标签函数 | 计算 UTF-8 字节数，提供模式、任务、工作流与 SubAgent 状态文字 |

输入类型来自 core 与 control，仅浏览器可用的模块参与值引用。`ACTIVE_TASK_STATUSES` 与 `TERMINAL_TASK_STATUSES` 由 core 的 `task-status.ts` 提供，展示归属由 control 的 `session-attribution.ts` 提供；原模块仍再导出它们。

## 数据与状态

`backgroundProcesses` 安装快照中的后台状态，并仅接受不早于已有版本的 `background_process.changed` 实时事件。退出观察与停止核实分别保留，`stop_unverified` 显示占用仍在；实例变化时重新安装，补发不回滚快照。后台列表与日志的分页读取由客户端负责。

`ownerQuestions` 从快照和问题状态事件恢复待答卡片、已答内容与唯一续接引用，保留选项说明、推荐标记、多选类型、选择索引与跳过的空答案。实时事件只接受不早于已有版本的状态；补发不回滚快照，数据实例变化重新安装问题数组，普通会话草稿独立保留。

`ViewState` 保存快照给出的 mainSessionId、项目、会话、任务、审批、产物、工作委托与 SubAgent，以及按会话隔离的 `SessionView`。`EventFlow` 以任务、消息段、思考段和工具操作的身份维护条目、事件版本与未连续到达的正文及思考片段。内存中的命令条目只参与统一排序与重同步保留；生成命令、执行及读写 SQLite 由 TUI 持有。

初始历史窗口最多保留 300 条；主动向前翻页会扩展窗口，已读内容可保留。会话 JSONL 仍是最终正文的唯一权威副本，投影与预览不替代它。

`task.attachments` 与历史按任务身份合并为同一用户消息，保留安全文件名与大小；纯附件允许空正文。迟到任务详情只补未落盘的输入，不覆盖已关联的历史正文。

任务详情中的 `displayInput` 作为不可变展示元数据保留；迟到详情只补该字段，不回滚较新的任务状态。同实例快照与未携带该字段的任务更新不清除它，跨实例清空；EventFlow 及历史原文保持不变。

## 主要流程

1. 调用方每次安装新快照都更换异步请求代次，包括重连及同一连接内因 seq 缺口重同步；旧代次的历史、任务详情与正文补读结果均丢弃。先安装快照，再以 `replay` 应用握手补发事件，以 `live` 应用实时事件。
2. 经 `read_history` 安装历史页，并用 `list_tasks` 补齐快照之外的任务。对需要恢复的任务调用 `get_task`，连同其响应 `seq` 安装详情，再分页调用 `read_task_events`，以补发事件恢复思考、工具身份与正文顺序。任务事件各自维护游标，首次从 `after_seq=0` 读取，不能把详情 `seq` 当作历史事件的起点；每次新快照安装时清空这些游标。
3. 长正文经 `read_history_entry` 按 UTF-8 字节偏移补齐，组装完整条目后交给 `appendEntryView`。只有快照与历史页不足以恢复完整事件流。
4. 正文片段按 UTF-8 字节偏移拼接，重复片段不重复追加；工具意图与结果按操作身份合并，结果到达保留原始开始位置。完整历史到达后校正缺失的正文。

TUI 的恢复调用在 `app.ts`，共享投影只安装输入，不主动请求。每次快照安装时，TUI 重载本地命令记录；保存失败的本地结果优先于旧存储，失败提示仍在事件流中显示。

## 不变量与失败处理

全局 seq 去重、缺口检测与连接恢复由 `ControlConnection` 持有；view 按条目版本拒绝旧投影更新，任务详情用响应 `seq` 防止覆盖较新的实时状态。调用方不得把补发事件作为实时状态再次应用。

UTF-8 字节计数使用 `TextEncoder`，中文、emoji 与孤立代理项的计数与 Node 一致。源码 lint 拒绝 Node 内置模块及 Node 全局；浏览器打包后的全部可达代码仅按浏览器全局做 `no-undef` 检查，再在不提供 Node 全局的 VM 中执行投影。传递依赖中未执行分支的 Node 全局也会被拒绝。

历史关联缺失时保留普通正文并显示原因，不猜测任务或跨任务配对工具结果。数据实例变化时旧会话视图失效，同实例快照保留草稿与本地提示。思考增量按 UTF-8 offset 补洞去重，较旧缺失片段可补齐正文，阶段时间只取最新事件；旧无偏移快照仍替换。任务结束收尾尚未结束的思考段。待审批只包含状态为 pending、所属任务非终态且权限版本一致的请求。`task.mode_switch_failed` 只随后台中断产生，实时投影将非终态任务设为 interrupted、记录结束时间并保留失败原因；已有终态不回滚，不能将停止未核实解释为安全停止。

## 设计依据

- [搜索结果直接打开普通会话](../../.agents/notes/implemented/simplification/2026-10-21-desktop-search-session-navigation.md)

- [应用内 Spotlight 与历史定位](../../.agents/notes/implemented/feature/2026-10-21-desktop-spotlight-search.md)

- [Coding 会话后台持有独立目录占用](../../.agents/notes/implemented/feature/2026-10-21-coding-background-processes.md)

- [Coding 持久问题与可信续接](../../.agents/notes/implemented/feature/2026-10-21-coding-owner-questions.md)

- [完整思考与文件预览](../../.agents/notes/implemented/feature/2026-10-18-complete-reasoning-and-preview.md)

- [同仓 workspaces 分包](../../.agents/notes/implemented/architecture/2026-10-11-in-repo-workspace-packages.md)：包依赖、浏览器投影与 TUI 的职责划分。
- [桌面客户端作为又一个控制面客户端](../../.agents/notes/proposed/architecture/2026-10-15-desktop-client.md)：共享投影的使用方向与浏览器约束。
