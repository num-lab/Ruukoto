# apps/desktop 骨架：主进程、preload、安全基线、开发与打包入口

Status: ready-for-agent

## 目标与边界

实现[规格 R1、R3、R5、R7、R8、R14、R17、R18](../spec.md)：做一个能连上 Code 目标、显示连接状态与工作区列表的空壳，安全基线与构建链在这一单一次立好。界面功能从 04 起逐步加入。

## 方案

1. **包与打包。** 新建 `apps/desktop`，用 electron-vite 构建三个目标，依赖全部列为 devDependencies。不定义名为 `build` 的脚本，免得根级 `npm run build --workspaces --if-present` 触发 Electron 打包。根级 `npm run desktop:build` 依次执行 `electron-vite build`、产物检查脚本 `apps/desktop/scripts/check-build.mjs`（见验收）和 electron-builder `--mac --dir`：`directories.output` 指向根目录 `dist/`，产物在 `dist/mac-arm64/Ruukoto.app`；`mac.identity: "-"` 做 ad-hoc 签名。主进程与 preload 的产物只允许 `electron` 和 Node 内置模块作为外部依赖，workspace 包的 `.ts` 源码一律打进产物。
2. **依赖边界检查。** `scripts/workspace-boundaries.mjs` 加一条只作用于 `apps/desktop` 的规则：该包的值引用可以来自 `devDependencies`，因为它的依赖都会打进产物，生产安装用不到。其他包仍只认 `dependencies`；未声明依赖、跨包相对路径、动态 import 的检查对桌面包照常生效。同时就地更新[同仓 workspaces 分包](../../../.agents/notes/implemented/architecture/2026-10-11-in-repo-workspace-packages.md)的说明。桌面依赖声明在 `apps/desktop/package.json`，安装更新的是根锁文件，不另建锁文件。
3. **主进程的两种配置来源。** 由启动方式决定：
   - **日常 .app**（默认）：启动时从登录 shell（`$SHELL -ilc`）取一次 `node` 路径与环境。Code 目标的路径和令牌都按这份环境解析，不按 .app 自己的进程环境：`connect.ts` 与令牌解析读的是当前进程的 `process.env`，而 `ensureBackend` 的 `env` 只传给子进程。做法二选一：解析前先采用这份环境，或者从中取出路径覆盖变量与令牌变量后显式传入。按 02 显式传产品，并同时传 `dataDir` 与 `controlDir`。后台没运行时调用 `ensureBackend`：`spawnExecPath` 用登录 shell 里的 `node`，`spawnArgv` 指向构建时经 electron-vite `define` 记录的仓库路径下的 bin，`env` 用登录 shell 环境。
   - **受管开发前端**（由开发启动器拉起，启动器在子进程环境中设 `RUUKOTO_DESKTOP_MANAGED=1`）：不执行登录 shell，因为重新执行 shell 配置会把启动器洗掉的日常令牌和日常目录重新带回来。路径、令牌都直接用启动器给的环境：它已经清洗过，并注入了完整的开发档案目录，令牌从开发档案控制目录里的 `owner.token` 读取。绝不调用 `ensureBackend`；后台不可用时只等 `ControlConnection` 重连。这条沿用[开发启动器的决定](../../../.agents/notes/implemented/process/2026-10-09-dev-launchers.md)：开发前端只连接启动器管理的后台。
   - 两种来源下，仓库路径缺失、node 不可用都显示可操作的错误。Personal 目标的令牌由 08 经 SSH 读取，直接交给该目标的连接，不走上面的令牌解析。
4. **版本信息结构化传递。** 服务端的错误应答帧本来就带有服务端版本 `v`，所以线上协议不变，`PROTOCOL_VERSION` 不升版。改动如下：
   - `ControlClient` 收到 `protocol_version` 错误时，在 `ControlClientError` 上附加 `versions: { client, server }`。
   - `ControlConnection.onState` 增加一个可选参数，进入 `failed` 时把这个错误对象一并传出。
   - `ensureBackend` 的失败结果增加可选的 `code` 与 `versions`。
   - 服务端错误消息按方向给提示：请求版本较旧时，提示升级客户端；请求版本较新时，说明后台版本较旧，需要结束旧后台进程后重开。TUI 显示的就是这条消息，所以同样受益。
   - 桌面端只根据 `versions` 判断该更新哪一侧，不解析 message，也从不向任何进程发信号。
     - 客户端较新、Code 目标：旧后台的版本较旧，新版本的 `ruukoto-code stop` 也连不上它，因为服务端在认证之前就拒绝版本不同的请求。桌面端显示双方版本和当前控制目录，并给出人工恢复步骤。查找依据是当前连接实际使用的 `<控制目录>/control.sock`，不用数据目录或命令行子串：数据目录与控制目录可以分别配置，后台也可能不带 `--data-dir` 启动。步骤如下：
       1. 运行 `lsof -nP -a -U -- <control.sock 路径>`，列出正在监听这个 socket 的进程。路径按 shell 单引号规则转义后嵌进命令。在 macOS 上，这条命令只列出监听方（同一个 PID 可能占多行），已连接的客户端不会出现。
       2. 核对：输出里应当恰好只有一个 PID。再用 `ps -o user=,command= -p <PID>` 确认它属于你自己的用户，完整命令是 ruukoto-code 的 `server` 进程。
       3. 对确认过的这一个 PID 执行 `kill -TERM <PID>`，效果与 `stop` 相同，活动任务会记为中断。然后点“重新连接”。
       4. 例外情况：没有任何 PID，说明后台已经退出，直接点“重新连接”；出现多个不同 PID、命令不是后台，或者无法核对时，停在这一步，不发信号，按指引核对控制目录配置和 `<控制目录>/spawn.log`。

       这些步骤只供拥有者阅读执行：桌面端不会把查询结果接到 kill 上，也不代为执行任何一步。受管开发前端不给这些步骤，只提示重启开发启动器。
     - 客户端较新、Personal 目标：提示在服务器部署同一 commit 并重启服务后重新连接。
     - 客户端较旧：提示重建 .app。
     - 只有拥有者点“重新连接”时才再连一次，除此以外都停在失败状态：不自动重试，不加兼容区间。日常 Code 目标的“重新连接”会重新走一遍 `ensureBackend`，然后新建连接，旧后台结束后由它拉起新后台；受管开发前端只重新连接。这个按钮不会停止任何进程，如果版本仍然不一致，照样停在失败状态。经实例锁核实身份并自动停止旧后台另立工单，见 [10](10-stop-stale-backend.md)。
5. **preload。** 源码保持 ESM TS。electron-vite 把 preload 构建为单个 CommonJS 文件 `out/preload/index.cjs`（内联动态 import，不拆 chunk），窗口的 `preload` 指向这个文件；sandbox 不关。preload 只暴露 `subscribe`、`request`、`pickFolder`、`reveal`，本身不做过滤：op 放行名单在主进程的 `ipcMain` 处理函数里执行，名单随 04–07 实际调用的 op 逐步增加。令牌不进入任何 IPC 载荷。跨 IPC 的错误转成可序列化的 `{ code, outcome, message, versions? }`，供 05 区分"应答丢失"，不依赖 Error 类实例跨 IPC 保留。
6. **渲染进程。** 开 `sandbox` 与 `contextIsolation`，关闭 `nodeIntegration`。CSP 按页面来源分两条交付路径，同一页面只受其中一条约束，不会叠加：
   - **打包页面**：主进程用 `loadFile` 加载 `out/renderer/index.html`。`file://` 页面拿不到 HTTP 响应头，所以严格策略 `default-src 'self'` 写成 `<meta http-equiv="Content-Security-Policy">`。这个 meta 由一个只在构建时生效的 Vite 插件（`apply: "build"`）在 `transformIndexHtml` 中插入，作为 `<head>` 的第一个子元素，排在所有脚本与样式之前。源 `index.html` 本身不含 CSP meta，开发页面因此不会带上生产策略。打包运行时，主进程不安装响应头钩子。
   - **开发页面**：渲染进程从 `ELECTRON_RENDERER_URL`（vite dev server，http）加载，策略由主进程经 `session.webRequest.onHeadersReceived` 以响应头下发。开发启动器每次启动生成一个随机 nonce，通过 `RUUKOTO_DESKTOP_DEV_NONCE` 同时交给 vite 配置的 `html.cspNonce`（只在 `serve` 时设置）和主进程。开发策略只额外放行 dev server 这个源、它的 ws，以及带该 nonce 的脚本与样式；不放行 `'unsafe-inline'`，没有 nonce 的内联脚本仍会被拒绝。
   - 生产策略是一个常量，由插件和产物检查共用；纯函数 `cspFor(devServerUrl, nonce)` 只生成开发响应头。
   - 其余设置：`will-navigate` 与 `setWindowOpenHandler` 拦截导航，只把 http 与 https 交给系统浏览器。窗口用 `hiddenInset` 与 `vibrancy: 'sidebar'`，明暗跟随系统；React 19 与 Tailwind v4，沿用 demo 的 CSS 变量。
7. **开发入口。** `packages/tui/src/dev.ts` 增加 `--desktop` 前端，只对 ruukoto-code 可用，与 `--config` 互斥。`npm run code -- --desktop` 用 `buildChildEnv` 的环境加 `RUUKOTO_DESKTOP_MANAGED=1` 启动 `electron-vite dev --watch`：主进程与 preload 的变更由 electron-vite 重建并重启 Electron，渲染进程走 HMR。监听分类同步调整：
   - `classifyWatchPath` 对 `apps/desktop/` 下的路径返回 `null`。这条要放在 `apps/*/src` 判为 `backend` 那一分支之前，交给 electron-vite 处理。
   - `planWatchRestart` 增加 `desktop` 前端：任何变更都不由启动器重启它。后台重启后，桌面端靠 `ControlConnection` 重连；view、control、core 的变更由 electron-vite 的监听接手，实施时核实 workspace 包的源码确实在它的监听范围内。
   - 退出时清理整组进程：Electron、electron-vite、后台都要退出。
8. **测试位置。** 纯逻辑模块（连接目标配置、配置来源选择、op 放行名单、`cspFor`、版本方向提示、后台拉起参数）不 import `electron`：CI 设了 `ELECTRON_SKIP_BINARY_DOWNLOAD`，在 Node 下 `electron` 包不可用。用例放在 `test/38-desktop-main.test.ts`，由 `scripts/test-app.mjs` 现有的 `test/*.test.ts` 规则发现。依赖 Electron 的胶水代码保持很薄，由人工检查覆盖。
9. **CI。** `check.yml` 设 `ELECTRON_SKIP_BINARY_DOWNLOAD=1`；桌面端的 lint、typecheck 与单测纳入现有检查。
10. **文档。** 新增 `docs/modules/desktop.md`；更新 `docs/architecture.md` 模块地图、`AGENTS.md` 仓库布局、`CONTEXT.md` 的「桌面客户端」；`docs/modules/control.md` 补上结构化版本信息；新命令同步到 `README.md`、`docs/development.md` 与 `.agents/skills/pre-push-checks/SKILL.md`。

## 进展与交接

- 当前：第五轮独立方案审查通过，第四轮人工恢复 P2 已关闭，无未解决的方案阻断。自动停止仍由 [10](10-stop-stale-backend.md) 单独评估，实现未开始；本结论不代表工程或产品验收通过。
- 下一步：02 实现完成后，由实施者按本单方案、验收与第五轮实施交接完成实现，再交独立实现审查和真实 Electron 外部验收。
- 基点：`develop` @ `4611eff`。依赖 02。
- 阻塞：02 方案已通过、实现未完成。

## 验收与证据

工程待验证。

- **主进程单测**（`test/38-desktop-main.test.ts`）：
  - op 放行名单直接调用主进程处理函数，名单外的 op 被拒绝；
  - 令牌不出现在 IPC 载荷中，跨 IPC 的错误保留 `code`、`outcome` 与 `versions`；
  - 日常模式下，`RUUKOTO_CODE_DATA_DIR` 这类路径覆盖变量只出现在登录 shell 环境时，解析出的路径与令牌来源仍然正确；
  - 受管模式下，即使登录 shell 的配置里定义了日常目录与令牌，也不调用登录 shell，解析结果等于开发档案，并且从不调用 `ensureBackend`（以替身断言调用次数为 0）；
  - `cspFor` 只放行给定的 dev server 源、它的 ws 与给定 nonce，不包含 `'unsafe-inline'`；构建插件对源 `index.html` 的输出中，CSP meta 是 `<head>` 的第一个子元素，内容等于生产策略；
  - 客户端较新、较旧两种情况下，Code 与 Personal 两个目标的提示都正确；客户端较新的 Code 提示以当前 `control.sock` 为查找依据：包含 `lsof` 查询、单个 PID 的核对与 SIGTERM 步骤，以及无匹配、多匹配时的处理；生成的命令把路径按 shell 转义（用含空格和单引号的路径，经 `/bin/sh` 回显后与原路径相同）；提示里不会把查询结果直接接到 kill 上；日常模式的“重新连接”会再调一次 `ensureBackend`，受管模式不调；受管模式下只提示重启开发启动器；只有调用“重新连接”时才发起新连接。
- **依赖边界**（`test/99-workspace-boundaries.test.ts`）：
  - 正例：桌面包的值引用来自 devDependency，lint 通过；
  - 负例一：桌面包引用未声明的依赖，被拒绝；
  - 负例二：桌面包跨包使用相对路径，被拒绝；
  - 负例三：其他包（例如 `packages/control`）的值引用来自 devDependency，仍被拒绝。
- **版本信息**：用会盖上 `v±1` 的替身服务端（同 `test/72-on-demand-backend.test.ts` 的做法）覆盖服务端较新、客户端较新两种情况，并断言：
  - `ControlClientError.versions` 两个值都正确；
  - `ControlConnection` 进入 `failed` 时带出这个错误，而且不再重试；
  - `ensureBackend` 失败结果中的 `versions` 正确；
  - 用真实 `ControlServer` 分别接收 `v-1` 与 `v+1` 的原始请求时，消息给出的更新方向正确。
- **人工恢复指引可用**（只在 macOS 上运行：`test/39-desktop-recovery-guide.test.ts`，加入 `scripts/test-app.mjs` 的 `MACOS_EXCLUSIVE`）：用替身进程搭三种场景，通过 shell 执行指引生成的 `lsof` 命令，断言输出里只有监听当前 `control.sock` 的那个 PID：
  - 后台不带 `--data-dir`、按默认目录启动；
  - 另有一个实例，数据目录与当前的同前缀（`data` 与 `data-other`），并有自己的 socket；
  - 第三轮的 A/B 路径错配：当前控制目录是 A，数据目录指向 B 的持锁者。

  三种场景下都另接一个客户端连着当前 socket，它不出现在输出里。
- **开发启动器**（`test/32-dev.test.ts`）：
  - `apps/desktop/src/main/index.ts` 与 `apps/desktop/src/renderer/App.tsx` 的分类结果都是 `null`；
  - `planWatchRestart(["both"], "desktop")` 只重启后台；
  - `planWatchRestart(["tui"], "desktop")` 什么都不重启；
  - 对 ruukoto-code 可以解析 `--desktop`，与 `--config` 同时给出时报参数错误。
- **构建产物**：`check-build.mjs` 在 `desktop:build` 中执行，任一项不满足就让构建失败：
  - `out/renderer/index.html` 的 `<head>` 第一个子元素是生产 CSP meta，并且不含 Vite 的 `csp-nonce` meta。比较的是解析后的属性值，因为 Vite 会把单引号写成 `&#39;`；检查脚本对缺失 meta、meta 放错位置两个负例都会失败；
  - preload 产物是单个 CommonJS 文件；
  - 主进程与 preload 产物的外部依赖只有 `electron` 和 Node 内置模块。
- **CI**：四个 job 通过，日志中没有 Electron 二进制下载；`npm ci --omit=dev` 不安装 Electron。

人工检查（外部验收，需要真实 Electron）：

- **打包与签名**：`npm run desktop:build` 产出 `dist/mac-arm64/Ruukoto.app`，`codesign --verify` 通过，.app 能启动。
- **preload 与安全选项**：真实 Electron 中 preload 加载成功，四个桥接入口都能调用；渲染进程里取不到 `require` 和 `process`。
- **CSP 实际生效**：在打包产物的开发者工具里，能看到 `<head>` 中的 CSP meta；注入一段内联脚本会被拒绝，控制台出现 CSP 违规报告。在受管开发前端里，注入一段没有 nonce 的内联脚本同样被拒绝。
- **后台拉起与归属**：后台未运行时 .app 能拉起后台，TUI 同时连接，看到的是同一个后台；退出 .app 后，后台仍在运行。
- **版本不一致**：两个方向各人为制造一次，都显示双方版本号与正确的更新方向，并且不重试。Code 目标在仓库已更新、旧后台仍在运行时，按界面上的步骤用 `lsof` 找到并核对旧后台，结束它后点“重新连接”，新后台被拉起，连接恢复。
- **受管开发前端**：
  - 登录 shell 里设置了日常目录和令牌时，`npm run code -- --desktop` 连接的仍然是开发档案；
  - 改后台源码后自动重连；
  - 制造一次后台重载失败，再重启一次前端，都不会多出一个不受启动器管理的后台；
  - 改主进程、渲染进程、view 的源码，分别生效；HMR 在 nonce 开发策略下正常，Tailwind 的开发样式能正常加载；
  - 退出后，Electron、electron-vite 与后台都没有残留进程。
- **外观**：明暗两种外观都正常。

## Comments

2026-10-15：拥有者完成 grilling 并确认整体方案，本单由规划阶段建立。

2026-10-15：根据 [02 首轮方案审查](02-explicit-product-and-external-node.md#2026-10-15-独立方案审查)的 03 交接事项，第 2 步补充：路径与令牌按登录 shell 环境解析，拉起后台改用 `spawnExecPath`，并加了对应单测。

### 2026-10-15 独立方案审查

对象：`43c16ac` 上的未提交修订，本单审查前 SHA-256 前缀为 `767d10397361`；对照规格 R1／R3／R5／R7／R8／R17–R20、桌面客户端提案、01／02／05 交接及当前源码。新客户端涉及权限、进程生命周期与构建契约，采用重流程。结论：需修订，暂不能交实施；以下四项由方案者修订后复审，不需要重新确认已获授权的产品范围。

1. **P1：第 1、4 步未处理 ESM preload 与 sandbox 的冲突，默认构建的桥接无法加载。** 按仓库 ESM 约定设置 `type: "module"`，隔离探针使用 electron-vite 6.0.0 默认配置，产出含 `import { contextBridge } from "electron"` 的 `out/preload/index.mjs`。Electron 的 sandbox preload 以普通脚本运行，不支持 ESM import，见 [Electron ESM 说明](https://www.electronjs.org/docs/latest/tutorial/esm#sandboxed-preload-scripts-cant-use-esm-imports)；因而窗口能启动也不能证明四个桥接入口可用。修订要求：源码保持 ESM，明确把 preload 构建为可在 sandbox 中执行的单一 CommonJS 产物并使用对应文件名，依赖随产物打入，不通过关闭 sandbox 解决。验收增加真实 Electron 中 preload 成功加载、四个入口可调用与安全选项仍生效；构建产物不能依赖未随包提供的 `.ts` 文件或拆分 preload 模块。
2. **P1：第 2 步的登录 shell 与按需拉起规则没有排除第 5 步的开发入口，会破坏开发档案隔离和后台归属。** [开发启动器](../../../packages/tui/src/dev.ts) 的 `buildChildEnv` 清除日常路径与 `RUUKOTO_OWNER_TOKEN*`，但交给 Electron 后再次执行登录 shell，会重新执行 shell 配置。隔离的 `.zshrc` 探针已证明：被清除的模拟日常令牌重新出现，开发控制目录也被覆盖；即使档案路径另行显式传入，`resolveOwnerToken` 仍优先使用重新引入的日常令牌。源码重载失败或前端重启时再调用 `ensureBackend`，还会派生不由 dev 持有的 detached 后台，违反[开发入口决定](../../../.agents/notes/implemented/process/2026-10-09-dev-launchers.md)。修订要求：分别明确日常 .app 与受管开发前端的配置来源；开发前端使用启动器已清洗的环境和完整档案配置，不重新引入日常令牌，只连接启动器管理的后台、不自行拉起。验收增加 shell 中存在日常目录／令牌时仍连接开发档案，以及后台重载失败、前端重启和退出时不产生脱离管理的后台。
3. **P2：第 1 步的全部 devDependencies 与现有依赖检查直接冲突，第 6 步无法通过。** [workspace-boundaries.mjs](../../../scripts/workspace-boundaries.mjs) 只允许值引用本包 `dependencies`，`devDependencies` 只用于类型引用。原样复制检查器、给隔离桌面包声明三项 devDependencies 后，`electron`、`@ruukoto/control/connection.ts`、`react` 的值 import 全部被报为未声明运行时依赖。修订要求：把检查器与 [test/99-workspace-boundaries.test.ts](../../../test/99-workspace-boundaries.test.ts) 纳入范围，为桌面构建时打入产物的依赖设明确且局部的规则，保留其他包的运行时声明、分层和跨包相对路径限制；用正例与越界负例验证，不把依赖移入生产安装来绕过 R17。同步相关分包说明。另将规格 R18 的“依赖与锁文件只出现在 apps/desktop”纠正为桌面依赖声明在该包、安装仍更新根锁文件，与[同仓分包决定](../../../.agents/notes/implemented/architecture/2026-10-11-in-repo-workspace-packages.md)一致，避免新增独立锁文件。
4. **P2：第 2 步未规划版本信息的结构化传递，现有接口不能正确指出需要更新的一侧。** [服务端](../../../packages/control/src/server.ts) 在所有版本不等时固定提示“请升级客户端”；真实 socket 探针发送 v26 给当前 v25，确实得到这条错误指引。`ControlClient` 丢弃应答的 `v`，`ControlClientError` 只保留 code／message／outcome，`ControlConnection.onState` 与 `ensureBackend` 的失败结果又只暴露文本。因此只复用现有错误无法落实 R5，解析 message 取版本也违反错误处理约定。修订要求：纳入相关 control 调用链，保留服务端应答版本和客户端版本的结构化信息，桌面端据此指出较旧的一侧；不增加兼容区间。验收覆盖服务端较新、客户端较新两种情况，均显示双方版本、正确更新方向并停在失败状态、不自动重试；当前验收只有“两版本号且不重试”，不足以捕获本反例。

实施交接（不另计阻断）：

- op 放行名单的执行点必须是主进程，验收直接调用主进程处理逻辑，不能只测试 preload 过滤；这落实 R3 已有要求。桥接错误也须保留可序列化的 code／outcome，供 05 区分应答丢失，不依赖跨 IPC 后仍保有原 Error 类实例。
- 开发监听需处理桌面源码与 electron-vite 的分工。现有 `classifyWatchPath` 将桌面 main／preload 的 `.ts` 判为 `backend`、将 renderer 的 `.tsx` 判为 `null`；不能原样复用这一分类。落实 01 的 view 变更交接，补 `test/32-dev.test.ts` 的桌面分类／重启断言，并核实 Electron、electron-vite 与后台各自退出；CSP 下的开发样式、脚本与热更新也应纳入实际启动检查。
- 根测试入口 [scripts/test-app.mjs](../../../scripts/test-app.mjs) 只发现 `test/*.test.ts`；新增纯逻辑用例放入该入口可发现的位置，或明确调整发现规则。`desktop:build` 应明确先执行 electron-vite build，再由 electron-builder 打包，并落实约定的最终 `.app` 路径与签名。

依赖可行性证据：在仓库外临时目录安装 electron-vite 6.0.0、Vite 8.3.4 与 Electron npm 包 44.7.2，以 devDependencies 和 workspace 链接引用当前 `ControlConnection`、`ensureBackend`、`SubmissionGuard`、`PendingRequestStore`，三个目标构建通过；主进程产物约 40.30 kB，仅保留 `electron` 与 Node 内置模块导入，没有外置 workspace `.ts`、`node:sqlite` 或原生扩展。当前选用的客户端依赖图不存在必须把后台／SQLite 打进 .app 的前提，`.ts` exports 解析可行；后续以实际选定版本与最终 import 集合复核。默认 ESM preload 被普通脚本解析器拒绝；显式单文件 CommonJS 产物在只提供 Electron bridge 桩的 VM 中执行成功。这是构建与脚本格式证据，不是 Electron sandbox 的真实运行验收。

本轮已执行：macOS arm64、Node v24.15.0；`npx tsx --test --test-name-pattern='包边界：' test/99-workspace-boundaries.test.ts` 为 2/2 通过；`npx tsx --test --test-name-pattern='环境清洗：|code 档案：|监听分类：' test/32-dev.test.ts` 为 3/3 通过；`npx tsx --test --test-name-pattern='协议版本不兼容（握手阶段）' test/12-reconnect-pending.test.ts` 为 1/1 通过。上述 lint、登录 shell、监听分类、真实版本拒绝应答及构建／preload 正反例均独立执行；测试只证明既有行为和方案缺口。

未覆盖：Electron 二进制下载在 GitHub 发布资源站点 TLS 连接超时，已停止下载，因此未验证 Electron 自带 Node 实际加载、真实窗口、开发热更新、打包签名与进程清理；未运行 CI 四平台组合、生产安装、真实模型或全量检查。本轮只更新本单状态与审查交接，保留工作区其他修订；临时探针已清理，无该探针残留进程；本单 9 个相对链接、单一状态、段落及末尾换行与 `git diff --check` 均通过。

### 2026-10-15 方案修订

方案者按首轮审查修订，拥有者确认的范围不变。

- P1 preload：第 5 步把 preload 构建为单个 CommonJS 文件，sandbox 保持开启；第 1 步规定主进程与 preload 产物只把 `electron` 和 Node 内置模块作为外部依赖；验收补了真实 Electron 中的加载检查与产物检查。
- P1 开发环境：第 3 步区分日常 .app 与受管开发前端。受管模式不执行登录 shell，也不调用 `ensureBackend`；第 7 步用 `RUUKOTO_DESKTOP_MANAGED=1` 标出受管模式；单测断言受管模式下登录 shell 与 `ensureBackend` 的调用次数都为 0。
- P2 依赖检查：第 2 步给 `apps/desktop` 加一条局部规则，并配一个正例、三个负例。规格 R18 的锁文件说法已改为"安装更新根锁文件"。
- P2 版本信息：第 4 步从应答帧已有的 `v` 取服务端版本，经 `ControlClientError`、`ControlConnection` 与 `ensureBackend` 结构化传出；服务端消息按方向给提示。协议不升版。验收覆盖两个方向。
- 实施交接：放行名单在主进程执行，跨 IPC 的错误可序列化（第 5 步）；开发 CSP（第 6 步）；桌面路径的监听分类与退出清理（第 7 步）；测试位置及纯逻辑模块不 import `electron`（第 8 步）；`desktop:build` 的步骤顺序与签名（第 1 步）。
- 落点调整：electron-builder `--dir` 的默认产物路径是 `<output>/mac-arm64/`，规格 R1 的路径因此改为 `dist/mac-arm64/Ruukoto.app`。
- 方案者已在当前代码上核实：服务端的版本错误应答带 `v: CONTROL_PROTOCOL_VERSION`，消息固定为"请升级客户端"（`server.ts` 第 118–128 行）；`ControlClientError` 只有 code、message、outcome（`client.ts` 第 43–51 行）；`onState` 只传 detail 字符串（`connection.ts` 第 25 行）；`buildChildEnv` 会洗掉 `RUUKOTO_OWNER_TOKEN*` 与 `RUUKOTO_CODE_*`（`dev.ts` 第 72–84 行）。

### 2026-10-15 第二轮方案审查

对象：`43c16ac` 上的最新未提交修订，本单复审前 SHA-256 前缀为 `c5164ac255c0`；同步核对规格 R1／R3／R5／R8／R17／R18、提案笔记及当前调用方。源码未变，首轮未受影响的证据继续有效。结论：仍需修订，以下两项交方案者处理；不重复打开已解决的 preload、开发环境与依赖检查意见。

1. **P1：第 6 步只安排 HTTP 响应头，未给出打包本地页面能生效的 CSP 交付方式。** `session.webRequest.onHeadersReceived` 可设置 HTTP 响应头，但按通常的 `loadFile`／`file://` 路径加载打包 HTML 时不能以 HTTP 头交付 CSP；[Electron 官方说明](https://www.electronjs.org/docs/latest/tutorial/security#csp-meta-tag)说明 file 资源不能用 HTTP 头设置策略，并给出 HTML meta 的做法。方案没有定义其他可带响应头的页面协议，因此 `cspFor(undefined)` 返回正确字符串也不能证明打包页面受保护，无法落实 R3。修订要求：明确打包页面的加载方式与策略注入位置；最小做法是在打包 HTML 的 head 中、资源加载前输出严格 CSP meta，开发 HTTP 页面单独处理。保留真实 Electron 的内联脚本拒绝验收，并检查最终 HTML／实际生效策略，而非只测策略生成函数。开发 HMR 的内联需求应限定到可信脚本与样式，不宜实现为任意内联脚本都可执行；可利用 [Vite 的 CSP nonce 支持](https://vite.dev/guide/features.html#content-security-policy-csp)，同时验证无 nonce 的注入仍被拒绝。若开发与打包共用 HTML，需明确如何避免生产 meta 与开发响应头叠加后阻断 HMR。
2. **P2：第 4 步给 Code 目标的恢复命令在版本不兼容时不可执行。** 仓库已更新而旧后台仍运行时，当前仓库的 `ruukoto-code stop` 也使用新版协议。[CLI 的 withClient](../../../packages/tui/src/cli.ts) 先认证再发送 stop，[服务端](../../../packages/control/src/server.ts) 则在认证和操作分派之前拒绝版本不等的所有请求。独立执行当前真实 bin 的 `stop`，连接返回 v24 的替身服务端（客户端 v25）：退出码 1，服务端只收到 `auth`，未收到 `stop`，旧后台不会因此停止。修订要求：保留已补齐的结构化版本信息与不重试规则，替换为在版本不匹配时仍可执行、能核实后台归属的恢复步骤；例如明确使用仍与旧后台匹配的入口停止，或给出不依赖控制面协议的受控停止办法，不引入跨版本放行。验收应实际覆盖“仓库／客户端已升级、旧后台尚未退出”的恢复流程，不能只断言文案包含 stop 或更新方向。

首轮关闭情况：单文件 CommonJS preload 和对应文件名覆盖了 ESM／sandbox 反例，真实窗口验收已列明；受管模式明确不执行登录 shell、不调用 `ensureBackend`，并对两个调用次数断言为 0，覆盖日常环境重新引入与失管后台反例；桌面专属 devDependencies 例外和根锁文件归属已明确。审查者在仓库外复制现有检查器，只按拟定方案扩展一处依赖判定，3 个桌面已声明值引用正例及未声明依赖、跨包相对路径、其他包 devDependency 值引用、非静态动态 import 共 4 个负例全部符合预期。版本应答现有的 `v` 足以供客户端附加 versions，不需要升版；从 ClientError 经连接失败回调／ensureBackend 再到 IPC 的传递范围现已完整，本轮第二项针对恢复动作而非重开结构化信息缺口。

其余交接：桌面源码归 electron-vite、开发启动器只重启后台的分工已明确；workspace 监听、热更新、整组退出及主进程放行名单都已列入验收。实现时跨 IPC 的结构化错误应作为响应数据传递，避免只抛 Error 后再次丢失字段。打包输出目录与根锁文件的修正已同步规格，属于工具实际落点的澄清。

本轮证据：macOS arm64、Node v24.15.0；真实 CLI 加 Unix socket 替身的 stop 反例、拟定依赖规则的 7 项正反例均独立执行；`npx tsx --test --test-name-pattern='协议版本不兼容的探测保留原始原因' test/72-on-demand-backend.test.ts` 为 1/1 通过，确认现有探测拒绝后不会拉起第二个后台。CSP 结论依据 Electron 官方交付限制与 Vite 官方 nonce 文档，未声称在真实 Electron 中复现。临时 socket／目录与 CLI 子进程已清理，未连接或停止日常后台。

未覆盖：未重复首轮已通过且未受影响的测试和构建探针，未重试 Electron 下载，未运行真实 Electron、打包签名、CI 矩阵、生产安装或全量检查。本轮只更新本单审查与交接，其他工作区修订保持原样；本单 13 个相对链接、单一状态、段落及末尾换行检查通过；`git diff --check` 通过。

### 2026-10-15 第二轮方案修订

方案者按第二轮审查修订，拥有者确认的范围不变。

- **P1 CSP 交付**：第 6 步分成两条路径。打包页面用只在构建时生效的插件写入 CSP meta，开发页面由主进程以响应头下发、只放行 nonce，两者不会叠加。验收新增三项：构建产物检查 `check-build.mjs`、插件输出的单测，以及真实 Electron 中的内联脚本拒绝检查。
- **P2 旧后台恢复**：第 4 步新增 `stopStaleBackend`。它经 core 的 `probeLockHolder` 核实持锁进程的启动标识后发 SIGTERM，不经控制面。CLI 的 `stop` 在版本不一致且客户端较新时，也走这条路径；桌面端经拥有者确认后调用它，再按日常流程拉起新后台。验收用替身旧后台覆盖完整恢复流程，外加三种拒绝情况和一种超时情况。
- **范围说明**：CLI 的 `stop` 回退属于本单新增的改动，牵涉 `packages/tui/src/cli.ts` 与 `docs/usage.md` 中 stop 的说明。加入的原因是服务端的新提示（“停止后台再重开”）需要一个确实能执行的入口。
- 方案者已在当前代码上核实：`probeLockHolder` 以 owner.json 中的启动标识识别 PID 复用，身份无法核实时返回 `unverifiable`（`instance-lock.ts` 第 104–133 行）；CLI 收到 SIGTERM 时调用 `stopAndExit("signal_sigterm")`（`cli.ts` 第 345 行）；开发启动器重启后台用的也是 SIGTERM（`dev.ts` 第 385–410 行）。

### 2026-10-15 第三轮方案审查

对象：`43c16ac` 上的最新未提交修订，本单复审前 SHA-256 前缀为 `5ba1e8daec81`。重点核对第 4、6 步、对应验收、规格与提案笔记；实现源码未变。结论：CSP 交付方案通过；新增的直接发送进程信号能力尚不能交实施，以下两项由方案者修订。前两轮已关闭且未受影响的意见不重开。

1. **P1：第 4 步把“确认活锁”当成“启动标识已核实”，现有 probe 接口不能提供这项保证。** [probeLockHolder](../../../packages/core/src/instance-lock.ts) 在 owner 没有 `processIdentity` 时跳过启动标识比较，只要命令行包含 `ruukoto`／`cli.ts`／`dev.ts` 就返回 `held: true, unverifiable: false`；返回值也没有区分现代身份核实与旧记录命令行兼容的字段。后者原用于保守阻止第二个实例启动，不能直接作为发送 SIGTERM 的依据。独立探针用真实持锁子进程删除 owner 中的 `processIdentity` 后，确实仍得到这组布尔值；[test/101-instance-lock.test.ts](../../../test/101-instance-lock.test.ts) 也刻意保留该兼容语义。修订要求：明确停止路径如何取得并严格核实持久的 PID／启动标识，不能只判断 `held && !unverifiable`，也不能解析 detail 文本；可以提供严格查询或显式身份核实字段，但保留锁竞争与导入等既有调用方的保守语义。把缺少启动标识但命令看起来像后台的旧记录列入拒绝且不发信号的负例，并在发送前复核选定身份未变。若需要改 core，将接口、文档与 101 回归纳入本单范围。
2. **P1：`stopStaleBackend({ dataDir, timeoutMs })` 未把待停止进程绑定到报告版本不兼容的连接，可能停止另一个实例。** [connect.ts](../../../packages/control/src/connect.ts) 允许 DATA 与 CONTROL 目录独立覆盖，[Runtime.controlDir](../../../packages/runtime/src/runtime.ts) 同样支持独立控制目录。若当前连接指向 A 的 control.sock、dataDir 却指向仍在运行的 B，第 4 步会因 A 的版本拒绝而检查 B 的 runtime.lock；即使 B 的启动标识完全匹配，也不能证明 B 就是需要更新的 A。隔离双进程探针已复现：A 回 `protocol_version`，随后按 B 的 dataDir 探测得到 B 的有效持锁 PID，两个 PID 不同；现有拟定输入中没有 socket／控制目录或选定后台身份可供核对。修订要求：保留自动停止时，明确怎样证明连接目标、数据目录和待发送信号的进程属于同一实例；不能证明就拒绝自动停止并给出人工恢复指引。拥有者确认之后还需复核目标没有换代，避免旧后台已被别处替换后继续停止新后台。验收增加 A／B 路径错配和确认期间目标替换两种负例，断言不会向无关或新实例发信号。桌面与 CLI 回退共用这项核实，不能仅凭一个 `protocol_version` 错误就对默认 dataDir 的锁持有者发信号。

第二轮 CSP 已关闭：用 Vite 8.3.4 独立构建最小页面，`apply: "build"` 的 `transformIndexHtml` 插件以 `head-prepend` 注入策略；产物的 head 首个元素为 CSP meta，没有开发 nonce。启动同一页面的 Vite dev server 并设置 `html.cspNonce` 后，HTTP 页面没有生产 CSP meta，两个脚本标签和 `csp-nonce` meta 均带本次 nonce，开发与打包策略没有叠加。这证明拟定注入方式可行；真实 Electron 的响应头生效、脚本拒绝及 React／Tailwind HMR 仍按人工清单验收。产物检查实施提醒：Vite 会将属性中的单引号写为 `&#39;`，应比较解析后的属性值，不能按原始 HTML 字面量误拒合法策略；检查脚本还应有故意缺失或放错 CSP meta 的负例。

停止方向的其他部分可沿用：SIGTERM 确实进入 CLI 的 `runtime.stop` 优雅停止路径；拒绝未知身份、超时不升级 SIGKILL、受管前端不显示恢复按钮、停止成功才重新拉起都已明确。本轮两项针对“给哪个进程发信号”的前置证明，不要求开放跨版本控制面，也不要求增加通用进程管理框架。若保留这项新增能力，CLI 回退与文档影响不能只留在修订历史中，应并入现行方案和验收范围。

本轮证据：macOS arm64、Node v24.15.0；上述 Vite build／serve 注入探针、缺失启动标识探针和双实例路径错配探针均独立执行；`npx tsx --test test/101-instance-lock.test.ts` 为 4/4 通过。锁与 socket 都在临时目录，探针期间未执行拟定的停止逻辑；只在清理时向本轮创建的两个子进程发送 SIGTERM 并等待退出，未连接或停止日常后台。这些证据核实的是方案前提，不是尚未实现的 stopStaleBackend 验收。

未覆盖：未运行真实 Electron、打包签名、React／Tailwind HMR、Linux、CI 矩阵、生产安装或全量检查；未重复前两轮未受影响的检查。本轮只更新本单审查与交接，其他工作区修订保持原样；临时目录已清理，两个子进程退出与 Vite dev server 关闭均已等待完成；本单 17 个相对链接、单一状态、段落及末尾换行检查通过，`git diff --check` 通过。

### 2026-10-15 第三轮方案修订

方案者按第三轮审查修订。

- 两项 P1 都针对 `stopStaleBackend` 要给哪个进程发信号：一是严格核实启动标识，二是把版本被拒的那条连接绑定到被停止的进程。要满足这两项，就得新增一套进程身份与归属核实能力，这超出了拥有者已确认的 R5（显示双方版本与需要更新的一侧，不自动重试）。因此第 4 步删掉了 `stopStaleBackend` 和 CLI `stop` 的回退，改为不发信号的人工恢复步骤，外加一个“重新连接”按钮。对应的验收也删掉了，CLI 与 `usage.md` 因此不在本单范围内。
- 审查给出的要求原样转到 [10](10-stop-stale-backend.md)，作为单独的待评估工单：严格的启动身份、连接与持锁进程属于同一实例、确认后复核目标没有换代，以及 A/B 路径错配与目标被替换两种负例。旧后台无法用新 CLI 停止这个问题在 TUI 中本来就存在，并非桌面端引入。
- 第三轮审查提醒的两点已写进产物检查的实施说明：比较 CSP 属性时用解析后的值（Vite 会把单引号转义成 `&#39;`）；检查脚本要配缺失 meta、放错位置两个负例。
- 规格 R5 与笔记已同步改为人工恢复。

### 2026-10-15 第四轮方案审查

对象：`43c16ac` 上的最新未提交修订，本单复审前 SHA-256 前缀为 `b8f6092026c0`；同步核对规格 R5、提案笔记和新建的 10，源码未变。结论：撤回自动停止与 CLI 回退后，第三轮两项 P1 已不属于 03 的实现范围；10 保存的自动停止前提仍待独立评估，本轮不批准其方案。本单尚有以下一项 P2，修正文案与验收即可，不要求实现自动进程识别或停止能力。

1. **P2：第 4 步用 dataDir 的命令行子串查找旧后台，人工恢复可能找错或找不到目标。** macOS 的 `pgrep -fl` 默认对子串正则匹配；隔离进程探针表明，查询 `server --data-dir /tmp/<夹具>/data` 同时返回以 `data` 和 `data-other` 为参数的两个进程。另一方面，[CLI](../../../packages/tui/src/cli.ts) 支持不带目录参数的 `ruukoto-code server`，目录由环境／默认值解析，这种合法启动方式不会被该查询找到。更关键的是，第三轮已核实 DATA 与 CONTROL 可以独立配置，显示数据目录并按它查进程仍不能把候选绑定到当前拒绝连接的 socket；把发信号交给人，并未使这条查找依据变得可靠。修订要求：人工步骤以当前控制目录中的实际 `control.sock` 为检索依据，列出候选后由拥有者核对进程用户、完整命令和目标路径，再对确认的单个 PID 发 SIGTERM；无匹配、多匹配或无法核实时停止该步骤并给出核实指引，不把 pgrep 结果直接视为待停止后台。路径按 shell 参数正确转义。可用的 macOS 查询例为 `lsof -nP -a -U -- '<控制目录>/control.sock'`，本轮已在隔离 Unix socket 上验证能返回监听它的进程；实际指引仍需说明人工核对，不把查询结果自动接到 kill。

对应验收应证明人工指引可用，而不只是包含 dataDir 和 SIGTERM：至少覆盖后台采用默认目录启动、不显式携带 `--data-dir`，以及另一个实例的数据目录与当前目录同前缀的情况；使用第三轮 A／B 路径错配设置时，步骤应指向当前控制 socket 的后台而非另一个 dataDir 的持锁者。这里核实的是面向拥有者的操作说明，不新增程序化停止职责。

其余修订保持有效：R5、提案与 10 一致回到“版本提示、人工恢复、显式重新连接”，不再修改 CLI stop 或 core 锁接口；CSP 属性按解码值比较及产物负例已补齐。重新连接的实施交接：日常 Code 目标在旧后台已结束后应重新走既有 `ensureBackend` 再建连接的流程，受管前端继续只连接；仅对旧 `ControlConnection` 重试 socket 无法兑现人工清单里的恢复连接。这个按钮不授权停止其他进程，版本再次不符时仍停在 failed。

本轮证据：macOS arm64、Node v24.15.0；三种命令行的隔离进程探针独立执行，确认同前缀误匹配与无目录参数漏匹配；macOS 本机 pgrep 手册也明确默认按子串、`-f` 按完整参数表匹配。另用本轮创建的 Unix socket 验证上述 lsof 命令，返回监听进程的 PID、用户与 socket 路径。只在清理时停止本轮创建的三个空闲子进程，均等待退出；监听 socket 和临时目录已清理，未查询、连接或停止日常后台。

未覆盖：源码未变，未重复前三轮未受影响的回归和构建探针；未运行真实 Electron、打包、CI 矩阵、生产安装或全量检查。本轮只更新 03 的审查与交接，其他修订及新建的 10 保持原样；本单 21 个相对链接、单一状态、段落及末尾换行检查通过，`git diff --check` 通过。

### 2026-10-15 第四轮方案修订

方案者按第四轮审查修订，范围不变：仍是人工恢复，不新增程序化停止。

- P2：第 4 步改为以当前 `control.sock` 为依据，用 `lsof` 列出监听进程；拥有者核对恰好一个 PID、所属用户与完整命令后，才对它发 SIGTERM；无匹配、多匹配或无法核对时停在这一步。路径按 shell 单引号规则转义。验收新增指引生成的单测，以及只在 macOS 上运行的真实定位检查，覆盖默认目录、同前缀数据目录与 A/B 错配三种场景。
- 重新连接的实施交接已写进第 4 步：日常 Code 目标重新走 `ensureBackend` 再建连接，受管前端只重新连接；版本仍不一致时照样停在失败状态。
- 实测（macOS arm64、Node v24.15.0）：在一个含空格的临时目录里，起一个监听 Unix socket 的进程，再接一个客户端。`lsof -nP -a -U -- <路径>` 只列出监听方的 PID，一行是监听 fd，一行是 accept 出来的 fd；客户端进程不出现。临时进程和目录都已清理。

### 2026-10-15 第五轮方案审查

对象：`43c16ac` 上的最新未提交修订，本单复审前 SHA-256 前缀为 `0a63ef240f2d`；重点复核第 4 步、人工恢复验收及规格 R5，源码未变。结论：方案通过，第四轮 P2 已关闭，无新增阻断；02 仍是实施前置。本结论只覆盖 03，不批准 10 的自动停止方案，也不代替尚未开始的实现验收。

关闭依据：人工查询现以连接实际使用的 control.sock 为参数，不再依赖后台命令行中的 dataDir。修订明确按唯一 PID 去重、核对用户与完整命令、对多匹配或无法核实时停止操作，且查询与 SIGTERM 不连成自动命令。日常“重新连接”重新走 ensureBackend 并新建连接，受管前端只连接，覆盖了旧后台停止后仍需重新拉起的步骤；版本不符仍保持 failed。规格 R5、提案和 10 的范围与本单一致。

独立验证：macOS arm64、Node v24.15.0。在含空格和单引号的临时控制目录中启动 Unix socket 监听进程 A，另起已连接客户端，再加入拥有独立 socket、目录名同前缀的进程 B；通过 `/bin/sh` 执行按单引号规则转义的 lsof 命令。路径回显与原值完全一致；查询 A 的 socket 始终只得到 A 的唯一 PID（监听与 accept 共两行），不包含客户端或 B。A 不携带 `--data-dir` 参数时仍可定位；将配置的 dataDir 指向 B 不改变按 A socket 查询的结果。上述定位与转义断言均通过，足以覆盖上轮 pgrep 的误匹配、漏匹配和错误查找依据。探针只验证命令定位方法，真实 GUI 指引与恢复流程仍由实施验收完成。

实施交接（不另计阻断）：

- [MACOS_EXCLUSIVE](../../../scripts/test-app.mjs) 只控制 macOS 的测试分批，不会让文件在 Linux 上跳过。39 用例须显式限定 macOS；如果加入该清单，同步更新 [test/124-test-app-runner.test.ts](../../../test/124-test-app-runner.test.ts) 的文件夹具、分批断言与失败路径回归。没有证实全局夹具碰撞时，也可以保留普通分批，只在用例内限定平台。
- 无 PID 的提示写成“未查到监听进程”，不要把空输出或 lsof 执行失败断言为后台已退出；先核对命令错误，再允许重新连接。现有 ensureBackend 仍负责安全探测与实例锁收敛，此分支不发停止信号。多行同一 PID 只算一个候选。

未覆盖：沿用前三轮有效的依赖、CSP、版本与环境证据，未重复应用测试或构建；未运行真实 Electron、打包签名、React／Tailwind HMR、Linux／CI 矩阵、生产安装或全量检查。三个探针子进程均已在清理时停止并等待退出，临时目录已删除，未触碰日常后台。本轮只更新 03 的状态与审查交接，保留其他工作区修订及 10；本单 23 个相对链接、单一状态、段落及末尾换行检查通过，`git diff --check` 通过。
