# 个人持久会话与本机管理

## 职责与边界

`apps/ruukoto/src/personal-*.ts` 提供正式个人 Pi 1.3.0 会话、本机引导管理及模型/宿主后台工作入口。正式 bin、根启动脚本、开发启动器与部署复用同一套[产品装配](products.md)，不装配旧 Runtime/Driver/Task Store 或控制协议；本机向导可在 Linux 配置主/子会话只读服务检查，可信宿主 API 也可显式注入；可经引导菜单配对 QQ/Telegram 文本与图片私聊，启用服务操作后子会话可调用受控重启。可信宿主还可显式启用独立服务操作，Telegram 持有原入口审批、权限快照和精确长期授权。CLI 与 Telegram 宿主菜单可按原检查接纳请求停止重核，也可分别保存原服务写入效果核实和请求原写操作停止重核。

## 对外接口

`ruukoto` 与根 `npm start` 无参打开菜单，`serve` 前台托管后台，`npm run personal:durable` 是同入口兼容命令。正式默认 `~/.ruukoto-durable/`，`RUUKOTO_PERSONAL_DIR` 可选择新档案；dev 固定检出散列目录并忽略该覆盖，默认薄启动器托管 Node watch 前台后台，`--config` 直接使用同一菜单且不监听源码，拥有本次后台生命周期；配置菜单源码变化须退出重开。dev 拒绝已启用 QQ/Telegram 的配置，不改写原记录或连接平台。旧个人档案与旧开发、工作流、GitHub 自动评审及个人导入不接入本模块。

`ruukoto settings` 提供版本化、有界 stdin/stdout JSON 机器入口。在线查询与显式模型测试通过当前后台认证的 `/settings`，配置写入及托管技能变更仅在停机持锁后执行；档案身份与内容修订在同一锁内比较。查询返回模型元数据、凭据引用状态、技能来源/诊断、MCP 服务/工具及未决阻塞，不返回密钥、任意 SQL、文件或完整请求证据。保存不运行连接测试，离线测试不使用 SSH shell 凭据冒充实际服务环境。生命周期只查询，SSH 与停存启由客户端另行管理。

配置字节修订流式计算，不将请求大小上限用于拒绝既有配置。MCP 按服务和原工具定义分页；按服务启停、移除和字段保存由后台保留未提交的原字段/工具，避免小修改必须回传整份大配置。完整 `config.save` 则要求提供整份配置。机器协议的具体参数见[操作手册](../usage.md#25-个人-agent-引导与管理)。

所有保存统一检查未决输入、工作、HTTP 等通用工具、MCP、浏览器、命令、服务、应用数据及检查/浏览器绑定的未核实事实，原工具任务已终结也不能解除外部占用。在线由已有 Harness 查询，离线持锁读 Storage，最多呈现 32 条；未知记录版本或损坏引用拒绝保存，达到输出上限仍继续核实。

显式模型测试发固定 `ping`、最多 1 token、无工具的有界请求；发送前的选择/规范输入和实际 payload 通过 `ruukoto.settings-model-test` data entries 留存，认证头不记录。证据写失败不发送，测试只返回固定脱敏结果；这些 entry 不含 model 消息，不进入主聊天历史或创建工作。

CLI 按聊天、后台工作/定时、审批核实、权限/资料、停机配置及实例运维分组；在线仅访问本机认证接口。`/permissions` 查看本机/Telegram共用和QQ独立的默认模式，POST只影响新接纳；`/service/grants` 与 `/service/grants/revoke` 查看及按原版本撤销长期服务授权，创建仍限原IM审批。两平台 `/帮助`、`/状态` 由宿主给出管理路径、当前模式与装配事实，不调用模型。`personal-owner-controls` 扩展标记使旧程序拒绝忽略新命令菜单。

六个 `app_data_*` 工具在主/独立定时会话开放，子工作须由本次委派显式给 `appData: true`，身份复用不继承；最终汇总仅开放查询。业务库为档案内 `agent-data/main.db`，复用共享表结构、事务、关系和查询预算。CLI「管理应用数据审批与回执」与两平台 `/应用数据` 可选择原操作、分页读参数/结果、批准/拒绝或恢复原库后重新核实；本机来源在本机批准，IM来源须回原平台/账号/owner/代次的已送达菜单。本机认证路由为 `/app-data/operations`、`/app-data/operation`、`/app-data/decide`、`/app-data/recheck`。

`memory` 提供稳定记忆的查找、分页读取、保存、按预期版本修订及撤销；主可管理全部新记忆，子/定时只读写自身，自动注入仅选本会话。`history_search` 每次扫描至多256条、返回8项；有续页时即使空页仍可继续，`history_read` 每页4096字符。主可查本实例已登记主/子/定时历史，子和定时仅自身；原生压缩后原文仍在。CLI 可直接管理记忆、查询历史和配置技能，无需填写内部编号。仅来源缺失的记忆仍可从可信本机列表定位并撤销，修订证据损坏继续拒绝；撤销不解除其他图片/工具证据的恢复要求。

`skill` 加载拥有者配置库中的正文及相对引用文本。技能仅作参考，不增加工具或权限；目录/正文动态刷新，版本与实际加载保存为原生 entries/documents。主会话 `/skill:名称 参数` 按原用户 entry 固定展开，保留原入站正文；仅显式技能不能由模型自行加载。目录缺失、非法引用或原快照无法核实均停止依赖操作。

技能来源包含外部配置库的 skills 子目录与档案内 `managed-skills` 清单启用的包；没有外部库也可使用托管技能。外部库只读，托管包按稳定身份预览、导入、启停与逻辑移除，包字节与路径保留给旧引用，新选择仍保存实际请求证据。远端目录选择只返回拥有者所选配置来源或技能导入目录中的有界子目录候选，正文详情按技能身份读取；不提供通用文件读取或物理删除。

配置资料与网络工具后，主/子开放 `read_file`、`write_file`、`http_request`、`web_search` 与 `read_artifact`，名称清单同时用于装配、恢复和调用检查。资料目录内读写、明确授权内读取直接执行；越界请求等待原入口决定，自动审查仅处理文件读和无凭据、无头/正文的 GET/HEAD。主可读本实例产物，子只读本子会话；命令/MCP 结果继续使用原读取接口。本机向导管理配置、资料授权、原审批、效果/结束和独占产物导出；Telegram `/工具` 绑定原宿主菜单。

浏览器经 `personal-browser` 原生工具装配，向已核实的完全访问主拥有者输入，以及创建时已保存该能力和完全访问模式的独立定时会话开放；子会话与汇总输入不开放。主会话和各定时会话使用独立浏览器绑定与操作记录。共享 BrowserManager 负责原生 CLI、Chrome、loopback 附接和进程身份，异步持久回调必须提交后才继续启动。CLI 配置程序与 Chromium 路径，在线管理原操作、效果核实和真实停止；Telegram `/浏览器` 仅管理原 bot/owner/代次操作。截图与长网页输出使用同一 `read_artifact` 和本机产物列表/导出，不要求先配置文件资料目录。

`personal-media` 接收固定拥有者的图片并提供 provider 发送恢复；Telegram 从最大照片和 caption 接线，共用主会话，QQ 从好友私聊文本/图片段接线，缺图片 URL 时通过 get_image 取已列明 QQ HTTPS CDN 地址；不读取平台本地文件，两平台使用相同的接收及原生来源核实规则。仅接受 JPEG/PNG/WebP，每条最多4张、单图8MiB，下载至多3次。含图文字不解析成控制命令。输入、工具结果与请求快照只保存类型化图片引用，最终 provider 前核实原生 submission/tool-result、MIME、哈希和文件身份后恢复字节。实际payload按各API的原生图片位置记录，Responses包括工具结果的output数组；图片字节与出现次数均须匹配。图片模型能力由配置明确选择；入站不支持给固定回执，本地读图/截图不支持给明确工具错误，继续文本回答。原引用缺失或被改写时不发请求。

`personal-command-worker.ts` 构建为自包含的 `worker/personal-command-worker.mjs`。可信宿主按[执行边界](execution.md)准备对应原模式的输入，以预先保存的原引用调用 `runPersonalCommand`；`readPersonalCommandReceipt` 校验并读取原回执，`stopPersonalCommand` 无内存句柄也按原引用停止。Linux 停机向导固定独立目录及 dev/ino，`commands` 配置启用子会话的 `run_command`、`read_command_output`；请求确认/自动审查在原目录内执行且不联网；完全访问继承后台账户环境，可访问目录外与网络，免逐次审批。完全访问仍登记独立 scope，按原身份核实停止；不承诺收回主动迁出单元的进程或外部服务。同账户可读写后台资料与证据，私有目录不构成其隔离。子会话请求展示原工作模式，按原生 section 留证据，不沿用上项工作的权限说明。原 WorkTask 持有命令 Task，接纳和开始意图分别留不可改证据；恢复只查原回执并核实原执行停止，不重跑；停止须核对原请求及原 launch 指纹，缺证据或 stop 先手不能证明旧执行已停。`readPersonalCommandOutput` 每页返回最多 3072 原字节的 base64；无回执时明确为片段。模型结果的 `verifiedEffect` 与 `stopped=true` 表示双事实已齐，原 `effect_unknown` 保留中断历史，输出片段不使已核实事实失效。工作查询的 `commands` 直接给出原命令当前宿主事实及 `requiresVerification`，CLI/IM/定时汇总显示相同事实，优先于旧子回答的解释。CLI 与两平台 `/命令` 可查询原记录、分页双流、保存不可覆盖的已生效/未生效证据，并登记原停止重核；IM由已发送原菜单固定平台/账号/owner/代次，旧入口从本机查询。停止任务固定原控制收件，执行前核入口活性；恢复双向核对收件、效果证据及停止任务，失去应答先查询原记录。未知效果或停止未核实保留原工作占用及来源暂停，完整回执也须停止已证明才释放；共享命令目录在任一原执行未核实停止时拒绝新执行。

`openPersonalHarness` 接受独立目录或已持有的 `PersonalProfileLock`、provider 与模型，接管锁的释放责任，返回主会话、Harness、提交、等待回答与关闭方法；可用 `beforeUnlock` 在放锁前收齐管理接口。可选 `service` 接受宿主固定的 helper 配置，安装 `service_inspect` 与 `read_service_inspection`，模型只能指定白名单内精确单元名或本会话的证据编号。返回的 `inspections.list/recheckStop` 供可信宿主查询未决检查与重核停止，不提供强制释放；未取消的活动检查拒绝宿主重核。`requestInspectionStop(ref)` 固定原 Task/接纳引用，仅登记后台重核并返回其 Task ID；它不等待停止。提交键由调用方保持稳定，用于 durable 会话内去重。`parsePersonalModel` 校验模型配置，`personalProvider` 按环境变量名读取凭据。个人 Pi 1.3.0 对象不传给 Coding 的 Pi 0.85.1。

`startPersonalServer` 独占后台，HTTP 仅监听档案内 Unix socket，经本地令牌逐次认证；提供 `/status`、`/messages`、`/inputs`、`/input`、`/telegram`、`/qq`、`/works`、`/work`、`/work/cancel`、`/work/close`、`/work/notes`、`/delegations`、`/delegation`、`/delegation/cancel`、`/delegation/report`、`/inspections`、`/inspection/stop`、`/services`、`/service`、`/service/decide`、`/service/resolve`、`/service/stop` 、`/commands`、`/command`、`/command/resolve`、`/command/stop`、`/mcp/operations`、`/mcp/operation`、`/mcp/decide`、`/mcp/resolve`、`/mcp/recheck` 和 `/stop`；状态的服务开关只表示能力已装配，不代表 helper 可用或业务健康。`personalControl` 为 CLI 调用；CLI 不重开 Harness。引导与前台托管见[操作手册](../usage.md#25-个人-agent-引导与管理)。

`startPersonalServer` 另提供 `/schedules`、`/schedule`、`/schedule/cancel`、`/schedule/runs` 与 `/schedule/run/result`，创建和按原请求键核实共用在线认证后台。CLI「后台工作与定时计划」中的「管理定时计划与运行」与两平台 `/定时` 共用同一宿主控制函数，逐步选择规则、时区和计划；IM 草稿及确认菜单持久保存，回复已发送的原确认菜单才可创建。列表每页8项，完整报告按原运行分页，不要求拥有者填写内部键。

工作结果的 `partial=true` 表示模型输出因长度限制截断，逐页读完仍只是已保存片段；工具、CLI/IM 与定时汇总均保留此标记，不自动续写，不改变原工作完成和身份释放。工作与报告文本页给出从零开始的 `offset` 和保存总长 `totalChars`，只有 `nextOffset` 表示有后页；任意非零位置的切片不等于原文开头。可信宿主使用返回的 `work.delegate` 委派或复用长期子 Agent，`append` 为当前分析追加说明，`list/status` 查询身份和原生工作进度，`cancel` 等待取消核实，`closeAgent` 关闭空闲身份。首次委派可给名称；已有身份通过具名工作引用管理。主聊天来源须引用已进入主会话的拥有者输入请求；定时成员固定到原调度运行及其真实输入。同工作键异参拒绝。主会话的 `background_work` 工具支持委派、列身份、分页读结果、追加说明、取消工作及关闭空闲身份；来源与请求键由宿主绑定原生工具和唯一活动输入，模型不能自行提供。CLI 的后台分析菜单直接查询历史、读原结果、请求取消与关闭空闲身份，Telegram 的 `/工作` 只管理原 bot/owner/代次的分析。菜单关闭还核实原工作仍是该身份最新工作。追加在当前回答结束后按接纳顺序处理，结果取最后说明的完整回答；取消或结束后拒绝新说明。子会话按服务、命令、MCP及当前工作应用数据资格提供相应工具，另有自身记忆、历史与技能参考。模型取消只请求取消，后续查询停止结果，不占住主聊天。模型委派同轮归入分析委托，跨轮可指定原委托继续；`background_work` 的 delegations/progress/cancel_delegation 查询和取消整项分析。CLI 的分析委托菜单与 Telegram `/委托` 共用此归属，取消包括分析成员的固定检查、服务重启、命令和 MCP 并等待效果及停止核实，不包含独立宿主服务写操作。主 Agent 安排好全部分析后通过 report 封组，原生报告 Task 等成员停止后请主会话汇总；report_result、CLI 的完整报告菜单与 Telegram「查看报告」分页查询原报告及送达状态。封组后共用入口拒绝续派和追加；未封组委托可跨轮继续。历史与可信宿主单项分析不自动归组。

个人调度由 `personal-scheduler` 装配，主会话通过 `schedule_create`、`schedule_query`、`schedule_cancel` 创建、查询和整项取消；创建必须来自真实活动拥有者输入。独立定时会话沿创建时工具及资料快照执行，可通过 `background_work` 委派、查询、读取和取消本次成员，不开放新计划创建、嵌套委派或主聊天分析控制；最终汇总只开放查询。首次回答结束后宿主自动封组、等待整项停止并汇总，无需模型另行 report。

`serviceOperations: true` 另启用宿主 `service` API：`request` 以原拥有者输入建立独立后台 restart 工作，`list/status` 查询原生 Task 和操作事实，`decide/cancel/resolve/recheckStop` 决定原审批、取消或核实效果与停止。模式固定于创建，默认自动审查；无有效长期授权时，自动审查与请求确认的服务写入等人工批准，完全访问免逐次审批。其中查询、一次性效果核实和独立停止重核通过本机认证菜单提供；本机来源可在服务详情批准本次或拒绝，Telegram 审批仍在原私聊；本机不创建长期授权。Telegram 来源强制使用原收件的模式，不能由 API 扩大；其审批只能通过原 Telegram 宿主菜单决定。历史本机可信 API 仍显式提供模式与单次决定，不能冒充 Telegram 来源。

`telegram` 配置启用固定拥有者文本入口；返回的 `telegram.receive/poll/status` 分别持久接收平台更新、管理可中止轮询、查询连接和最近 16 条收发。后台仅以配对的 bot/私聊拥有者收件，所有输入使用同一 main；普通直发收件保存当时模式/权限版本；`/检查` 选择原检查并请求停止重核；`/服务核实` 选择当前原入口服务操作，保存已生效/未生效及证据，或登记原写操作停止重核；`/权限` 管理以后新 Telegram 输入的模式，`/审批`、`/服务状态` 与 `/授权` 查询和管理服务工作。回复已发送宿主菜单选择动作，不要求输入内部键；控制消息不进入模型，也不等待聊天。服务请求也可由主会话委派的子 Agent 发起，权限固定为原工作授权。配置、配对和停用见[操作手册](../usage.md#25-个人-agent-引导与管理)。

`qq` 配置和返回的 `qq.receive/poll/status` 提供同一 main 的好友私聊入口，传输仅复用 OneBotClient；QQ 与 Telegram 独立配对、凭据指纹和代次，默认模式也分平台保存，QQ 换代重置为自动审查。QQ 图片仅从固定腾讯 HTTPS CDN（含 multimedia.nt.qq.com.cn）下载，不携连接凭据、不跟随跳转。本篇 Telegram 宿主菜单同样适用于 QQ，所有工作、审批、长期授权、效果及停止核实均按原平台/账号/owner/代次筛选；回复已送达的原菜单才能选择，控制不调用模型。后台与最终报告固定原入口，换代取消旧待发，不随另一入口聊天改发。

可选 `mcp` 配置让主/子会话使用 `mcp_tools` 查询钉版原定义，`mcp_call` 沿原工作权限调用，`read_mcp_result` 分页读取完整原请求响应。调用直接使用原生工具 Task；请求确认/自动审查逐次等待原入口批准，完全访问免操作审批，仍核对来源、配置、定义与凭据。远端只读标注不提供权限。宿主 `mcp.list/detail/decide/resolve/requestRecheck` 与 CLI/Telegram 菜单分别提供原记录、业务效果说明和原 SSE 流查询；核实任务只登记后返回，不占住控制收件事务。

## 数据与状态

`ruukoto.app-data` 固定库身份、初始化意图和原工具索引；每次写入以独立 pi.tool Task 派生操作键，保存接纳、完整参数指纹、来源/权限、批准/消费及结果entry。业务变更和含请求指纹/内容校验的审计同应用库事务，durable结果另行提交，不声称两库原子。首次初始化先登记身份，再在应用库事务写同一身份；中断仅可继续无业务操作的原初始化意图。

记忆索引、每条当前版本、全部修订引用和幂等回执在 `ruukoto.memories`、`ruukoto.memory`、`ruukoto.memory-operation`，正文与来源随不可变修订 entry 同事务保存。来源只接受可见原消息、已核实产物或可信本机拥有者说明；模型不能伪造后者。技能配置文件为私有 `skills.json`，目录版本、全文、读取和显式展开存 durable；原加载不因文件变化改写。

`ruukoto.schedules` 索引计划、运行及原生扫描 Task；`ruukoto.schedule` 保存创建者反链、模式和权限版本、工具及资料范围快照、时间规则、可选固定入口和取消事实；`ruukoto.schedule-run` 保存独立会话、原生 Task/Submission、真实定时输入、成员、封组、整项结果与发送引用。不可改接纳、取消、结果和发送 entries 双向核对，执行状态由原生 Task/Submission 派生；不复用共享 SchedulerStore、旧 Task 表或会话 JSONL。

两平台复用既有 `ruukoto.telegram`、`ruukoto.telegram-receipt` 与 `ruukoto.telegram-input` 持久 kind；QQ 来源显式保存 `platform: "qq"`，Telegram 缺省字段保持原证据。稳定消息键含平台、账号、owner 与有符号消息号，不以消息大小或到达顺序去重。QQ 扩展标记防止旧程序忽略新平台；QQ 接收连接变化及缺口另留 entry 和诊断 document，不能当作平台重投保证。

`ruukoto.browser` 保存宿主配置、主会话绑定与操作/会话索引，`ruukoto.browser-session` 保存各独立定时会话的绑定及暂停事实，`ruukoto.browser-operation` 关联原生 `pi.tool`、接纳、开始、观察、效果和停止证据；历史 entries 与索引双向核实，丢掉索引不能隐藏未知动作。`ruukoto.media`、`ruukoto.media-message` 与 `ruukoto.image` 保存图片接收/拒绝/绑定、平台身份、原生来源和不可变产物引用；未绑定满24小时标失效再清理原字节，已绑定历史保留。文件和 durable 不跨存储原子。

本机输入在原生 admission 前保存正文指纹和权限接纳，主/子工具及委派沿该快照；默认模式变更只影响新输入，恢复复核原 entry。媒体/浏览器扩展标记和 document 版本在恢复前核实，旧程序不能忽略新归属；首次启用前须完成旧未决输入和工作。

`tools.json` 固定资料目录及 dev/ino、具名 HTTP 凭据的 host/header/环境变量引用与 Tavily 原始 key 的环境变量名。`ruukoto.tools` 保存配置、逐条资料授权版本和操作索引，`ruukoto.tool-operation` 沿原生工具 Task 保存来源、参数、固定目标、审批/审查认领、开始、观察及双事实核实；不可改 entries 相互核对。私有 `artifacts/` 保存最多8MiB的原字节，durable 只保存引用、来源、哈希、长度、身份与 partial；搜索沿256KiB界限，命令/MCP不复制已有正文。

目录中的 `profile.json` 标记产品、Pi、档案和业务扩展版本；`owner.sqlite` 仅持有进程锁。`personal.sqlite` 保存 durable 会话、原生任务、提交、历史、业务格式 document、逐键输入指纹和 `ruukoto.model-request` entries。请求证据保存会话来源、规范化输入、推理级别和实际请求体，两条记录以请求键关联。凭据不写入请求证据，文件与 socket 权限为 0600，目录为 0700。

可选 `managed-skills/` 与其他顶层私有目录共用布局及 chmod 分类，缺省不改变档案格式。其内部只允许 `state.json`、`state.json.tmp`、`packages/<身份>/<原包名>/` 与 `.staging/<身份>/<原包名>/`；取得档案锁后、读配置和启动前核实普通类型、当前所有者、无链接、目录 0700、文件 0600 且 nlink=1。公开权限、错误所有者和链接直接拒绝，不自动修复。安全的未提交临时清单、暂存和孤立包可重开，但不解析为安装状态、不扫描为技能、不自动清理；未知顶层或管理节点仍拒绝。

`ruukoto.service-config` v2 保存 helper/sudo/策略路径与 useSudo 的指纹，`personal-service-inspect` 和 `personal-service-executions` 写入主会话；不支持的版本或缺扩展时拒绝。`ruukoto.service-execution` 按原工具/服务 Task 保存机器、尝试 ID、会话、来源 Submission、接纳及结果/停止证据；`ruukoto.service-executions` 仅索引未核实退出的 Task，原 Task 终态不会退役这些记录。`ruukoto.inspection-stop` 是一次拥有者停止重核的 background Task，固定原 Task/接纳引用及可选 Telegram 控制收件；原生终态结果保存是否取得原退出证明，不镜像检查状态。`ruukoto.service-inspection` entry 保存检查目标、错误码、base64 编码的原始 stdout/stderr 与截断标记；它没有模型正文，只在读取工具结果中按需进入上下文。

`ruukoto.subagents` 保存长期 ownerless Conversation 的身份、名称、关闭事实与单工作占用；`ruukoto.work` 按请求键保存内容指纹、拥有者来源、Task/Submission 引用、原权限快照、Telegram 绑定、模型工具引用、追加说明/来源/原生提交引用及取消事实。每项工作是主会话拥有的 background `ruukoto.background-work` Task，状态与结果以原生 Task/Submission 为准，结果留在子会话。子会话显式选择模型、`personal-subagent` 提示和工作扩展；启用服务检查时增加 inspect/read 及 `personal-subagent-service-inspect` 标记；服务操作另增加 `service_restart`、`read_service_operation` 与 `personal-subagent-service-operations`。检查接纳另存工作、原权限/入口与实际 child inputs，来源映射到原主会话或独立定时输入、委托说明与当时已接纳说明；所有新说明均有不可改接纳。

`ruukoto.analysis-delegation` 以原拥有者 entry 保存固定来源、权限、入口、成员与整项取消事实；成员工作保存委托引用和本轮说明来源。`ruukoto.analysis-admission` 与委派同 commit 保存工具、原输入、本轮说明、权限和入口证明；组内追加以 `ruukoto.work-note-admission` 固定原说明。恢复与这些不可改写的 entry 对照，不能把说明替换成另一条有效旧输入。状态从原生任务及占用派生，全部成员结束只表示空闲，仍可跨轮续派；报告引用表示已封组，原生 `ruukoto.delegation-report` Task 持有等待、生成及发送阶段；接纳 entry 固定原工具、说明与模型输入，报告 document 保存各次安全模型尝试、原 Submission/answer、暂停证明和固定外发事实；检查暂停引用不可改接纳，服务暂停沿原操作键，执行状态仍从原生 Task 派生。

`command.json` 保存原机器、TMPDIR、命令目录及 dev/ino；`ruukoto.commands` 钉定配置指纹。`ruukoto.command` 保存原工作权限、全部来源、执行引用、准备输入及外部事实；`ruukoto.command-admission`、`ruukoto.command-start` 和 `ruukoto.command-observation` 分别固定接纳、派发意图及结果/停止证据。`ruukoto.command-stop` 是原接纳的独立后台停止重核任务；私有 `commands/` 保留宿主双流和回执，文件与 durable 不跨存储原子。启动核对所有原 Task/document/entry 反链；缺原 worker、配置、目录或执行证据时保留现场。

`service.json` 保存版本与固定 helper/策略/sudo 绝对路径，生产固定通过 sudo，不接收旧环境中的服务配置、替身开关或测试超时。停机向导首次启用、查看和保留原配置，不提供变更/停用；文件存在本身不代表已成功装配。

`model.json` 只保存模型配置与凭据环境变量名，临时文件加 rename 保存；`control.token` 每次启动轮换，`control.sock` 只在后台持锁时清理，`backend.log` 保存后台诊断。`pending-<UUID>.json`（主聊天）、`pending-work-<UUID>.json`（原分析追加）与 `pending-schedule-<UUID>.json`（计划创建）是客户端发送前独占创建的原键/正文，追加另含原工作引用；独立前缀和接口避免误投主聊天。多个 CLI 不覆盖彼此；按原 submission 或计划创建键核实后只删对应文件。它不镜像执行状态，也不授予执行资格。

`ruukoto.service-operations-config` 标记操作能力；`ruukoto.service-operation` 按请求键保存来源、模式、固定操作身份、审批快照、消费、外部效果和停止核实事实。历史宿主操作对应主会话拥有的 background Task；子操作的同类 Task 在 root conversation 中由原 WorkTask 持有，沿后台子树运行，执行状态以 Task 为准。不可改 `ruukoto.service-work-admission` 同事务固定原工具、执行代次、子输入、映射来源、工作权限与入口，恢复双向核实。`ruukoto.service-operation-evidence` 保存每次 helper 调用的原始有界字节，结果和证据同 commit；核实记录保留拥有者证据，不覆盖原未知结论；Telegram 核实与原收件双向回链，说明每页 1200 字符。`personal-service-recovery-controls` 防止旧程序忽略新控制；独立 `ruukoto.service-stop` Task 保存原操作及启动器/机器身份，登记立即返回，最近重核状态与错误码可查询。

`telegram.json` 保存入口版本、随机配置代次、bot/owner、平台接管边界、凭据环境变量及指纹，不含 token。`ruukoto.telegram` 保存当前绑定和诊断水位；`ruukoto.telegram-receipt` 按稳定平台消息键保存原文、固定来源/回复目标、原生 Task/Submission 引用与发送事实。每条消息是主会话拥有的 background Task；429 重试时刻保存在原生 checkpoint，执行状态不另建副本。

主会话登记 `personal-telegram-permissions` 扩展，旧程序缺该扩展时拒绝恢复；`ruukoto.permissions` 保存新 Telegram 输入的模式与版本；`ruukoto.service-grants` 保存精确服务授权、原决定/操作、行版本及失效原因。控制收件保存已接受的结构化决定与授权关联，恢复时双向核实；授权只由原 pending 审批明确创建，完全访问不会自动创建授权。

`ruukoto.mcp-config` 保存配置与代次历史，`ruukoto.mcp` 按原生工具 Task 保存原来源、权限、批准消费、完整 JSON-RPC 请求/应答及 SSE 原流证据；不可改 entries 对应配置、接纳、开始、观察、批准与业务效果核实。`mcp.json` 保存当前端点和允许列表，凭据仅为私有文件路径与内容指纹；初始化及后续每次请求重读核实，失效不降为匿名。首次启用和变代均须没有未决工作、输入或外部占用，历史配置与调用不改写。

新的 MCP 配置为 version 2，服务逐项保存 `enabled`；已有 version 1 原样读取，经拥有者显式迁入生成新代次并保持原服务启用。启停保留端点、凭据及工具定义，停用不再允许新调用；每次保存生成新代次，原调用与配置历史保持原版本。文件和 durable 当前配置均拒绝降回 version 1，旧程序遇到 version 2 拒绝打开；配置元数据不另建执行状态。

## 主要流程

单次命令先在独立私有证据目录认领原引用与临时目录，保存完整启动指纹后 launch；启动返回并接好双流消费才提交 stdin。原始 stdout/stderr 完整落盘并观察正常退出后原子发布回执，记录长度、哈希和退出观察；退出码及 stderr 不解释为业务效果或未执行。取消、超时、独立停止或写入失败不发布完成回执，已捕获部分保留；恢复只查询原回执与停止，不重跑。停止未核实保留原临时目录，已退出且路径/dev/ino 相符才清理，替换目录保留；命令证据始终保留。恢复要求原机器和 TMPDIR；目录绑定前崩溃可遗留未派发的临时目录，双流没有磁盘配额。

启动先拒绝旧目录和链接文件，取得 SQLite EXCLUSIVE 锁并核对档案标记，再打开存储、核对业务格式与每个会话的扩展引用，最后打开 Harness 并检查 live Task 版本。检查完成才恢复调度。主会话显式选择模型、个人提示与工作管理工具；服务检查按宿主配置启用。已有空闲会话可更新模型或启用服务检查，有未完成输入/任务时拒绝增加工具或换模型恢复。子检查首次启用同样拒绝未决旧工作，全部子配置和主标记在同一事务升级；旧程序缺扩展即拒绝。首次保存服务配置前，持锁通过 Storage 核实业务格式、已有配置指纹与未完成工作，不启动 Harness 或提交业务记录；只读服务档案新增操作能力同样检查。已有指纹与操作配置匹配时允许恢复缺失文件。Harness 的首次服务启用检查先于新授权记录提交，拒绝后仍能用原配置启动。已启用检查的档案缺配置、指纹变化、配置版本不支持或记录缺失均在恢复前拒绝。

提交先由 durable 持久化，再生成回答；同键重投返回原 submission。每次调用 provider 前保存规范化输入，实际 API 发出 HTTP 前保存最终请求体。请求证据通过持久 ProviderDoc.sessionId 唯一定位实际会话，生成和压缩都写入该会话。回答只从已完整结束的 assistant entry 读取；进程重开恢复原会话与尚未完成的输入。

调度扫描只登记（计划、版本、原定时刻）对应的唯一运行，每个计划最多一个未关闭运行；繁忙时合并周期，停机期间无在途运行时只补最近一次。原生后台 Task 建立独立会话并提交真实 `ruukoto.schedule-input`，不复制主聊天历史、不伪装拥有者消息。创建工具的任务说明参数提供定时会话的四个后台动作与自动收尾流程。首次回答后封组，等待全部成员、检查与外部操作实际停止；同一独立会话的查询汇总完成后，同事务保存整项结果、关闭运行和登记唯一发送意图。最终报告正文只交付业务结果、失败和未完成之处，生成后的发送状态由宿主记录并供查询。发送由独立 Task 处理，离线等待不占下次运行。

首次委派在同一 commit 创建子身份、显式配置、工作 Task、来源和占用。Task 经原生 admission 提交稳定键 `personal-work:<taskId>` 并保存 Submission 引用；两次提交之间崩溃时重接原键。追加先持久接纳，由原 Task 逐轮以工作和追加键派生的原键 admission；每轮失败停止后续说明。收齐后台后，最终事务重查取消和追加数，有新增则继续，全部回答后才释放占用；恢复从最后已 admission 的轮次继续，避免旧轮次收尾中止在途追加。主聊天不等待后台工作；完成或取消后保留子会话上下文供再次委派。取消先记录取消事实，等待模型的 Task 观察取消；模型工具与可信 API 还可 abort 工作 Task。停止子会话时同时收齐后台压缩；正常收尾同样收齐子会话执行，比较占用仍属于本工作后，与 Task 终态一起释放；未释放前拒绝复用或关闭。模型工具和 CLI 读取原工作 Submission 的完整回答，每页最多 4096 个 UTF-16 单元，不拆代理对；Telegram 每页最多 2400 个，菜单历史每页 8 项，模型列身份每页 16 个。宿主取消回执只确认登记，查询在原占用释放且正常收尾后才报告停止已核实，faulted/orphaned 不作停止证明。`personal-work-controls` 扩展阻止旧程序误读新菜单，历史菜单的工作与入口在恢复前核实。

委托成员与原生工作登记同 commit，续派固定首次权限，当前说明另存来源并核实仍属原入口；新默认模式不扩大旧委托。整项取消与全部活动成员取消同 commit，现有工作监听收齐子执行；已结束结果保留，取消不关闭身份。拥有者另行交办独立新工作时，可复用空闲且停止已核实的身份；模型保留 agent、省略 delegation 新建本轮委托，不能续派已取消或封组的旧委托，也不能重发原未知效果。取消与成员登记由事务顺序仲裁，停止未核实保持占用；其他委托和主聊天继续。CLI/Telegram 委托列表与成员分页不调用模型，详情只以原入口已送达宿主菜单定位。主 Agent 的 report 只登记封组，成员仍活动或效果待核实时也可安排；原入口有效且未取消才接纳。封组后禁止任何入口续派或追加，报告 Task 以 allSettled 等全部成员，再核实原效果与正常停止，未核实前不生成或发送报告。自定义报告输入仅可查询，以固定键 admission 主会话并读取自身 Submission.answer，最终回报固定最初入口和原消息；本机来源只保存在本机。模型的 progress/delegations 不返回报告阶段或发送状态，报告生成中的 report_result 引导读取成员业务结果；普通拥有者查询和宿主菜单保留真实发送状态。取消撤回该报告的排队输入，在途回答保留但不外发，不 abort 主会话。

已配置浏览器时，委托汇报参考仍不开放浏览器；筛选只移除该操作资格，报告继续由自身来源与停止/暂停门禁核实后生成。

汇总参考将原委托目标作为单行 JSON 字符串保留，引用之后明确本轮正在生成已登记报告的业务正文，由宿主在回答结束后唯一回报原入口。正文不把再次登记、重新授权或发送状态列为业务待办；新模板不改写或重发旧报告。

主会话正常模型请求按原生输入记录说明本轮来源；当前消息与原拥有者输入逐对象一致时，在正文首尾标明本轮拥有者范围，技能先展开，图片顺序和内容保留。原消息与收件不改写，投影随请求留存，不改变原权限；历史压缩保留自己的摘要身份。

本机提交先记录正文 JSON 字符串编码的 SHA-256，再调用原生 admission，同键异参拒绝。指纹提交后而 admission 前崩溃时，原 submission 查询为未受理，不自动执行；CLI 让拥有者选择原键继续或保留。应答丢失先核实，不自动重送。停止请求先完成自身应答，再停 listener、等全部 handler、关 Harness；Harness 故障关闭也完成接口清理后才放实例锁。

服务检查以固定 argv 调用共享 `service-helper.ts`，helper 逐次核实本机、当前策略和白名单。原始输出先写 durable，再返回固定状态、观察时间和证据编号；`read_service_inspection` 每页最多 4096 字符，只读本会话的指定类型 entry。模型输入证据包含实际工具定义和结果；读取原文不再次调用 helper。

主/子会话工具与服务审批前的检查共用[持久检查身份协议](deploy.md)。spawn 前同 commit 登记原机器、ID、Task 和来源，正常结果也先保存原 ID 的停止证明。已有可信结果和停止证据直接复用；没有结果时先核实旧检查退出才可建立新观察。所有异步结果比较原 ID、机器与接纳，迟到旧应答不清新占用。恢复核对最新接纳与记录双向关系、原输入、工具或服务归属及结果/停止证据，resume 前仅对未决原 ID 做一次有界停止观察。

检查停止重核由 CLI 本机认证或 Telegram 已送达宿主菜单接纳。CLI 可列全档案检查；Telegram 仅列全部原来源均属于当前 bot/owner/代次的检查，混合或本机来源拒绝。接纳和后台执行都核实原接纳及原任务已终态或取消，事务外只对捕获的原执行做一次 stop-inspect；重启沿原身份恢复，错误证明保留占用，不循环重核。旧菜单不改指新尝试；登记不表示已停止。

子服务工具仅接收精确单元名，宿主按原生工具 Task 派生稳定键，同事务登记原工作及服务 Task。审批前检查接纳和批准消费都复核原工作、取消、整项暂停与全部来源；跨轮说明不能扩大原授权。工具内部等待审批和原操作结束，返回及分页读取均带原模式、批准依据和是否消费；只看到执行终态不能推断未等待审批。失败明确报告未执行或效果未知；完整原证据仅可在原子会话分页读取。WorkTask 正常收尾等待所持服务 Task，取消先保存服务取消事实，再收齐子会话及原生 owned task；faulted 且已消费的未结论操作在线转 interrupted，原菜单可分别核实效果及停止。审批前检查未停、效果或写停止未核实均不能释放身份；整项取消与报告沿成员工作等待，不包含独立宿主操作。

服务操作先经 helper 只读检查并保存目标修订，再等待持久审批 document 的决定；批准消费前复核原来源和策略内容，helper 在派发前再次核对修订。消费前同事务再次复核后来出现的检查占用；消费、开始事实与恢复 checkpoint 同 commit，仅当前 invocation 派发一次 restart。可信请求前拒绝记未执行，可信非零命令退出如实保留已执行结论；进程中断、超时或结果无法核实均暂停，恢复只停止与核实原操作。拥有者的效果说明与启动器/命令单元停止证明分别保存，两者齐全才释放。

Telegram 配对通过真实 getMe 和随机私聊短语选择身份，操作者确认后按已观察批次核实平台接管边界。运行中每批全部持久化才允许下一次轮询短期确认该批；重启不携带旧 offset，按 bot/chat/message 去重，允许平台空闲后随机生成较小 update ID。重复同键异文拒绝。每条原生 Task 用稳定消息键向 main admission，崩溃后接回原提交；只有对应的完整回答进入原目标的发送。

Telegram 控制消息按原始完整正文分类，回复关系只定位同 bot/owner/代次且已发送的宿主菜单；转发、引用摘录与普通回答不能决定操作。收件、决定/授权/撤销和固定回执意图同 commit，重投沿原记录，不重做决定。长期授权每次经 inspect 核实机器、单元、策略及单元修订，再在消费事务重读有效版本；撤销先提交恢复人工，消费先提交只影响后续。服务未知使同机器/单元的全部授权失效；历史未知完成核实后不再影响后来授权。

回复正文先固定保存，再提交 sending 与 verify checkpoint，最后发请求。明确 429 拒绝延后原发送，其他明确 4xx 拒绝终止；断线、5xx、畸形回执或发送后结果落盘失败都保留效果未知，重开不重发。目标停用/换代使旧未开始输入和待发回复取消；已进入主会话的历史保留，已开始发送的未知状态保留。后台停止先收齐轮询，再关闭 Harness，故障放锁前也收齐网络与本机接口。

## 不变量与失败处理

应用数据的破坏性迁移、多行更新/删除和重写在请求确认/自动审查等待人工，完全访问免逐次审批；批准只消费一次，消费前复核原工作/入口/权限，业务事务再比预期revision。已开始操作恢复只查原键回执：匹配则补记已提交，可信原库无回执且审计修订连续则记未提交；缺库、换库、损坏回执保持未知并暂停所属工作、子身份复用、委托/定时汇总，其余独立工作继续。已绑定库不自动重建，查询子进程也复核身份。人工回执重核只接受已终态原工具，恢复原库后可解除已核实的暂停；重核不重发写入。新扩展首次启用须完成旧未决工作，记录版本或证据断链在调度前拒绝。

记忆修订与撤销比较当前版本；重复原工具调用返回原回执，同键异参拒绝。主修订子记忆仍核实来源对子可见，不能借此传入父聊天。撤销停止后续记忆查询和注入，保留原历史。注入检查最近256条、最多16项和32 KiB，其余可用工具查找。每次 provider 前组装当前参考，在规范输入和实际 payload 两边界核实同一批来源/版本并保存实际全文；证据失败、来源缺失或版本变化时零请求。主/子/定时恢复核对修订及技能索引反链；首次新增扩展前须先完成旧未决工作。

计划固定创建时模式、权限版本、工具及扩展清单、资料授权、MCP、命令、浏览器、技能目录配置和服务策略内容等配置。默认模式变更不改旧计划；工具、资料或配置变化使旧计划停止后续新执行，拥有者核实未决效果后取消重建。运行及其成员沿真实定时来源核实权限、取消和同源未知占用；未知时整项暂停外调、委派与汇总，只可查询和取消。服务操作可在原入口逐次批准，不匹配或新建长期授权。取消先持久化，再停止名下全部活动并等待真实停止；取消不回滚已有外部效果，迟到结果不恢复运行。

OneBot 正向 WebSocket 没有收件 ACK/offset；本地事务提交才算受理，断线未持久受理的消息不保证恢复，向导展示接收缺口。未开始发送时离线可沿原目标等待；发送已开始后丢答、async、畸形回执及 NapCat 1200 都保留未知不重发。无可核实的 QQ 限流契约时不解析错误文案猜重试；Telegram 仍仅按明确 429 拒绝延后。QQ 图片 URL 不进请求快照，下载仅限受控 HTTPS 图片 CDN，源反链和字节均须核实。

定时浏览器只使用创建时已开放的完全访问能力，人工暂停不能由该运行自行恢复；拥有者从原操作菜单核实或取消。正常及取消收尾都停止本次浏览器并核实会话关闭；网页效果未知仍阻止整项收尾。最终回报固定原平台、账号、拥有者和代次；本机创建的计划仅留本机结果，以后配对入口也不补目标。入口失效取消未发回报，已开始发送后丢答或重启保留效果未知，不重发。平台长文本有界截断，完整结果留在原运行。

浏览器先保存开始事实，再发一次动作；已有开始事实的恢复仅停止原执行并补观察，不重发。写入丢答、取消或崩溃保留网页效果未知，沿共同来源暂停所有外部操作、委派和报告，独立新聊天可继续。未知时宿主关闭原浏览器，可能丢失页面现场；关闭只能证明本地执行停止，不能证明网页写入未发生或回滚。效果说明与真实停止证明均满足才解除占用。人工暂停记录接收与原生队列屏障，暂停前已收到的消息不能解除；恢复清空旧元素引用。

新工具在消费批准前复核原工作、入口、权限、配置、资料授权版本和实际目标；撤销使未开始调用失效。审查是一次30秒无工具调用，规范输入与实际 payload 先保存；失败、非法输出或恢复中的未完成审查转人工。只读中止无写入效果，已开始写入缺结果不重发并暂停原来源、整个委托和报告；HTTP 本地关闭不能证明远端写请求结束，效果和结束分别核实后才释放。文件新建需要 Linux 父目录句柄原语，其他平台明确拒绝；现存普通文件仍按对象与原文指纹执行。文件写入必须完成所有短写。

文件/HTTP 在模型预览前保存有界原字节，3072字节/base64分页不丢二进制；超限和中断标 partial。产物损坏、缺失或换 inode 拒绝依赖该证据的恢复/读取；导出拒绝 partial 和覆盖目标。凭据值不入配置、诊断或模型证据，HTTP 秘密回显拒收，搜索先脱敏（含截界前缀），这些响应不承诺秘密原字节可取回。产物发布与 durable 提交不跨存储原子，缺引用的窗口保留私有文件且不能重发原操作。

同一档案只允许一个拥有者，关闭清理完成或进程崩溃后释放锁，锁文件不删除。配置写入使用同一锁，不因连接失败而离线争写。不支持的版本、缺扩展或缺任务定义均阻止调度；已有数据库缺少格式记录也拒绝。输入证据写失败时不发请求；存储失败关闭 Harness 并报告，宿主不自动重开。正常关闭保留未完成输入供重开恢复，不能当作工作取消。坏令牌、链接及旧目录拒绝，不能清理后自动接管。

请求体 128 KiB、消息正文 16 KiB、应答 256 KiB；客户端总时限 5 秒，后台收件 10 秒、闲置 15 秒。最近记录扫描 64 条 entry、显示最多 16 条消息，每条最多 8192 字符并标截断/中断；不返回输入证据或堆栈。终端输出过滤控制字符。

服务检查 stdout/stderr 总计最多 1 MiB，超限停止检查并明确标记部分证据；畸形应答、多条前缀、目标或状态字段不符均报错，不把它们当状态。helper 超时、取消或输出超限先固定首次失败并发停止信号，调用进程与 stdio 关闭后才返回，捕获保留关闭前的有界输出；无法关闭时保持等待。调用关闭不证明 systemd 操作单元或所有后代停止；durable 检查另以原身份协议核实固定同组 show。未核实时拒绝同目标或来源的新检查/restart/委派，终态与取消也保留占用，独立来源和目标继续；停止观察不沿已取消信号，停止证据由 Harness 提交。旧 helper 不支持新协议时保留占用，不回退 inspect。证据写入失败关闭 Harness，不能报告成功。服务配置仅由持锁的宿主 API 或停机向导提供，不由模型、工具参数或本机消息正文决定；服务重启通过另行启用的宿主 API 或子工具，模型不能指定模式或执行身份。

仅使用新的隔离目录，不能以此 API 浏览或恢复旧个人档案。SQLite WAL/NORMAL 支持进程崩溃恢复，不保证断电时最近提交保留。服务检查为无写入效果工具，中断后须先核实原执行退出才可重观察；旧无身份服务档案拒绝直接恢复，应保留原档案并使用对应程序完成处理，再建立新隔离档案。服务操作另按开始事实保守恢复，不将只读重跑规则用于 restart。

`personal-work-notes` 扩展阻止旧程序读取追加记录；恢复核对本机指纹/工作、Telegram 原已送达详情菜单、模型拥有者/工具动作及原生输入正文。追加不修改原权限，接纳及后续子请求同时复核原工作与追加来源的未知服务操作。工作扩展依赖的索引缺失、文档版本不支持、会话/身份或 Task/占用关系断链均在调度前拒绝；未核实的遗留占用不因 Task 意外终态而自动清除。旧无工作档案只在无未决输入/任务时启用后台工作。模型变更有未决工作时在写配置前拒绝，空闲时显式同步所有长期会话。配置保存与Harness启用共用空闲检查，仅豁免与调度索引及原Task完整匹配的监督任务；未结束定时运行、其他活动任务或排队输入继续阻断，各能力未知效果检查另行保留。provider 两处记录边界都复核活动占用及取消事实，缺失/歧义来源、空闲/关闭/取消身份不发模型请求。子检查逐次核实活动工作、原 generation/输入及委托暂停，三模式均只读，不继承长期授权。服务工具、工作结果与进度保留当前宿主服务事实，通用工具中断不能自行推成效果未知；复用子身份时只刷新本次实际输入内可核实的原服务结果，并保存实际请求，不改历史或继承批准。正常收尾及取消收齐子会话后继续等待检查停止证明，再同事务核实并释放；关闭重开重接原 Task，不将待核实抛成不可恢复终态。主聊天的模型工作工具只在活动工具调用中执行，变更另需唯一拥有者输入，回报输入仅可查询；首次启用有未决输入/任务时先拒绝，不固化扩展。原 Telegram 绑定失活或同来源服务效果/停止未核实时，委派与子模型请求均拒绝；历史绑定不改成新绑定，其他来源聊天仍可继续。

`personal-analysis-delegations` 阻止旧程序恢复新归属，首次启用前须完成旧未决输入/任务。恢复双向核实委托/成员、原输入、权限、入口、本轮说明及精确模型委派参数；不猜测历史归属。续派、追加及子模型请求检查整项取消，以及全部成员（含终态）的原输入、本轮说明和追加来源的未知服务效果。暂停仍可查询和取消；原入口失效不能跨平台或换代续派。报告后台按暂停记录观察原服务操作、检查或命令 document，等待效果及停止核实，不占主会话。admission 后 provider 门禁发现未知时先持久记录该尝试的暂停证据，再拒绝真实请求；该轮 unanswered 后，仅带证据的原报告可递增尝试号重做只读模型汇总，每次固定键恢复、最终外发身份唯一。普通汇总失败可查且不循环重试；取消/换代/停止未核实阻止后续请求，已领取发送仍保留真实效果。恢复核对模型输入、封组及暂停接纳、Task/Submission/answer、固定正文与发送检查点，缺关系即停止。

服务目标与同一原输入各只允许一个未结束操作；未知效果、停止未核实乃至意外 faulted 终态均保留占用，不允许换键或换目标绕过同来源暂停。效果核实不可覆盖；只有效果与停止均核实才释放占用，核实不恢复长期授权或重发 restart。停止控制接纳及执行只接受已消费且非 started 的未知写操作，不处理审批前检查；执行前复核原入口，结果写回核对原身份，失败不循环重核。本机可管理旧入口，Telegram 仅当前原代次，控制恢复核对菜单、证据、决定和 Task 回链。其他来源的独立目标与主聊天继续。原输入后来 unanswered 不破坏档案来源身份，但不能再消费未执行的批准。缺操作配置、扩展、版本或来源/Task 双向关系均拒绝调度；已保存的停止证明必须绑定本机、操作及命令单元并带 `launcherExited`，旧 helper 应答不能释放占用。

Telegram 数值 offset 只在一批更新收到后 60 秒内用于紧接的一次请求；失败、空批或超期清空，不能把 ID 视为永久单调。配对身份选择同样有 60 秒截止。平台明确确认与配置保存没有跨存储原子性，保存失败需重新配对；凭据变化不沿用旧配置启动。发送回执必须验证平台结果、消息身份和固定目标；原生 fetch 错误及含 token 的 URL 不进入日志。每批最多 16 条更新，HTTP 回执最多 1 MiB，正文最多 16 KiB；平台回复最多 3900 个 Unicode 字符加截断提示，完整回答保存在 durable。

旧 Telegram 收件没有权限快照时不能新建服务工作；已有这类未消费操作失效，已消费操作仍保留效果核实与占用。旧代次服务批准无法消费，长期授权失效；模式变更只影响新收件。权限/授权版本及来源关联缺失或操作模式与原快照不符时拒绝恢复，不能重建默认授权。

MCP 在外调前原子保存原请求及批准消费；同工具恢复与传输内部第二次调用均不重发。完整终结应答才能证明远端请求结束，HTTP 超时、关闭、取消、任务句柄及需要后续输入的应答均不能代替。未知调用暂停原工作、整个委托及报告，保留子身份与端点占用；其他独立来源和不同端点仍可继续。人工效果说明不修改远端结束，只有原会话/协议/游标齐备且服务支持 SSE 恢复时才能 GET 查询原迟到应答，缺证据持续保留占用。完整原响应分页读取，isError、error.data、结构化与非文本内容均保留；返回不代表业务成功。

## 设计依据

- [Personal 设置入口](../../.agents/notes/implemented/feature/2026-10-21-personal-settings.md)：认证查询、停机持锁写入、机器协议、凭据环境与托管接线。

- [正式入口与旧装配退出](../../.agents/notes/implemented/simplification/2026-10-18-personal-product-entry.md)
- [个人应用数据的双库回执与来源](../../.agents/notes/implemented/architecture/2026-10-18-personal-durable-app-data.md)

- [个人资料、技能与实际请求参考](../../.agents/notes/implemented/architecture/2026-10-18-personal-memory-skills-history.md)

- [个人持久调度的独立来源与整项收尾](../../.agents/notes/implemented/architecture/2026-10-18-personal-durable-scheduled-work.md)

- [个人浏览器与图片归属](../../.agents/notes/implemented/architecture/2026-10-18-personal-browser-media.md)：durable 绑定、图片引用、单发恢复和权限接纳。

- [个人通用工具、资料与产物](../../.agents/notes/implemented/architecture/2026-10-17-personal-tools-access-artifacts.md)：精确审批、原字节和共享暂停。

- [个人 MCP 原生工具与外部证据](../../.agents/notes/implemented/architecture/2026-10-17-personal-durable-mcp.md)：配置、批准、原请求与 SSE 恢复、未知占用。

- [完全访问命令的持久 scope 与原工作恢复](../../.agents/notes/implemented/architecture/2026-10-17-personal-full-access-commands.md)

- [个人命令沿原工作恢复并核实外部事实](../../.agents/notes/implemented/architecture/2026-10-17-personal-durable-commands.md)

- [个人单次命令由宿主保存完成证据](../../.agents/notes/implemented/architecture/2026-10-17-personal-command-execution.md)

- [个人 durable 档案与请求证据先于恢复](../../.agents/notes/implemented/architecture/2026-10-17-personal-durable-foundation.md)
- [隔离个人实例由后台独占并通过本机接口管理](../../.agents/notes/implemented/architecture/2026-10-17-personal-local-management.md)
- [durable 服务检查先持久归属再核实原执行](../../.agents/notes/implemented/architecture/2026-10-17-personal-durable-inspection.md)
- [个人 durable 服务检查复用固定 helper](../../.agents/notes/implemented/architecture/2026-10-17-personal-service-inspect.md)
- [服务 helper 中断在调用进程关闭后返回](../../.agents/notes/implemented/architecture/2026-10-17-service-helper-exit.md)
- [个人后台工作占用长期独立子会话](../../.agents/notes/implemented/architecture/2026-10-17-personal-background-work.md)
- [个人服务操作先持久消费并核实未知效果](../../.agents/notes/implemented/architecture/2026-10-17-personal-service-operations.md)

- [个人 Telegram 收件与固定回复由 durable 任务衔接](../../.agents/notes/implemented/architecture/2026-10-17-personal-telegram-entry.md)

- [Telegram 原收件与服务权限](../../.agents/notes/implemented/architecture/2026-10-17-personal-telegram-permissions.md)

- [个人隔离向导固定服务配置](../../.agents/notes/implemented/architecture/2026-10-17-personal-service-configuration.md)

- [个人模型工作由宿主固定拥有者来源](../../.agents/notes/implemented/architecture/2026-10-17-personal-model-work.md)

- [个人后台分析由宿主菜单控制](../../.agents/notes/implemented/architecture/2026-10-17-personal-work-controls.md)

- [个人追加说明由原工作按轮次接纳](../../.agents/notes/implemented/architecture/2026-10-17-personal-work-notes.md)

- [个人分析委托持有跨轮成员与取消事实](../../.agents/notes/implemented/architecture/2026-10-17-personal-analysis-delegations.md)

- [个人委托显式封组并固定最终回报](../../.agents/notes/implemented/architecture/2026-10-17-personal-delegation-reports.md)

- [子工作逐次绑定固定检查并等待原执行停止](../../.agents/notes/implemented/architecture/2026-10-17-personal-subagent-inspection.md)

- [拥有者按原接纳请求固定检查停止重核](../../.agents/notes/implemented/architecture/2026-10-17-personal-inspection-stop-controls.md)

- [拥有者分别核实服务效果与原写操作停止](../../.agents/notes/implemented/architecture/2026-10-17-personal-service-recovery-controls.md)
- [子服务操作归原工作持有并沿原授权恢复](../../.agents/notes/implemented/architecture/2026-10-17-personal-subagent-service-operations.md)
