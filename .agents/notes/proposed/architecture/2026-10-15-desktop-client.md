# Agent Note: 桌面客户端作为又一个控制面客户端

Status: proposed

## 问题

两个产品的交互入口只有 TUI、CLI 与 IM。拥有者需要一个 macOS 桌面界面，在同一窗口里操作本机的 ruukoto-code 与服务器上的 ruukoto，界面参考 [ui-demo](../../../../.scratch/desktop-gui/ui-demo.html)。

约束来自三处：控制面只在本机 Unix socket 上监听，文档写明远程使用沿用登录服务器后启动 TUI、不新增远程协议；控制面协议要求客户端与服务端版本完全相等，`PROTOCOL_VERSION` 在 2026-09-20 到 2026-10-14 间从 1 升到 25；抽取前的 TUI 事件投影（`state.ts`、`event-flow.ts`）经 `workflows.ts` 间接依赖 pi-tui，并直接使用 Node API，不能原样运行在浏览器环境里。

## 方案

桌面客户端是控制面的又一个客户端，与 TUI 并存，可同时连接同一后台。它只经控制面读写后台事实；唯一例外是 Code 目标的本机系统动作：文件夹选择框与在 Finder 中显示。缺少的能力以新增 op 补齐，TUI 同样可用。

外壳用 Electron。主进程运行 Node，直接复用 `@ruukoto/control` 的 `ControlConnection`、`SubmissionGuard` 与协议类型，与后台出自同一份 TS 源码；协议升版只需重建桌面端，不维护第二套客户端。渲染进程用 React 19 与 Tailwind v4。

进程边界按安全要求划分。令牌、连接、ssh 子进程与后台拉起只在主进程；preload 只暴露订阅、带 op 放行名单的请求、文件夹选择与在 Finder 中显示；渲染进程开 sandbox 与 contextIsolation、关闭 nodeIntegration，CSP 只允许本地资源：打包页面经 `file://` 加载，拿不到 HTTP 响应头，所以策略以构建时插入的 HTML meta 交付；开发页面以响应头加 nonce 交付。Markdown 不渲染原始 HTML。模型与工具输出可能含网页或仓库里攻击者控制的内容；渲染进程一旦被注入脚本，最大的危害是代替拥有者调用 `respond_confirmation`，放行名单与 CSP 用来缩小这个面。

快照与事件到界面状态的投影抽到新包 `packages/view`，TUI 与桌面端共用。该包必须能在浏览器运行：不引 `node:*`、不用 Node 全局，对其他 workspace 包的值引用只能来自本身不依赖 Node 的模块：以浏览器为目标打包，再只按浏览器全局对产物做 `no-undef` 检查，以此判定，依赖模块里的 `Buffer` 这类自由变量也能查出来。抽取按桌面端需要逐步进行，每抽一块，TUI 就改为引用新位置，并以 TUI 既有测试回归。

协议版本保持严格相等。版本不一致时，桌面端显示双方版本和需要更新的一侧，不加兼容区间。服务端版本取自错误应答帧里已有的 `v`，经 `ControlClientError` 以结构化字段传出，不解析消息文本。仓库已升级而旧后台仍在运行时，新客户端无法经控制面停止它，因为服务端在认证前就拒绝版本不等的请求。桌面端只给出人工恢复步骤，自己不向进程发信号。要自动停止旧后台，必须证明被停止的进程就是拒绝连接的那个实例，这部分另立工单处理。

Code 目标只拉起与桌面端同一份仓库代码的 ruukoto-code：.app 在构建时记录仓库路径，后台未运行时，用登录 shell 解析出的 node 执行该路径下的 bin。控制面的 `ensureBackend` 以 `spawnExecPath` 指定可执行文件（默认 `process.execPath`），`spawnArgv` 只放 bin 及服务参数；把 node 塞进 `spawnArgv` 会让宿主把二进制当脚本，不能选择外部 Node。`spawn` 失败按系统 `code` 分类并给出路径与修复指引：`ENOENT` 为找不到 node，`EACCES` 为 node 不可执行，其余附原码；先探测再报告，其他后台已经就绪则按复用返回，不等待退出宽限窗口，也不杀后台。路径与令牌须按登录 shell 环境解析，`ensureBackend.env` 只影响子进程；后台脱离运行，退出桌面端不停止后台。

`packages/control/src/connect.ts` 的 `defaultDataDir`、`defaultAgentDir`、`controlDirFor` 接受可选的显式产品参数，省略时仍调用 `productFromEnv()`，保留 CLI／TUI 约定；显式参数让主进程可交替解析两个产品且不改全局身份。`resolveClientConfig` 不扩参数，跨产品调用时传全 `dataDir` 与 `controlDir`；`PendingRequestStore` 沿用显式目录入参。

个人 Agent 目标经 SSH 转发控制面 socket：`ssh -N -L <本地 socket>:<远端 control.sock> <host>`，使用拥有者的 `~/.ssh/config` 与密钥或 ssh-agent，不支持交互式密码。每次控制面建连前，都经 ssh 预检远端 socket 并读取令牌，令牌只保存在主进程内存；为此，`ControlConnection` 的令牌改为可按次获取。只支持同账户部署，即 SSH 登录账户就是后台账户，与当前部署步骤一致；令牌读的是原文件，所以轮换后下一次建连就能读到新令牌。两条 ssh 命令都显式关闭连接复用与认证后转入后台，确保桌面端持有的子进程就是实际的监听者。ssh 转发由主进程的监督者负责重启，控制面由 `ControlConnection` 负责重连，连接是否在线以认证完成并装好快照为准。握手快照新增产品身份，协议升到 v26，桌面端拒绝连到产品不符的后台。后台仍只监听本机 Unix socket，认证仍是 SSH 身份加拥有者令牌，与登录服务器启动 TUI 的权限相同。实施时把远程使用的说明改为：登录服务器后启动 TUI，或由桌面客户端经 SSH 转发控制面 socket；不新增远程协议。

桌面端放在 `apps/desktop/`，依赖全部列为 devDependencies。运行时依赖都会打进产物，所以服务器的 `npm ci --omit=dev` 不受影响；ESLint 的依赖边界检查为此只对这个包放开一条：值引用可以来自 devDependencies。CI 设 `ELECTRON_SKIP_BINARY_DOWNLOAD=1`，只跑不依赖 Electron 的检查。构建用 electron-vite，打包用 electron-builder 的目录产物并 ad-hoc 签名；首版只在 macOS 验收，只供拥有者自用。

需求、范围与验收归[规格](../../../../.scratch/desktop-gui/spec.md)，实施步骤归 `.scratch/desktop-gui/issues/`。拥有者已逐轮确认四轮共 22 题并确认整体方案；共享投影已抽取，落地归[同仓分包决定](../../implemented/architecture/2026-10-11-in-repo-workspace-packages.md)，整体桌面客户端仍待交付，因此保持 proposed。

## 既有笔记审计

按远程、ssh、GUI、桌面、客户端、投影、workspaces 与协议版本检索 active notes。proposed 与 rejected 中没有同题记录；不修改归档。

| 笔记 | 关系与处理 |
| --- | --- |
| [后台任务与终端](../../implemented/architecture/2026-09-19-detach-terminal-from-task-runtime.md) | 沿用：后台与客户端分离、本机 socket 加令牌、按 seq 恢复、客户端断开不取消任务、探测与复用。桌面端是又一个客户端；SSH 转发后，后台看到的仍是本机 socket 连接。不改其决定。 |
| [两个 Agent 产品](../../implemented/architecture/2026-10-02-two-agent-products.md) | 沿用：两个产品各自的档案、socket 与实例锁。桌面端按显式产品分别解析路径，不新增跨产品通道。 |
| [同仓 workspaces 分包](../../implemented/architecture/2026-10-11-in-repo-workspace-packages.md) | 部分扩展：新增 `packages/view` 与 `apps/desktop`，依赖方向增加 `tui → view`。实施时就地同步该笔记的包表与依赖方向。 |
| [开发启动器](../../implemented/process/2026-10-09-dev-launchers.md) | 沿用：开发前端只连接启动器管理的后台。受管的桌面开发前端不执行登录 shell，也不自行拉起后台；日常 .app 才按需拉起。 |
| [浏览器自动化](../../implemented/feature/2026-10-14-agent-browser.md) | 引用：dashboard 已用 `ssh -L` 转发并只在本地打开，是本方案转发方式的先例。桌面端浏览器页推迟，不改其决定。 |

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

## 验收标准

[规格](../../../../.scratch/desktop-gui/spec.md)的各项要求逐项给出证据：投影抽取后 TUI 既有测试通过，`packages/view` 不含 Node 依赖；放行名单外的 op 被主进程拒绝，令牌不出现在 IPC 载荷与本地文件中；版本不一致时显示双方版本且不重试；后台未运行时 .app 能拉起后台，并与 TUI 同时连接同一后台，退出 .app 后后台仍在运行；ssh 进程被杀后按退避恢复，远端令牌更换后下次建连可用；CI 四个 job 不下载 Electron 二进制。GUI 行为由人工检查清单验收，归外部验收，缺环境时记为不可验证。

## 风险

- .app 依赖构建时记录的仓库路径与登录 shell 里的 node；仓库移动或 node 版本切换后拉起失败，必须显示可操作的错误，由拥有者修正或重建。
- 主进程运行在 Electron 自带的 Node 上；`@ruukoto/control` 及其传递依赖必须兼容该版本，升级 Electron 时要复核。
- 协议严格相等要求服务器部署与桌面端构建来自同一 commit；忘记重建时个人 Agent 目标不可用，直到重建。
- SSH 转发依赖本机 OpenSSH 与免交互认证；需要密码或 2FA 的主机不支持。
- 抽取投影层会改动 TUI 的核心状态代码，回归质量取决于 TUI 既有测试的覆盖面。
- 渲染进程使用第三方 Markdown 与 UI 库，安全依赖 CSP、op 放行名单与关闭原始 HTML 三者同时成立。
