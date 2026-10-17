# Agent Note: 个人模型工作由宿主固定拥有者来源

Status: implemented

## 问题

[长期子会话](2026-10-17-personal-background-work.md)已有可信宿主生命周期接口，但模型不能委派或查询。工具执行 API 不携带原始 Submission，直接让模型填写来源或扫描最新 pi.user 会把工作归属和授权交给模型；把子结果当新拥有者输入还会允许它继续创建工作。

## 决定

主会话装配 `personal-model-work` 扩展及 `background_work` 工具，支持 delegate/list/result/cancel/close。模型只提供业务说明和所需对象引用；工作键固定由原生工具 TaskId 派生。模型与可信宿主共用事务登记、指纹、单工作占用与取消/关闭实现，不复制队列或任务状态。子会话仍显式空工具，没有工作管理或外部操作能力。

工具先从活动 run 的唯一 Submission 获取候选请求键，再在同一变更事务通过原生 `submissionByRequest` 复核 ID、placed 状态与 pi.user entry；同时核实 root 的 pi.tool、其 generation owner、LiveDoc.run 与 running 工具槽。候选读取在事务外，因为公共 Tx 不暴露按 SubmissionId 查询；事务内重新读取的原生记录才是依据。Harness 显式选择 one-at-a-time；即使人为混入多输入也拒绝变更，不猜最新输入。非拥有者输入只允许 list/result，不能 delegate/cancel/close。

新委派保存原权限模式与版本；Telegram 必须匹配直发原收件、Submission 与当前固定绑定，不能从最新默认模式补造授权。子会话 provider 的两处证据提交继续核实取消/占用，并增加原入口有效性与同来源未核实服务操作检查。原绑定失活只阻止旧工作请求，恢复不改写历史绑定或拒绝其他独立聊天；服务效果或停止未知时，同来源不能通过新子身份绕过。空工具切片不声称这些快照已经授权外部工具。

结果查询按原工作 `personal-work:<taskId>` 的已完成 Submission.answer 读取，每页 4096 字符；运行、失败、取消等状态不伪装成成功。list 每页 16 个身份。取消事实与活动拥有者来源在同事务记录；收齐原 Task 后，还须核实正常收尾且原身份占用已释放才报告 stopped。faulted/orphaned 或占用未释放时报告 stop_unverified，保留现场，不把终态当停止证明。关闭同样在拥有者授权事务检查空闲并保留历史。

首次启用模型扩展有未决输入/任务时先拒绝，不固化新扩展。恢复检查模型键、工具调用 entry、工作与原生 Task、权限快照及 Telegram 原收件关系；旧程序因缺新扩展拒绝新档案。旧宿主工作仍按原记录恢复，不补猜其权限或工具归属。

## 既有笔记审计

按 durable、后台工作、子 Agent、来源、权限与取消检索 active notes。迁移提案、后台工作、[Telegram 权限](2026-10-17-personal-telegram-permissions.md)、[服务操作](2026-10-17-personal-service-operations.md)和[档案基础](2026-10-17-personal-durable-foundation.md)部分重叠，各自保留决定并互链；旧共享委派与恢复继续服务 Coding，不改变其状态机。没有完全吸收或待归档提案。

## 备选方案

- 让模型提供 sourceRequestId 和幂等键：接口最简单，但正文可以冒充原输入，模型重试也可能另造工作；由宿主固定原生工具和 Submission 关系。
- 取最新 pi.user：省去活动工具核实，但排队输入或回报后的历史不等于本轮授权；只接受当前唯一拥有者输入，模糊时结束本轮并报告。
- 本片直接外发每个子结果：更快看到通知，但不能证明同一委托全部结束并由主 Agent 汇总，取消与发送也需要完整归属；固定最终回报整体留给后续切片，不把子结果通知记作最终交付。
- 同批下放服务写工具与追加说明：能扩展用途，但需额外接通子操作未知暂停及追加输入/收尾竞争；先复用已经验收的空工具生命周期，后续按真实工具建立权限与停止证明。

## 后果

模型可以异步委派分析，主聊天继续响应，并按原工作查询结果；已有身份与取消语义保持。代价是工具归属与权限关系的恢复检查；升级启用模型委派前必须完成旧未决工作。[独立宿主菜单](2026-10-17-personal-work-controls.md)共用查询与停止证明，不依赖模型控制；后台结果自动唤醒/外发与追加说明仍由总方案推进。完整迁移与产品体验不能据窄检查宣称通过。模型入口验收和未覆盖项由[实施工单](../../../../.scratch/personal-pi-durable/issues/10-model-background-work.md)持有。
