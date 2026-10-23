# 桌面客户端

## 职责与边界

Personal 聊天 SSH 连接识别旧控制协议；新 durable 设置使用独立管理连接，不转换聊天快照。新个人聊天使用 IM 与引导式 CLI，Code 桌面能力保持。

`apps/desktop` 是 macOS 上的控制面客户端，与 TUI 共用后台。Code 目标提供工作区与会话树、添加工作区、新建会话、会话标签页、对话流、输入提交、模型／Effort 与会话默认模式选择、停止与继续、暂停队列恢复，以及右栏独立标签中的 SubAgent 历史与单次工具差异、隔离浏览器、工作区只读文件树／预览、Git graph与本机集成终端；Code 在会话内展示审批与拥有者问题卡片，两个目标共用系统通知与 Dock 角标；Personal 提供旧控制协议下的 Ruukoto 单一主会话及审批，两个后台连接并存。后台事实只经控制面取得，不通过数据库、JSONL、工作区文件或 git 重建；主进程为终端核实已登记工作区根目录，并读取拥有者选择的附件快照，以及地址栏明确打开的本机文档与同目录静态资源。

## 对外接口

Electron 或 MyGo 共用的 Node DesktopHost 持有令牌、`ControlConnection`、SSH 子进程和后台拉起。preload 只向渲染进程暴露 `subscribe(target, listener)`、`request(target, op, params)`、`pickFolder()`、`pickSkillFolder(target, instanceId)`、`pickAttachments(sessionId, target?)` 与 `reveal(path)`及终端的open/input/resize/kill四方法。主进程校验 IPC 来源和操作名单：本地 `reconnect`、`desktop_browser_open`／`desktop_browser_release`及仅向Code开放的`desktop_terminal_open/input/resize/kill`，以及后台的 `list_session_summaries`、`open_workspace`、`create_session`、`read_history`、`read_history_entry`、`list_tasks`、`get_task`、`read_task_events`、`work_list`、`work_get`、`read_tool_result`、`read_artifact`、`get_tool_op_params`、`list_models`、`set_session_model`、`set_session_mode`、`get_session`、`interrupt`、`cancel`、`resume_queue`、`get_confirmation_params`、`respond_confirmation`、`list_prompt_requests`、`get_context_breakdown`、`list_workspace_files`、`read_workspace_file`、`read_workspace_git`。`search_history`、`background_processes`、`background_process_output`、`background_process_stop`、`session_background_end` 及 `owner_questions`、`owner_question_answer`、`owner_question_cancel` 与 `owner_question_receipt` 仅向 Code 开放；`submit`、`continue` 与 `owner_question_answer` 交主进程的 SubmissionGuard，`find_task` 仅供守护内部使用；本地 `desktop_pending_read` 与 `desktop_pending_clear` 处理输入恢复。Personal 开放历史、任务、工具、委派、模型、Context、审批、输入与恢复操作及本地 `desktop_personal_config_read`／`desktop_personal_config_save`，拒绝工作区创建、文件、Git 与 Plan。Code 另开放 `get_model_config`、`save_model_catalog`、`set_model_api_key`、`remove_model_api_key`、`remove_model_provider`、`set_default_model`、`set_summary_model` 与 `test_model_connection`，Personal 不放行这些操作。字段与权限继续由控制面校验。错误作为 `{ code, outcome, message, versions? }` 响应数据跨 IPC 传递，保留应答丢失分类。

渲染进程使用 React、Tailwind v4、shadcn 源码组件与 AI Elements、Lucide，主题和三栏布局以定稿 demo 为准，消费 `@ruukoto/view` 的快照和事件投影。开发与构建命令见[开发说明](../development.md#桌面客户端)，启动与故障恢复见[操作手册](../usage.md#桌面客户端)。

MyGo 试验外壳使用 Go 与 WKWebView，预加载实现同一 DesktopBridge，Node 子进程复用 DesktopHost；双方通过私有 JSONL 管道交换原始 JSON，单帧上限 16 MiB。Go 负责选择器、Finder、系统通知和角标；附件选择前固定目标、控制器、连接对象与实例，路径只在宿主之间传递。构建记录 Node 绝对路径，使用独立应用数据目录；操作与构建见[桌面开发](../desktop-development.md#mygo-试验)。

Code MCP 另开放 `mcp_sources`、`mcp_list/configure/set_enabled/remove/check`、`list_credentials` 与 `mcp_save_credential/remove_credential`；通用凭据写入不向桌面开放，Personal 不放行这些操作。

Code Skills 开放 `skills_list`、`skill_get`、`skill_set_enabled` 与 `skill_remove`；本地导入经系统目录选择和后台预览后，仅用宿主选择引用调用 `desktop_skill_import`。宿主固定原 Code 连接、实例、路径与修订，拒绝 renderer 任意路径及旧选择；两壳共用同一检查，Personal 不放行。

Personal 设置管理沿同一 `request` 桥开放 `desktop_personal_management_config_read/save/detect` 与 `desktop_personal_settings_read/request/apply/restore/finish`，分别读取本机连接、检测新协议、查询原档案、显式单项停存启、恢复原服务及结束人工核实。Host 校验目标和操作，不增加 preload 原语；Personal 模型、Skills、MCP 页面通过这些接口提交版本化请求。

## 数据与状态

连接目标由产品身份、socket 和令牌来源组成，Code 固定为 `ruukoto-code`，Personal 固定为 `ruukoto`；安装快照前核对产品，不符以 `product_mismatch` 停在 failed。连接状态沿用 control 的 connecting、online、reconnecting、failed 与 closed；版本被明确拒绝后停在 failed，仅由拥有者重新连接。令牌只在 Node 宿主内存；本模块保存连接配置和待核实提交，不保存令牌或后台历史副本。日常后台仍使用自己的档案与日志。

Personal 配置保存在应用数据目录的 `personal.json`，只含 `host` 与 `controlDir`（默认 `/var/lib/ruukoto/control`）。主机别名只允许字母、数字、点、下划线与连字符，首位须为字母或数字；远端绝对路径只允许字母、数字、点、下划线、连字符与斜杠。保存与加载均校验最终 socket 路径的字节长度，本地 macOS 上限 103，远端 Linux 上限 107。转发 socket 位于应用数据目录的 `ssh/personal.sock`，`ssh` 目录权限 0700。

新管理连接单独存为 `personal-settings.json`，保存 SSH 别名、规范档案路径、受支持程序位置与生命周期，不保存令牌。`ssh/settings.sock` 转发原 `control.sock`，在线请求每次读取原 `control.token`；机器 JSON 经 stdin，128 KiB 请求、256 KiB 响应、有界超时。`pending/personal-settings/` 的版本化维护记录只含原身份、修订、请求摘要和阶段；未决时禁止改掉原连接，重开只核实原操作。

会话标签页和待完成创建记录仅保存在渲染进程内存。创建记录持有原请求键、参数、连接目标和数据实例，结果核实前阻止另起创建；安装新快照不会丢弃它。同实例快照保留标签页，换实例清空旧标签与会话视图。普通草稿、附件引用、主题、侧栏宽度与折叠状态仅在渲染进程内存中保存；草稿按实例和会话隔离，退出或重载后丢失。提交中的原文、附件引用与继续来源留在输入区并锁定，权威接收后才清空；未确认原文继续保存在主进程记录里。

提交与继续的完整参数、原请求键和数据实例标识先保存在应用数据目录的 `pending/code/<控制目录摘要>`，Personal 使用 `pending/personal/<主机及控制目录摘要>`，再发送；目录按目标与配置隔离。待核实状态按请求键更新，原始记录与损坏记录留在主进程；额外恢复诊断界面暂不开放。同会话有待核实输入时禁用发送，同原任务的待核实继续不会另建请求键。

本机终端及xterm滚动历史只在本次应用内存中保留，最多同时8个，滚动历史5000行；关闭终端标签或所属会话、换数据实例、页面重载／崩溃与应用退出均回收，普通断线、同实例快照和切换标签／会话／Personal保留。终端用与全局一致的等宽字体栈，明暗主题各带完整ANSI 16色；样式依赖生产CSP对内联样式的放行。

## 主要流程

应用内 ⌘K 切换当前 Code 实例的 Spotlight 开关，顶栏侧栏开关左侧的搜索图标也可打开；弹窗从上向下进入，在 PA 页面也只搜 Code 工作区。完整普通会话摘要用于即时名称匹配，正文在输入稳定 180ms 且组合输入结束后查询；每个控制器最多一页在途，空命中进度页继续推进，满 20 条后滚动接近列表底部自动续查。候选与结果只在内存中保存，关闭、断线、新快照和换实例淘汰旧轮次；名称结果保留工作区与存档标记；正文结果上行显示会话名和存档标记，下行显示单行正文预览，短消息完整保留，超宽时按实际像素宽度让匹配词尽量居中，右侧显示相对时间；匹配词高亮，搜索弹窗使用主题灰色背景；长名称在末尾省略，正文预览保持单行，超出显示范围的部分裁切；加载使用搜索框内图标，检索状态仅向读屏播报，实际读取失败与离线可见，两种结果之间用分隔线区分，滚动条只在滚动中及停止后短暂显示，不再提供加载按钮。

Code 的会话菜单提供后台清单、日志与“结束本会话后台”，存档也在同一菜单。清单每页最多20项，并受256 KiB响应预算约束，选择命令读取 stdout/stderr 的原字节页、完整性及可切换的base64；单个停止只显示请求已接纳，退出码与停止核实分别展示。结束动作经确认后由主进程保存原请求键与实例，应答未知时查询状态并保留原键，显式重核沿原键重试；关闭面板、标签、窗口、断线与存档均不触发停止。

Node 宿主创建时开始准备环境，与窗口加载并行。日常应用执行一次登录 shell，取得 node 与环境；首次连接复用结果，采用后显式解析 Code 的数据、agent、控制目录。预热失败由连接报告，重新连接可重试；退出取消并回收直接读取进程，迟到结果不再采用。`ensureBackend` 先经认证 ping 轻量探测已有后台，正式连接再安装一次完整快照；需要启动时用登录环境中的 node 执行构建时记录的仓库 bin。Code 后台脱离运行，关闭应用不停止它。

首次本地 Code 建连显示全屏毛玻璃加载页，旋转环与连接提示整体居中；connecting 或 online 尚无实例快照时保持。就绪、明确失败、关闭或进入首次退避重试时淡出，退出完成前底层与快捷键不可操作。失败后沿原界面恢复连接或配置 PA；之后普通重连不再显示全屏遮罩。减少动态效果时直接退出，正式端没有模拟展示延时。

受管开发前端使用启动器清洗后的环境，从开发控制目录读取 owner.token，不执行登录 shell，也不调用 ensureBackend；后台重载后由 ControlConnection 自动重连。桌面源码由 electron-vite 监听，渲染进程热更新，主进程重建后重启 Electron，preload 重建后重载渲染进程。启动器负责整组进程退出。

Personal 只支持 SSH 登录账户与后台账户相同的部署。每次控制面建连前，经独立 SSH 检查控制目录、socket 与原 `owner.token` 的访问权限并读取令牌；远端登录 shell 需支持 POSIX `test`、`||` 与 `;`。令牌轮换并重启后台后，控制面重连会读取新令牌。预检只核实可访问性，不能识别所有不同账户部署。

两条 SSH 命令均设 `BatchMode=yes`、`ControlMaster=no`、`ControlPath=none`、`ControlPersist=no`、`ForkAfterAuthentication=no`、`RemoteCommand=none`、`ConnectTimeout=10`；读取另设 `ClearAllForwardings=yes`、`RequestTTY=no`，转发设 `ExitOnForwardFailure=yes`、`StreamLocalBindUnlink=yes`、`ServerAliveInterval=15`。主机前加 `--`，远端预检路径经 shell 单引号转义。SSH 主机、密钥与 ProxyJump 等仍沿用 ssh_config。仅控制面完成认证和快照安装才报告 online。

左右侧栏支持收起、展开和拖动调宽，方向键可调节边界；左栏收起后保留两个图标宽的轨道，只留 Ruukoto 与设置两个图标，其余内容不渲染也不可聚焦，右栏关闭内容不可聚焦，减少动态效果时关闭过渡。左下设置打开左分类、右内容浮窗，包含外观、模型、Skills、MCP、PA 远程连接、已存档会话。外观切换明暗主题，PA 远程连接分为新设置管理与旧聊天连接，远端离线也可编辑本机连接；Code 模型页可管理实例级提供方、模型、凭据和默认值；Code MCP 页按工作区及原来源管理服务与凭据；Code Skills 与 Personal 模型、Skills、MCP 均已接入各自真实配置；工作区上方 Ruukoto 切换到唯一 Personal 主会话，不新开顶部标签，身份由快照 mainSessionId 提供；选中时图标周围显示圆角方块底色。名称筛选只过滤已加载的工作区与会话，不查询全文历史。

左栏按工作区组织归属列出普通开发会话，摘要按 `workspace_id` 查询，排除角色与 SubAgent 会话与已存档会话；会话行悬停时行内右端浮现存档键（叠在会话按钮内，按钮固定预留键位，短名不渐隐、长名尾部渐隐收尾，状态点在键左侧），存档后从列表与顶部标签移除，历史与任务保持不变，可在设置的「已存档会话」中取消存档。Ruukoto 下方的 New chat 打开不含会话的新对话草稿页：输入区与既有会话页一致，带附件、模式与模型选择（未选时继承当前会话或后台默认值），工作区选择器位于输入框之外，菜单顶部按名称搜索、底部可直接新建工作区，未选中时不能开始对话；发出首条消息时才按所选工作区与草稿设置创建会话、补传附件并提交，创建在途或失败时草稿保留原文、不发送，切换会话即收起草稿页。添加工作区先打开系统文件夹选择框，再带新请求键调用 `open_workspace`；新建会话同样带键调用 `create_session`，成功后打开原会话；请求在途时只有发起该请求的工作区行把加号换成加载图标，其余新建入口保持禁用。成功之后再次添加同一目录会在已有工作区下新建会话。新会话在首次点击时继承当前或最近 Code 会话的模式、模型与 Effort，跨工作区同样适用；关闭最后标签仍保留本次连接来源，换实例清除。设置保存中或结果未知先核实，不建立旧设置的新会话。初始选择随原创建键固定，和 session.created 同事务保存；重放不覆盖后来设置。

Code 模型设置在总览直接选择默认模型／Effort 与摘要模型并自动保存；提供方在完整弹窗内添加或编辑连接、存储 Key、模型能力与高级字段，API 类型使用选择框，保留脱敏占位符。弹窗叉号放弃草稿并退出，已提交操作仍可核实；删除按钮位于左下角，保存位于右下角。目录与存储 Key 同时修改时先保存目录并读回，再按新修订保存 Key，后一步失败明确报告部分成功。列表只读配置位置与已注册成员、真实 Effort，不解析动态凭据或验证认证；存储条目、目录 apiKey 和具体请求头分别操作，环境由后台启动环境维护。OAuth 条目的替换／移除不会撤销远端令牌。后台默认模型与会话模型分开，摘要模型可清除；显式启动参数覆盖会提示。所有写入携带读取修订，冲突保留草稿并读回当前值，应答丢失只核实原实例，不自动重发；秘密提交后清空。点击连接测试直接联网；模型名旁以黄／绿／红点表示未测试、成功／失败，失败详情放在圆点提示中，配置变化后旧结果失效。目录事件淘汰会话和新聊天菜单的旧分页并刷新运行时默认值，不改已有任务选择。

Code Skills 列表按名称检索已取得项，显示托管／外部维护、启停、仅显式调用及诊断；正文有界且跳过 HTML，图片只显示文字。外部来源只读；托管单包导入复制到 Code 私有区，源库不变。启停和逻辑移除只影响后续新任务选择，旧任务正文、原恢复引用与包字节保留；操作前展示影响。冲突保留列表、选择和预览供刷新比较；丢答按原技能身份读回，不再次复制，查询失败保持待核实。

设置无需打开会话。模型、Skills、MCP 各自通过 Code / PA 双页签选择本地 Code 或远程 Personal，打开时默认聊天目标，此后不切换聊天；Code MCP 另选工作区和原配置来源，普通会话提供工作区及原项目初值，无会话默认首个工作区自身来源，没有工作区时引导添加。配置来源候选须由后台按实例和工作区提供，界面按名称选择并显示写入归属；后台分页列出工作区自身及旧会话的原项目和服务数量，不推断唯一来源。设置容器内未保存的模型、MCP、Skills 导入与 PA 连接编辑在切类别、关闭及收起侧栏前提供保存、放弃或继续编辑；提供方弹窗叉号直接放弃草稿，保存中禁止重复动作；浮窗与两侧内容在窄窗内滚动。

对话恢复先取历史页与历史窗口内的任务状态，任务状态先装入再公开历史页，随后安装带 seq 的任务详情并从零起分页补读任务事件；恢复期间的重绘合并为一次，打开会话时已收起的 trace 从首次可见起保持收起。长正文按连续 UTF-8 字节偏移补全，历史页里已有条目的补全不阻止自动收起。每条工具结果落盘后即补发条目引用，同批后续工具仍运行时，已展开详情也能自动读取。每次新快照都更换异步代次并清空流游标，旧代次结果丢弃；向前翻页保留已加载条目。正文用 react-markdown 与 remark-gfm 渲染并关闭原始 HTML；正文中的图片仅显示说明，防止 file 页面通过相对路径加载本机图片。历史在滚动到顶部时补读并保留锚点，工具与 SubAgent 按时间顺序逐条显示，单条调用保留各自的详情展开。已记录 reasoning 使用 Thought 行，Thinking 下直接显示当前原文，两处均限6行视觉高度并可内部滚动（Driver 只记录8KiB尾部）；在线 running 的请求前、参数生成及工具轮间显示 Thinking，最新同任务非空正文流接替状态，工具执行时直接显示本批次已完成／进行中调用，不显示 Working 标题；任务完成且最终 assistant 正文已确认后，动画收起此前连续的执行记录及中间进度正文，摘要显示 Worked for 与实际任务耗时（缺时间显示 Worked），可重新展开，最终回复、用户输入和审批卡保持可见，不跨排队输入重排记录；等待审批、取消、暂停及终态不留旋转状态，TUI 操作说明与工作流提示不显示。标签关闭键仅 hover／焦点时覆盖显示并渐隐邻近文本；拖动结束及取消后暂停旧位置hover，隐藏关闭键并停止其鼠标命中，待本组指针移动后恢复，键盘焦点提示保留。选中标签两侧不显示分隔，左右标签区以短竖线隔开，右栏正文与顶部标签之间没有横向分割线；关闭标签不删除会话。两组标签独立等宽，按空间在96至180px调整；拖动邻项避让，放下提交顺序，取消恢复，Alt+Shift+左右方向键也可排序。整个窗口提供单层半透明模糊，左栏、顶部与消息区圆角露出同一底层，减少透明效果回退实色。筛选与工作区／工具折叠有开合动画，关闭内容不接收焦点，遵守减弱动画；手写行按钮的 hover、悬停显露的关闭与添加键、展开箭头旋转和提示条出现也有短过渡。

右栏标签位于窗口顶栏，与侧栏共用宽度，按父会话保存文件差异、SubAgent、浏览器、文件树和文件预览。新增标签页列出浏览器和文件树，不列工具差异、SubAgent清单或Git检测中的提示，检测失败仍可重试；真实 Git 仓库增加 Git graph，非仓库不显示，检测失败可重试。Personal 新标签页只留浏览器，仍可从委派行打开SubAgent，动作入口也拒绝文件与差异。委派行按结构化 sub_agent_id、work_id 或 requestKey 关联工作与子会话，不解析工具返回文字。委派行显示 Agent 的真实身份状态；子会话用户气泡优先展示任务详情中可核实的原始委派请求，缺失时保留原文。选择子会话后复用对话恢复，实时补读和新快照同样覆盖子会话；工作详情和取消入口暂不展示。已加载的主／子消息每次渲染只读取一次有序流，Markdown按正文与路径引用缓存，保留真实行布局以减少快速滚动时的延迟绘制。工具调用直接平铺，等待结果沿用对应工具进行中动作，Read 不折叠，路径按来源会话 cwdReal 映射已登记工作区打开文件；域外成功 Read 的唯一捕获产物可直接预览当时版本，仅在部分捕获时显示紧凑提示，校验任务／会话／产物身份，不读取任意绝对路径；缺失、多义或完整参数不可用时明确提示。Edit／Write 行内展开已记录 diff，Bash 展开完整命令与结果；截断参数核实操作及来源后分页补齐，错误标红并显示原始错误，未知效果不显示成功。缺失与空 diff 分开，旧 Write 没有记录 diff 时明确提示。对应正文中的文件路径仍打开单次调用差异，同文件多次修改保留独立标签。成功 edit 显示 unified patch 的行号、增删与上下文，write 显示实际写入内容，空文件沿用零行内容区。差异直接平铺，横向滚动时行号与标记固定；超过单页的正文经 more 按 UTF-8 偏移加载，失败保留已读内容。

输入框 Enter 发送、Shift+Enter 换行，IME 组合与重复按键不发送；空输入 Enter 不停止任务，附件输入沿相同资格检查。发送时携带会话模型，继续输入保留原任务来源；暂停期间新任务显示为排队。模型目录按 `nextOffset` 分页并保留思考档位与可用性，认证不可用的选项禁用。Effort 位于模型菜单内，只展示实际 thinkingLevels；切换模型保留支持的档位，否则采用该模型首个支持档位。输入区功能键始终单排，较窄时模式只留对应图标、模型只留 Brain 图标。模型与默认模式设置均带版本；默认模式只影响后续任务。运行且草稿为空时，发送按钮变为停止图标；有输入时仍可排队。中断请求受理不当作终态，只有后台确认 interrupted 才展示继续来源；继续只从当前会话的中断任务发起。独立取消列表和效果未知提示卡不展示。恢复队列前检查缺模型的旧任务，先选模型，再确认补齐数量与模型；取消确认保持暂停，没有缺模型任务时只传会话。

Context 环形入口不显示百分比数字，悬浮层按 System prompt、Tool definitions 和 Messages 展示最近一次已记录模型输入的估算与当时容量；Messages 包含除前两类外的所有已选输入。没有记录、容量或读取失败时保持未知，不用 provider usage 或当前目录代替；实时输出与终态刷新，在途刷新合并后补读，新快照和断线淘汰旧请求。

流式思考保持 6 行可见高度，随新增文本滚动内部内容到末尾；历史思考可手动滚动。完整思考由有界增量重组，取消总量截断。

文件树只读当前会话组织归属的已登记工作区，逐层读取，目录最多显示 200 项并明确提示截断。文件预览按页读取全部内容，支持文本、Markdown、PNG／JPEG／GIF／WebP，其他类型明确不支持；跨页修订、来源或大小变化丢弃整次结果；Markdown 可切源码，源码按已支持扩展名高亮并保留完整原文、固定行号，未知类型纯文本，图片失败可见。后台按登记根身份、保护根和全路径拒绝符号链接、硬链接及不稳定读取，renderer 不获得任意宿主路径读取权。断线和快照淘汰旧读取；文件预览关闭重开及读取重试同样丢弃旧应答，目录缓存按工作区保留，活动文件树每3秒和窗口聚焦刷新根与已展开层；关闭或离线停止，旧树保留至新响应，错误可重试，删除同时失效对应文件缓存。域外 Read 快照最多显示256KiB，partial和截断明确提示；零字节旧记录可能没有捕获。目录列表的保护核实在读取前后分别批量比对根与目标，每阶段只遍历保护目录，跳过普通文件元数据；枚举期间目录身份或纳秒修改／状态时间变化时拒绝读取。文件预览继续逐对象核实保护关系。

浏览器初始为空页，地址接受无凭据 HTTP(S) 与本机file，提供后退、前进与刷新；历史记录只覆盖地址栏提交。本机文档由Host分配临时loopback地址与随机令牌，保留原始file地址；可读取同目录／子目录相对资源，拒绝越界、链接、`.env*`、`.git-credentials`等敏感元数据及userData。每文件8MiB、每文档累计32MiB／256次请求，至多8份文档和16个并发读取；地址栏导航、刷新、关闭与Host退出释放能力，iframe内部导航不记历史或保证即时释放。模块与fetch支持无凭据CORS，本地HTML可用CDN和联网，其脚本可能转交同目录能力，不能把此功能当作不可信JS防泄密执行器。网页使用无 same-origin、顶层导航、弹窗或下载权限的 iframe，不加载桌面开发来源；远程 frame 无 preload／IPC／Node，所有网页权限、设备与屏幕捕获均拒绝。站点禁止嵌入时不能预览，界面不显示固定嵌入提示。普通Web Demo没有任意本机读取能力。

右栏新标签页的终端入口是与文件树同形的按钮，点击为当前会话归属的工作区开新终端，无归属工作区或未登记根目录时禁用；宿主按预期数据实例与工作区根真实身份选择cwd，启动默认登录shell；不调用后台，也不受Agent任务沙箱限制。输入、resize和base64输出按终端引用分流，output直接写xterm，不重绘React；隐藏终端常驻，重新显示后更新尺寸，明暗跟随应用并各自提供完整16色，字体使用具体等宽字体栈（与全局--font-mono同值；canvas字体语法不解析var()，CSS变量会静默回退比例字体并压错行高），Ctrl组合交给shell。

文件树首读用加载图标；文件夹读取时在行末显示图标，完成或失败后展开，失败可重试，空目录留空。读取中再次点击取消展开；缓存命中直接展开，刷新保留现有内容。左栏折叠与展开共用一个按钮，位置连续过渡，保持焦点并避开原生交通灯。

Git graph 每页读取200条真实提交，滚动接近底部自动追加直到末尾，没有累计条数上限；只渲染可视区附近的行与图线，窗口外行以占位撑高，横向内容宽度保存本次打开见过的最宽行，滚到短行窗口后仍可左右滚动并触发续页；Tab、读屏、文本选择与浏览器 Find 只覆盖窗口内已渲染行（窗口外焦点行旁路渲染时除外）。提交主题与分支名保持自然宽度，可左右滚动，续页无可见加载文字；隐藏、离线、加载中或发生错误时暂停，追加失败显示重试。父关系、branch／tag与remote共用六种彩色lane，28px摘要只给左侧图标着色，名称保持中性。点击展开作者、时间、短哈希与父提交，可刷新。翻页绑定工作区与仓库修订，refs、HEAD、shallow、grafts或目录身份变化时要求刷新；追加失败保留已有历史并可重试，刷新或换实例丢弃旧追加。每次后台读取预算5秒，限制输出和元数据数量，拒绝受保护目录、元数据链接、alternates和配置include；超限或不安全形式明确报错。

附件加号打开系统文件选择器，每次最多 4 个、每个不超过 8 MiB；文件按原目标、连接对象与实例上传，renderer 只收到引用、名称与大小。选取与上传期间禁止发送，成功后附件与草稿一起提交；移除附件不删除后台快照，普通文件与图片的读取方式见 [runtime](runtime.md)。

拥有者问题卡片由 view 的快照和事件恢复，顶部只显示当前问题，选项纵向整行展示，名字后显示可选说明和 Recommended 标记，全文允许换行；单选保留编号，多选以复选框替代编号，不显示多选标签；推荐不预选。12像素的自由输入图标与输入行位于选项下方，输入文字清除所有选择，选择不重复填入输入行。底部保留题号、翻页、Skip 和下一步；Skip 清空当前答案并前进，末题进入整批核对，核对与终态显示已跳过但保存空字符串。顶部没有进度、折叠或取消入口。选项不自动补齐；已回答、取消和失效显示简短状态，原回答和题目继续可读。快照省略的题目在选择会话与快照恢复时经控制面查询待答优先的最近一页，保留全文；查询代次隔离会话与实例，并保留较新的事件状态。取消整批问题不产生回答或后续任务；关闭标签、普通聊天和断线保留待答问题。回答与取消由主进程发送前落盘原键、完整参数与实例，丢答和重连按原回执恢复；未决问题记录不并入普通聊天草稿。

已回答的问题卡片取代对应回答的用户消息，留在当时的消息位置，底部只保留待答、取消或失效的独立卡片。替换按同会话的续接任务关联，不按正文猜测；原历史和模型输入保留。问题资料尚未加载时先显示原用户消息，资料到达后原位更新。

审批卡片以 view 的当前待审批集合为准，任务终态、权限版本变化、人工或自动审查解决后立即失效。卡片只展示本次实际命令或参数及用途，完整参数自动按 UTF-8 字节偏移续读，读完后直接批准或拒绝；权威成功应答后移除卡片。正文较窄时，标题与按钮组自动换行。操作绑定原目标、实例、审批和展示的权限版本。

主进程为两个目标分别维护 view。后台新待审批及完成、失败、中断任务发系统通知，前台只更新已见基线；取消不通知。Dock 角标始终为两个目标当前待审批数之和。通知点击聚焦窗口，经目标订阅定位会话；SubAgent 通知定位父会话并保留子会话与任务选择，Code 同时打开右栏子会话历史。

首次观察实例的快照及其截止 seq 以内的补发只建基线，握手缓冲的更新实时事件照常通知。同实例重连按审批和终态任务 ID 去重补通知；没有补发时，用 `get_task` 查询此前观察中、现已离开快照的任务。失败保留待查，下次快照再查。应用不持久化通知基线，也不扫描全部历史：离线期间新建又结束、既无补发又超出快照范围的任务不补通知。

消息流以外的文字在原尺寸上增加2px，包括输入框、菜单、设置及右栏文件／Git内容；主与SubAgent消息正文、工具和审批字号保持不变。深色左栏及Tab选中项使用更亮的半透明底色，沿用单一玻璃背景。源码与行号共同保持23.8px行高。

Code MCP 新服务先保存禁用草稿，再主动联网发现工具，逐项选择允许工具与本地副作用类别后保存并显式启用；远端只读注解不自动授权。服务表单始终显示工作区和来源，保存携带读取版本，启停后读回。凭据仅保存到本地 Code 后台，首次落盘即限所选来源与 MCP；省略引用保留，匿名选择清除引用。列表显示配置状态与服务引用，仍被引用的凭据不能清理。冲突保留草稿并展示当前值，丢答仅读回原来源，不自动重发；停用不取消已经发出的远端调用。

双端 MCP 设置可选择「本机 Cua Driver」或「Linux 桌面沙箱」；后台发现已安装固定程序与既有沙箱，生成版本、哈希及目标身份，界面展示检查结果。Code 工具发现只读静态清单并预检当前后台宿主授权位，不宣称实际桌面捕获成功。电脑配置保存与普通服务共用修订检查和未决阻塞。暂停与继续经原后台管理，关闭设置窗不停止后台动作。恢复页展示原未知动作，依次核实停止、人工检查和新截图；图片按原观察分页读取、校验并实际加载后才可接受，重观察、失败或连接更换丢弃旧选择，后台再次核实观察身份。Linux 整沙箱停止须明确确认内存与未保存应用状态丢失，磁盘保留。

Personal 三页每次打开重读原档案，模型编辑单模型、API 类型、容量、图片能力与环境变量引用，显式测试当前草稿且与保存分开；技能库与包均通过远端目录选择和预览，外部来源只读，托管启停与逻辑移除保留旧引用所需字节。MCP 编辑档案级服务、私有凭据文件或显式匿名；原工具允许列表分页读取完整定义，未改工具时由后台保留，不用摘要覆盖 schema。写入先展示影响并确认停存启；忙时返回原入口处理事项，丢答、已保存未启动与待核实保留恢复及人工结束维护动作。

## 不变量与失败处理

新管理连接核实机器版本、产品与档案身份后才读取配置，在线再经认证 HTTP 查询；SSH 成功不表示可写。显式停存启必须实际后台凭据与未决预检通过，固定系统服务身份及精确权限可证实；CLI 环境未知、开发实例与部署缺前提保持只读。连接与维护预检读取一项配置摘要并完整检查未决事项，合法大 MCP 列表不会因默认页过大阻断停止。停止超时保留原进程与锁，保存后启动失败保留已保存事实；托管技能修订冲突报告明确未保存，并保留草稿比较与恢复原服务入口。任一阶段断线均保留原操作关联，查询原修订与服务状态，不重放保存或强杀；原服务启动失败后，原进程已退出、MainPID 为零且档案锁可取才允许显式恢复；拥有者再比较配置并结束维护。改变连接与退出回收自有子进程，旧响应不继续维护。

选择会话名称或正文结果均直接打开对应的普通会话，沿用已有标签、最新消息、历史分页、实时输出与输入区，保留原草稿和附件。正文片段用于辨认会话，不单独进入历史模式或滚动定位原消息。已存档结果可显式打开且不取消存档。

终端参数不接受任意cwd；仅按当前Code实例已登记根的真实路径和inode启动，迟到打开或实例变化拒绝。输出16ms合并／发送节流、单帧最多64KiB，pending达64KiB暂停PTY，MyGo等待管道写完后继续。回收先核实shell及当前后代进程组，TERM后500ms升级KILL，不因shell先退出取消；回收失败保留记录和界面提示，提供重试回收入口；输入与尺寸更新逐终端串行，失败后停止后续发送。主动脱离、已经成为孤儿或回收快照后新派生的外部进程无法保证追回；工作区只限制启动cwd，终端可访问应用账户可访问的其他目录。

MyGo 仅在精确 `mygo://localhost/` 顶层文档安装 bridge，每个 Go 方法另核对调用窗口及文档 URL，原生拒绝子 frame IPC。保留生产 CSP 与 iframe sandbox，拒绝网页权限、下载和全部新窗口，主文档外链交系统浏览器。子 frame 隔离不依赖主文档导航回调。未写入 Node 的请求为 not_sent，交付后丢答保留 unknown／disconnected，禁止自动重放；坏帧、EOF、写入故障或传输期限使全部在途调用失败并报告 failed，旧更新不再安装。退出先等待 Node 回收连接与 SSH，再有界升级终止；日常后台继续运行。

Electron 窗口启用 sandbox、contextIsolation，关闭 nodeIntegration。sandbox preload 构建为单个 CommonJS 文件；preload除Electron与Node内置模块外的依赖全部打包；主进程另精确允许vendor node-pty，包含runtime JS、本平台native与macOS spawn-helper，native/helper从asar解包。生产 HTML 的 head 首个元素是严格 CSP meta，样式额外放行内联，因 xterm 运行时注入无 nonce 的 style 元素承载终端颜色与字体；开发页面只使用带本次 nonce 的响应头策略，放行 dev server 的 HTTP 与 WebSocket 源，脚本不开放 unsafe-inline。开发页面仅允许对配置的完整文档 URL 自身重载；其他导航被拦截，只有主页面 HTTP(S) 链接交给系统浏览器。CSP 仅对 iframe 增加 HTTP(S)、预览图片增加 data 来源；脚本 nonce、主 frame IPC 与主页面导航限制保持。

版本不一致显示双方版本与更新方向：客户端较旧时重建应用；受管后台较旧时重启开发启动器；日常后台较旧时按当前 control.sock 的 lsof 指引核对唯一 PID、用户和完整后台命令，由拥有者手动结束后重新连接。未查到监听进程时先核对命令是否成功，多匹配或无法核实时停止操作。桌面客户端不向后台进程发送信号。仓库移动或 node 不可用会提示修复环境或重建。

Personal 预检总期限为 15 秒；超时或网络失败、远端 socket 暂不存在由控制面退避重连。目录、socket 权限、令牌读取、认证、主机密钥及未知 SSH 失败进入 failed；SSH 外部 stderr 只在程序边界归类。转发绑定／配置失败单独报 `forward_setup_failed`，提示修复 LocalForward 或另设无转发的别名；其他非主动转发退出由监督者以 500 ms 至 8 s 退避重启。终止失败只接受显式重新连接。

关闭、改配置与终止失败都会取消计时器和控制面连接，对本目标读取与转发进程发 SIGTERM，2 秒后仍未退出则发 SIGKILL；等待退出后再移除本地 socket，旧代次结果不能改变状态。应用退出等待回收；用户已有的 SSH master 不受影响。

创建明确拒绝时清除待完成记录并提示失败；在线应答丢失先按 `createRequestId` 核实，找不到才按原键原参数重发一次。断线或未发送等新快照安装后再核实。一次重发仍无法确认时保留记录，提示在左栏工作区树查看；迟到的创建事件也可确认结果。实例不符时保留“原操作结果仍未知”，要求连回原实例，不向当前实例重发，也不采纳旧实例的迟到成功。读取失败沿现有提示呈现原因，正文分页不连续时不安装伪完整内容。

差异先按工具状态判定：运行中不读取，成功但没有历史条目 ID 时等待落盘；失败与效果未知保留状态，有 ID 才读错误正文，否则显示摘要或明确状态。只有 `done` 且结果明确 `isError: false` 才显示 patch／写入内容，字段缺失显示“差异不可用”，不拿调用参数补位。工作读取与工具结果随每次快照换代，跨实例清空右栏选择；读取失败提供刷新或重试。

提交丢答时保留原记录：在线超时当场核实，每次快照安装后串行核实全部记录，覆盖重启、重连和同连接重同步；运行中的触发合并为补跑。找到原任务就关联，明确未接收才原键原参数重发，实例不符保留并提示连回原实例。未发送或明确拒绝时原文仍在所属会话，保留已有草稿；原请求与在途草稿只按请求键关联，不按会话或相同正文猜测。

缺模型且确认未接收的记录在所属会话自动交付为可编辑草稿，不自动发送。交付先只读原记录、按请求键合入原文和附件，再确认严格清除；同一渲染进程重复确认不重复拼接，继续来源保留。读取／删除的权限与 IO 失败可见且保持发送禁用；清理应答丢失可以重试。只有当前目标、当前实例、最近核实为缺模型的现存记录可恢复；清理已不存在记录幂等成功。

设置容器的导航、关闭与 Code 断线和快照淘汰旧读取；Personal 管理页以独立档案身份和读取轮次隔离，不受旧个人聊天状态影响；换实例清除旧 MCP 范围，原提交中的表单保留待核实关联。PA 连接保存区分请求未送出、明确拒绝与应答丢失：前两者保留可编辑草稿，丢答锁定原提交并提供只读核实，不自动重新保存。读回不同值时展示当前配置并保留草稿，查询失败继续待核实；连接配置已保存不等于远端连接成功。

设置冲突或在线丢答读回 `get_session`；任务控制在线丢答读回 `get_task`，队列恢复丢答读回实际队列。断线等待同实例新快照，查询失败保留结果未知；这些操作都不自动重放。设置尚在保存或等待核实时，恢复队列也等待核实，保留原设置未知标记。设置应答不覆盖较新的队列事件。

审批决定从不自动重发。明确失效移除卡片；权限版本不符重读详情并等待重新决定；未发送保留卡片。在线应答丢失查询原审批，断线等待同实例快照，查询失败或过旧保留防重复状态并经现有提示报告；重新连接可再次核实。新快照淘汰旧详情与核实结果；换实例丢弃原操作结果。系统通知送达仍受 macOS 通知设置约束。

## 设计依据

- [Cua 具名配置与人工恢复](../../.agents/notes/implemented/architecture/2026-10-23-cua-official-mcp.md)

- [Personal 三类设置与维护关联](../../.agents/notes/implemented/feature/2026-10-21-desktop-personal-pages.md)

- [Personal SSH 维护](../../.agents/notes/implemented/feature/2026-10-21-personal-settings-ssh.md)：新管理协议、原服务生命周期与断线核实。

- [Code Skills 宿主目录选择与核实](../../.agents/notes/implemented/feature/2026-10-21-desktop-code-skills.md)

- [Code MCP 来源与凭据管理](../../.agents/notes/implemented/feature/2026-10-21-code-mcp-settings.md)

- [Code 模型设置与凭据来源](../../.agents/notes/implemented/feature/2026-10-21-code-model-settings.md)

- [设置容器、范围选择与原表单保护](../../.agents/notes/implemented/feature/2026-10-21-desktop-settings-shell.md)

- [搜索结果直接打开普通会话](../../.agents/notes/implemented/simplification/2026-10-21-desktop-search-session-navigation.md)

- [应用内 Spotlight 与历史定位](../../.agents/notes/implemented/feature/2026-10-21-desktop-spotlight-search.md)

- [Coding 会话后台持有独立目录占用](../../.agents/notes/implemented/feature/2026-10-21-coding-background-processes.md)

- [持久拥有者问题](../../.agents/notes/implemented/feature/2026-10-21-coding-owner-questions.md)：问题与审批分别登记，可信回答唯一续接。

- [本机集成终端](../../.agents/notes/implemented/feature/2026-10-20-desktop-integrated-terminal.md)

- [首次连接加载页](../../.agents/notes/implemented/feature/2026-10-18-desktop-connection-loading.md)

- [完整思考与文件预览](../../.agents/notes/implemented/feature/2026-10-18-complete-reasoning-and-preview.md)

- [Git历史分页](../../.agents/notes/implemented/feature/2026-10-17-desktop-git-history-pages.md)
- [Git历史自动续页](../../.agents/notes/implemented/feature/2026-10-17-desktop-git-lazy-loading.md)
- [Git graph 行窗口化](../../.agents/notes/implemented/feature/2026-10-18-desktop-git-graph-windowing.md)
- [文件树加载反馈](../../.agents/notes/implemented/feature/2026-10-17-desktop-file-tree-loading.md)
- [侧栏折叠按钮](../../.agents/notes/implemented/bug-fix/2026-10-17-desktop-sidebar-toggle.md)
- [收起后的左栏图标轨道](../../.agents/notes/implemented/feature/2026-10-19-desktop-sidebar-rail.md)
- [新建会话在途显示加载图标](../../.agents/notes/implemented/feature/2026-10-20-desktop-creation-spinner.md)
- [新对话在首条消息时创建会话](../../.agents/notes/implemented/feature/2026-10-20-desktop-new-chat.md)
- [会话存档只影响列表可见性](../../.agents/notes/implemented/feature/2026-10-20-desktop-session-archive.md)
- [Tab hover资格](../../.agents/notes/implemented/bug-fix/2026-10-17-desktop-tab-hover.md)
- [非消息字号与选中样式](../../.agents/notes/implemented/feature/2026-10-17-desktop-chrome-typography.md)

- [PA 与仓库标签迁移](../../.agents/notes/implemented/architecture/2026-10-17-desktop-demo-v4.md)

- [启动环境预热与就绪探测](../../.agents/notes/implemented/bug-fix/2026-10-17-desktop-connection-startup.md)

- [MyGo 外壳试验](../../.agents/notes/implemented/architecture/2026-10-17-desktop-mygo-experiment.md)

- [Desktop Trace 详情与执行状态](../../.agents/notes/implemented/architecture/2026-10-16-desktop-trace-migration.md)

- [按当前 demo 更新](../../.agents/notes/implemented/architecture/2026-10-16-desktop-current-demo.md)

- [按定稿 demo 迁移](../../.agents/notes/implemented/architecture/2026-10-15-desktop-shadcn-demo.md)
- [工具结果分页](../../.agents/notes/implemented/feature/2026-10-16-tool-result-pagination.md)
- [桌面客户端提案](../../.agents/notes/proposed/architecture/2026-10-15-desktop-client.md)
- [同仓 workspaces 分包](../../.agents/notes/implemented/architecture/2026-10-11-in-repo-workspace-packages.md)
- [开发启动器](../../.agents/notes/implemented/process/2026-10-09-dev-launchers.md)
- [目录保护优化](../../.agents/notes/implemented/bug-fix/2026-10-17-directory-protection-cost.md)：目录列表合并扫描与分类稳定性。

- [工具平铺与完成后的执行记录](../../.agents/notes/implemented/feature/2026-10-18-completed-trace.md)
- [执行阶段与reasoning批次](../../.agents/notes/implemented/bug-fix/2026-10-17-desktop-execution-activity.md)

- [本机文档预览能力](../../.agents/notes/implemented/feature/2026-10-17-desktop-local-browser.md)
