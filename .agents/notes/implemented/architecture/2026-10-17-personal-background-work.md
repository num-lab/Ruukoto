# Agent Note: 个人后台工作占用长期独立子会话

Status: implemented

## 问题

[个人迁移](../../proposed/architecture/2026-10-17-personal-pi-durable.md)要求主聊天可继续响应、子 Agent 长期复用且取消不关闭身份。把 Conversation 交给单次工具 Task 拥有，会把上下文寿命和工作取消绑在一起；直接向同一子会话排队另一工作，又会让 Conversation.abort 取消错误的输入。

## 决定

可信宿主通过 `openPersonalHarness().work` 管理后台工作。子 Agent 身份是 ownerless Conversation；每次委派是主会话拥有的 background `ruukoto.background-work` Task，两者通过 `ruukoto.subagents` 索引关联。创建身份、显式配置、登记 Task、来源和占用在同一 durable commit；工作键的 SHA-256 固定内容、来源、目标及名称，同键异参拒绝，重复返回原工作。来源必须是已进入主会话的拥有者原生 input，不接受排队输入或回报。索引只保存身份、关闭事实和占用，不复制 Task 的执行状态。

子会话显式装配 `personal-subagent` 提示、`personal-background-work` 任务扩展和空工具。长期上下文不携带外部执行权限；主会话现有只读服务工具不下放。此切片没有模型委派工具、追加说明、结果自动外发或 IM/CLI 管理入口，不声称完成权限模式、审批或未知写入暂停。

工作 Task 用 `personal-work:<taskId>` 经原生 admission 受理，再保存 Submission 引用并等待。admission 不能与宿主登记同 commit；这个窗口依靠原键恢复，不另写一套队列或运行状态。结果和进度直接读 Task/Submission；结果留在原子会话。完成后保留身份和上下文，关闭只保存关闭事实，不删除历史。

取消先提交 `ruukoto.work` 的取消事实，再调用原生 abortTask。恢复中的 Task 同样检查取消事实；abort handler 停止目标 Conversation，跨 background 收齐压缩等执行。正常回答或失败收尾也停止子会话余下后台执行。只有确认目标会话已停，才比较占用仍属于本 Task，并在同一 Task 终态 commit 释放占用。取消事实已提交而 abortTask 尚未调用时，正常收尾直接结束为 aborted；不能用相同 checkpoint 要求上游重新调度。unexpected fault 保留占用，终态不能当作停止证明。

provider prepare 与 onPayload 都按持久 ProviderDoc.sessionId 唯一定位实际 Conversation，在保存证据的同 commit 复核活动占用与取消事实。缺失/歧义来源、空闲/关闭/取消的子身份拒绝请求，不能只靠会被跳过的 beforeRequest hook。每份证据写在实际调用会话，生成和压缩沿同一入口。恢复前核对文档版本、身份/会话双向关系、工作/占用/原生 Task 双向关系及来源；旧无工作档案仅在无未决输入/任务时启用新扩展。空闲时同步所有长期会话模型，有未决工作时拒绝换模型。

## 既有笔记审计

按 durable、长期子 Agent、后台工作、取消与 ProviderDoc 检索 active notes；没有 rejected 目录。[迁移总方案](../../proposed/architecture/2026-10-17-personal-pi-durable.md)、[档案基础](2026-10-17-personal-durable-foundation.md)、[本机管理](2026-10-17-personal-local-management.md)与[服务检查](2026-10-17-personal-service-inspect.md)部分重叠，互链并保留各自决定；本篇只增加宿主工作生命周期。[旧委派模型](2026-10-03-work-delegation-subagent-task.md)与[旧重启恢复](2026-10-05-subagent-restart-recovery.md)仍服务正式共享底座，不搬入旧状态机。[后台命令提案](../../proposed/feature/2026-10-14-bash-background-lifecycle.md)管理 OS 进程，本片没有该执行能力，属无关。无完全吸收或待归档记录。

## 备选方案

- 先做通用未知效果框架：可以为所有写工具预留入口，但尚无消费者会掩盖真实回执和权限差异；先交付有模型工作消费者的归属，再按实际写操作接入。
- 工具 Task 拥有子会话：取消自动级联且代码更少，但无法保持跨工作身份寿命；改用独立长期会话并显式取消当前工作。
- 只等待普通 idle：符合上游默认且省一次停止，但后台压缩可能跨到下一工作；收尾跨 background 停止，再原子释放占用。

## 后果

工作和历史仍由 durable 持有，主聊天不等待 background Task；单工作占用让取消范围明确，恢复不用猜测是否重复受理。代价是额外业务关系与恢复核对；异常断链保留占用并拒绝恢复，不能用删除索引绕过。当前子会话没有外部工具，取消验证只证明模型/框架执行停止，不证明 OS 子进程或外部副作用已核实。

验收与未覆盖项见[宿主工作工单](../../../../.scratch/personal-pi-durable/issues/05-background-work.md)；完整迁移、产品交互和部署仍由总工单持有。
