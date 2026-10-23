# 操作手册

本页是 `ruukoto`（个人 Agent）与 `ruukoto-code`（Coding Agent）的操作入口：运行、配置、启用各入口、导入旧实例与故障排查。机制解释见[架构总览](architecture.md)与[模块文档](modules/)，开发与测试见[开发说明](development.md)。

## 1. 前提与安装

两个产品的文件检索需要宿主预先安装 ripgrep（`rg`）并加入 PATH；`npm run setup` 会检查，工具调用不下载。缺失时返回 `file_search_unavailable`，安装后重新提交任务。

开发与离线检查需要 Node ≥ 22.19、Git、ripgrep（`rg`）、Bash 和支持 PTY 的 Python 3，使用 macOS 或 Linux 的普通用户账户。两个产品的受限执行均使用原生沙箱与宿主工具链，无需 Docker：macOS 构建需 Command Line Tools 的 Clang，Linux 前置见[原生沙箱部署](../deploy/native/README.md)。个人 Agent 面向 Linux 常驻服务，另需运行账户的 user manager 与 linger 配置。

```bash
npm run setup       # 按两份锁文件安装依赖、检查前提并安装轻量提交钩子
npm run build       # 构建工具 worker、macOS 原生监督器与 app 包
npm link            # 可选：把 ruukoto / ruukoto-code 装进 PATH（否则用 npm start -- …）
```

根 `npm start` 默认进入个人引导菜单，`npm start -- serve` 前台托管个人后台；保留 `RUUKOTO_PRODUCT=ruukoto-code` 的入口选择，也可用 `npm start --workspace=ruukoto-code -- …`。各 app 的 bin 固定产品身份；构建出的 app tarball 引用同仓共享包，部署保留完整 workspace。生产部署的系统身份、systemd 单元、提权入口与服务 helper 见 [deploy/systemd/README.md](../deploy/systemd/README.md)。

## 2. 运行

### 2.1 启动后台

```bash
ruukoto                         # 个人模型、凭据引用与实例管理菜单
ruukoto serve                   # 个人前台后台，SIGTERM/SIGINT/SIGHUP 触发停止
ruukoto settings                # stdin/stdout 有界 JSON，模型、Skills 与 MCP 管理
ruukoto-code server             # Coding 前台后台，默认原生受限执行
ruukoto-code stop               # 优雅停止 Coding 后台
```

个人使用 `~/.ruukoto-durable/` 或 `RUUKOTO_PERSONAL_DIR` 指定的新目录；运行前先在菜单配置模型，凭据由环境提供。菜单可启动独立后台并查询、停止，退出日常菜单不取消已受理工作。生产 systemd 部署见[服务器部署](../deploy/systemd/README.md)，开发托管例外见[开发实例](#8-开发实例)。旧 TUI/桌面、`server/start` 和旧控制面命令不属于个人新入口。

Coding 默认且只接受 native；`--execution` 或 `RUUKOTO_EXECUTION_BACKEND` 中的 local/container 明确拒绝。native 在 macOS 使用 Seatbelt 与原生监督器，在 Linux 使用 bubblewrap、namespace/seccomp 与 user scope/cgroup；缺失或失效报 `execution_unavailable`，不回退。完全访问直接使用后台账户已有权限并继承其环境，清除内部 Ruukoto 控制变量。

新个人目录须为空白或已知 durable 档案，旧目录和未知版本在恢复前拒绝，不导入或改写旧资料。Coding 新档案创建当前 schema；既有库版本须与代码一致，拒绝旧库与较新库，不自动升级或回填。两种格式不互转；保留原档案与匹配代码，旧个人归档不能为查阅而启动恢复执行。

### 2.2 交互入口

Coding 的完全访问普通会话可由模型显式启动后台服务，跨消息保留；修改同目录代码前先停止并核实。TUI `/processes` 或会话菜单、Desktop 会话菜单可查日志、请求停止及“结束本会话后台”。窗口关闭、存档和客户端断开保留后台；关闭请求的原键重核只涉及原请求成员，后来新启动以最新清单为准。macOS 需要已构建原生监督器，Linux 需要 cgroup v2 与可用 user systemd；停止未核实会保留目录占用，不用恢复队列强行解除。stdout/stderr 合计最多16 MiB，限额或磁盘失败自动请求停止并保留不完整标记。存储 schema49、控制协议36须配套使用，新版本拒绝旧库；保留旧档案供匹配版本查阅，不自动迁移或清空。

个人菜单需要 TTY；本机与 QQ/Telegram 的聊天、配置、工作、授权与核实操作见[引导与管理](#25-个人-agent-引导与管理)。非交互运行使用 `ruukoto serve` 托管后台。

```bash
ruukoto-code config               # 模型与 API key，后台停机时支持离线配置
ruukoto-code ~/code/my-repo        # 新建工作区会话，按需拉起后台
ruukoto-code                      # 回到既有会话，不隐式新建
```

Coding TUI 与配置中心需要 TTY；非 TTY 使用 `status`、`events`、`submit` 等 Coding CLI 命令。工作区按真实目录身份归属，符号链接与路径变体复用，同名不同目录分开；代码仓库本身不能用作工作区。相对路径按客户端调用目录解析，路径含空格时加引号，命令同名目录用 `./config` 或 `-- <路径>`。旧 `tui` 拼法给出迁移指引后沿用原行为。

### 2.3 按需拉起后台

仅 `ruukoto-code` 的 TUI 入口：打开任务界面（`ruukoto-code`、`ruukoto-code <路径>`、`--session`）时先探测控制面（socket 可连、令牌认证且 ping 确认未停止）。已在运行直接复用，不启动第二个实例；不在运行才拉起 detached 后台进程（标准输出／错误追加到 `<controlDir>/spawn.log`），就绪后打印一行提示并进入界面。

- 拉起的后台与 TUI 生命周期无关：退出 TUI、终端断开都不停止后台或取消任务，显式 `ruukoto-code stop` 才结束。后台会等待在途模型配置和连接测试收尾，再释放配置锁；等待不表示可以启动另一个配置写入方。
- 两个终端同时打开时并发拉起由后台实例锁（`<dataDir>/runtime.lock`）收敛为单个实例：败于锁竞争的进程退出，TUI 侧不误判为启动失败，继续探测到胜者就绪后按复用进入（不算本进程拉起）。
- 状态明确，拉起失败均打印错误并非零退出：后台正在退出时等待退出完成后重新连接，不重复拉起；socket 可连而令牌认证不通过 → 后台其实在运行，给出令牌核对指引；服务进程以非实例锁原因提前退出且宽限窗口后探测仍不通过 → 「后台启动失败」并附 spawn.log 尾部（常见原因：未配置可用模型 → 先 `ruukoto-code config`）；到期限仍未就绪 → 等待超时，单独标注且不杀进程。
- 运行中断线仍按既有规则显示重连中，**重连只恢复观察，不会再次拉起后台**；后台不可用要再拉起时重开 TUI 即可。后台明确拒绝（令牌无效、协议版本不符）照旧终止重连并给出修复指引。
- 拉起的后台沿用产品默认 native；显式旧后端覆盖在探测或连接已有后台前拒绝，不自动改写设置。
- 个人 Agent 不使用 Coding 按需后台或 TUI，运行方式见[引导与管理](#25-个人-agent-引导与管理)。
- 手动后台照旧：`ruukoto-code server --data-dir … --agent-dir …` 前台运行，与按需拉起共用同一实例锁（谁在运行谁生效，重复启动被拒绝）。

### 2.4 两个产品的差别

个人由 Pi durable 1.3.0 持有会话、执行、队列和恢复；Coding 使用原 Runtime/Driver 与 Pi 0.85.1。两端独立启停，目录、实例锁、配置、凭据与协议各自分开，不传递 SDK 对象。

Coding 的独立档案为 `~/.ruukoto-code/{data,agent,control,pending}`，路径只读 `RUUKOTO_CODE_*_DIR`；拥有者认证使用 `RUUKOTO_OWNER_TOKEN`/`RUUKOTO_OWNER_TOKEN_FILE` 或控制目录令牌。它不启动 QQ/Telegram 或个人调度，旧记录仍可核实。旧项目写命令引导改用工作区，保留只读查看与组织迁移；跨产品核心库按 `meta.product.type` 拒绝。

个人使用引导式 CLI 与 IM，共用主会话，不提供普通开发会话、工作区编码、旧工作流脚本/定义库、GitHub 自动评审或旧资料导入。运行中菜单只访问本机认证接口，离线配置须持锁；旧客户端不能连接新后台。

<a id="25-个人-durable-隔离向导"></a>

### 2.5 个人 Agent 引导与管理

固定服务可用 `ruukoto serve --directory /绝对/档案路径` 前台托管，目录参数优先于 `RUUKOTO_PERSONAL_DIR`；只接受这组规范参数。`ruukoto maintenance` 使用与 settings 相同的有界 JSON 封装，核实原系统级服务并显式启停，参数与管理员前提见[桌面设置维护](../deploy/systemd/README.md#桌面设置维护)。

`ruukoto`、`npm start` 与兼容命令 `npm run personal:durable` 打开同一个个人 Pi 1.3.0 引导菜单，按聊天与消息、后台工作与定时计划、审批/效果/停止核实、权限/授权/个人资料、停机配置、实例状态与启停分组：配置模型、启动后台、状态、发送消息、最近消息、核实上次提交、QQ/Telegram 配对/收发、Linux 服务与命令目录配置、管理后台分析、管理检查停止重核、管理服务审批与核实、命令效果与停止核实、MCP 配置与原调用核实、管理定时计划与运行、技能配置、长期记忆、历史检索与应用数据审批/回执。默认档案为 `~/.ruukoto-durable/`；可用 `RUUKOTO_PERSONAL_DIR` 显式选择另一个新目录，开发入口另用固定检出散列档案。它提供主会话与可选 QQ/Telegram 文本/图片入口、浏览器、资料与网络工具、产物和独立调度；正式 bin、根 start、开发与 systemd 使用同一新装配，生产接管另行安排。

个人助手提出结构化问题后，可继续普通聊天。在本机选择「聊天与消息」→「问题与回答」，或回原 QQ/Telegram 私聊发送 `/问题`，选择问题并逐题回答。单选、多选和自由输入均可；Skip 留空本题，「全部跳过」清空整批，长题、选项和核对答案须沿原菜单完整翻页，末页才可确认；已答记录也可完整翻页。推荐不会自动选择，业务答案不批准工具操作。IM 只接受回复已送达的原宿主菜单，其他平台不能替答；本机可查询或取消旧入口问题。回执丢失从同一菜单核实上次回答，程序保留原请求；未知发送不重发。重新配对使未答问题失效，重开后台与普通聊天保留待答。

程序可调用 `ruukoto settings`，stdin 发送一份最多 128 KiB 的 JSON，stdout 返回一行最多 256 KiB 的 `{v:1,product:"ruukoto",ok,result}` 或 `{v:1,product:"ruukoto",ok:false,code,message}`，失败退出 1。先用 `{"v":1,"op":"settings.read"}` 读取配置、来源诊断、凭据引用状态、阻塞事项、档案 `profile` 和各内容修订；分页可加 `offset` 与 `limit`（1–50）。在线只经当前认证后台，离线查询也取得档案锁，连接失败不表示已停机。

| 操作 | 参数与行为 |
| --- | --- |
| `lifecycle.status` | 无额外参数；查询运行、开发托管与原环境未验证状态，不执行启停 |
| `config.preflight` / `config.save` | 原 `profile`、`target:model/skills/mcp`、对应 `revisions` 的 `expectedRevision`、完整 `value`；保存仅停机持锁执行，一次只写一份配置 |
| `model.test` | 原 `profile`、模型修订及所选配置 `value`；只在实际后台发无工具、最多 1 token、30 秒测试，可能计费；离线返回尚未验证 |
| `mcp.get` / `mcp.discover` / `mcp.migrate` | 原 `profile` 与 MCP 修订；详情加服务 `id`，工具定义默认每页 1 项，可用 `offset/limit` 继续；发现加 `service`，迁入须停机；发现不调用业务工具 |
| `mcp.save-service` / `mcp.set-enabled` / `mcp.remove` | 原 `profile` 与 MCP 修订；保存加含 `id` 的服务字段 `service`（省略 `tools` 保留原允许列表），启停加 `id/enabled`，删除加 `id`；均须停机，原定义由后台保留，适用于大配置 |
| `mcp.cua-targets` / `mcp.cua-status` / `mcp.cua-control` / `mcp.cua-image` | 原 `profile` 与 MCP 修订；发现固定程序与既有沙箱、读取暂停及原未知动作。在线控制支持暂停／继续与逐步恢复；观察身份由界面保管，图片每页最多 128 KiB。控制丢答先读取状态，不重发旧动作 |
| `skills.list` / `skills.get` | 原 `profile` 与 `skills.revision`；列表可分页，详情加稳定 `id`，返回 `sourceHost:personal` 的远端来源与正文 |
| `skills.select-directory` / `skills.preview-import` | 原 `profile`、`skills.revision`、拥有者明确选择的远端 `directory`；目录选择另填 `purpose:library/import`，只枚举至多 1000 个子项并返回有界子目录候选 |
| `skills.import` / `skills.set-enabled` / `skills.remove` | 原 `profile`、`skills.revision` 与预览/列表中的 `id`；导入另填 `directory`、预览的 `contentRevision`，启停另填 `enabled`；均须停机且无未决事项 |

模型只填写凭据环境变量名；普通 MCP 服务发现/新建时显式选择 `authentication:"anonymous"` 或提供远端私有 `credentialPath`，也可保留已读取的 `credential` 路径与摘要。读取不回显令牌，端点 query 值用占位符隐藏；编辑原服务保留该占位符，程序按原服务身份恢复隐藏值。新的普通 MCP 配置为 version 2，Cua 配置使用 version 3，逐服务填写 `enabled`；已有 version 1 先显式 `mcp.migrate`，新代次由程序管理，旧历史保持原版本。保存成功不表示连接测试通过；应答丢失先读回原档案/技能身份核实，不换身份重发。原服务环境无法核实便不自动恢复，systemd 精确授权及固定入口见[桌面设置维护](../deploy/systemd/README.md#桌面设置维护)，真实 SSH/systemd 组合仍需部署验收。

托管技能导入只复制远端已有单包，不上传 Mac 目录、不修改外部源。停用与逻辑移除仅改变后续选择，原包字节和旧引用保留；没有物理回收操作。外部库不可用时查询保留配置与显式诊断，修复目录后再保存。普通交互仍通过下述菜单逐步选择，无需手填内部身份与修订。

本机选择「权限、授权与个人资料」→「管理默认模式与长期授权」可查看和切换新输入模式、查看或撤销原长期服务授权；本机与 Telegram 共用默认值，QQ 独立。完全访问有明确选择步骤，已有输入与工作不随默认值扩权。长期服务授权仍只能在原 IM 的具体待审批菜单创建；本机撤销按程序保存的原版本执行，包括旧入口记录，应答丢失先刷新原授权。资料读取授权从「管理工具审批、资料授权与产物」管理。

先在菜单选择模型配置，选择接口并填写服务地址、模型、凭据环境变量名与上下文/输出上限。凭据只由启动后台时的环境提供，不粘贴进向导；配置与凭据不从旧档案复制。配置只能在后台停止时保存，连接失败不能代替实例锁判断。接口支持 OpenAI Completions、OpenAI Responses、Anthropic Messages。

可通过主聊天要求模型把独立分析交给后台子 Agent，再继续聊天；后续询问原工作进度或结果，也可补充当前分析的说明、要求取消工作、复用或关闭空闲身份。取消后停止已核实、身份空闲时，可在新消息明确交办独立新工作并复用原身份；已取消的委托仍不能续派。配置服务后子 Agent 可用固定只读检查，配置命令目录后可沿原权限执行命令；主 Agent 安排好分析后请求最终汇总，宿主等待成员停止后请主 Agent 汇总，并自动回报最初 QQ/Telegram 入口，本机来源报告保留在本机。不要把登记应答当成完成。升级首次启用模型委派前，需先用原版本完成未决输入和工作。

不经过模型控制时，CLI 选择“管理后台分析”，从名称、说明与状态选择原工作，查询、翻页读原结果、请求取消或关闭空闲身份；取消登记后刷新核实停止。Telegram 直接发送 `/工作`，回复已送达的宿主菜单选择“分析1”等列出的序号；需要更多记录选择“更多分析”。详情菜单支持刷新分析、查看结果、下一页结果、取消这项分析、关闭此身份；回复详情菜单发送“补充：正文”可追加说明。CLI 在原分析操作里选择“追加说明”。说明在当前回答结束后依次处理，结果取最后回答，原权限保持；取消/结束或原操作待核实时不接纳。菜单只管理原绑定入口和代次的工作。旧菜单不会改为取消该身份的新工作，身份曾复用则需重新查询才能关闭；关闭后历史保留。取消收尾异常或停止未核实时保留占用，请查询原记录并检查后台日志，不要重新委托重试。此菜单针对单项分析。另可在 CLI 选择“管理分析委托”，或在 Telegram 发送 `/委托` 并回复已送达菜单选择“委托1”等，查询所属成员、刷新或“取消整项分析”；取消后刷新核实停止。模型同轮委派归入同一委托，后续可继续原委托，保持首次入口和权限。成员全部结束只表示分析空闲；主 Agent 安排汇总后封组，不能继续委派或追加。CLI 选择「查看完整报告」，Telegram 回复详情菜单「查看报告」，可分页读完整报告并核对送达状态；发送效果未知时请在原平台核实，不自动重发。外部操作效果或停止未核实时报告在后台等待，其他聊天继续。历史及宿主单项分析不自动归组，取消涵盖分析成员、其固定服务检查、服务重启、三模式命令和尚未开始的最终回报，不包含独立宿主服务写操作；已开始发送按原效果核实。

管理定时工作时，在已启动后台的 CLI 选择「后台工作与定时计划」分组中的「管理定时计划与运行」，再选择「创建定时计划」，逐步填写名称、完整任务说明，选择一次性、每日或每周规则、时区及日期/星期，核对后确认。本机计划的报告只留本机。QQ/Telegram 直接发送 `/定时`，回复已送达菜单选择「新建计划」，按原草稿逐步填写并在最终菜单回复「确认创建计划」；自由正文按当前草稿接收。也可在主聊天要求 Agent 创建计划。创建键和权限由宿主管理，不在正文中填写内部 ID 或指定模式、收件人。

CLI 的「查看计划与运行」以及 `/定时` 原菜单可选择计划、查看运行、分页读取完整报告或「取消这项计划」。每次到期在独立会话执行，不占主聊天；宿主在首次回答后自动等待所有成员及外部操作停止，再汇总并回报原入口，无需另发汇报命令。取消同时停止未来触发与当前整项工作，登记后刷新核实停止；已有成果保留。繁忙或停机漏过周期会合并，不逐次补跑。发送等待不阻止下次运行；平台长报告截断，全文从原运行菜单读取。原入口停用或换代不改发，发送效果未知请在原平台核实，系统不重发。

计划固定创建时模式、权限版本、已开放工具和资料范围；更改默认模式只影响新计划。工具、资料授权、MCP、命令、浏览器配置或服务策略内容变化会停止旧计划后续新执行，请先核实原运行未决效果，再取消重建。受限模式按原入口逐次审批，不沿用或创建长期授权。外部效果或停止未知时，整项运行暂停外调、委派和汇总，可查询或取消；不要换工具、子 Agent 或请求重试。CLI 创建丢答选择「核实上次创建」，按保存原键核对，不要另建同内容计划。时间与收尾机制见[调度说明](modules/scheduler.md)。

配置技能时先停止后台，在「配置或查看技能」选择一个含 `skills/` 子目录的技能库；每个技能目录含 `SKILL.md`。核对目录和诊断后保存，启动后主/子/定时可按需加载正文和目录内引用文件，脚本只作参考文本。后续修改技能内容从下一次模型调用生效，原加载快照保留；变更配置目录使旧定时计划失效，核实未决效果后取消重建。拥有者可在主聊天或已绑定私聊发送 `/skill:名称 参数` 显式调用，包括仅显式技能；原输入和展开版本分别保存。

在线选择「管理长期记忆」可新建拥有者记录，或按关键词选择已有记忆，分页读取、修订与撤销；版本由程序管理，冲突时重新选择当前记录。偏好、约定、已确认决策和经验可通过自然语言请主 Agent 保存，临时进度留在原工作。子/定时记忆仅在自身会话使用；主可查询管理全部新记忆，但修订子记忆不能引入父聊天来源。撤销停止后续记忆查询和自动注入，原历史与已发请求仍保留。失去写操作应答先从列表核实，不自动重建同内容记忆。来源不可用的记录在本机列表仅提供撤销，不读取或修订；撤销仅解除本条记忆依赖，其他缺失图片/工具证据仍须恢复。

在线选择「管理应用数据审批与回执」，或在原QQ/Telegram私聊发送 `/应用数据`，选择原操作，分页核对表、参数、理由和版本，再批准本次或拒绝。非破坏性写入直接执行；破坏性迁移、多行更新/删除和重写在请求确认/自动审查逐次人工批准，完全访问免逐次批准。批准后库修订或原权限变化会使操作失效，刷新原结果后再决定，不自动覆盖。子工作只有本次明确授予应用数据资格才可访问，复用身份不继承。

应用数据回执缺失且无法核实、库身份变化或回执损坏时，所属工作暂停，主聊天仍可处理独立事务。先保留整个档案并检查可信原库，恢复后在原记录选择「重新核实数据回执」；原工具未结束时先等待并刷新。核实只读原回执，不重发写入；不能新建空库、换操作键、工具或子Agent证明旧操作未发生。首次初始化中断沿原固定身份继续，已绑定业务库缺失则停止能力。应答丢失先查原操作列表，内部编号/版本由宿主管理。

在线选择「检索历史原文」，输入关键词后选择摘要，继续检索或分页读原文；本机可查全部已登记的新主/子/定时会话，子与定时工具只读自身。压缩前消息仍可找到，标有中断的片段不代表完整回答；该入口不打开旧归档。记忆/技能来源缺失、版本变化或请求证据保存失败时模型调用停止，请保留档案并查询后台状态。

设置所选凭据环境变量后重新打开向导，选择启动后台，再发送消息和查询最近消息。后台独立运行；退出向导、终端断开都不取消已受理输入。菜单停止会保留未完成输入供下次恢复；停机尚未核实时不能改配置。配置保存前核实未完成输入、工作与定时运行，拒绝时保留原文件；合法空闲调度监督不阻止配置。模型端点、API、凭据变量和图片能力的更换也须先完成原输入；相同配置仍可恢复。QQ/Telegram停用或重新配对可使未决旧入口失效，原历史与未知效果仍保留。需要前台托管时使用 `ruukoto serve`（仓库内等价于 `npm start -- serve`），SIGINT/SIGTERM/SIGHUP 会关闭接口与 Harness。后台诊断写入所选档案的 `backend.log`，不在日志中输出凭据或消息正文。

提交失去应答时，选择核实上次提交；向导按保存的原键和原工作查询，追加说明不会投到主聊天。已受理的消息不重发，尚未受理时可选择原请求继续或保留。不要手工删待核实文件、换键重交或删除 socket 来接管实例。最近消息是有界诊断视图，截断和中断片段均有标注，完整记录保留在 durable SQLite；不是旧历史查看入口。

Telegram 请使用专用测试 bot，并先停止该 bot 的其他接收后台。在启动向导的环境设置 bot 凭据变量后，选择配置 Telegram，输入 API 地址（默认官方地址）与环境变量名；向导验证 bot，明确选择接管后过滤旧积压，再按提示发送随机私聊配对短语，从列出的身份选择自己。身份选择须在 60 秒内完成；确认边界及之前的消息不会执行，之后消息留待后台。配置仅存凭据指纹和环境变量名，凭据变化须重新配对。隔离验收使用专用测试 bot；生产 bot 仅在另行完成旧连接停止与接管验收后配对。

QQ 请使用专用 NapCat/OneBot v11 正向 WebSocket，并先停止该账号的其他后台。选择「配置 QQ」，输入回环 WS 或 WSS 地址与凭据环境变量名；向导核实在线登录账号，按提示用另一个拥有者好友账号发送随机配对短语，从候选身份中选择自己。配对及选择须在3分钟内完成；以选中配对消息的平台时间和消息身份固定边界，该消息及边界同秒/之前消息不执行，启动后重新发送委托。配置只保存凭据指纹，每次重新配对或停用都会换代，QQ 新代次恢复默认自动审查，需要完全访问时从新原菜单选择。隔离验收不接管生产账号；QQ 群聊、群临时会话和自身消息拒绝。OneBot 无离线补拉，查看 QQ 收发可见持久连接缺口；请核实缺口内未受理消息后重新发送。仅在请求尚未发出时，QQ 待发回复随原账号重连继续；发送后丢答与 NapCat 1200 均未知，不重发，也不猜错误文案中的限流。

以下 Telegram 宿主菜单同样适用于 QQ，回复各自已送达的原菜单选择；两平台共用主会话，模式默认值、审批、长期授权、工作控制及回报仍按原平台、账号和代次隔离。QQ 图片支持平台 file/URL，缺 URL 时查询 get_image；只从已列明的 QQ HTTPS 图片 CDN 下载 JPEG/PNG/WebP，本地路径及其他来源固定拒收。QQ 图文沿同一大小/数量规则，caption 不执行控制。

配对完成后启动后台，通过已绑定私聊发送新文本；与本机向导共享主会话。选择查看 Telegram 收发可看连接状态、最近最多 16 条输入与回复状态。效果未知表示平台可能已收到，系统不会重发；请通过平台核实。完整回答留在 durable，会话较长时平台单条显示截断提示。停用入口同样要求后台停止，旧待发回复取消，不改发给新绑定。可发送 Telegram 照片消息及 caption，下载后的 JPEG/PNG/WebP 每条最多4张、单张8MiB；含图文字不执行控制命令。已识别照片的格式错误、下载失败和模型不支持图片均有固定回执；文件附件、动画和其他消息类型只计为忽略。配置模型时明确选择是否支持图片，未选择时保持纯文本；不自动换模型。群消息不接纳。两平台可直接发送 `/帮助` 发现宿主管理入口，`/状态` 查看本入口默认模式与能力装配；装配不表示外部服务健康。`/权限` 返回宿主选择菜单，回复选择自动审查、请求确认或完全访问，只影响新的 Telegram 输入。启用服务配置后，`/审批` 展示原入口待审范围，回复该条消息选择批准本次、批准并长期授权、拒绝或下一项；`/服务状态` 查询结果，`/授权` 查看并回复撤销授权或下一项。转发、引用摘录和回复普通回答不能授权。批准不表示执行成功，效果未知需保留原工作并核实；回执丢失可查询，不能据此重新委托。服务请求可由主会话委派的子 Agent 按原工作权限发起。

浏览器先准备[官方程序与 Chromium](#12-浏览器)，停止后台，在向导选择「配置浏览器」，填写两个可执行文件的绝对路径并选择有头/无头。启动后选择「管理浏览器、截图与网页效果」查看连接、导出产物、停止并核实原执行，或为新输入选择默认模式。完全访问的主拥有者输入，以及创建时已开放浏览器的完全访问定时计划可操作各自独立浏览器；子 Agent 和最终汇总不开放，旧输入和工作保持原权限。让 Agent `start` 后操作网页，人工登录先 `pause`，完成后发送新消息 `resume`，暂停前排队的消息不能恢复；定时运行不能自行恢复人工暂停，请从原操作菜单核实或取消计划。截图要求图片模型，纯文本模型可用 `snapshot` 读取文字。

网页动作应答丢失、取消或崩溃后不会重发，原浏览器会关闭以核实本地停止，页面现场可能丢失。通过管理菜单分别核实网页实际效果与原进程停止，两者齐全才解除占用；关闭不证明网页写入未发生。Telegram `/浏览器` 回复宿主列表选择原操作，再选择效果并回复「浏览器核实说明 你的证据」，或选择「停止并核实浏览器」登记宿主检查。仅管理当前原入口，本机可查旧入口操作。截图、长输出、文件和已绑定图片统一从产物菜单独占导出；原产物和会话历史保留，partial不能当完整导出。

Linux 上先按[服务管理部署](../deploy/systemd/README.md)安装受控 helper、白名单与 sudoers，停止后台后选择“配置或查看服务”。逐步确认 helper、策略和 sudo 的绝对路径，再选择保存；默认路径对应标准部署。首次启用需要没有未完成输入或工作，拒绝保存时先用原配置启动并完成处理。启用后向导只展示并保留原路径，不能停用或更换；缺失或改动会阻止恢复，不要手工删改。服务配置不安装或重启服务，状态显示“已装配”也不代表部署可用或服务健康。旧无身份服务档案需保留原件并使用对应程序完成处理，再建立新的隔离档案；不要手工修改版本。启用后长期子分析也可使用同样的固定只读检查，启用服务操作后子 Agent 可按原工作权限请求受控重启，不能执行任意命令。本机向导选择“管理服务审批与核实”，选原目标后批准本次或拒绝；Telegram 发送 /审批 并回复原菜单决定。自动审查/请求确认无有效长期授权时等待人工，完全访问免逐次审批；跨轮说明不扩大原工作权限。检查停止未核实时，子工作及身份保留占用，原目标与来源暂停自动操作，先保留档案、核实原执行及 helper 部署，不换键重试。其他部署请使用新隔离档案；macOS 向导不能启用服务。

Linux 上停止后台后，选择“配置或查看命令目录”，填写已存在的专用个人事务目录并选择保存。首次启用前完成原档案未决输入和工作；不能选择后台档案、源码、凭据目录或其父目录。请求确认/自动审查仅在目录内读写且不联网；完全访问使用后台账户环境，可访问目录外资料、网络和同账户后台凭据，免逐次审批，仍须核实未知效果与原执行停止。停止覆盖原 scope 及其中后代，不承诺收回主动脱离的进程或外部服务。配置固定原目录身份、机器和 TMPDIR，保存后不能更换；恢复必须保留原环境，其他目录使用新隔离档案。命令证据留在私有档案中，不能手工删除或修改以解除占用。运行时从“管理命令效果与停止核实”选择原命令，可分页查看双流的 UTF-8 预览与原字节 base64；QQ/Telegram 发送 `/命令`，回复宿主菜单选择原命令，分页查看记录、输出或错误，按原效果确认菜单填写证据，或登记原停止重核。IM只管理当前原平台/账号/owner/代次，旧入口从本机查询；停止重核执行前再次核实入口，回执丢失先重新查询。运行返回不等于业务成功。效果未知时独立核实后选择已生效/未生效并填写证据，再登记原命令停止重核；效果与停止均核实后才释放原工作，不会重发命令。应答丢失先刷新原记录，不重复提交。

个人 Linux 固定命令目录另支持会话后台。让主 Agent 在新的完全访问拥有者输入中启动服务；继续改同目录文件前先停止并核实。CLI「后台工作与定时计划」→「管理会话后台与日志」可选择原命令、分页读 stdout/stderr、停止或「结束本会话后台」；QQ/Telegram 发送 `/后台`，回复已送达菜单选择原执行，结束需再次确认。退出向导、断线和存档保留后台；停止实例或重开时只停止并核实原执行，不自动恢复服务。结束丢答从原键查回执，不涉及之后新启动的后台。后台停止未核实会保留目录认领；普通命令与文件写入还须核实未知效果，先查询原记录。新个人业务格式要求新档案；旧格式由匹配程序查阅，不修改版本或清空记录以求启动。

检查停止未核实时，在在线向导选择“管理检查停止重核”，选原服务检查，再选择登记停止重核。Telegram 原绑定私聊发送 `/检查`，回复宿主列表选择检查，再回复详情选择“核实检查停止”或“刷新检查”。原检查仍在执行时先取消原后台分析或等待检查结束。登记不表示停止已核实；原检查仍待核实时保留占用，请核实 helper 部署后再主动重核，不能强制释放或据此确认服务写入效果。Telegram 只列当前入口的全部原来源，本机、混合或旧代次检查请从本机向导管理。控制回执丢失先刷新查询；系统不会因此再次登记或重发回执。

服务写操作效果未知时，在线向导选择“管理服务审批与核实”，选原操作，独立核实后选择“确认已生效”或“确认未生效”并填写证据；保存后不可覆盖。Telegram 发送 `/服务核实`，回复列表选择服务，再选择效果，回复确认菜单“核实说明 你的证据”（最多 8192 字符，不填凭据）。长说明可分页读取。停止未核实时选择“登记原操作停止重核”，Telegram 选择“核实操作停止”，刷新原状态查询最近重核结果；失败请检查 helper 后主动重核。只确认效果或只取得停止证明都不会释放占用，不会重发 restart；审批前检查仍从检查菜单管理。本机可管理旧入口操作，Telegram 只管理当前原入口。应答丢失先刷新原状态。

停止后台后选择「配置 MCP 服务」，设置普通服务名称与 HTTP 端点，选择显式匿名或已有私有令牌文件，再从实际发现的工具逐个选择允许范围。普通服务端点限 HTTPS，回环 HTTP 仅供测试；不支持任意 stdio、OAuth 或客户端代执行。凭据文件须为当前账户的私有普通文件，配置仅保存路径与内容指纹；撤销、替换或权限改变会拒绝后续请求，不会降级匿名。修改前须完成未决工作并核实原外部占用；配置代次与内部服务键由向导管理，不手工编辑。启动后主/子 Agent 可用普通服务的原工具清单与完整结果读取；请求确认和自动审查均逐次批准，完全访问免逐次批准，远端只读标注不提供授权。

在线向导选择「管理 MCP 调用」，从服务名称及原工具选择记录，翻页查看完整原请求、原响应及核实事实。本机来源可批准本次或拒绝；Telegram 来源在原私聊发送 `/MCP`，回复已送达的宿主菜单选择 MCP1 等，再回复详情菜单批准或拒绝。业务效果未知时独立核实后选择已生效/未生效并填写证据，Telegram 回复确认菜单「MCP核实说明 你的证据」；人工效果说明不证明原远端请求结束。只有完整终结应答或原 SSE 流查询取得原应答才核实请求结束；具备原游标的记录可选择「核实原请求结束」，登记后刷新查询，系统只 GET 原流，不重发工具。缺游标、不支持恢复或原凭据无法核实时保留未知、原工作/报告暂停与端点占用；本地关闭或超时不能解除，不要换键、工具、配置或子 Agent 重试。其他独立工作和主聊天可继续。完整应答不表示业务成功，按原响应检查实际结果。

个人 Cua 从「配置 MCP 服务 → 新增 Linux 桌面沙箱」或桌面 PA 的 MCP 设置选择既有本地沙箱，检查连接并选择允许工具后保存；程序、哈希和容器身份由管理入口核实。主会话连接跨对话轮保留；在线暂停／继续从实例管理的电脑控制或桌面 MCP 页操作。暂停先持久拒绝新调用，原在途结束后停止 CLI；继续前核实原 CLI 停止，下一次操作重新截图。出现未知结果后，在「管理 MCP 调用」或桌面电脑控制选择原记录，依次核实原电脑运行代停止、检查结果并开始恢复、实际查看新截图、接受该观察后开放新工作；若原来已暂停，仍须显式继续。停止整个沙箱会丢失内存和未保存的应用状态，须明确确认，磁盘保留。人工效果说明不能跳过这些步骤，原结果未知与原远端未结束事实保持；恢复只开放新工作，旧动作不会重发。普通 HTTP MCP 仍须取得原终结应答，不能通过电脑恢复解除占用。

真实模型验收使用显式选择的 `models.json` 和 `provider/model`，在临时新档案由模型保存记忆、后台重启后查找/读取并引用原版本，再加载临时技能完成任务，并经应用数据工具以单次事务保存两行、再次重启查询；核实真实SQLite、实际工具结果和两阶段请求证据。凭据仅进入测试进程环境，不复制到个人档案；不执行配置中的凭据命令或自定义认证头。来源配置也可用 `RUN_PERSONAL_MODELS_FILE=-` 经 stdin 提供，内容只在进程内读取。缺开关或配置退出 2，不记通过：

```bash
RUN_MODEL_CHECK=1 RUN_PERSONAL_MODELS_FILE=/path/models.json \
  RUN_PERSONAL_MODEL=provider/model \
  npx tsx verification/smoke/smoke-personal-durable.mts
```

### 资料、网络与产物

在个人引导菜单中选择「配置资料与网络工具」，后台须先停止。选择独立资料目录；HTTP 凭据只填写名称、目标 host、头名和环境变量名称，环境中保存完整头值（Authorization 含 Bearer 前缀）；Tavily 环境变量保存原始 key。不要粘贴凭据值。配置成功后重启后台，已有未结束工作或待核实调用会阻止变更配置。文件检索从该资料目录开始，外部目录先通过资料授权管理开放；不使用命令目录。缺检索 worker 时先运行 npm run build:worker。

运行中选择「管理工具审批、资料授权与产物」：逐项查看原请求、批准或拒绝本次；选择绝对路径添加只读资料授权或撤销已有授权。撤销令未开始调用失效，不能扩大旧工作权限。产物按列表选择后导出到新文件，已有目标与 partial 拒绝导出；命令双流和 MCP 原响应仍在对应管理入口查看。Linux 才支持安全新建文件，其他平台可读取及改写已有普通文件。私有产物目录没有全局磁盘配额，需保留证据并关注档案空间。

Telegram 直接发送 `/工具`，回复已送达的宿主菜单选择原操作、分页、批准或拒绝。未知写入后，分别独立核实业务效果与原外部请求结束，再在菜单填写证据；本地断线或取消不证明远端结束。未核实前工作和报告暂停，仍可查询或取消，主聊天可处理独立新工作。产物损坏或缺失时保留档案并恢复原文件，不通过重发外调补证据。真实模型、IM 与生产切换按各自外部验收记录，不由菜单可用推定通过。

## 3. 控制面命令

除 `server` 外都需要拥有者令牌（`RUUKOTO_OWNER_TOKEN`、`RUUKOTO_OWNER_TOKEN_FILE` 或控制面目录的 `owner.token`）。本节及第 4、7 节适用于 Coding，`ruukoto-code help` 列出命令；个人操作由上文引导菜单提供。

### 3.1 连接与查询

```bash
export RUUKOTO_CODE_DATA_DIR=~/.ruukoto-code/data
# socket：~/.ruukoto-code/control/control.sock；认证：RUUKOTO_OWNER_TOKEN 或 control/owner.token

ruukoto-code status [taskId]          # 快照或单任务（工具操作、审批、产物引用）
ruukoto-code events                   # 订阅持久事件流（seq 单调递增）
```

### 3.2 任务与会话

```bash
ruukoto-code create-project my-project
ruukoto-code create-session my-project /path/to/workdir
ruukoto-code submit <sessionId> <requestId> "任务输入" \
  [--mode confirm|full_access|auto-review|plan] [--grant <path>:<read|read_write>[:用途];...]
ruukoto-code set-session-mode <sessionId> confirm|full_access|auto-review|plan
ruukoto-code switch-mode <taskId> confirm|full_access|auto-review [--grant ...]
ruukoto-code interrupt <taskId>       # 显式中断运行中/等待确认的任务
ruukoto-code cancel <taskId>          # 取消排队或活动任务
ruukoto-code continue <taskId> <newRequestId> "继续输入" [--mode ...]
ruukoto-code resume-queue <sessionId> # 拥有者确认后恢复队列（并释放遗留占用）
ruukoto-code confirm <confirmationId> approve|reject
ruukoto-code read-artifact <taskId> <artifactId> [--offset N] [--length N]
ruukoto-code read-artifact <taskId> <artifactId> --output /path/to/file
```

`read-artifact` 默认向 stdout 输出一页正文（默认 256 KiB，单页最多 720 KiB）；`--offset` / `--length` 按字节切片。`--output` 自动分页导出完整的 `complete` 产物，核对每页元数据、总字节数及图片的 MIME 与 SHA-256，成功后以 0600 文件原子替换目标；读取、校验或写入失败时保留原目标。`--output` 不能与切片参数同用；`partial` 产物只能切片查看已捕获部分。

`request_id` 由客户端保存、唯一范围为会话：提交落盘但应答丢失时，同键同参数（含模式与授权范围）重试返回原任务，同键异参返回 `request_conflict`。

### 3.3 工作区与旧项目迁移

```bash
ruukoto-code project migration-preview <项目id> [--limit N]
ruukoto-code project migration-preview <项目id> --plan <文件>
ruukoto-code project migration-apply --plan <文件> [--request-id <id>]
```

`migration-preview` 只读零写入，按源项目列出目录分组、逐会话归属、歧义与异常、安全认领条件与建议计划；会话数可限制，截断如实报告且不可用于认领或生成修订。按建议编写计划文件（`action: map_sessions` 的会话 → 目标分配，或 `claim_source` 的安全认领）后，带 `--plan` 的 preview 校验选择并把绑定最终选择的修订写回计划文件。`migration-apply` 缺省请求键按计划文件内容派生（同一文件重发即原键核实），成功后 `action: "revert"` 的计划文件按回执校验当前值后只恢复显式组织字段。

映射目标必须是根目录含所选会话真实目录的工作区（`existing_workspace`）或通过目录与保护根校验的新根（`new_workspace`，同一真实目录已有工作区时必须复用其 ID）；安全认领仅在来源项目无根、会话集合非空且全为普通 dev、目录全部有效且为同一真实目录、目标即该目录、无占用、无已映射会话时成立（混合／部分／祖先认领拒绝）。

### 3.4 模型

```bash
ruukoto-code models [--provider provider] [--offset 0] [--limit 100]   # 分页查询安全目录
ruukoto-code set-model <session> <provider/model> --thinking <level>   # 保存选择
ruukoto-code submit ... --model provider/model --thinking level        # 本次提交显式指定
```

后台启动可传 `--model provider/model --thinking off`；模型 ID 中后续斜杠会保留。未指定 `--model` 时取 `default-model.json` 持久默认（含思考档位），再回退到目录首个模型；未指定 `--thinking` 时沿用持久默认的档位，没有则为 `off`。显式参数优先：带 `--model`／`--thinking` 运行期间，在线设置的默认模型只写入文件，重启去掉参数后生效。具体合法档位由该模型能力校验。

后台重启后队列仍暂停。旧排队任务若未记录模型，TUI 恢复时显示数量和待补选择，确认后补齐；CLI 需 `resume-queue <session> --model provider/model --thinking level` 显式确认。旧终态任务显示「模型配置未记录」。缺模型、凭据或不支持的档位会拒绝整次变更；目录中认证材料可用不代表远程连通性或额度已验证。

### 3.5 凭据

```bash
ruukoto-code credentials list
ruukoto-code credentials add --name N --host H --header H --purpose P --secret-env VAR
ruukoto-code credentials remove <name>
```

秘密值由可信环境经 `--secret-env` 指定的环境变量提供，不进命令行、模型上下文、事件或日志。用途（purpose）与主机在登记时固定；同名修改或删除在写入前单调推进引用它的入口配置版本，旧连接、旧入站与旧批准失效，A→B→A 轮换不恢复旧代次。

### 3.6 资料授权

```bash
ruukoto-code grant create --from <项目> --to <项目> --category history|artifact|memory
ruukoto-code grant list [--all]
ruukoto-code grant revoke <id>
```

跨项目读取只来自拥有者创建的授权（from/to 项目 + 类别），可查看、可撤销；撤销自后续查询与上下文注入起生效。

### 3.7 长期记忆与历史检索

```bash
ruukoto-code memory list|show|save|revoke|restore
ruukoto-code history-search <关键词> [--project P] [--session S] [--task T] [--role R]
  [--since T] [--until T] [--limit N] [--scan-limit N] [--cursor base64]
```

搜索是字面关键词匹配（中文按原文匹配），支持角色／时间／会话／任务过滤、命中数与扫描上限、游标继续；达到扫描上限时如实返回「结果不完整」。

### 3.8 选择记录

```bash
ruukoto-code selection-records --task <id> | --session <id>
```

### 3.9 SubAgent 工作委派

```bash
ruukoto-code work list | show | close | cancel
ruukoto-code work close <工作ID>
ruukoto-code work cancel <工作ID> [--reason R]        # 停止中拒绝
```

`work show` 的工作对象带取消三列与当前任务状态；`work_get` 的 `messages` 列表查看工作内消息。普通控制面 `submit`／`continue`／`switch-mode`／会话默认模式不能作用于子会话。

### 3.10 文件访问授权

越界读取形成的审批在 TUI 或拥有者 IM 私聊中批准；已登记但未开始的授权可用 `request_file_access` 的正常路径复核，不需要单独命令。

## 4. 配置

### 4.1 配置中心

`ruukoto-code config` 打开独立配置界面：复用控制面拥有者认证与 TUI 组件，不直接打开核心数据库，也不成为绕过任务审批的入口（任务执行审批仍在任务界面）。在线管理范围：provider 与模型目录（显式端点、SDK 已支持协议、模型列表及上下文／输出参数）、模型 API key、后台默认模型、摘要模型、项目指令／Web Search／资料授权、会话默认模型／思考档位／权限模式、MCP 服务、QQ 配置、服务凭据。

- **并发与修订**：模型配置以 `expected_revision`（`models.json` + `auth.json` + `default-model.json` + `summary-model.json` 的内容指纹）做条件更新；项目／会话／MCP／QQ 沿用各自的 `expected_version`。冲突时要求重新加载，不静默覆盖。
- **模型配置应用时机**：provider、模型目录与 API key 的修改只在没有受影响的 `running`／`awaiting_confirmation`／`queued` 任务或手动压缩操作时应用；检查到应用完成之间，受影响 provider 的新提交、手动压缩与会话模型设置被拒绝（`model_config_busy`，可重试）。占用时返回 `model_config_blocked` 与任务及操作数，不先改文件、不部分应用、不自动取消任务。应用 = 校验 → 写文件（原子、0600）→ 重建 ModelRuntime／模型目录／审查器并同步到各会话驱动；任一步失败回滚文件并保持原配置。删除 provider 或模型前核对后台默认、摘要模型、会话与 `agent_roles` 引用（`provider_in_use`）。
- **摘要模型**：上下文压缩的滚动摘要所用模型，保存为 `<agentDir>/summary-model.json`（`{provider, modelId}`，不存思考档位）。设置后，main 与开发会话较早的对话（含工具结果）会发给该模型的提供方做摘要。
- **秘密**：API key 输入遮蔽；模型列表只读脱敏配置位置，存储条目存在不代表认证有效；移除存储凭据仅删除 auth.json 的所选条目，目录、环境等来源仍可能生效。目录 apiKey 或具体 header 须另选字段清除，环境由后台启动环境修改；OAuth 移除不撤销远端令牌。响应只展示配置位置与必要元数据；秘密不进入日志、事件、命令行参数或重载状态文件。模型 API key（`auth.json`）与服务凭据（`credentials.json`）分开管理。
- **项目分区**：ruukoto-code 的「项目」分区把工作区列在前（标注「工作区」并展示根目录），旧项目列在后（标注「旧项目」）。指令与 Web Search 保存携带读取时的设置版本；「MCP 服务」入口只列本项目服务。
- **离线模式**：后台不可达时（或 `--offline`）进入有限离线配置：只做模型目录、默认模型、摘要模型与 API key 的初始化／修复，直接写 `<agentDir>` 下文件。互斥按规范化 agentDir 的配置锁（`<agentDir>/config.lock/`）判定：后台运行时持有该锁（不同 dataDir 共用 agentDir 也被覆盖），socket 不可达或认证失败不证明后台已停；无法取得独占时明确失败，不放宽权限、不改属主。

### 4.2 权限模式

模式按会话设默认值、按任务生效，TUI 顶部持续显示。切换只在无执行中工具的边界生效，递增权限版本并使等待中的审批失效。

| 模式 | 行为 |
| --- | --- |
| 请求确认 `confirm`（默认） | 工作区内读写与检查自主执行；越出工作区、未授权网络或凭据、对外写操作逐次请拥有者确认。批准绑定目标、内容指纹、方法与完整 URL，单次消费 |
| 自动审查 `auto-review` | 执行环境同上；越界的文件读取与无凭据 GET/HEAD 先经一次独立的无工具审查调用裁决，失败或拿不准一律转拥有者 |
| 完全访问 `full_access` | 由拥有者在可信入口选择；以启动账户无任务沙箱运行，所有已开放工具免操作审批，不额外赋予 OS 权限；模型输入不能提供权限升级来源 |
| 计划 `plan` | 仅普通开发会话；沿用自动审查的环境与审批，要求只调研不修改，持续到手动切换。保留的 `bash` 仍可能写入，不是全面只读保证 |

受限模式使用原生沙箱，默认无网络，只开放工作区、任务级授予与宿主钉定的只读范围；核实执行单元停止后才释放占用和临时资料。完全访问的文件、HTTP、MCP、应用数据、通知与服务工具均免操作审批，仍核实活动任务、权限版本、目标与修订，并保存真实授权来源；同账户的后台数据、凭据与令牌可被完全访问命令直接访问。

### 4.3 项目设置

```bash
ruukoto-code project set-instructions <项目id> <文件...>    # 工作区相对路径
ruukoto-code project web-search <项目id> on|off             # 默认启用
```

项目指令从 `project.rootDir?.cwdReal ?? session.cwdReal` 起经受限读取钉版（realpath 后必须仍在基准目录内），任务内固定、下一任务重新读取。项目指令与 Web Search 共用 `projects.settings_version`：保存经 `Store.updateProjectSettings` 在同一事务核对可选期望版本、更新同一行、递增同一版本并追加 `project.settings_changed` 事件；不符 = `version_conflict`，不改配置、无事件；同值保存幂等。

### 4.4 子代理角色文件

Coding 读取本实例 `<agentDir>/agents/*.md`，不自动扫描仓库。文件名是小写 kebab-case 角色名，同名覆盖内置 general/reviewer；新增文件新增角色。普通委派和工作流的 `role` 从同一目录选择：首次省略为 general，继续或复用沿固定角色；实际工具与权限按来源、角色及宿主约束求交。

```markdown
---
description: 阅读给定资料并给出有依据的结论。
---
根据委派目标阅读资料，报告结论、依据与未验证项。
```

`description` 必填非空，正文必填；可选 `tools` 为不重复工具名称列表，省略表示继承；`permissions` 可含 `mode`（默认 inherit，另有 confirm、auto-review、full_access）和布尔 `protect_source`（默认 false），保护不能与 full_access 同时要求。未知字段或非法 YAML 明确报错，坏覆盖不会使用内置兜底。文件须为不超过 64 KiB、单一硬链接的普通文件，目录及文件符号链接均拒绝。

主模型的子代理角色目录显示有效名称与诊断；拥有者控制面查询 `list_subagent_roles` 返回目录、字段及错误。修正文件只影响后续新建身份或新启动工作流；原子代理继续、复用、消息与重启沿完整快照，换角色须新建身份。GitHub 宿主固定评审不使用用户角色覆盖。记录损坏时保留历史并报告拥有者，不从当前文件猜测恢复。

代码修改与代码审查委派都显式给 `target`；无目标使用独立目录与获准资料。Git 副本包含当前未提交内容，忽略文件和依赖不复制；子代理报告缺依赖后在获准位置准备。内置 reviewer 用受限模式保护原目录，允许在副本写检查产物。普通汇总只应用子增量；来源同文件后来变化会冲突并保留成果。大小写不敏感文件系统的仅大小写重命名可能被 Git 套用预检拒绝，成果仍保留。非 Git 普通执行用原目录串行，需要保护来源则拒绝。普通委派与工作流均拒绝旧 `mode`；用 `role` 选角色、`target` 指定代码目标。工作流冻结验证使用 `verify`，与 `target` 互斥，角色不改变宿主验证限制。

## 5. 启用各入口

### 5.1 Telegram owner 入口

个人在停机引导菜单中配置凭据环境变量名、核实 bot 并配对拥有者，详见[个人引导与管理](#25-个人-agent-引导与管理)。旧 `credentials add`、`telegram configure/enable` 不用于新个人实例。

### 5.2 QQ owner 私聊

个人在引导菜单配对专用 NapCat/OneBot 私聊，原账号、拥有者与代次由宿主固定，详见[个人引导与管理](#25-个人-agent-引导与管理)。QQ 群聊与群临时会话拒绝。

### 5.3 私聊图片入站

QQ/Telegram 主会话支持 JPEG、PNG、WebP，格式、大小、模型图片能力与失败回执见[个人引导与管理](#25-个人-agent-引导与管理)。

### 5.4 通用定时任务

个人通过主聊天、CLI「后台工作与定时计划」或 IM `/定时` 逐步创建计划，固定创建时权限和原入口，独立上下文执行并等待整项收尾；漏期合并。配置与取消、完整报告和未知效果核实见[个人引导与管理](#25-个人-agent-引导与管理)。Coding 不创建个人调度。

### 5.5 调度与通知查看

个人从原计划、分析委托和平台收发菜单查看实际回报状态；登记不等于平台成功，未知发送不重发。旧共享账本的只读诊断仍由 Coding 的 `schedule list/show`、`notify list/show` 提供，不接管个人新计划或发送。

### 5.6 Web Search

```bash
ruukoto-code credentials add --name tavily --host api.tavily.com --header authorization \
  --purpose tavily_search --secret-env TAVILY_API_KEY
ruukoto-code project web-search <项目id> off     # on 恢复；默认对所有项目启用
```

秘密值为 API key，工具按 `Bearer <key>` 注入；值不进入模型上下文、事件、日志、历史正文或错误文本。未配置、host 或用途不匹配一律拒绝调用且不发送请求。任务开始固定工具清单：禁用中的项目任务不注册 `web_search`；任务内禁用立即阻止后续调用；重新启用从下一任务生效。

### 5.7 MCP 服务

```bash
ruukoto-code credentials add --name github-mcp --host api.githubcopilot.com \
  --header authorization --purpose mcp --secret-env GITHUB_MCP_PAT
ruukoto-code mcp configure --project <id> --name github \
  --endpoint https://api.githubcopilot.com/mcp/readonly --credential github-mcp \
  --tools get_me,get_file_contents [--expected-version N]
ruukoto-code mcp list [--project <id>]        # 脱敏视图
ruukoto-code mcp check <service-id>           # 连接检查 + 工具发现，标注每个远端工具是否在允许列表
ruukoto-code mcp disable <service-id> | enable | remove <service-id> [--expected-version N]
```

MCP 凭据用途固定为 `mcp`，host 须与服务端点一致，经 authorization 头以 Bearer 注入；配置服务时 scope 自动收紧到该项目 + mcp 操作，已有冲突 scope 拒绝配置。首个接入对象为官方远程 GitHub MCP。

Cua 是独立的电脑配置。Code 从「设置 → MCP → Code」添加「本机 Cua Driver」，或运行 `ruukoto-code mcp cua` 打开配置界面，在 MCP 服务中选择已安装程序。程序自动核实版本与哈希，保存禁用草稿；检查程序、权限并发现工具后，逐项选择允许范围，再保存并启用。Mac 检查只读当前后台启动宿主的辅助功能／屏幕录制授权位；静态工具发现不启动电脑 runtime，授权位通过不代表实际截图捕获通过。电脑连接限一个拥有者主会话，操作前须使用支持图片的模型取得新画面。暂停先停用以拒绝新调用，再核实原执行停止；在途操作须先中断并从原记录核实，继续时重新启用并取得新画面。

安装按[官方 Driver 指引](https://cua.ai/docs/cua-driver/quickstart)与[官方 CLI 指引](https://cua.ai/docs/cua-cli/quickstart)，使用固定版本；安装由拥有者执行，Ruukoto 不自动安装或升级：

```sh
# 当前 Mac 开发机：Cua Driver 0.38.0
curl -fsSL https://cua.ai/driver/install.sh | CUA_DRIVER_RS_VERSION=0.38.0 /bin/bash
# 个人 Agent 所在 Linux 主机：Cua CLI 0.7.0
curl -fsSL https://cua.ai/install.sh | sh -s -- --cli-only --version 0.7.0
```

Code 固定 `mcp --direct`，macOS 授权归实际启动后台的终端、IDE 或应用宿主；在「系统设置 → 隐私与安全性」给该宿主辅助功能和屏幕录制权限，按系统提示重启宿主后重新检查。官方 app 的 `permissions status` 查询的是 app daemon，不能替代 direct 宿主检查；更换启动宿主须重新核实。无需另一台 Mac 或 TLS／Bearer 网关。[官方 direct 归属说明](https://cua.ai/docs/cua-driver/reference/cli/serve-and-configure#cua-driver-mcp)。

Personal 需要同账户可用的 Linux user systemd、cgroup v2 与本机 `/usr/bin/docker`、`/var/run/docker.sock`，并先由拥有者准备专用的既有 Linux 桌面沙箱。固定 guest Spacesd 0.6.0／Driver 0.38.0，镜像为 `ghcr.io/trycua/linux@sha256:d0f845852b717aca5f3692fbe244e724500847f22400f2f672c505623ed542bf`。沙箱须已运行，禁用自动重启，不用特权、宿主 PID／网络、设备映射或宿主桌面／Docker socket 挂载；管理入口只选择和核实，不创建、删除或修改策略。CLI 使用 `--embedded`，不接共享 daemon。缺安装或权限时保留普通聊天与 HTTP MCP。

电脑结果未知时，原档案的电脑入口冻结；从 MCP 管理依次查看原未知动作、核实原执行停止、检查结果并开始只读恢复、查看新截图、接受这次观察后开放新工作。桌面直接显示原图，命令行交给系统图片查看器；Linux无图形会话时从桌面PA查看。图片读取或显示失败不能接受，重新观察会废弃旧选择。停止整个 Linux 沙箱会丢失内存和未保存应用状态，须本人明确选择，磁盘保留。关闭设置窗不停止后台动作，正常关闭先暂停并核实停止；故障后保留原记录，不重发旧动作。其他实例和人类仍可操作同一桌面，使用时避免同时控制。

GitHub MCP 首次配置：端点 `https://api.githubcopilot.com/mcp/readonly`（URL 路径 `/readonly` 为服务端只读开关）；凭据为独立只读 PAT（`purpose=mcp`、`host=api.githubcopilot.com`）。允许列表按 `mcp check` 实际发现的工具名精确填写（服务端工具集随版本变化，以发现结果为准）；建议只开放身份查询、仓库文件、PR、Issue、Actions 与 Checks 的读取类别。仓库可访问范围由 PAT 权限约束：通用客户端未实现参数级仓库限制，项目级启用不等于令牌内的单仓库隔离。

### 5.8 GitHub PR webhook

新个人入口不提供 GitHub 自动评审；Coding 未因此获得个人 webhook 或 IM 能力。保留的旧事件、修订和评审归档机制见[消息渠道](modules/channels.md)，不以旧启动参数接入新个人实例。

### 5.9 Jev 上下文筛选实验

实验按项目配置，默认关闭。先登记 TypeSafe API key，再在 `ruukoto-code config` → 项目 → 选择项目 → Jev 上下文筛选实验中选择凭据引用并启用：

```sh
ruukoto-code credentials add --name jev-myproject --host api.typesafe.ai \
  --header authorization --purpose jev_context --secret-env JEV_API_KEY
```

`JEV_API_KEY` 由拥有者的可信环境提供，值为原始 key，宿主发送时添加 `Bearer`。每个 Jev 凭据只绑定一个项目，普通 `http_request` 不可借用。缺少有效凭据时不发送请求；QQ 群聊和 chat 角色项目不开放本实验。启用从下一任务生效；停用阻止后续 Jev 请求并丢弃迟到结果，已经发送的内容无法撤回。当前阈值为 0.5，单次超时 2 秒；最多评估 24 个候选。

### 5.10 服务器服务管理

先按[部署说明](../deploy/systemd/README.md#服务器服务管理)安装固定 helper、白名单与 sudoers，再在个人停机菜单配置路径。原 IM `/审批` 可逐次批准或保存精确长期授权，CLI/IM 权限菜单查看、撤销授权；服务效果与停止分别核实，详见[个人引导与管理](#25-个人-agent-引导与管理)。Coding 不装配个人服务工具，旧长期授权记录可按既有诊断入口核实。

### 5.11 工作流问题与回报

本节工作流定义、运行、CLI 与 TUI 用于 Coding；个人以独立调度和后台分析完成工作，不使用旧脚本语言、定义库或 IM 工作流命令。

已有工作流的问题从 Coding 的 CLI/TUI 查看并答复，业务回答不批准工具，需要工具批准时使用任务审批入口。

主 Agent 可等待明确的后台任务或工作流，收到任一结果或需介入时继续处理；超时可再次等待，新消息打断本次等待但后台工作继续。

结果由有效父轮回到 Coding 来源会话汇总，父轮中断则沿原键补报，同来源多个目标共用一份总结。汇总保留终态、覆盖、停止核实与失败事实，终态事实取代中途旧状态；停止已核实不代表写入效果已知。暂停、取消、未知效果与已有成果保留，已有外部效果不回滚。

定义文件在实例 `<agentDir>/workflows/<名称>.js`，名称为 1–64 位字母数字及 `_`/`-`，首位为字母数字。保存入口自动写入接口版本首行，后面是 async 函数体，接收 JSON `input`，可调用 `agent`、`ask`、`integrate`、`progress`；先让模型用 `workflow_instructions` 读取编写说明。文件/临时脚本均须通过普通文件、UTF-8、128 KiB 与 QuickJS 语法校验，符号链接和越界名称拒绝，不回退旧版本。每次运行固定版本、参数及来源授权；编辑当前文件只影响新请求。模型可在当前可信任务内自主使用，计划模式、子任务和工作流步骤不能发起嵌套运行。

Coding 的 CLI 管理定义和运行。启动固定当前会话的模型和模式；需改变授权先用已有模式入口选择，启动参数不能回填授权。

```sh
ruukoto-code workflow save batch --script-file ./batch.js --request-id save-batch-1
ruukoto-code workflow definitions
ruukoto-code workflow definition batch
ruukoto-code workflow run batch --session sess_x --request-id batch-1 --input-json '{"question":"继续?"}'
ruukoto-code workflow list --session sess_x
ruukoto-code workflow show wfrun_x
ruukoto-code workflow logs wfrun_x
ruukoto-code workflow step wfrun_x step-key
ruukoto-code workflow question wfrun_x question-key
```

`save` 新建时不填 `--expected-digest`；更新须用 `definition` 返回的当前 digest。正文/问题/步骤可用 `--offset`、`--length` 按 UTF-8 字节分页，详情步骤用 `--step-offset`；定义历史用 `--version-offset` 按返回的 `nextVersionOffset` 续读，每页 100 项。列表/详情只含送达摘要，完整最终事实和回报正文用 logs 分页读取；历史脚本用 `workflow version <定义ID>`。运行参数也可 `--input-file` 读取 JSON；临时脚本以 `workflow run --script-file F --title 名称 --session S --request-id K` 启动，可用 `--description` 填简短说明；命名定义的名称固定，不接受 `--title` 覆盖。无版本标记的旧定义可查，须按 `role` / `target` / `verify` 更新正文，再用 `save` 与当前摘要显式保存新版；旧运行保留查询与取消，不恢复或自动重跑。临时脚本的旧 `mode` 调用会被拒绝，先前步骤的副作用仍保留。定义不可读/语法失败先修文件，`script_validator_unavailable` 先运行 `npm run build:script`；模型或执行入口失败先检查配置。

| CLI 后续操作 | 必填字段 |
| --- | --- |
| `workflow answer <运行ID> <步骤键>` | `--run-version` 填问题建立代次，`--question-version` 填问题版本，`--request-id`、`--answer-json` 或 `--answer-file` |
| `workflow pause/resume/cancel <运行ID>` | `--expected-version` 填 show 当前版本，`--request-id`；resume 的 `--clock-confirmed true`、`--stops-confirmed true` 只在确已核实时提供 |
| `workflow budget <运行ID>` | `--expected-version`、`--request-id`、`--max-attempts`、`--duration-ms`；调整不自动恢复 |
| `workflow find` | 原启动的 `--session`、`--request-id` |
| `workflow saved` | 原保存的 `--request-id` |

所有写操作用稳定请求键。应答丢失先 find/saved 或 show 核实；同键重放返回原记录，异参冲突，不能换新键把未知写入重做。停止未核实须先核实执行/占用，时钟未核实也须单独确认；效果未知、写入缺结果、来源失效或重放分歧不会因 resume 确认自动解除。取消保留历史及成果，故障处理见[工作流模块](modules/workflows.md#不变量与失败处理)。当前 schema49/协议36严格拒绝旧档案和客户端，原资料保留并用匹配代码查阅。

TUI 用 `/workflow` 打开侧栏：默认列出当前会话全部活动运行和最近十项结果，历史和长列表可续读。选运行后进入详情，查看步骤、日志、业务问题及独立的停止核实、效果未知和最终回报状态，再选择回答、暂停、恢复、取消或预算；名称、含毫秒时间、展示序号和显式说明帮助辨认同名运行。选“启动工作流”后选择已保存定义、填写 JSON 业务参数与可选简短说明，再确认启动；编辑脚本通过文件或 Agent。Enter 确认、↑↓ 选择、PageUp/PageDown 阅读正文，Esc 逐层返回并在根层关闭，浏览层也可用 q 返回。宽度至少 120 列时侧栏与聊天共存，Tab 切换焦点；窄屏以独立窗口显示同一所在层，Tab 可回聊天，缩放保留选择。关闭侧栏或客户端不取消运行。稳定键、原版本和参数由程序在发送前落盘，应答丢失、重连和客户端重启先只读核实原提交；明确未接收后可选择原键原参数重试，实例变化或记录损坏时保留待核实，不向新库重发。过期操作退回最新详情，重新选择并确认。

## 6. 导入旧实例

含持久提问或答案回执的源报 `owner_questions_import_unavailable`；保留原档案与匹配代码查阅，不能丢掉问题绑定后迁入。当前 Coding schema49、控制协议36沿精确版本拒绝，使用独立新档案，不手改版本号或回填授权。

含工作流运行、步骤、执行绑定、问题或控制记录的源实例明确报 `workflow_import_unavailable`；保留原档案用匹配代码查阅，当前导入不迁移工作流授权与执行。只有定义版本的资料不随普通资料导入。

Coding 导入必须离线执行：preview／apply／revert／list 都要求目标后台已停止（CLI 持目标实例锁运行，不走控制面）；源实例全程只读——源后台存活（或持锁身份无法核实）时拒绝，快照 = 把 `ruukoto.db` 及 WAL 侧车逐文件复制到临时目录后在副本上核实当前格式，源目录逐文件 sha256 不变。

### 6.1 开发资料迁入（ruukoto-code）

`ruukoto-code legacy-import` 只在 **ruukoto-code** 产品下可用，把旧 ruukoto 实例中的开发资料迁入 Coding Agent 档案。

```bash
ruukoto-code legacy-import preview --from <源数据目录> [--plan 计划文件]
ruukoto-code legacy-import apply --plan 计划文件 [--request-id <id>]
ruukoto-code legacy-import revert <导入ID>
ruukoto-code legacy-import list
```

拥有者在计划文件中修改 `renames`（重名项目改名）与 `personal_memories`（显式选中发布的个人记忆）后 apply：先查回执／核修订（源或目标变化即 `revision_conflict`），再备份目标库 `<dataDir>/migration/<导入ID>/target-before.db`（`VACUUM INTO`，回执记录 sha256），复制文件后单事务入库并写回执与条目账本；中断后用同一计划重跑即可，同键重放返回原回执。

导入范围是 allow-list，行 ID 原样保留：源项目内的普通 dev 会话及其任务、工具操作、审批、产物、选择记录、压缩点、事件与 SubAgent 一层；项目配置、范围内记忆、双端都在导入范围的资料授权、MCP 与 Jev 配置（缺凭据绑定时以停用导入）。不导入角色绑定会话、QQ 群会话与 main 资料、历史索引、目录占用、agentDir 全部配置与凭据。导入不调用模型、不重放外发。

整库恢复为手工路径：

```bash
ruukoto-code stop  # 确认后台已停止
cp <dataDir>/migration/<导入ID>/target-before.db <dataDir>/ruukoto.db
rm -f <dataDir>/ruukoto.db-wal <dataDir>/ruukoto.db-shm
# 复制的 JSONL 与产物正文如需一并移除，按回执 report.files 逐项删除
```

<a id="62-个人资料迁入ruukoto"></a>

### 6.2 个人资料归档

个人不提供旧实例导入、旧凭据复制、旧调度接续或在途执行迁移。原地保留旧档案及对应代码、依赖和一致备份；新实例使用空白目录，重新配置模型、平台绑定与服务。不得启动会自动恢复任务或外发的旧后台查阅归档。

生产切换须另行核实旧连接、scheduler/outbox、后台与独立执行单元停止，重新登记平台接管边界；未受理委托由拥有者重新提交。回退也使用另一个空白档案并重设边界，两份原档案均保留，不能加载旧备份重新消费积压。操作归[部署说明](../deploy/systemd/README.md#升级与回退)。

## 7. 交互终端

顶部是项目／会话／工作目录／连接状态／权限模式／执行后端，中间是消息与工具记录，底栏是权限模式、token 用量与模型。TUI 只经本机 socket + 拥有者令牌连接后台，不加载模型凭据、不读数据库。

### 7.1 输入

| 按键 | 行为 |
| --- | --- |
| `Enter` | 提交 |
| `Alt+Enter` / `Shift+Enter` / `Ctrl+J` | 换行（部分终端不上报 Shift+Enter） |
| `Shift+Tab` | 循环切换会话默认模式（Ask for approval → Full access → Auto review → Plan） |
| `Ctrl+C` | 有草稿先清空草稿；空草稿退出客户端 |
| `PageUp` / `PageDown` / 滚轮 | 翻页；滚动后新输出不会把视口拉回底部 |
| `End` | 回到最新位置，恢复跟随 |

选择与查看的悬浮层与窗口均可用 `q` 或 `Esc` 关闭；窗口与选择悬浮层打开时不触发 `Shift+Tab`。命令以 `packages/tui/src/tui/commands.ts` 的条目表为准：补全、`/help`、派发、回显、是否作为任务输入与是否保留成功结果都由条目推出。

### 7.2 命令

| 命令 | 说明 |
| --- | --- |
| `/help` | 命令与快捷键说明 |
| `/todo` | 打开或关闭右上角工作清单悬浮层 |
| `/resume` | 切换当前项目中的会话 |
| `/project` | 切换项目（ruukoto-code 为工作区／旧项目列表） |
| `/new-project <名称>`、`/new-session <目录>`、`/new` | 创建项目／在当前项目创建会话／在当前工作区创建会话 |
| `/branch [名称]` | Coding Agent 从当前普通开发会话的已落盘历史建立独立会话并切换 |
| `/compact [prompt]` | Coding Agent 主动摘要当前空闲普通开发会话，可补充本次摘要重点 |
| `/history` | 重新加载当前会话历史；滚动到顶部自动加载更早历史 |
| `/artifact <id 前缀>` | 查看工具产物正文（按字节分页） |
| `/approvals` | 待处理审批；详情内 `a` 批准、`r` 拒绝，`Esc`／`q` 关闭不等于拒绝 |
| `/interrupt [taskId]`、`/cancel <taskId>`、`/continue [taskId]` | 停止与继续任务 |
| `/resume-queue` | 恢复已暂停的会话队列 |
| `/model` | 选择提供方／模型／思考强度，作用于之后提交的任务 |
| `/mode` | 选择会话默认模式，作用于后续新任务 |
| `/status` | 查看当前任务详情 |
| `/search <关键词>` | 字面搜索会话历史原文 |
| `/memory <子命令>` | 长期记忆：list / show / revoke / restore |
| `/context` | 上下文窗口分解（各部分占比与压缩点） |
| `/prompt` | 本会话的模型请求列表与每次调用的 prompt |
| `/skill <名称> [参数]` | 显式调用技能（不带名称时同 `/skills`） |
| `/skills` | 技能库与诊断 |
| `/workflow` | 工作流侧栏：选择运行、历史、定义启动与逐层操作；Tab 切换聊天 |
| `/processes` | 查看本会话后台，分页读取 stdout/stderr，停止单项或选择“结束本会话后台” |
| `/questions` | 查看待答问题，逐题单选、多选、自由输入或 Skip，核对整批后发送；可返回或取消 |
| `/qq <子命令>` | QQ 入口：status / enable / disable / groups / inbox / outbox（后三者为旧群归档） |
| `/quit` | 退出客户端（后台任务继续运行） |

Telegram／QQ 私聊不识别 `/skill:`。`/plan` 已移除，按未知命令处理；CLI/API 的 `/plan …` 仅作为普通输入。

Coding Agent 的后台清单从 TUI `/processes` 或 Desktop 会话菜单打开，选择命令后查看 stdout/stderr、翻页或停止，无需填写内部引用。“结束本会话后台”需确认，接纳后继续刷新，直到显示已核实停止；应答丢失时保留原结束请求，刷新后选择“重核原结束请求”。关闭客户端窗口、返回聊天、断线和存档均保留后台。

Coding Agent 的待答问题不会占住聊天：TUI 用 `/questions`，Desktop 在会话中显示问题卡片，逐题选择或自由输入，核对全部答案后提交。预选项不会自动提交，每题最多4096字符；返回只离开作答，取消问题才结束待答。普通聊天、切换会话、存档、窗口关闭和后台重启都保留问题；应答丢失显示待核实并沿原键恢复，两个客户端只有一个能接纳。回答采用当时的模式与模型，具体工具操作仍独立审批。

会话选择列表每项两行：首行优先使用持久名称，其余使用最早用户输入（无输入时显示未命名会话），次行显示距最后任务活跃时间的间隔；项目选择列表首行显示「项目名 · 会话数」，次行显示会话的工作区路径。切换普通开发会话时沿用切换前选择的模式（含 Plan）、模型和思考档位，保存为目标会话的默认设置；提交新任务会等待设置保存完成。分支创建后的自动切换保留后台继承的设置。

`/branch 中文 名称` 保留名称内空格，同名会话以 ID 区分；省略名称时生成「父标题 · 分支 N」。它要求普通工作区会话或已映射旧会话，未映射来源先走工作区映射。后台固定已落盘历史，排除部分尾记录及活动任务未完成的工具批次，并显示实际分支点与排除说明；无可复制消息时等待落盘或使用 `/new`。成功后编辑器为空，失败保留父选择与草稿；命令与结果留在发起会话的命令历史。

父子共享工作目录，文件改动共同可见，同目录任务继续串行；分支不创建 Git 分支或工作副本，也不回滚文件。它不发模型请求、不复制任务、队列、审批、临时授权或用量。默认模型、思考档位、运行模式与确认工具独立继承；项目配置继续共享原来源。有效压缩点与工作清单各自延续，原图片、产物和已完成 SubAgent 结果按限定来源只读查询，原工作后续结果不进入该集合；管理原工作仍要回到其父会话。

`/compact` 主动生成滚动摘要，保留最后一个完整 assistant 回复批次及其后的原文尾部，工具调用与结果整批保留。`/compact 保留数据库迁移细节` 将指引补在固定摘要规则之后；首尾空白去掉，内部空格和换行保留，仅本次生效。空会话、没有可摘要内容或没有新增覆盖且未提供指引时无需压缩；已有摘要且提供指引时可重新聚焦旧摘要，无法恢复旧摘要遗漏的细节。完整历史仍可通过 `/search` 与历史工具查回，JSONL 不改写，命令与结果只保存到 TUI 命令历史。

手动压缩使用配置的摘要模型；未配置时使用接收时的会话模型，较早消息、旧摘要和本次指引会发给其提供方。一次尝试、最长 180 秒，输入预算不足、模型不可用、空输出、触顶或失败时不替换原有效点。会话有排队、正在启动或活动任务时拒绝压缩；压缩期间同会话新提交与继续被拒绝且输入保留，其他会话照常使用，也可查看或切换会话。`/interrupt` 取消当前在途压缩，已提交成功则报告成功；断开客户端不取消操作，后台停止或异常重启将未完成操作记为中断，不自动重调摘要模型。

成功结果显示摘要覆盖条数、实际摘要模型与历史上下文前后估算；估算包含完成历史视图与摘要，不含下一任务的项目指令、技能、记忆、工具定义及新输入，也不保证一定下降。`/context` 仍查询最近一次主模型调用，下一次实际调用才反映新点；手动压缩不会新增主模型调用或改写既有选择记录。

### 7.3 断开与重连

退出只关闭客户端，后台任务继续执行。重连后从后台重建快照、历史及任务事件，恢复思考、工具、完整正文和完成状态的顺序，按事件和消息身份去重；不自动新建任务、不恢复暂停队列。事件序号缺口或游标过旧时自动重新同步。

提交前生成 `request_id` 并把完整请求原子保存到拥有者私有目录（默认 `~/.ruukoto-code/pending/`，`RUUKOTO_CODE_PENDING_DIR` 可覆盖，0600）；应答丢失时显示「接收结果待核实」，按 `session_id + request_id` 核实（断线的等重连后，连接仍在的当场核实这一条）：已接收则关联原任务，明确未接收才以原键原参数重试；记录绑定数据实例标识，换新数据库后不会向空后台重发。未发送或后台明确拒绝时清除记录并恢复输入。

`/mode`、`/model`、审批应答丢失时：连接仍在立即查询后台状态，已断线则提示结果未知、以重连快照为准，都不自动重发。

分支请求在待确认目录的 `branches/` 保存原键及参数；应答丢失或退出重进后按原键查询，必要时重用原快照恢复发布。后台更换数据实例时保留记录供核实。已发布分支的历史缺失会明确拒绝，恢复历史后再继续，不能用空会话冒充原分支。

手动压缩请求在待确认目录的 `compactions/` 保存发起会话、原键、参数和数据实例身份直到终态。应答丢失、重连和退出重进先查询原请求，只有后台明确未接收才按原键重发；数据实例变化时保留原键供核实。另一客户端可查询当前会话最近一次压缩结果；结果归发起会话，切走后不会强制切回。

### 7.4 终端安全与恢复

消息、工具日志与审批参数渲染前剥离终端控制序列（CSI/OSC/APC，含 OSC 52 剪贴板写入与擦屏／光标控制），不可见控制字符显示为转义形式；只改变展示，不改动历史与执行参数。

正常退出、`SIGTERM`、`SIGHUP` 与可处理异常都会关闭 socket、恢复 raw mode／光标／屏幕，不发送 `stop` 或取消任务。进程被强杀（SIGKILL）时无法执行清理回调：如终端显示异常，执行 `reset` 或 `stty sane` 恢复。

## 8. 开发实例

`npm run dev` 用固定检出散列档案前台托管个人后台，`--config` 打开同一菜单，退出停止本次后台。默认入口由薄启动器托管 Node watch，源码变化后重启、失败可等待修正文件；`--config` 不监听源码，配置菜单源码变化须退出重开。忽略继承目录，拒绝已启用 QQ/Telegram 的档案，不修改原记录或连接平台。`npm run code` 保留 Coding 开发后台、TUI、`--config` 与 `--import-models`；详情见[开发说明](development.md#开发实例)。

## 9. 数据目录

个人默认 `~/.ruukoto-durable/`，`RUUKOTO_PERSONAL_DIR` 可选新目录；目录 0700，配置、日志、证据和令牌文件 0600。`profile.json` 保存格式，`owner.sqlite` 持锁，`personal.sqlite` 保存 durable 会话与执行，`model.json` 等文件保存宿主配置；`agent-data/main.db` 是独立业务库，本机 socket 与 `control.token` 用于运行中管理。旧 `RUUKOTO_DATA_DIR/AGENT_DIR/CONTROL_DIR/PENDING_DIR` 及 owner token 不配置新个人实例。

Coding 保留原结构：

```
~/.ruukoto-code/data/      0700  元数据库、会话 JSONL、产物、实例锁
~/.ruukoto-code/control/   0770  控制面 socket（0660）与拥有者令牌（0600）
~/.ruukoto-code/agent/     0700  models.json、auth.json、credentials.json、default-model.json
~/.ruukoto-code/pending/   0700  待核实的提交记录
```

Coding 只读 `RUUKOTO_CODE_{DATA,AGENT,CONTROL,PENDING}_DIR`，令牌可由 `RUUKOTO_OWNER_TOKEN_FILE` 指定；核心库拒绝跨产品归属。完整机制见[存储与身份](modules/core.md)，个人格式见[个人持久会话](modules/personal-durable.md)。

## 10. 故障排查

下列任务队列、事件与共享 MCP 诊断适用于 Coding。个人从菜单查询原输入、工作、效果和停止记录，按[引导与管理](#25-个人-agent-引导与管理)处理；旧目录或未知格式被拒绝时保留原资料并另选新目录，连接失败不能替代实例锁或停止证明。

### 10.1 后台起不来

| 现象 | 处理 |
| --- | --- |
| 「后台启动失败」并附 spawn.log 尾部 | 常见原因是未配置可用模型，先跑 `ruukoto-code config`；spawn.log 在 `<controlDir>/spawn.log` |
| socket 可连但令牌认证不通过 | 后台其实在运行；核对 `RUUKOTO_OWNER_TOKEN`、`RUUKOTO_OWNER_TOKEN_FILE` 与控制面目录的 `owner.token` |
| 等待超时 | 到期限仍未就绪，单独标注且不杀进程；确认 native 平台前置、宿主工具与 worker 构建产物可用 |
| 重复启动被拒绝 | 同一实例锁已在运行（`<dataDir>/runtime.lock`）；`ruukoto-code stop` 或确认已在运行的后台 |
| `schema_version_unsupported` | 档案版本与代码不一致；保留原档案并用匹配代码查阅，当前代码使用独立新档案，不修改版本号或补字段 |
| 实例锁无法核实 | 按 `owner.json` 的 `processIdentity` 核实进程启动身份；无法核实时保留锁并要求人工处理 |
| 队列不自动恢复 | 后台重启后有排队任务的会话暂停自动调度，用 `resume-queue` 显式恢复；`occupancy_unverified` 需先核实旧执行已退出 |

### 10.2 执行相关

| 现象 | 处理 |
| --- | --- |
| 完全访问工具启动失败 | 检查 worker、Node 与安装依赖；完全访问无需执行账户或沙箱配置，服务 helper 的缺失只影响服务工具 |
| 受限任务立即失败 | 按[原生部署前置](../deploy/native/README.md)核实 bubblewrap/profile、user manager/bus、cgroup 委派与宿主工具；能力缺失明确拒绝、不静默回退 |
| 任务已结束但目录仍被占用，或报 `tool_process_unreaped` / `mode_switch_unverified` / `worker_stop_unverified` | 从任务事件与占用查询核对未退出的执行单元；确认旧单元及其后代已退出后，再用上方 `resume-queue` 恢复，它释放该会话遗留任务的父目录与副本占用，并重建已结束的驱动器。worktree 创建与汇总保留副本现场和已收到的结果，不能把已完成工具或效果未知操作自动重放 |
| 旧 local/container 覆盖被拒 | 移除 `--execution` / `RUUKOTO_EXECUTION_BACKEND` 覆盖或明确改为 native；保留原档案，先完成平台前置 |

### 10.3 MCP

| 现象 | 处理 |
| --- | --- |
| 认证失败（401/403） | 凭据无效、已撤销或权限不足——核对 `credentials list` 中 host／用途／scope 与 PAT 权限 |
| 服务不可用事件 | 按事件中的 reason 区分连接失败、超时、协议不兼容（SDK 结果校验失败说明服务端违反 MCP 规范）与工具数／分页超限 |
| 工具缺失 | `mcp check` 对比远端实际工具与允许列表；远端改名须更新配置（下一任务生效） |
| 限流（429）与超时 | 一次终止并明确报错，不自动重试；由拥有者决定重试时机 |
| `snapshot_missing` / `snapshot_corrupt` / `snapshot_changed` | 保留原目录、副本、私有基线和历史，核实来源身份及文件是否仍完整；该工作不能继续/交付，不回退 HEAD 或自动重跑，向拥有者报告后重新准备新工作 |
| `version_conflict` | 带有 `--expected-version` 的调用发现版本不符；重新读取当前版本后再保存 |

### 10.4 消息入口

个人在菜单查询 QQ/Telegram 的绑定、连接与最近收发。只接纳已配对拥有者的私聊及支持的图文；重新配对或凭据变化须更新绑定代次，旧审批与未发送回复失效、不改发。QQ 断线缺口不承诺补拉，核实未受理后重新发送；已经接纳或发送效果未知时查询原记录，不新建请求重试。完整步骤见[个人引导与管理](#25-个人-agent-引导与管理)。

### 10.5 上下文与队列

| 现象 | 处理 |
| --- | --- |
| 任务以 `context_budget_exceeded` 中断 | 必留内容超过输入预算，任务中断并暂停队列；用 `/context` 查看分类估算，人工继续 |
| provider 返回 `context_overflow` | 任务中断并暂停队列，不自动压缩或重试；人工继续 |
| 模型配置无法应用 | `model_config_blocked`（有受影响任务）或 `model_config_busy`（正在应用）；等任务结束后重试 |
| 导入报 `revision_conflict` | 预览后源或目标发生变化，重新 preview 生成计划 |
| 回退被阻挡 | 导入后目标侧产生了新任务、事件、会话、授权或版本；返回 `ok: false`、`status: applied`，回执与资料保持原状 |

## 11. 已知限制

前两项工作区与手工队列恢复限制属于 Coding；个人的恢复、未知效果和停止核实限制见[个人引导与管理](#25-个人-agent-引导与管理)。

- 同一工作目录同时只允许一个写任务；并行修改靠 SubAgent 的 worktree，非 Git 目录串行。
- 上下文超出预算或 provider 返回 `context_overflow` 时任务中断、队列暂停，需人工继续。
- 原生任务使用实际后台账户的目录权限与宿主工具；HOME/TMPDIR 使用宿主临时磁盘，无单任务配额，停止未核实保留现场与占用。
- 服务器服务管理只覆盖白名单服务的检查与重启。
- 生产接管与最终候选组合另行验收；旧首期模拟与容器证据不代表新个人通过。跨端共享记忆、邮件、GitHub comment 渠道和独立 QQ 群聊外挂尚未交付；历史与当前证据入口见[发布与验收说明](release-acceptance.md)。

## 12. 浏览器

Coding 完全访问的普通开发会话可直接调用 `browser` 打开网页、操作表单和看截图。其他模式、Plan、SubAgent、定时、工作流和 GitHub 评审不开放。先在运行后台的机器准备 [agent-browser v0.39.1 官方原生资产](https://github.com/vercel-labs/agent-browser/releases/tag/v0.39.1)及可运行的 Chromium；无需安装要求 Node ≥24 的 npm wrapper，宿主继续支持 Node 22.19/24。程序按官方 SHA-256 和版本核实；准备缺失只使浏览器不可用，模型任务不自动安装或提权。

个人入口使用[浏览器配置向导](#25-个人-agent-引导与管理)保存路径和窗口选择；完全访问主输入及创建时已开放该能力的完全访问定时计划使用各自独立浏览器，子 Agent 和汇总不开放。它不读取下面的 Coding 变量，产物从向导导出。

```bash
RUUKOTO_BROWSER_BINARY=/absolute/path/agent-browser-darwin-arm64 \
RUUKOTO_BROWSER_CHROME="/absolute/path/Chromium" ruukoto-code server
# 浏览器变量由 Coding 后台读取；个人通过菜单配置
```

Linux 使用对应 linux 资产并准备系统库、可用 sandbox、持久磁盘空间；常驻服务将两个路径变量交给实际后台进程。默认 macOS 有头、Linux 无头。先让 Agent `start`，再打开登录页并 `pause`；按返回的 `dashboardUrl` 或有头窗口人工输入密码与验证码，密码不要发给 Agent。Linux 将该 URL 的端口经 `ssh -N -L 127.0.0.1:<本地端口>:127.0.0.1:<服务端端口> <主机>` 转发，只在本地打开。dashboard 只承担人工键鼠输入，不配置额外模型聊天。人工完成后发新消息让 Agent `resume`；原任务不能自行解除暂停。

接管已有浏览器先由拥有者启用本机 CDP，向 Agent 提供明确的 `http://127.0.0.1:<端口>` 或浏览器 WebSocket 地址并请求 `attach`。只接受 loopback，发现结果也重新核实地址和端口；同一目标跨产品、跨会话只允许一个自动化连接。`close`、取消或后台停止对附接仅断开自身连接，保留已有窗口和标签。不要把网络上的远程 CDP 地址交给该入口。

同一会话跨轮保留页面。默认空闲 60 分钟后回收，自有 profile、历史与截图保留；重新 `start` 只打开新页面，不恢复旧页面或重放点击/提交。持久 Cookie 与网站资料沿 Chromium profile 保存；没有到期时间的会话 Cookie 及网站自身的登录期限不保证跨关闭延续，必要时重新人工登录。

截图保存为不可变图片产物并交给视觉模型，用 `read-artifact <taskId> <artifactId> --output screenshot.png` 完整导出。纯文本模型在发送图片前明确报 `image_input_unsupported`；`image_too_large` 可改用视口截图；`artifact_write_failed` 检查磁盘与目录权限。动作报告 `outcome_unknown` 时先人工查看实际页面或服务端结果，再用新消息核实连接；不要重发原提交。`browser_stop_unverified` / `browser_identity_unverified` 先核对原进程及绑定，再显式 `close`；停止尚未核实前不会新开实例或释放接管占用。

## 桌面客户端

从「设置 → PA 远程连接 → 设置管理」填写同账户 SSH 别名与新 durable 档案，检测后选择安装程序和启动方式，保存本机连接，再「核实档案与服务」。新连接与旧聊天分开，检测成功不代表可写；未核实 CLI 环境、开发实例和缺部署前提均只读，按[部署说明](../deploy/systemd/README.md#桌面设置维护)恢复。维护失败先读取原档案与服务，已保存但未启动可点「恢复原服务」，该动作不重发保存；比较原草稿与当前配置后再结束人工核实。在模型、Skills、MCP 中选择 PA 即管理该远端档案，无需打开聊天。每项写入先「查看保存影响」，再确认「停止、保存并启动」；忙时先回原 IM 或管理入口处理未决事项，不自动取消工作。

检测程序失败时按显示的 SSH、档案或协议错误修复后重新检测；一个安装位置失败不影响另一个已检测成功的位置。

切换 PA 模型、Skills、MCP 或连接核实时，未完成的档案读取由新页面继续等待；模型测试、工具发现与保存等其他操作仍需等待原操作结束。首页的旧聊天「尚未配置」不表示设置管理离线；新 Personal 聊天使用 QQ/Telegram 或个人菜单。

按 ⌘K 或顶栏侧栏开关左侧的搜索图标查找当前 Code 实例全部工作区的普通会话与聊天正文，包含已存档会话；在 PA 页面同样搜索 Code，不包含 Personal 聊天。输入完整关键词，中文连续匹配、英文 ASCII 不分大小写；↑／↓选择、Enter 打开、Esc 或再次 ⌘K 关闭，非终端区域也支持 Ctrl+K。选择名称或正文结果都直接打开对应会话，保留原草稿与正常输入；向上滚动可加载更早消息。搜索结果滚动接近底部时自动续载，短消息完整显示，长预览尽量把匹配词放在中间；搜索框内图标表示正在读取；读取失败或离线时显示原因，恢复连接后可关闭并重新打开搜索。会话读取失败时显示原因。

MyGo 试验运行 `npm run desktop:mygo`，或打开已构建的 `dist/mygo/darwin-arm64/Ruukoto MyGo.app`；要求 macOS Apple Silicon，构建前提见[桌面开发](desktop-development.md#mygo-试验)。它沿用同一界面与后台，独立保存 Personal 配置和未决提交；切换外壳前先在原应用核实未知操作。MyGo 子进程失败时重新打开应用，Node 或仓库路径失效时重新构建。

从左下「设置 → 模型 → Code」管理本地提供方、模型、存储 API Key、后台默认模型／Effort 与摘要模型，无需打开会话。默认／Effort 与摘要模型在总览直接选择并自动保存；添加或编辑提供方时，在同一弹窗填写连接、存储 Key、模型容量及能力，API 类型从选择框选择。「目录密钥与请求头」按位置替换／清除，其余字段保留。点叉号放弃草稿并退出，左下角删除提供方，右下角保存；已发出的请求仍须核实。目录与存储 Key 分步保存，若部分成功按弹窗结果处理，秘密提交后输入清空。存储条目消失不表示没有其他认证来源。点击连接测试直接使用已保存配置联网且可能收费，不另弹确认窗；模型名旁黄、绿、红点表示未测试、成功、失败，失败详情可在圆点上查看，配置变更后需重新测试。发生冲突先比较当前值与保留草稿；应答丢失选择「核实原操作结果」，不要重新发起同一写入。PA 模型页编辑当前模型、API 类型、地址、容量、图片能力与凭据环境变量引用；「测试当前模型」使用当前草稿与实际后台环境，主动联网且可能收费，不保存配置。离线显示未核实；凭据缺失须恢复原后台环境。

从「设置 → Skills → Code」查看技能、诊断与正文，名称检索只作用于已取得列表，可继续加载更多。点击「导入技能目录」选择单个根含 SKILL.md 的本机目录，核对预览后确认；原目录保持不变，重名不覆盖。外部维护来源只读；托管副本可启停或移除。仅显式调用与停用分开，停用阻止新任务及新的显式调用，旧任务与原恢复引用继续可读。移除是逻辑移除，保留旧引用需要的包字节。清单冲突保留选择，重新读取比较后再选择目录；应答丢失点击「核实原操作结果」，不要重新导入。PA Skills 页通过远端目录逐层选择外部库（根下含 skills）或根含 SKILL.md 的单个技能包，预览后再停存启导入；不打开 Mac 选择器，不跨机上传。外部来源只读，托管启停与逻辑移除同样保留旧包字节。

从「设置 → MCP → Code」选择工作区与配置来源，无会话时默认工作区自身；多个旧项目来源按名称选择。添加服务时填写端点，显式选择匿名、已有凭据或新 Bearer 令牌；先保存禁用草稿，再点击「检查连接并发现工具」，逐项选择允许工具与本地副作用类别、保存并启用。发现会联网但不执行业务工具，远端只读注解不自动授权。省略凭据保留原引用，选择匿名才清除引用；清理凭据前查看服务引用，有引用时先更换或清除。停用或删除不取消已经发出的远端调用。版本冲突先比较草稿和当前值；丢答点击「重新读取 MCP 配置」核实原来源，不重新保存。PA MCP 页管理档案级服务，认证须显式匿名或引用远端私有凭据文件，文件无效不能降级匿名。发现后选择允许工具，调用仍经原审批；旧配置先显式迁入服务启停格式，新服务先保存为停用再启用。

在 macOS 运行 `npm run desktop:build` 后打开 `dist/mac-arm64/Ruukoto.app`。Code 可打开会话、提交输入、选择模型与会话默认模式、停止与继续任务、恢复暂停队列；日常应用采用登录 shell 的环境和日常 Code 档案，按需启动后台，退出应用后后台继续运行。开发入口与档案隔离见[开发说明](development.md#桌面客户端)。

左下设置可切换明暗主题；两侧边界支持拖动与方向键调宽，折叠后保留宽度。输入区加号选择本机附件，单会话草稿最多四个、每个最多 8 MiB；文件按选择时快照提交，不授予本机路径读取权限。普通文件交给 Agent 通过产物读取，JPEG、PNG、WebP 交给支持图片的模型；纯附件也可发送。核实期间原文与附件留在输入框，发送图标转为加载；接收确认后清空。长差异点击 more 续读，空文件显示空内容。

新增 Code 会话会继承当前或本次连接最近 Code 会话的模式、模型和 Effort；设置尚未保存或等待核实时，先核实再创建。模型菜单内可选择 Effort，模式和模型在窄输入区收为图标，底部按钮保持单排。Context 环形入口可查看最近一次已记录输入的三类估算，缺记录或容量时显示未知。执行时消息流末尾显示 Thinking 或 Working，Thinking下直接显示当前已记录reasoning，Working展开已完成与进行中的工具调用，reasoning位于组内首行；历史reasoning可折叠查看，现有记录最多保留8KiB尾部。Read 路径打开右栏预览，Edit／Write 展开差异，Bash 展开命令与结果，失败调用标红并显示错误。

右栏顶部加号可打开浏览器、当前工作区文件树或终端；终端先选择工作区，以该根目录启动默认shell，最多同时8个，切换标签／会话／Personal保留，关闭终端标签或所属会话结束进程，重载与退出丢失终端历史。它以桌面应用账户运行，可访问该账户的其他目录；后台断线不影响已打开终端。Git 工作区另有 Git graph，可展开提交详情；滚动接近底部自动加载更早提交，无总条数上限；超长历史只渲染可视区附近的行，滚出窗口的提交不再渲染，因此不参与文本选择、Ctrl+A 或浏览器查找（仅为保留焦点而渲染的行除外）；提交主题和分支名保持自然宽度，可左右滚动。仓库变更时按提示刷新，追加失败保留已有内容并可重试。文件只读，支持文本、Markdown 预览／源码与常见图片；单文件上限 256 KiB，目录最多显示 200 项。文件夹行末加载图标消失后展开，空目录留空，读取失败可重试。打开的文件树每3秒及窗口聚焦更新展开目录，关闭停止；工作区外成功 Read 可查看已捕获的当时版本，源文件删除后仍可读，缺少捕获时明确提示。浏览器接受无账号密码的HTTP(S)网址与本机file地址；本机文档可加载同目录资源，敏感路径、越界和超预算会拒绝，具体范围见[桌面模块](modules/desktop.md)。只打开可信本地文档，其脚本及CDN依赖可读取或转交该目录的预览能力。站点若禁止嵌入则无法显示，不授予网页定位、设备或桌面控制权。

版本不一致时，界面显示连接错误并停止自动重试。客户端较旧需重建应用；受管开发后台较旧需重启开发启动器；日常后台较旧用 `lsof -nP -U` 查询当前控制 socket，核对唯一 PID、所属用户与完整命令，人工结束后点“重新连接”。多 PID 或无法核对时先检查控制目录配置与 spawn.log，不发送信号；未查到监听进程先确认查询命令执行成功。桌面应用不会替你停止后台进程。仓库移动或 node 不可用时按界面提示修复环境或重建。

Personal 旧聊天 SSH 连接仅支持旧控制协议；从「PA 远程连接 → 旧聊天连接」配置，要求同账户部署：SSH 登录账户就是后台账户，且可访问控制目录、socket 与原 `owner.token`；只支持密钥或 ssh-agent 认证。建议在 `~/.ssh/config` 为桌面端单独配置不带 `LocalForward` 的主机别名，避免继承转发发生绑定冲突。令牌每次建连读取，本地不保存；账户或权限不符时按错误指引修正部署，不放宽令牌权限。左下设置的“PA 远程连接”保存主机别名与控制目录（默认 `/var/lib/ruukoto/control`）；工作区列表上方 Ruukoto 打开 PA 主会话，支持对话、附件和审批，右栏提供浏览器，也可从委派行打开SubAgent历史。远端与桌面端需使用相同控制协议，升级后重新连接。
