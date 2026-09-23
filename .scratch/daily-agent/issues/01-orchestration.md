Status: resolved

# 角色、事件与子任务编排

## 目标

在现有 `Project → Session → Task → Driver` 上增加逻辑角色和父子任务，使外部事件、main、coding、chat 可以通过后台可靠通信。

## 依赖

无。复用现有任务队列、持久事件和会话恢复机制。

## 实现范围

- 角色配置：`main`、`coding`、`chat`；每个角色绑定 Project、Session、工作目录、模型和工具白名单。
- 任务字段：`agent_id`、`parent_task_id`、`source_event_id`、`deadline`、结果摘要和结果引用。
- 入站事件：来源、外部 id、actor、目标角色、正文/产物引用、接收时间、处理状态。
- 内部委派 API：只允许后台编排器创建子任务；模型不能调用 owner 控制面。
- 子任务完成、失败、超时和结果未知事件；main 的有界唤醒输入。
- 幂等键覆盖外部事件、子任务创建和内部结果回传。
- 重启恢复：事件已登记但尚未建任务时可继续；不自动重放未知外部副作用。

## 边界

角色配置决定工具和资料范围，不能由输入正文、项目指令或模型结果修改。跨角色传递只传固定字段和引用，不复制未授权的完整历史。

## 验证

- 重复事件只创建一个子任务；
- 父任务完成前子任务结果可查询；
- 子任务结果能唤醒 main；
- 后台重启不会重复创建或重放外部操作；
- coding、chat 不能读取 main 的 owner token 或未授权资料；
- 现有 TUI、任务队列和恢复测试全部回归。

## Comments

### 2026-09-23：实现交付

实现事实（相对工单的对应关系）：

- 角色配置：`agent_roles` 表（宿主引导写入，含项目/会话/工作目录/模型/工具白名单），角色定义静态固定在 `src/runtime/orchestrator.ts`（main=host_data+web_search；coding=全量；chat=空）。工作目录在数据目录的兄弟目录 `agent-work/<role>/`（避开保护根，沿用 qq-work 口径）。工具白名单按注册来源类别，Driver 三层强制：装配过滤、发送前最终检查（`role_tools_forbidden`）、调用门阻止。
- 任务字段：`tasks` 补列 `agent_id / parent_task_id / source_event_id / deadline / result_summary / result_ref`（schema v10 → v11，ensureColumns 幂等补列；pre-v6 重建路径同步覆盖）。
- 入站事件：`inbound_events` 表，`(source, external_id)` 唯一即幂等键；状态 registered → queued → done/failed；先持久化再建任务（请求键 `evt:<eventId>`）。
- 内部委派 API：`Orchestrator.delegate()`（进程内，不经控制面、非模型工具）；请求键 `deleg:<parentTaskId>:<key>`（幂等键在父任务内唯一）。控制面 ops 不接受编排字段（submit 的编排参数只经窄接口传入）。
- 子任务终态事件：`child_task.completed / failed / timeout / result_unknown`；结果一次写入（`result_summary IS NULL` 条件更新去重）。超时取消原因 `deadline_exceeded` 持久化在任务行，重启后巡检仍可判定。有界唤醒：固定模板 + 摘要 ≤1000 字符，请求键 `wake:<childId>` 幂等，只投向角色会话（父任务在拥有者交互会话时不注入，结果经 get_task 查询）。
- 重启恢复：已登记未建任务按原请求键重提；重启窗口内终态的角色任务启动巡检补记结果/事件/唤醒（interrupted 一律结果未知，不重放外部副作用）；角色会话队列暂停自动恢复（沿用 QQ 适配器口径）。见 docs/runtime.md 恢复第 7 条。

已知边界与延迟项：

- spec.md 运行模型提到的“是否需要拥有者”结果标志与“安全子任务自动重试一次”不在本工单实现范围，留待 issue 05（委派链路）评估。
- local 执行后端无文件系统隔离（ADR 0004 既定）：直接 read/bash 的越界拦截由容器后端提供；宿主层保证保护根（含 owner token 所在控制面目录）不可经 request_file_access 申请，且不产生审批单。
- 角色会话出现在 TUI 会话列表中（未做隐藏）；14-tui-app 的两处绝对数量断言改为相对断言。

验证（test/27-orchestration.test.ts，8 项，mock 模型 + 临时目录；重启用例为进程内 stop/start 同目录）：

- 角色引导绑定独立项目/会话/工作目录且白名单符合定义；
- 重复事件只创建一个子任务（含重复委派返回同一子任务）；
- 子任务完成：结果记录 + child_task.completed + main 有界唤醒；
- 父任务运行中子任务结果已可查询；
- 超时取消：child_task.timeout + 唤醒带超时摘要；
- 重启：已登记未建任务继续（不多建）、中断子任务记结果未知并唤醒、不重复创建不重放、角色身份稳定；
- 工具白名单：chat 空工具、main 无编码工具、coding 全量（按模型实际请求载荷断言）；
- 资料隔离：owner token 审批入口硬拒绝（保护根）且未进入 coding 历史；跨项目搜索不含 main 未授权内容。

`npm run typecheck` 通过；`npm test` 全量 242 项：241 通过，1 项跳过（真实模型门禁）。注：test/26-qq.test.ts 的“排队超过 TTL”用例在本机全量并行下偶发超时，基线提交同样复现，与本工单无关。
