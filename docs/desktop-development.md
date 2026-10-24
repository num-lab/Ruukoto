# 桌面开发

`npm run code -- --desktop` 使用隔离的 Code 开发档案，不能与 `--config` 或位置工作区参数并用。后台由启动器管理；桌面端不执行登录 shell，也不自行拉起。桌面主进程改动由 electron-vite 重建并重启 Electron，preload 改动重建后重载渲染进程，渲染进程使用 HMR；view/control/core 的打包源码也由它监听，后台变更由原启动器重启。退出时清理 Electron、electron-vite 与后台整组进程。开发 nonce 每次新启动生成，覆盖 React 与 Tailwind 的开发资源；主进程允许配置的完整开发文档 URL 自身重载，使 preload 更新生效，其他路径仍交系统浏览器。

`npm run desktop:build` 在 macOS Apple Silicon 产出目录应用，无 DMG、公证或自动更新。安装依赖时若设置过 `ELECTRON_SKIP_BINARY_DOWNLOAD=1`，需先取消该变量并运行 `node node_modules/electron/install.js` 才能开发。构建链核对生产 CSP、单文件 CommonJS preload、外部依赖与Electron fuses；正式应用核实整包签名及ASAR位置，拒绝调试参数和外部renderer覆盖，先取单实例锁再加载Host；`codesign --verify --deep --strict dist/mac-arm64/Ruukoto.app` 核对签名。日常应用按构建时仓库路径调用登录 shell 的 node，仓库移动后需重新构建。

两外壳构建把node-pty运行代码、native及macOS的spawn-helper放入vendor；Electron解包native/helper，MyGo保留目录与执行位。缺文件或helper不可执行会阻断构建。终端真实PTY回归不可跳过，定向运行`npx tsx --test test/desktop-terminal.test.ts test/38-desktop-build.test.ts test/desktop-mygo.test.ts`；实际两壳输入法、隐藏恢复、明暗与退出另验。

桌面依赖全部在 apps/desktop 的 devDependencies，根锁文件统一管理，包含正文渲染的 react-markdown 与 remark-gfm；生产安装 `npm ci --omit=dev` 不装 Electron。创建与应答丢失回归见 `test/40-desktop-creation.test.ts`，流恢复与快照代次见 `test/41-desktop-stream.test.ts`。安全选项、CSP 实际拒绝脚本、明暗外观与真实 HMR 需另做 Electron 验收，纯逻辑测试不能代替。

开发入口：`npm run code -- --desktop`。构建入口：`npm run desktop:build`。返回[开发说明](development.md#桌面客户端)。

## 测试导航

| 修改位置 | 常用测试起点 |
| --- | --- |
| `apps/desktop/` | `test/desktop-terminal.test.ts`、`test/38-desktop-main.test.ts`、`test/38-desktop-personal.test.ts`、`test/38-desktop-build.test.ts`、`test/39-desktop-recovery-guide.test.ts`、`test/40-desktop-creation.test.ts`、`test/41-desktop-stream.test.ts`、`test/42-desktop-inspector.test.ts`、`test/43-desktop-demo.test.ts`、`test/desktop-attachments.test.ts`、`test/desktop-agent-display.test.ts`、`test/desktop-context.test.ts`、`test/desktop-composer.test.ts`、`test/desktop-inspector-tools.test.ts`、`test/desktop-tool-activity.test.ts`、`test/desktop-workspace-files.test.ts`、`test/desktop-browser-security.test.ts`、`test/desktop-mygo.test.ts`、`test/desktop-personal-interface.test.ts`、`test/desktop-workspace-git.test.ts`、`test/desktop-demo-v4.test.ts`、`test/desktop-session-settings.test.ts`、`test/desktop-live-files.test.ts`、`test/desktop-interaction-regressions.test.ts`、`test/desktop-polish.test.ts`、`test/desktop-git-lazy.test.ts`、`test/desktop-file-tree-loading.test.ts`、`test/desktop-git-layout.test.ts`、`test/desktop-git-windowing.test.ts`；MyGo 另跑 `cd apps/desktop/mygo && go test -race ./...`；真实外壳另验 |

桌面设置从 `test/desktop-settings.test.ts`、`test/desktop-settings-models.test.ts`、`test/desktop-models-layout.test.ts`、`test/desktop-settings-mcp.test.ts`、`test/desktop-settings-mcp-backend.test.ts`、`test/desktop-settings-skills.test.ts` 起跑；PA 加 `test/desktop-personal-settings.test.ts`、`test/desktop-personal-settings-pages.test.ts`、`test/desktop-personal-native.test.ts`。远程协议/维护/配对看 `test/personal-remote.test.ts`、`test/personal-remote-maintenance.test.ts`、`test/personal-remote-auth.test.ts` 与 `test/personal-desktop-events.test.ts`；安全存储与启动看 `test/desktop-personal-credential-storage.test.ts`、`test/desktop-startup-security.test.ts`、`test/desktop-mygo-credentials.test.ts`。双壳交互、真Keychain拒绝/锁定/重建授权、生产制品注入负例、Tailscale/固定systemd与真实模型/IM分别留外部证据，替身不记为真实验收。

## MyGo 试验

macOS Apple Silicon 安装 Go ≥ 1.27.1 和 Command Line Tools 的 Clang 后，`npm run desktop:mygo` 重建并打开 MyGo 应用，`npm run desktop:mygo:build` 只构建；产物是 `dist/mygo/darwin-arm64/Ruukoto MyGo.app`，原 Electron 入口继续可用。MyGo Go module 固定 v0.5.5，首次构建下载 Go 依赖；构建显式 `CGO_ENABLED=1` 以调用系统Security.framework，无需Bun。`codesign --verify --deep --strict "dist/mygo/darwin-arm64/Ruukoto MyGo.app"` 检查签名。

此入口连接Code和PA；修改源码后重新运行，不使用Electron HMR或受管开发入口。窗口使用WKWebView，Node子进程复用DesktopHost；应用包不含Node，签名资源固定Node绝对路径及SHA-256、sidecar与凭据命名空间，启动先核实整包签名及资源，清洗注入环境并禁止SIGUSR1调试。Code后台/终端的登录环境仍经独立选择传递，采用到Host前再次清洗；Node内容、路径或仓库变化后重新构建。传输失败先核实原操作，再重开应用。

MyGo的Personal配置、Keychain凭据和未决提交与Electron独立；Go内固定Keychain存储槽仅经宿主专用帧供Node使用，秘密不走renderer事件或绑定。`desktop:mygo`构建签名内的development命名空间及独立应用数据子目录，`desktop:mygo:build`构建production；正式应用拒绝argv、`RUUKOTO_DESKTOP_MYGO_USER_DATA`及受管覆盖。两壳各自持单实例锁，开发不得复用正式凭据。MyGo的sidecar打包后只允许require内置模块，ws可选原生扩展走JavaScript回退，不从机器上的其他目录加载代码。`npx tsx --test test/desktop-mygo.test.ts`覆盖共用桥接，`cd apps/desktop/mygo && go test -race ./...`覆盖私有帧、启动、单实例与退出；真实WKWebView输入法、滚动、选择器、网页隔离与观感另验。设计依据见[MyGo试验](../.agents/notes/implemented/architecture/2026-10-17-desktop-mygo-experiment.md)和[PA安全存储与启动](../.agents/notes/implemented/architecture/2026-10-24-personal-tailscale-https.md)。
