# Agent Note: 桌面客户端作为又一个控制面客户端

Status: proposed

## 问题

两个产品的交互入口只有 TUI、CLI 与 IM。拥有者需要一个 macOS 桌面界面，在同一窗口里操作本机的 ruukoto-code 与服务器上的 ruukoto，界面参考 [ui-demo](../../../../.scratch/desktop-gui/ui-demo.html)。

后续组件统一采用[先审定 shadcn demo 再迁移](../../implemented/architecture/2026-10-15-desktop-shadcn-demo.md)，视觉来源仍为本篇引用的原始 HTML，业务要求仍由现行规格持有。

约束来自三处：控制面只在本机 Unix socket 上监听，文档写明远程使用沿用登录服务器后启动 TUI、不新增远程协议；控制面协议要求客户端与服务端版本完全相等，`PROTOCOL_VERSION` 在 2026-09-20 到 2026-10-14 间从 1 升到 25；抽取前的 TUI 事件投影（`state.ts`、`event-flow.ts`）经 `workflows.ts` 间接依赖 pi-tui，并直接使用 Node API，不能原样运行在浏览器环境里。

## 方案

桌面客户端是控制面的又一个客户端，与 TUI 并存，可同时连接同一后台。它只经控制面读写后台事实；Code 目标另有本机系统动作：文件夹选择框、拥有者选中的附件快照与在 Finder 中显示。附件来源及上传按[附件通路](../../implemented/architecture/2026-10-16-owner-attachments.md)。缺少的能力以新增 op 补齐，TUI 同样可用。

外壳用 Electron。主进程运行 Node，直接复用 `@ruukoto/control` 的 `ControlConnection`、`SubmissionGuard` 与协议类型，与后台出自同一份 TS 源码；协议升版只需重建桌面端，不维护第二套客户端。渲染进程用 React 19 与 Tailwind v4。[MyGo 试验](../../implemented/architecture/2026-10-17-desktop-mygo-experiment.md)增加可对比外壳，最终选型待拥有者决定。

进程边界按安全要求划分。令牌、连接、ssh 子进程与后台拉起只在主进程；preload 只暴露订阅、带 op 放行名单的请求、文件夹选择与在 Finder 中显示；渲染进程开 sandbox 与 contextIsolation、关闭 nodeIntegration，CSP 只允许本地资源：打包页面经 `file://` 加载，拿不到 HTTP 响应头，所以策略以构建时插入的 HTML meta 交付；开发页面以响应头加 nonce 交付。Markdown 不渲染原始 HTML。模型与工具输出可能含网页或仓库里攻击者控制的内容；渲染进程一旦被注入脚本，最大的危害是代替拥有者调用 `respond_confirmation`，放行名单与 CSP 用来缩小这个面。

快照与事件到界面状态的投影抽到新包 `packages/view`，TUI 与桌面端共用。该包必须能在浏览器运行：不引 `node:*`、不用 Node 全局，对其他 workspace 包的值引用只能来自本身不依赖 Node 的模块：以浏览器为目标打包，再只按浏览器全局对产物做 `no-undef` 检查，以此判定，依赖模块里的 `Buffer` 这类自由变量也能查出来。抽取按桌面端需要逐步进行，每抽一块，TUI 就改为引用新位置，并以 TUI 既有测试回归。

协议版本保持严格相等。版本不一致时，桌面端显示双方版本和需要更新的一侧，不加兼容区间。服务端版本取自错误应答帧里已有的 `v`，经 `ControlClientError` 以结构化字段传出，不解析消息文本。仓库已升级而旧后台仍在运行时，新客户端无法经控制面停止它，因为服务端在认证前就拒绝版本不等的请求。桌面端只给出人工恢复步骤，自己不向进程发信号。要自动停止旧后台，必须证明被停止的进程就是拒绝连接的那个实例，这部分另立工单处理。

Code 目标只拉起与桌面端同一份仓库代码的 ruukoto-code：.app 在构建时记录仓库路径，后台未运行时，用登录 shell 解析出的 node 执行该路径下的 bin。控制面的 `ensureBackend` 以 `spawnExecPath` 指定可执行文件（默认 `process.execPath`），`spawnArgv` 只放 bin 及服务参数；把 node 塞进 `spawnArgv` 会让宿主把二进制当脚本，不能选择外部 Node。`spawn` 失败按系统 `code` 分类并给出路径与修复指引：`ENOENT` 为找不到 node，`EACCES` 为 node 不可执行，其余附原码；先探测再报告，其他后台已经就绪则按复用返回，不等待退出宽限窗口，也不杀后台。路径与令牌须按登录 shell 环境解析，`ensureBackend.env` 只影响子进程；后台脱离运行，退出桌面端不停止后台。

`packages/control/src/connect.ts` 的 `defaultDataDir`、`defaultAgentDir`、`controlDirFor` 接受可选的显式产品参数，省略时仍调用 `productFromEnv()`，保留 CLI／TUI 约定；显式参数让主进程可交替解析两个产品且不改全局身份。`resolveClientConfig` 不扩参数，跨产品调用时传全 `dataDir` 与 `controlDir`；`PendingRequestStore` 沿用显式目录入参。

个人 Agent 目标经 SSH 转发控制面 socket：`ssh -N -L <本地 socket>:<远端 control.sock> <host>`，使用拥有者的 `~/.ssh/config` 与密钥或 ssh-agent，不支持交互式密码。每次控制面建连前，都经 ssh 预检远端 socket 并读取令牌，令牌只保存在主进程内存；为此，`ControlConnection` 的令牌改为可按次获取。只支持同账户部署，即 SSH 登录账户就是后台账户，与当前部署步骤一致；令牌读的是原文件，所以轮换后下一次建连就能读到新令牌。两条 ssh 命令都显式关闭连接复用与认证后转入后台，确保桌面端持有的子进程就是实际的监听者。ssh 转发由主进程的监督者负责重启，控制面由 `ControlConnection` 负责重连，连接是否在线以认证完成并装好快照为准。握手快照新增产品身份，协议升到 v26，桌面端拒绝连到产品不符的后台。后台仍只监听本机 Unix socket，认证仍是 SSH 身份加拥有者令牌，与登录服务器启动 TUI 的权限相同。实施时把远程使用的说明改为：登录服务器后启动 TUI，或由桌面客户端经 SSH 转发控制面 socket；不新增远程协议。

桌面端放在 `apps/desktop/`，依赖全部列为 devDependencies。运行时依赖都会打进产物，所以服务器的 `npm ci --omit=dev` 不受影响；ESLint 的依赖边界检查为此只对这个包放开一条：值引用可以来自 devDependencies。CI 设 `ELECTRON_SKIP_BINARY_DOWNLOAD=1`，只跑不依赖 Electron 的检查。构建用 electron-vite，打包用 electron-builder 的目录产物并 ad-hoc 签名；首版只在 macOS 验收，只供拥有者自用。

需求、范围与验收归[规格](../../../../.scratch/desktop-gui/spec.md)，实施步骤归 `.scratch/desktop-gui/issues/`。拥有者已逐轮确认四轮共 22 题并确认整体方案；共享投影已抽取，落地归[同仓分包决定](../../implemented/architecture/2026-10-11-in-repo-workspace-packages.md)，整体桌面客户端仍待交付，因此保持 proposed。

## 当前落地边界

外观与交互以拥有者已认可的[shadcn 定稿迁移](../../implemented/architecture/2026-10-15-desktop-shadcn-demo.md)为准；本提案保留后台状态、安全与进程边界，下文旧参数展开、额外诊断卡及固定右栏要求不再约束正式界面。

Code 桌面已采用本提案的进程、安全、配置来源与构建方案：主进程持有连接与令牌，渲染进程复用 view 显示工作区与会话树、标签页和正文／思考／工具对话流，preload 单文件 CommonJS；开发与打包的 CSP 分开交付。结构化版本信息沿既有 v 字段传递；Personal 产品身份随握手快照加入，产品身份从 v26 提供；附件契约升版由后继迁移持有。请求名单按界面需要开放创建、读取、模型与会话默认模式设置、任务控制和队列恢复；提交与继续由主进程持久守护，本地恢复操作不转发。审批卡片与通知已接入两个目标，Personal 完整会话界面尚未交付，因此整体保持 proposed。

会话恢复的请求编排留在渲染进程，投影继续共用 view；每次快照递增请求代次，连同同连接重同步一起让旧历史、任务和正文补读失效。任务事件从零读起，不把详情 seq 当作事件游标；正文按 TextEncoder 的 UTF-8 字节计数连续补读。只装快照和历史会缺失思考、工具身份与长正文，直接照搬 TUI 的 Buffer 又无法在浏览器运行。

Code 右栏复用同一会话恢复和 Conversation 组件读 SubAgent 历史，选中子会话也纳入新快照重载和实时条目补读。工作委托读 work_list／work_get，全部 SubAgent 从共享快照与事件取得，避免只显示工作首位承接者。任务终态不等于空闲，工作查询从后台读回 idle／unverified；在途读取使用代次与查询序号，新的事件刷新不被旧查询覆盖。通知定位父会话时同时打开子会话右栏。

差异按工具调用展示，读取资格与结果状态分开：entryId 只控制正文能否读取，不覆盖失败或效果未知。只有 done 且 read_tool_result 明确返回 isError: false 才展示 patch 或 writeContent；缺字段明确不可用，空字符串则是有效空文件。历史的 writeContent 从调用参数恢复，失败时可能仍有内容，因此不能当作写入成功的依据，也不用有界参数预览补位。工具结果预览与单页上限为 64 KiB，按[分页决定](../../implemented/feature/2026-10-16-tool-result-pagination.md)读取剩余内容；小组件只按 unified patch 行类型呈现，不增加 Accept／Reject、语法高亮或文件读取。

正文与思考中的 Markdown 图片只显示替代说明。react-markdown 默认拒绝 file:，但 file 页面里的绝对路径和相对路径仍能加载本机文件；真实 Electron 探针已用临时自有 PNG 复现。仅关闭原始 HTML 或依赖 default-src self 都挡不住这条路径。首版没有直接文件读取能力，因此不用图片元素加载 URL；不增加文件代理或远程图片放行。

添加工作区与新建会话共享一条待完成创建记录，持有原键、参数、目标与 instanceId；同一待核实操作只按原键恢复，成功后的独立操作生成新键。在线应答丢失当场核实，断线与未发送等新快照再核实，找不到最多重发一次；未知状态保留并提示查树。快照代次只控制读取，不能丢掉用户尚未确认的创建结果。新实例里找不到原键不能证明旧实例未接收，因此实例不符既不重发，也不采纳旧响应，直到连回原实例核实。渲染进程不能引用含 node:fs 的 workspace 助手，故以小型创建状态机沿用同样语义，不引入新协议或通用请求框架。

提交与继续复用 SubmissionGuard，记录放在应用数据目录并按目标及控制目录摘要隔离；保存完整原参数、原请求键和数据实例。重复点击复用待核实记录。每次 onSnapshot 安装后触发串行核实，在线丢答也当场触发；运行中只合并一个后续轮次，不能依赖同连接重同步没有的第二次 online。守护的请求沿控制器脱敏，跨 await 仍核对原连接与实例，避免旧输入流入新数据库。

缺模型且确认未接收时保留记录，由拥有者选择恢复。主进程只读交付，渲染进程按请求键合并原文与继续来源，之后确认严格删除；清理失败保留禁用，重复确认幂等。原文进入所属会话草稿前保留唯一持久副本，不把先删后返回当成恢复。PendingRequestStore 增加严格 read/remove，仅 ENOENT 表示不存在；宽容 list 空结果无法证明删除成功，既有 clear/list 调用方不改变。普通草稿仍只在内存中按实例与会话隔离，已知未发送的迟到应答恢复原实例草稿，不安装到当前新实例。

模型和默认模式使用版本条件更新；应答丢失与冲突读回实际值，不重放设置。设置应答只更新版本化字段，队列恢复与查询按读取期间的快照／队列事件代次防回滚。任务中断与取消在线丢答读详情，断线等待同实例快照。旧队列先确认缺模型数量与具体模型，再显式传 model_selection；修改会话模型本身不能回填旧任务。模式标签留在浏览器模块，避免从含 node:crypto 的 core/types 值导入常量破坏开发页面。

开发时导航拦截允许配置的完整渲染文档 URL 自身重载：electron-vite 的 preload watch 用完整页面重载应用新桥接，若一律拦截，会把开发页面送到没有 preload 的系统浏览器。同源其他路径仍拦截并外开，不为 HMR 放开任意页面导航。

打包与开发入口的包边界、依赖和进程管理事实分别同步[同仓分包](../../implemented/architecture/2026-10-11-in-repo-workspace-packages.md)与[开发启动器](../../implemented/process/2026-10-09-dev-launchers.md)。macOS 恢复指引按实际 control.sock 生成 lsof 命令，路径按 shell 单引号转义；未查到监听进程时先核对命令是否成功，多匹配或无法核对时停止人工步骤。桌面端不向后台进程发送信号，版本拒绝后仅显式 reconnect 会再试；日常模式重走 ensureBackend，受管模式只连接。

Personal 连接监督者已落在主进程，与 Code 各自持有状态。配置只存主机别名和远端控制目录，输入白名单与 shell 转义同时存在：spawn 的 argv 不能保住远端 shell 参数边界，Unix socket 转发的冒号又有独立语法。原始令牌每次建连经 SSH 获取，不用权限不同的副本；同账户部署是支持前提，权限预检不能识别所有不同账户的历史部署。

读取命令清除用户配置的转发，15 秒总期限覆盖连接和远端读取，令牌输出上限 64 KiB；转发保留用户配置的其他转发，因此其绑定错误必须独立判为终止失败。其他转发退出（包括 0、255、外部信号）只负责退避重启，认证和配置错误归每次建连的预检分类。stderr 留有界尾部并固定 C locale。二者禁用复用、后台化和 RemoteCommand，才能在关闭／改配置时等待自有进程退出后复用 socket；仅 StreamLocalBindUnlink 不能证明旧监听者已退出。

共享 ControlConnection 在每个异步阶段核对代次，握手检查放在安装快照之前；只在 sync 返回后检查挡不住迟到快照。expectedProduct 可选，桌面两个目标启用，其他调用方保持固定令牌与既有行为。Personal 界面尚未开放，桥接先仅开放配置、重连与订阅，业务 op 留在界面要求确认后接入；不提前复制 Code 提交守护。

## 既有笔记审计

按远程、ssh、GUI、桌面、客户端、投影、workspaces 与协议版本检索 active notes。proposed 与 rejected 中没有同题记录；不修改归档。

| 笔记 | 关系与处理 |
| --- | --- |
| [后台任务与终端](../../implemented/architecture/2026-09-19-detach-terminal-from-task-runtime.md) | 沿用：后台与客户端分离、本机 socket 加令牌、按 seq 恢复、客户端断开不取消任务、探测与复用。桌面端是又一个客户端；SSH 转发后，后台看到的仍是本机 socket 连接。不改其决定。 |
| [两个 Agent 产品](../../implemented/architecture/2026-10-02-two-agent-products.md) | 沿用：两个产品各自的档案、socket 与实例锁。桌面端按显式产品分别解析路径，不新增跨产品通道。 |
| [同仓 workspaces 分包](../../implemented/architecture/2026-10-11-in-repo-workspace-packages.md) | 部分扩展：新增 `packages/view` 与 `apps/desktop`，依赖方向增加 `tui → view`。实施时就地同步该笔记的包表与依赖方向。 |
| [开发启动器](../../implemented/process/2026-10-09-dev-launchers.md) | 沿用：开发前端只连接启动器管理的后台。受管的桌面开发前端不执行登录 shell，也不自行拉起后台；日常 .app 才按需拉起。 |
| [浏览器自动化](../../implemented/feature/2026-10-14-agent-browser.md) | 引用：dashboard 已用 `ssh -L` 转发并只在本地打开，是本方案转发方式的先例。桌面端浏览器页推迟，不改其决定。 |

## 审批与通知的恢复

主进程与渲染进程分别持有 view，共用同一待审批选择器：审批为 pending、任务非终态、权限版本一致才显示和计数。后台结束任务或改变权限只把旧审批写成 stale，不保证产生解决事件，因此不能靠解决事件累减角标。终态常量放在 core 的无 Node 模块，避免破坏浏览器投影。

`task.mode_switch_failed` 目前只由 Store.endTask 的 interrupted 分支产生，不另发普通中断事件；view 因此直接把仍处于非终态的任务设为 interrupted，补结束时间、清理待切模式，并保留失败原因。已有终态不被迟到事件改写。若后台将来在非终态也发该事件，必须改为 get_task 核实；停止未核实始终不代表安全停止。

审批应答绑定目标、实例、审批 ID 与展示的权限版本，永不自动重发。在线丢答查询原任务的审批状态，断线等同实例快照；查询失败或旧于实时事件保留结果未知，提供刷新入口。权限版本改变会失效旧参数详情，读完新详情才能再次决定。快照递增请求代次，旧详情、应答和核实不得复活卡片或跨实例安装。

通知基线按目标与实例维护已见审批、终态和观察中任务。首次快照及不超过其截止 seq 的历史补发静默，缓冲 live 新事件照常通知，不能等 online 才解除静默。前台照常登记已见，后台不补发前台已见记录；取消只记终态。角标从两个当前审批集合求和，不靠事件累加。同实例快照未包含的观察中任务经 get_task 查询，失败留下次快照再查；Personal 在同步窗口允许这个只读查询。基线仅在应用内存中；不扫描全部历史，离线期间创建又结束且没有补发、已超出快照范围的任务不补通知。这用有限恢复覆盖已观察工作，避免另建通知服务。

点击通知经目标订阅发出带实例的导航意图，成功定位后消费，保留独立的子会话与任务选择供右栏使用。旧实例通知只提示原目标变化。

## 备选方案

- Tauri：用系统 WKWebView，安装包小。主进程是 Rust，复用客户端需要另带 Node sidecar；用 Rust 重写客户端则每次协议升版都要改两边，以当前升版频率不可承受。
- SwiftUI 原生：体验最原生。协议、客户端与投影都要用 Swift 重写，demo 也不能复用。
- 服务器开 TCP 或 WebSocket 监听并加 TLS 与令牌，或只在 Tailscale 私网暴露：桌面端不依赖本机 OpenSSH，重连更直接。这是新的远程协议，扩大攻击面，并推翻现有远程使用决定；SSH 转发服务端零改动，认证沿用既有 SSH 身份。
- 令牌存 Keychain：重连少一次 ssh 往返。本机会多一份静态秘密与 Keychain 代码，服务器换令牌后还要手动更新；每次经 ssh 读取更简单，并自动跟上轮换。
- 把后台打包进 .app，以 `ELECTRON_RUN_AS_NODE` 运行：.app 自包含，不依赖仓库路径与登录 shell。Electron 自带的 Node 不一定满足 `>=22.19` 与 `node:sqlite`，原生沙箱的构建产物也要跟着打包。
- 桌面端自写投影：不必先重构 TUI。协议高频变动下，两套去重、补发与正文拼接逻辑会各自漂移。
- 投影放在主进程，只把视图状态推给渲染进程：渲染进程更薄。要多一层状态同步协议，收益不足以抵消。
- 协议兼容区间或能力协商：允许桌面端与后台版本错开。与「线上协议直接替换、不适配旧格式」冲突，以当前升版频率维护成本高；单一拥有者在部署服务器时顺带重建桌面端即可。
- Code 目标直接读本地文件系统与 git：@File 与 diff 不必等新 op。两个目标会走两条路径，个人 Agent 目标用不了，也绕开了控制面与操作账本。
- 像 `verification/foundation` 一样放在 workspaces 之外、自带锁文件：CI 完全不受影响。要靠路径别名引用共享包，ESLint 的依赖边界检查不到它。
- 切换目标时断开另一条连接，或两个目标各开一个窗口：实现更简单。个人 Agent 的待审批需要随时可见，断开会漏掉。

- 删除待核实记录后再跨 IPC 返回原文：主进程更少状态，但交付失败会丢掉唯一持久副本。采用只读交付、草稿合并、严格确认清理三步；无需持久化所有普通草稿。
- 用宽容 `list()` 的空结果证明已清除：复用入口最少，但列目录失败同样返回空列表，不能解除发送禁用。新增严格读与删，保留其他调用方策略。

## 验收标准

[规格](../../../../.scratch/desktop-gui/spec.md)的各项要求逐项给出证据：投影抽取后 TUI 既有测试通过，`packages/view` 不含 Node 依赖；放行名单外的 op 被主进程拒绝，令牌不出现在 IPC 载荷与本地文件中；版本不一致时显示双方版本且不重试；后台未运行时 .app 能拉起后台，并与 TUI 同时连接同一后台，退出 .app 后后台仍在运行；ssh 进程被杀后按退避恢复，远端令牌更换后下次建连可用；CI 四个 job 不下载 Electron 二进制。GUI 行为由人工检查清单验收，归外部验收，缺环境时记为不可验证。

## 风险

- .app 依赖构建时记录的仓库路径与登录 shell 里的 node；仓库移动或 node 版本切换后拉起失败，必须显示可操作的错误，由拥有者修正或重建。
- 主进程运行在 Electron 自带的 Node 上；`@ruukoto/control` 及其传递依赖必须兼容该版本，升级 Electron 时要复核。
- 协议严格相等要求服务器部署与桌面端构建来自同一 commit；忘记重建时个人 Agent 目标不可用，直到重建。
- SSH 转发依赖本机 OpenSSH 与免交互认证；需要密码或 2FA 的主机不支持。
- 抽取投影层会改动 TUI 的核心状态代码，回归质量取决于 TUI 既有测试的覆盖面。
- 渲染进程使用第三方 Markdown 与 UI 库，安全依赖 CSP、op 放行名单与关闭原始 HTML 三者同时成立。

环境准备时机与轻量就绪探测由[启动优化](../../implemented/bug-fix/2026-10-17-desktop-connection-startup.md)持有；本篇其他决定继续适用。
