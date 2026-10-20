# 桌面客户端

## 职责与边界

本模块的 Personal SSH 连接仅识别旧控制协议，不支持新个人 durable 入口；新个人使用 IM 与引导式 CLI。Code 桌面能力保持。

`apps/desktop` 是 macOS 上的控制面客户端，与 TUI 共用后台。Code 目标提供工作区与会话树、添加工作区、新建会话、会话标签页、对话流、输入提交、模型与会话默认模式选择、任务控制、暂停队列恢复，以及右栏的工作委托、SubAgent 历史与单次工具差异；两个目标共用审批卡片、系统通知与 Dock 角标；Personal 完整会话界面尚未开放，主进程支持与 Code 并存的 Personal SSH 连接。后台事实只经控制面取得，不读取数据库、JSONL、工作区文件或 git。

## 对外接口

主进程持有令牌、`ControlConnection`、SSH 子进程和后台拉起。preload 只向渲染进程暴露 `subscribe(target, listener)`、`request(target, op, params)`、`pickFolder()` 与 `reveal(path)`。主进程校验 IPC 来源和操作名单：本地 `reconnect`，以及后台的 `list_session_summaries`、`open_workspace`、`create_session`、`read_history`、`read_history_entry`、`list_tasks`、`get_task`、`read_task_events`、`work_list`、`work_get`、`read_tool_result`、`list_models`、`set_session_model`、`set_session_mode`、`get_session`、`interrupt`、`cancel`、`resume_queue`、`get_confirmation_params`、`respond_confirmation`。`submit` 与 `continue` 交主进程的 SubmissionGuard，`find_task` 仅供守护内部使用；本地 `desktop_pending_read` 与 `desktop_pending_clear` 处理输入恢复。Personal 开放订阅、重新连接、审批读取与应答、`get_task` 核实，以及本地 `desktop_personal_config_read`／`desktop_personal_config_save`；其他业务操作随界面开放。字段与权限继续由控制面校验。错误作为 `{ code, outcome, message, versions? }` 响应数据跨 IPC 传递，保留应答丢失分类。

渲染进程使用 React 与 Tailwind，消费 `@ruukoto/view` 的快照和事件投影。开发与构建命令见[开发说明](../development.md#桌面客户端)，启动与故障恢复见[操作手册](../usage.md#桌面客户端)。

## 数据与状态

连接目标由产品身份、socket 和令牌来源组成，Code 固定为 `ruukoto-code`，Personal 固定为 `ruukoto`；安装快照前核对产品，不符以 `product_mismatch` 停在 failed。连接状态沿用 control 的 connecting、online、reconnecting、failed 与 closed；版本被明确拒绝后停在 failed，仅由拥有者重新连接。令牌只在主进程内存；本模块保存连接配置和待核实提交，不保存令牌或后台历史副本。日常后台仍使用自己的档案与日志。

Personal 配置保存在应用数据目录的 `personal.json`，只含 `host` 与 `controlDir`（默认 `/var/lib/ruukoto/control`）。主机别名只允许字母、数字、点、下划线与连字符，首位须为字母或数字；远端绝对路径只允许字母、数字、点、下划线、连字符与斜杠。保存与加载均校验最终 socket 路径的字节长度，本地 macOS 上限 103，远端 Linux 上限 107。转发 socket 位于应用数据目录的 `ssh/personal.sock`，`ssh` 目录权限 0700。

会话标签页和待完成创建记录仅保存在渲染进程内存。创建记录持有原请求键、参数、连接目标和数据实例，结果核实前阻止另起创建；安装新快照不会丢弃它。同实例快照保留标签页，换实例清空旧标签与会话视图。普通草稿仅在渲染进程内存中按实例和会话保存，退出或重载后丢失；尚未交付的待恢复原文继续保存在主进程记录里。

提交与继续的完整参数、原请求键和数据实例标识先保存在应用数据目录的 `pending/code/<控制目录摘要>`，再发送；目录按目标及控制目录隔离。待核实列表按请求键更新，损坏记录显示数量与位置。同会话有待核实输入时禁用发送，同原任务的待核实继续不会另建请求键。

## 主要流程

日常应用启动时执行一次登录 shell，取得 node 与环境，在采用这份环境后显式解析 Code 的数据、agent、控制目录。`ensureBackend` 先探测已有后台；需要启动时用登录环境中的 node 执行构建时记录的仓库 bin。Code 后台脱离运行，关闭应用不停止它。

受管开发前端使用启动器清洗后的环境，从开发控制目录读取 owner.token，不执行登录 shell，也不调用 ensureBackend；后台重载后由 ControlConnection 自动重连。桌面源码由 electron-vite 监听，渲染进程热更新，主进程重建后重启 Electron，preload 重建后重载渲染进程。启动器负责整组进程退出。

Personal 只支持 SSH 登录账户与后台账户相同的部署。每次控制面建连前，经独立 SSH 检查控制目录、socket 与原 `owner.token` 的访问权限并读取令牌；远端登录 shell 需支持 POSIX `test`、`||` 与 `;`。令牌轮换并重启后台后，控制面重连会读取新令牌。预检只核实可访问性，不能识别所有不同账户部署。

两条 SSH 命令均设 `BatchMode=yes`、`ControlMaster=no`、`ControlPath=none`、`ControlPersist=no`、`ForkAfterAuthentication=no`、`RemoteCommand=none`、`ConnectTimeout=10`；读取另设 `ClearAllForwardings=yes`、`RequestTTY=no`，转发设 `ExitOnForwardFailure=yes`、`StreamLocalBindUnlink=yes`、`ServerAliveInterval=15`。主机前加 `--`，远端预检路径经 shell 单引号转义。SSH 主机、密钥与 ProxyJump 等仍沿用 ssh_config。仅控制面完成认证和快照安装才报告 online。

左栏按工作区组织归属列出普通开发会话，摘要按 `workspace_id` 查询，排除角色与 SubAgent 会话。添加工作区先打开系统文件夹选择框，再带新请求键调用 `open_workspace`；新建会话同样带键调用 `create_session`，成功后打开原会话。成功之后再次添加同一目录会在已有工作区下新建会话。

对话恢复先读历史页，再按历史窗口查询任务、安装带 seq 的任务详情和从零起分页补读任务事件；长正文按连续 UTF-8 字节偏移补全。每次新快照都更换异步代次并清空流游标，旧代次结果丢弃；向前翻页保留已加载条目。正文用 react-markdown 与 remark-gfm 渲染并关闭原始 HTML；正文与思考中的图片仅显示说明，防止 file 页面通过相对路径加载本机图片。思考按共享投影计时，连续工具活动按折叠组显示。关闭标签只改变界面，不删除会话。

右栏按父会话显示工作委托和全部 SubAgent，工作详情经 `work_get` 读取任务。选择子会话后复用同一对话组件与恢复流程，实时补读和新快照恢复同样覆盖子会话。委派、任务与关闭事件触发工作查询，旧查询不能盖过新查询。点击 edit／write 工具切到差异页，以该工具所属会话读取结果；成功 edit 按行显示 unified patch 的增删与上下文，成功 write 显示写入内容，空文件单独标明。超过 64 KiB 的结果标记截断，不提供 Accept／Reject 或语法高亮。

输入框发送时携带会话模型，继续输入保留原任务来源；暂停期间新任务显示为排队。模型目录按 `nextOffset` 分页并保留思考档位与可用性，认证不可用的选项禁用。模型与默认模式设置均带版本；默认模式只影响后续任务。中断与取消作用于所选任务，继续只从当前会话的中断任务发起，原操作效果未知时先提示核实。恢复队列前检查缺模型的旧任务，先选模型，再确认补齐数量与模型；取消确认保持暂停，没有缺模型任务时只传会话。

审批卡片以 view 的当前待审批集合为准，任务终态、权限版本变化、人工或自动审查解决后立即失效。卡片展示操作范围、目标、审查状态与转人工原因；完整参数按返回的 UTF-8 字节偏移续读，不完整或失败可见，读完之后才开放批准与拒绝。操作绑定原目标、实例、审批和展示的权限版本。

主进程为两个目标分别维护 view。后台新待审批及完成、失败、中断任务发系统通知，前台只更新已见基线；取消不通知。Dock 角标始终为两个目标当前待审批数之和。通知点击聚焦窗口，经目标订阅定位会话；SubAgent 通知定位父会话并保留子会话与任务选择，Code 同时打开右栏子会话历史。

首次观察实例的快照及其截止 seq 以内的补发只建基线，握手缓冲的更新实时事件照常通知。同实例重连按审批和终态任务 ID 去重补通知；没有补发时，用 `get_task` 查询此前观察中、现已离开快照的任务。失败保留待查，下次快照再查。应用不持久化通知基线，也不扫描全部历史：离线期间新建又结束、既无补发又超出快照范围的任务不补通知。

## 不变量与失败处理

窗口启用 sandbox、contextIsolation，关闭 nodeIntegration。sandbox preload 构建为单个 CommonJS 文件；主进程与 preload 除 Electron、Node 内置模块外的依赖全部打包。生产 HTML 的 head 首个元素是严格 CSP meta；开发页面只使用带本次 nonce 的响应头策略，放行 dev server 的 HTTP 与 WebSocket 源，不开放 unsafe-inline。开发页面仅允许对配置的完整文档 URL 自身重载；其他导航被拦截，只有 HTTP(S) 链接交给系统浏览器。

版本不一致显示双方版本与更新方向：客户端较旧时重建应用；受管后台较旧时重启开发启动器；日常后台较旧时按当前 control.sock 的 lsof 指引核对唯一 PID、用户和完整后台命令，由拥有者手动结束后重新连接。未查到监听进程时先核对命令是否成功，多匹配或无法核实时停止操作。桌面客户端不向后台进程发送信号。仓库移动或 node 不可用会提示修复环境或重建。

Personal 预检总期限为 15 秒；超时或网络失败、远端 socket 暂不存在由控制面退避重连。目录、socket 权限、令牌读取、认证、主机密钥及未知 SSH 失败进入 failed；SSH 外部 stderr 只在程序边界归类。转发绑定／配置失败单独报 `forward_setup_failed`，提示修复 LocalForward 或另设无转发的别名；其他非主动转发退出由监督者以 500 ms 至 8 s 退避重启。终止失败只接受显式重新连接。

关闭、改配置与终止失败都会取消计时器和控制面连接，对本目标读取与转发进程发 SIGTERM，2 秒后仍未退出则发 SIGKILL；等待退出后再移除本地 socket，旧代次结果不能改变状态。应用退出等待回收；用户已有的 SSH master 不受影响。

创建明确拒绝时清除待完成记录并提示失败；在线应答丢失先按 `createRequestId` 核实，找不到才按原键原参数重发一次。断线或未发送等新快照安装后再核实。一次重发仍无法确认时保留记录，提示在左栏工作区树查看；迟到的创建事件也可确认结果。实例不符时保留“原操作结果仍未知”，要求连回原实例，不向当前实例重发，也不采纳旧实例的迟到成功。读取失败显示原因，正文分页不连续时不安装伪完整内容。

差异先按工具状态判定：运行中不读取，成功但没有历史条目 ID 时等待落盘；失败与效果未知保留状态，有 ID 才读错误正文，否则显示摘要或明确状态。只有 `done` 且结果明确 `isError: false` 才显示 patch／写入内容，字段缺失显示“差异不可用”，不拿调用参数补位。工作详情与工具结果随每次快照换代，跨实例清空右栏选择；读取失败提供刷新或重试。

提交丢答时保留原记录：在线超时当场核实，每次快照安装后串行核实全部记录，覆盖重启、重连和同连接重同步；运行中的触发合并为补跑。找到原任务就关联，明确未接收才原键原参数重发，实例不符保留并提示连回原实例。未发送或明确拒绝时把原文恢复到所属会话，保留已有草稿。

缺模型且确认未接收的记录提供“恢复输入”和“暂不处理”。恢复先只读原记录、按请求键合入草稿，再确认严格清除；同一渲染进程重复确认不重复拼接，继续来源保留。读取／删除的权限与 IO 失败可见且保持发送禁用；清理应答丢失可以重试。只有当前目标、当前实例、最近核实为缺模型的现存记录可恢复；清理已不存在记录幂等成功。

设置冲突或在线丢答读回 `get_session`；任务控制在线丢答读回 `get_task`，队列恢复丢答读回实际队列。断线等待同实例新快照，查询失败保留结果未知；这些操作都不自动重放。设置应答不覆盖较新的队列事件。

审批决定从不自动重发。明确失效移除卡片；权限版本不符重读详情并等待重新决定；未发送保留卡片。在线应答丢失查询原审批，断线等待同实例快照，查询失败或过旧保留“结果未知”并提供“刷新审批状态”。新快照淘汰旧详情与核实结果；换实例丢弃原操作结果。系统通知送达仍受 macOS 通知设置约束。

## 设计依据

- [桌面客户端提案](../../.agents/notes/proposed/architecture/2026-10-15-desktop-client.md)
- [同仓 workspaces 分包](../../.agents/notes/implemented/architecture/2026-10-11-in-repo-workspace-packages.md)
- [开发启动器](../../.agents/notes/implemented/process/2026-10-09-dev-launchers.md)
