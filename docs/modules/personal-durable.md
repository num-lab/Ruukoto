# 个人持久会话与本机管理

## 职责与边界

`apps/ruukoto/src/personal-*.ts` 提供独立的 Pi 1.3.0 会话、本机引导管理及模型/宿主后台工作入口，只用于隔离验证。正式个人 bin、根启动脚本、开发启动器与部署入口使用[产品装配](products.md)中的共享运行时；本机向导可在 Linux 配置主会话只读服务检查，可信宿主 API 也可显式注入，子会话固定空工具；可经隔离向导配对 Telegram 文本私聊，没有模型写工具。可信宿主还可显式启用独立服务操作，Telegram 持有原入口审批、权限快照和精确长期授权。

## 对外接口

`openPersonalHarness` 接受独立目录或已持有的 `PersonalProfileLock`、provider 与模型，接管锁的释放责任，返回主会话、Harness、提交、等待回答与关闭方法；可用 `beforeUnlock` 在放锁前收齐管理接口。可选 `service` 接受宿主固定的 helper 配置，安装 `service_inspect` 与 `read_service_inspection`，模型只能指定白名单内精确单元名或本会话的证据编号。提交键由调用方保持稳定，用于 durable 会话内去重。`parsePersonalModel` 校验模型配置，`personalProvider` 按环境变量名读取凭据。个人 Pi 1.3.0 对象不传给 Coding 的 Pi 0.85.1。

`startPersonalServer` 独占后台，HTTP 仅监听档案内 Unix socket，经本地令牌逐次认证；提供 `/status`、`/messages`、`/inputs`、`/input`、`/telegram`、`/works`、`/work`、`/work/cancel`、`/work/close`、`/work/notes` 和 `/stop`；状态的服务开关只表示能力已装配，不代表 helper 可用或业务健康。`personalControl` 为 CLI 调用；CLI 不重开 Harness。引导与前台托管见[操作手册](../usage.md#25-个人-durable-隔离向导)。

可信宿主使用返回的 `work.delegate` 委派或复用长期子 Agent，`append` 为当前分析追加说明，`list/status` 查询身份和原生工作进度，`cancel` 等待取消核实，`closeAgent` 关闭空闲身份。首次委派可给名称；已有身份通过具名工作引用管理。来源须引用已进入主会话的拥有者输入请求；同工作键异参拒绝。主会话的 `background_work` 工具支持委派、列身份、分页读结果、追加说明、取消工作及关闭空闲身份；来源与请求键由宿主绑定原生工具和唯一活动输入，模型不能自行提供。CLI 的后台分析菜单直接查询历史、读原结果、请求取消与关闭空闲身份，Telegram 的 `/工作` 只管理原 bot/owner/代次的分析。菜单关闭还核实原工作仍是该身份最新工作。追加在当前回答结束后按接纳顺序处理，结果取最后说明的完整回答；取消或结束后拒绝新说明。子会话仍为空工具，不支持自动最终回报；单项控制不等于整项工作委托取消或汇报。

`serviceOperations: true` 另启用宿主 `service` API：`request` 以原拥有者输入建立独立后台 restart 工作，`list/status` 查询原生 Task 和操作事实，`decide/cancel/resolve/recheckStop` 决定原审批、取消或核实效果与停止。模式固定于创建，默认自动审查；无有效长期授权时，自动审查与请求确认的服务写入等人工批准，完全访问免逐次审批。此 API 不通过本机 HTTP/CLI 暴露。Telegram 来源强制使用原收件的模式，不能由 API 扩大；其审批只能通过原 Telegram 宿主菜单决定。历史本机可信 API 仍显式提供模式与单次决定，不能冒充 Telegram 来源。

`telegram` 配置启用固定拥有者文本入口；返回的 `telegram.receive/poll/status` 分别持久接收平台更新、管理可中止轮询、查询连接和最近 16 条收发。后台仅以配对的 bot/私聊拥有者收件，所有输入使用同一 main；普通直发收件保存当时模式/权限版本；`/权限` 管理以后新 Telegram 输入的模式，`/审批`、`/服务状态` 与 `/授权` 查询和管理服务工作。回复已发送宿主菜单选择动作，不要求输入内部键；控制消息不进入模型，也不等待聊天。服务请求仍需可信宿主 API，模型写工具尚未接入。配置、配对和停用见[操作手册](../usage.md#25-个人-durable-隔离向导)。

## 数据与状态

目录中的 `profile.json` 标记产品、Pi、档案和业务扩展版本；`owner.sqlite` 仅持有进程锁。`personal.sqlite` 保存 durable 会话、原生任务、提交、历史、业务格式 document、逐键输入指纹和 `ruukoto.model-request` entries。请求证据保存会话来源、规范化输入、推理级别和实际请求体，两条记录以请求键关联。凭据不写入请求证据，文件与 socket 权限为 0600，目录为 0700。

`ruukoto.service-config` document 保存 helper/sudo/策略路径与 useSudo 的指纹，`personal-service-inspect` 扩展名写入会话；旧程序缺此扩展即拒绝。`ruukoto.service-inspection` entry 保存检查目标、错误码、base64 编码的原始 stdout/stderr 与截断标记；它没有模型正文，只在读取工具结果中按需进入上下文。

`ruukoto.subagents` 保存长期 ownerless Conversation 的身份、名称、关闭事实与单工作占用；`ruukoto.work` 按请求键保存内容指纹、拥有者来源、Task/Submission 引用、原权限快照、Telegram 绑定、模型工具引用、追加说明/来源/原生提交引用及取消事实。每项工作是主会话拥有的 background `ruukoto.background-work` Task，状态与结果以原生 Task/Submission 为准，结果留在子会话。子会话显式选择模型、`personal-subagent` 提示、工作任务扩展及空工具，主会话的服务检查不下放。

`service.json` 保存版本与固定 helper/策略/sudo 绝对路径，生产固定通过 sudo，不接收旧环境中的服务配置、替身开关或测试超时。停机向导首次启用、查看和保留原配置，不提供变更/停用；文件存在本身不代表已成功装配。

`model.json` 只保存模型配置与凭据环境变量名，临时文件加 rename 保存；`control.token` 每次启动轮换，`control.sock` 只在后台持锁时清理，`backend.log` 保存后台诊断。`pending-<UUID>.json`（主聊天）与 `pending-work-<UUID>.json`（原分析追加）是客户端发送前独占创建的原键/正文，追加另含原工作引用，独立文件名前缀和接口让旧客户端/后台无法误投主聊天；多个 CLI 不覆盖彼此；核实原 submission 后只删对应文件。它不镜像执行状态，也不授予执行资格。

`ruukoto.service-operations-config` 标记操作能力；`ruukoto.service-operation` 按请求键保存来源、模式、固定操作身份、审批快照、消费、外部效果和停止核实事实。每次操作对应主会话拥有的 background `ruukoto.service-operation` Task，执行状态以 Task 为准。`ruukoto.service-operation-evidence` 保存每次 helper 调用的原始有界字节，结果和证据同 commit；核实记录保留拥有者证据，不覆盖原未知结论。

`telegram.json` 保存入口版本、随机配置代次、bot/owner、平台接管边界、凭据环境变量及指纹，不含 token。`ruukoto.telegram` 保存当前绑定和诊断水位；`ruukoto.telegram-receipt` 按稳定平台消息键保存原文、固定来源/回复目标、原生 Task/Submission 引用与发送事实。每条消息是主会话拥有的 background Task；429 重试时刻保存在原生 checkpoint，执行状态不另建副本。

主会话登记 `personal-telegram-permissions` 扩展，旧程序缺该扩展时拒绝恢复；`ruukoto.permissions` 保存新 Telegram 输入的模式与版本；`ruukoto.service-grants` 保存精确服务授权、原决定/操作、行版本及失效原因。控制收件保存已接受的结构化决定与授权关联，恢复时双向核实；授权只由原 pending 审批明确创建，完全访问不会自动创建授权。

## 主要流程

启动先拒绝旧目录和链接文件，取得 SQLite EXCLUSIVE 锁并核对档案标记，再打开存储、核对业务格式与每个会话的扩展引用，最后打开 Harness 并检查 live Task 版本。检查完成才恢复调度。主会话显式选择模型、个人提示与工作管理工具；服务检查按宿主配置启用。已有空闲会话可更新模型或启用服务检查，有未完成输入/任务时拒绝增加工具或换模型恢复。首次保存服务配置前，持锁通过 Storage 核实业务格式、已有配置指纹与未完成工作，不启动 Harness 或提交业务记录；只读服务档案新增操作能力同样检查。已有指纹与操作配置匹配时允许恢复缺失文件。Harness 的首次服务启用检查先于新授权记录提交，拒绝后仍能用原配置启动。已启用检查的档案缺配置、指纹变化、配置版本不支持或记录缺失均在恢复前拒绝。

提交先由 durable 持久化，再生成回答；同键重投返回原 submission。每次调用 provider 前保存规范化输入，实际 API 发出 HTTP 前保存最终请求体。请求证据通过持久 ProviderDoc.sessionId 唯一定位实际会话，生成和压缩都写入该会话。回答只从已完整结束的 assistant entry 读取；进程重开恢复原会话与尚未完成的输入。

首次委派在同一 commit 创建子身份、显式配置、工作 Task、来源和占用。Task 经原生 admission 提交稳定键 `personal-work:<taskId>` 并保存 Submission 引用；两次提交之间崩溃时重接原键。追加先持久接纳，由原 Task 逐轮以工作和追加键派生的原键 admission；每轮失败停止后续说明。收齐后台后，最终事务重查取消和追加数，有新增则继续，全部回答后才释放占用；恢复从最后已 admission 的轮次继续，避免旧轮次收尾中止在途追加。主聊天不等待后台工作；完成或取消后保留子会话上下文供再次委派。取消先记录取消事实，等待模型的 Task 观察取消；模型工具与可信 API 还可 abort 工作 Task。停止子会话时同时收齐后台压缩；正常收尾同样收齐子会话执行，比较占用仍属于本工作后，与 Task 终态一起释放；未释放前拒绝复用或关闭。模型工具和 CLI 读取原工作 Submission 的完整回答，每页最多 4096 个 UTF-16 单元，不拆代理对；Telegram 每页最多 2400 个，菜单历史每页 8 项，模型列身份每页 16 个。宿主取消回执只确认登记，查询在原占用释放且正常收尾后才报告停止已核实，faulted/orphaned 不作停止证明。`personal-work-controls` 扩展阻止旧程序误读新菜单，历史菜单的工作与入口在恢复前核实。

本机提交先记录正文 JSON 字符串编码的 SHA-256，再调用原生 admission，同键异参拒绝。指纹提交后而 admission 前崩溃时，原 submission 查询为未受理，不自动执行；CLI 让拥有者选择原键继续或保留。应答丢失先核实，不自动重送。停止请求先完成自身应答，再停 listener、等全部 handler、关 Harness；Harness 故障关闭也完成接口清理后才放实例锁。

服务检查以固定 argv 调用共享 `service-helper.ts`，helper 逐次核实本机、当前策略和白名单。原始输出先写 durable，再返回固定状态、观察时间和证据编号；`read_service_inspection` 每页最多 4096 字符，只读本会话的指定类型 entry。模型输入证据包含实际工具定义和结果；读取原文不再次调用 helper。

服务操作先经 helper 只读检查并保存目标修订，再等待持久审批 document 的决定；批准消费前复核原来源和策略内容，helper 在派发前再次核对修订。消费、开始事实与恢复 checkpoint 同 commit，仅当前 invocation 派发一次 restart。可信请求前拒绝记未执行，可信非零命令退出如实保留已执行结论；进程中断、超时或结果无法核实均暂停，恢复只停止与核实原操作。拥有者的效果说明与启动器/命令单元停止证明分别保存，两者齐全才释放。

Telegram 配对通过真实 getMe 和随机私聊短语选择身份，操作者确认后按已观察批次核实平台接管边界。运行中每批全部持久化才允许下一次轮询短期确认该批；重启不携带旧 offset，按 bot/chat/message 去重，允许平台空闲后随机生成较小 update ID。重复同键异文拒绝。每条原生 Task 用稳定消息键向 main admission，崩溃后接回原提交；只有对应的完整回答进入原目标的发送。

Telegram 控制消息按原始完整正文分类，回复关系只定位同 bot/owner/代次且已发送的宿主菜单；转发、引用摘录与普通回答不能决定操作。收件、决定/授权/撤销和固定回执意图同 commit，重投沿原记录，不重做决定。长期授权每次经 inspect 核实机器、单元、策略及单元修订，再在消费事务重读有效版本；撤销先提交恢复人工，消费先提交只影响后续。服务未知使同机器/单元的全部授权失效；历史未知完成核实后不再影响后来授权。

回复正文先固定保存，再提交 sending 与 verify checkpoint，最后发请求。明确 429 拒绝延后原发送，其他明确 4xx 拒绝终止；断线、5xx、畸形回执或发送后结果落盘失败都保留效果未知，重开不重发。目标停用/换代使旧未开始输入和待发回复取消；已进入主会话的历史保留，已开始发送的未知状态保留。后台停止先收齐轮询，再关闭 Harness，故障放锁前也收齐网络与本机接口。

## 不变量与失败处理

同一档案只允许一个拥有者，关闭清理完成或进程崩溃后释放锁，锁文件不删除。配置写入使用同一锁，不因连接失败而离线争写。不支持的版本、缺扩展或缺任务定义均阻止调度；已有数据库缺少格式记录也拒绝。输入证据写失败时不发请求；存储失败关闭 Harness 并报告，宿主不自动重开。正常关闭保留未完成输入供重开恢复，不能当作工作取消。坏令牌、链接及旧目录拒绝，不能清理后自动接管。

请求体 128 KiB、消息正文 16 KiB、应答 256 KiB；客户端总时限 5 秒，后台收件 10 秒、闲置 15 秒。最近记录扫描 64 条 entry、显示最多 16 条消息，每条最多 8192 字符并标截断/中断；不返回输入证据或堆栈。终端输出过滤控制字符。

服务检查 stdout/stderr 总计最多 1 MiB，超限停止检查并明确标记部分证据；畸形应答、多条前缀、目标或状态字段不符均报错，不把它们当状态。证据写入失败关闭 Harness，不能报告成功。服务配置仅由持锁的宿主 API 或停机向导提供，不由模型、工具参数或本机消息正文决定；服务重启仅通过另行启用的可信宿主 API。

仅使用新的隔离目录，不能以此 API 浏览或恢复旧个人档案。SQLite WAL/NORMAL 支持进程崩溃恢复，不保证断电时最近提交保留。服务检查为无写入效果工具，可在中断后安全重跑并得到新的观察；服务操作另按开始事实保守恢复，不将只读重跑规则用于 restart。

`personal-work-notes` 扩展阻止旧程序读取追加记录；恢复核对本机指纹/工作、Telegram 原已送达详情菜单、模型拥有者/工具动作及原生输入正文。追加不修改原权限，接纳及后续子请求同时复核原工作与追加来源的未知服务操作。工作扩展依赖的索引缺失、文档版本不支持、会话/身份或 Task/占用关系断链均在调度前拒绝；未核实的遗留占用不因 Task 意外终态而自动清除。旧无工作档案只在无未决输入/任务时启用后台工作。模型变更有未决工作时拒绝，空闲时显式同步所有长期会话。provider 两处记录边界都复核活动占用及取消事实，缺失/歧义来源、空闲/关闭/取消身份不发模型请求。子会话固定空工具，不能据此声称外部进程停止或未知写入核实已完成。模型工作工具只在主会话活动工具调用中执行，变更另需唯一拥有者输入，回报输入仅可查询；首次启用有未决输入/任务时先拒绝，不固化扩展。原 Telegram 绑定失活或同来源服务效果/停止未核实时，委派与子模型请求均拒绝；历史绑定不改成新绑定，其他来源聊天仍可继续。

服务目标与同一原输入各只允许一个未结束操作；未知效果、停止未核实乃至意外 faulted 终态均保留占用，不允许换键或换目标绕过同来源暂停。其他来源的独立目标与主聊天继续。原输入后来 unanswered 不破坏档案来源身份，但不能再消费未执行的批准。缺操作配置、扩展、版本或来源/Task 双向关系均拒绝调度；已保存的停止证明必须绑定本机、操作及命令单元并带 `launcherExited`，旧 helper 应答不能释放占用。

Telegram 数值 offset 只在一批更新收到后 60 秒内用于紧接的一次请求；失败、空批或超期清空，不能把 ID 视为永久单调。配对身份选择同样有 60 秒截止。平台明确确认与配置保存没有跨存储原子性，保存失败需重新配对；凭据变化不沿用旧配置启动。发送回执必须验证平台结果、消息身份和固定目标；原生 fetch 错误及含 token 的 URL 不进入日志。每批最多 16 条更新，HTTP 回执最多 1 MiB，正文最多 16 KiB；平台回复最多 3900 个 Unicode 字符加截断提示，完整回答保存在 durable。

旧 Telegram 收件没有权限快照时不能新建服务工作；已有这类未消费操作失效，已消费操作仍保留效果核实与占用。旧代次服务批准无法消费，长期授权失效；模式变更只影响新收件。权限/授权版本及来源关联缺失或操作模式与原快照不符时拒绝恢复，不能重建默认授权。

## 设计依据

- [个人 durable 档案与请求证据先于恢复](../../.agents/notes/implemented/architecture/2026-10-17-personal-durable-foundation.md)
- [隔离个人实例由后台独占并通过本机接口管理](../../.agents/notes/implemented/architecture/2026-10-17-personal-local-management.md)
- [个人 durable 服务检查复用固定 helper](../../.agents/notes/implemented/architecture/2026-10-17-personal-service-inspect.md)
- [个人后台工作占用长期独立子会话](../../.agents/notes/implemented/architecture/2026-10-17-personal-background-work.md)
- [个人服务操作先持久消费并核实未知效果](../../.agents/notes/implemented/architecture/2026-10-17-personal-service-operations.md)

- [个人 Telegram 收件与固定回复由 durable 任务衔接](../../.agents/notes/implemented/architecture/2026-10-17-personal-telegram-entry.md)

- [Telegram 原收件与服务权限](../../.agents/notes/implemented/architecture/2026-10-17-personal-telegram-permissions.md)

- [个人隔离向导固定服务配置](../../.agents/notes/implemented/architecture/2026-10-17-personal-service-configuration.md)

- [个人模型工作由宿主固定拥有者来源](../../.agents/notes/implemented/architecture/2026-10-17-personal-model-work.md)

- [个人后台分析由宿主菜单控制](../../.agents/notes/implemented/architecture/2026-10-17-personal-work-controls.md)

- [个人追加说明由原工作按轮次接纳](../../.agents/notes/implemented/architecture/2026-10-17-personal-work-notes.md)
