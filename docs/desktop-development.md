# 桌面开发

`npm run code -- --desktop` 使用隔离的 Code 开发档案，不能与 `--config` 或位置工作区参数并用。后台由启动器管理；桌面端不执行登录 shell，也不自行拉起。桌面主进程改动由 electron-vite 重建并重启 Electron，preload 改动重建后重载渲染进程，渲染进程使用 HMR；view/control/core 的打包源码也由它监听，后台变更由原启动器重启。退出时清理 Electron、electron-vite 与后台整组进程。开发 nonce 每次新启动生成，覆盖 React 与 Tailwind 的开发资源；主进程允许配置的完整开发文档 URL 自身重载，使 preload 更新生效，其他路径仍交系统浏览器。

`npm run desktop:build` 在 macOS Apple Silicon 产出目录应用，无 DMG、公证或自动更新。安装依赖时若设置过 `ELECTRON_SKIP_BINARY_DOWNLOAD=1`，需先取消该变量并运行 `node node_modules/electron/install.js` 才能开发。构建链在打包前核对生产 CSP、单文件 CommonJS preload 与外部依赖；`codesign --verify --deep --strict dist/mac-arm64/Ruukoto.app` 核对签名。日常应用按构建时仓库路径调用登录 shell 的 node，仓库移动后需重新构建。

桌面依赖全部在 apps/desktop 的 devDependencies，根锁文件统一管理，包含正文渲染的 react-markdown 与 remark-gfm；生产安装 `npm ci --omit=dev` 不装 Electron。创建与应答丢失回归见 `test/40-desktop-creation.test.ts`，流恢复与快照代次见 `test/41-desktop-stream.test.ts`。安全选项、CSP 实际拒绝脚本、明暗外观与真实 HMR 需另做 Electron 验收，纯逻辑测试不能代替。

开发入口：`npm run code -- --desktop`。构建入口：`npm run desktop:build`。返回[开发说明](development.md#桌面客户端)。

## MyGo 试验

macOS Apple Silicon 安装 Go ≥ 1.27.1 后，`npm run desktop:mygo` 重建并打开 MyGo 应用，`npm run desktop:mygo:build` 只构建；产物是 `dist/mygo/darwin-arm64/Ruukoto MyGo.app`，原 Electron 入口继续可用。MyGo Go module 固定 v0.5.5，首次构建会下载 Go 依赖；无需 Bun。`codesign --verify --deep --strict "dist/mygo/darwin-arm64/Ruukoto MyGo.app"` 检查签名。

此入口连接日常 Code 档案；修改源码后重新运行，不使用 Electron 的 HMR 或受管开发入口。窗口使用系统 WKWebView，后台连接与恢复规则由同一 Node DesktopHost 承担；应用包不含 Node，启动使用构建时记录的 Node 绝对路径，登录环境仍由原逻辑读取。Node 或仓库移动后重新构建；MyGo 传输失败时重新打开应用，先核实原操作。

MyGo 的 Personal 配置和未决提交保存在独立应用数据目录，和 Electron 不互相覆盖；有结果未知的提交时先在原应用核实，再换壳。隔离验收可以设置 `RUUKOTO_DESKTOP_MYGO_USER_DATA`，并配合既有受管环境与临时控制目录，不连接日常后台。`npx tsx --test test/desktop-mygo.test.ts` 覆盖共用宿主与桥接，`cd apps/desktop/mygo && go test -race ./...` 覆盖 JSONL、失败分类、阻塞写入和退出；真实 WKWebView 的输入法、滚动、选择器、网页隔离与观感另验。设计依据见[MyGo 试验](../.agents/notes/implemented/architecture/2026-10-17-desktop-mygo-experiment.md)。
