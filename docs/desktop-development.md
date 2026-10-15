# 桌面开发

`npm run code -- --desktop` 使用隔离的 Code 开发档案，不能与 `--config` 或位置工作区参数并用。后台由启动器管理；桌面端不执行登录 shell，也不自行拉起。桌面主进程改动由 electron-vite 重建并重启 Electron，preload 改动重建后重载渲染进程，渲染进程使用 HMR；view/control/core 的打包源码也由它监听，后台变更由原启动器重启。退出时清理 Electron、electron-vite 与后台整组进程。开发 nonce 每次新启动生成，覆盖 React 与 Tailwind 的开发资源；主进程允许配置的完整开发文档 URL 自身重载，使 preload 更新生效，其他路径仍交系统浏览器。

`npm run desktop:build` 在 macOS Apple Silicon 产出目录应用，无 DMG、公证或自动更新。安装依赖时若设置过 `ELECTRON_SKIP_BINARY_DOWNLOAD=1`，需先取消该变量并运行 `node node_modules/electron/install.js` 才能开发。构建链在打包前核对生产 CSP、单文件 CommonJS preload 与外部依赖；`codesign --verify --deep --strict dist/mac-arm64/Ruukoto.app` 核对签名。日常应用按构建时仓库路径调用登录 shell 的 node，仓库移动后需重新构建。

桌面依赖全部在 apps/desktop 的 devDependencies，根锁文件统一管理，包含正文渲染的 react-markdown 与 remark-gfm；生产安装 `npm ci --omit=dev` 不装 Electron。创建与应答丢失回归见 `test/40-desktop-creation.test.ts`，流恢复与快照代次见 `test/41-desktop-stream.test.ts`。安全选项、CSP 实际拒绝脚本、明暗外观与真实 HMR 需另做 Electron 验收，纯逻辑测试不能代替。

开发入口：`npm run code -- --desktop`。构建入口：`npm run desktop:build`。返回[开发说明](development.md#桌面客户端)。
