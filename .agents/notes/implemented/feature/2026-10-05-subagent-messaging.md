# Agent Note: 同项工作内的 SubAgent 消息与协作加入

Status: implemented

原出处：ADR 0020「补充：工作内消息与协作加入」

## 问题

[工作委派](../architecture/2026-10-03-work-delegation-subagent-task.md)中的多个 SubAgent 需要交换有来源的消息，上级也需要补充说明。身份会跨工作复用，忙碌与模型预检可能延迟投递，因此旧协作者与迟到消息必须在复用后失去资格，消息不能扩展资料或工具权限。

## 决定

1. **协作加入**：`work_id` 与 `sub_agent_id` 同现的委派把一个既有空闲 SubAgent 拉入既有只读工作登记一次执行任务（任务关联列指向协作方；工作行保持首次承接者，参与者集合经 `tasks.sub_agent_id` 判定）。复用/继续/加入的可用性、竞争仲裁与来源并集复核与[继续、复用与关闭](2026-10-04-subagent-reuse-close.md)同一口径；加入的幂等键按目标 Agent 会话核实（不同协作方同键独立）。修改工作同一份文件单一写入者，宿主评审是固定单 Agent 流程，都不接受协作加入。
2. **发送方身份由发起任务核实**，模型参数不提供身份：工作父会话的任务 = 主 Agent（必须指定接收方），本工作的 SubAgent 任务 = 该 SubAgent（只能从本工作的任务中发送）；其他会话、其他工作、宿主评审 SubAgent 一律拒绝。接收方必须当前承接本工作（`active_work_id` 正是本工作）且未关闭——复用转做其他工作后旧协作者与迟到旧消息都失去资格（不进入新工作上下文）；不把关闭当作重新创建 Agent 的理由；已取消的工作不能投递。
3. **存储与幂等**：`subagent_messages` 表（schema v29 只建表，旧库表为空不回填）。按（工作, 发送方, 键）查重先于执行预检：同键同参的重放即使此后已取消/关闭也返回原记录，异参冲突。`message` 异步准备后，在同步登记事务内再次查重、执行预检返回的 `check` 并重核当前资格与模型选择；消息行带来源（发送方、发起任务）、投递与未投递结果，可追溯。发给 SubAgent 或 main 唤醒都须在事务外核实模型配置与受限执行入口；新消息遇 `model_config_busy` 等预检失败或模型选择变动，零新增消息、任务与事件。纯 dev 父会话注入不创建新执行，无需这道执行预检。`ParentDelivery.messageRecorded(msg, work, selection)` 只使用管理器已核实的模型选择插入 main 消息唤醒。
4. **投递不扩大权限**：发给 SubAgent 的投递为它在本工作的一次 `confirm` 执行任务（请求键 `smsg:<消息ID>`，`readScope` 沿用其在本工作最近任务的钉定，工具清单仍按工作内容钉版、另加 `subagent_message`）；发给主 Agent 的经 dev 注入（`[工作内消息]` 参考块，与结果注入同一收集与标记事务）或 main 唤醒任务（`agentId=main`、confirm、无截止时间）。正文上限 4096。
5. **待投递与冲刷**：接收方忙碌或父会话活动任务名额已满（3，与委派限额同一计数）时登记为待投递；宿主机在 SubAgent 任务终态（编排器结果登记后）、启动恢复、整项取消、resume-queue 核实完成与模型配置应用结束后异步冲刷。关闭仅在自身同步事务内清理目标 Agent 的待投递消息。冲刷先核资格，忙碌/名额满保持待投递且不做执行预检；具备投递条件时才预检，任意预检失败均保留已登记消息并输出诊断。RuntimeModels 在模型配置应用的 `finally` 中经 Runtime 注入的回调等待冲刷，成功与回滚都按当前配置再投；资格已失（`moved_work`/`closed:<时刻>` 等）或工作已取消记明确未投递结果并发 `subagent_message.dropped`。异步等待期间可能登记新委派，因此投递事务必须重核当前工作、资格与模型选择，按原 `smsg:<消息ID>` 键与一次写入标记仲裁；旧消息不能进入新工作，同一条消息不能投递两次。不依赖终态后的同步续段优先于新委派，也不增加锁。消息补建统一由管理器 `flushPendingMessages` 完成，父级送达 `sweep` 只补建结果唤醒。配置门闩与完整操作收尾的区别由[模型配置归属](../architecture/2026-10-23-runtime-models.md)持有。
6. **工具与可见性**：`subagent_message` 属 `subagent` 类别，dev 与 main 装配并经同一工厂对 SubAgent 子会话装配（宿主评审任务不激活），装配、发送前与调用门同一结论；工具操作账本按（工作, 发送方, 键）核实。主 Agent 经 `subagent_result` 的 `part=messages` 读取本工作消息；拥有者经控制面 `work_get` 的 `messages` 列表读取（控制协议 v15）；跨实例导入随所属工作的账本条目折叠。

<!-- agent-note-format: alternatives-not-recorded (pre-format Agent Note) -->

## 后果

同项只读工作可让既有空闲 Agent 协作，发起方与消息来源可追溯。代价是消息与执行分开保存，异步等待后必须在同步投递事务重核资格和模型；不能依赖终态同步续段先于新委派，也不额外加锁。协作加入没有一步新建协作者入口；修改工作保持单一写入者，宿主评审保持固定流程。消息随实例导入的工作账本折叠，未新增独立导入账本类别。

## 验证

[工单 13](../../../../.scratch/agent-direction/issues/13-subagent-messaging.md)记录 test/86-subagent-messaging 8/8、typecheck 与图解检查 4/4 通过。全量 897 项中 893 通过、1 跳过、3 失败，已逐项核实为 DNS、worktree 目录名和全量负载下 PTY 时序环境项。smoke-13-subagent-messaging.mts 在 macOS 与 ssh tx Linux 各 6/6，真实 Runtime、CLI、SQLite、JSONL、Docker worker，模型/平台模拟。moved_work 与 closed 待投递组合由最终状态播种覆盖守卫，不能作为正常时序自然可达的证明；宿主评审消息禁用由管理器断言覆盖，未构造完整评审场景。真实 QQ/Telegram 未实测。

## 适用范围

完全访问的账户、环境、免审批及宿主任务授权传播采用[本决定](2026-10-12-full-access-current-account.md)；本篇其他独立规则继续适用。

通用调度的独立执行、运行归属、审批来源与整项取消采用[本决定](2026-10-12-generic-scheduled-tasks.md)；本篇其他独立规则继续适用。
