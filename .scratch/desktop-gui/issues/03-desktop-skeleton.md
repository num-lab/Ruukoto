# apps/desktop 骨架：主进程、preload、安全基线、开发与打包入口

Status: plan-review

## 目标与边界

实现[规格 R1、R3、R5、R7、R8、R14、R17、R18](../spec.md)：一个能连上 Code 目标、显示连接状态与工作区列表的空壳，安全基线与构建链在此一次立好。界面功能由 04 起逐步加入。

## 方案

1. 新建 `apps/desktop`：electron-vite 三个目标；依赖全部列为 devDependencies；不定义名为 `build` 的脚本，避免根级 `npm run build --workspaces --if-present` 触发 Electron 打包；打包脚本由根级 `npm run desktop:build` 调用 electron-builder `--mac --dir`，产出 `dist/Ruukoto.app`，ad-hoc 签名。
2. 主进程：连接目标配置（产品、socket 路径、令牌来源）；每个目标一个 `ControlConnection`；Code 目标按 02 解析路径，后台未运行时从登录 shell 取 `node` 与环境，执行构建时经 electron-vite `define` 记录的仓库路径下的 bin。版本不一致、仓库路径缺失、node 不可用都显示可操作的错误。
3. preload 只暴露 `subscribe`、`request`、`pickFolder`、`reveal`；`request` 按 op 放行名单过滤，名单随 04–07 实际调用逐步增加；令牌不进入任何 IPC 载荷。
4. 渲染进程：`sandbox`、`contextIsolation`，关闭 `nodeIntegration`；CSP `default-src 'self'`；`will-navigate` 与 `setWindowOpenHandler` 拦截导航，只把 http 与 https 交给系统浏览器。窗口用 `hiddenInset` 与 `vibrancy: 'sidebar'`，明暗跟随系统；React 19 与 Tailwind v4，沿用 demo 的 CSS 变量。
5. 开发入口：`packages/tui/src/dev.ts` 增加 `--desktop` 前端，`npm run code -- --desktop` 启动 electron-vite dev 并把开发实例的档案路径传给主进程，复用后台自动重启与退出清理。
6. CI：`check.yml` 设 `ELECTRON_SKIP_BINARY_DOWNLOAD=1`；桌面端的 lint、typecheck 与单测纳入现有检查。
7. 文档：新增 `docs/modules/desktop.md`；更新 `docs/architecture.md` 模块地图、`AGENTS.md` 仓库布局、`CONTEXT.md` 的「桌面客户端」；新命令同步到 `README.md`、`docs/development.md` 与 `.agents/skills/pre-push-checks/SKILL.md`。

## 进展与交接

- 当前：方案已经拥有者确认，待独立方案审查；实现未开始。
- 下一步：方案审查者核对 electron-vite 对 workspace 包 `.ts` exports 的解析，以及 Electron 自带 Node 能否运行 `@ruukoto/control` 的传递依赖。
- 基点：`develop` @ `4611eff`。依赖 02。
- 阻塞：02 未完成。

## 验收与证据

工程待验证。单测：op 放行名单拒绝名单外的 op；连接目标配置与后台拉起参数的拼接；令牌不出现在 IPC 载荷中。CI 四个 job 通过且日志中没有 Electron 二进制下载；`npm ci --omit=dev` 不安装 Electron。

人工检查（外部验收）：`npm run desktop:build` 产出的 .app 能启动；后台未运行时能拉起，TUI 同时连接可见同一后台；退出 .app 后后台仍在；人为制造版本不一致时显示两个版本号且不重试；`npm run code -- --desktop` 改后台源码后自动重连，退出后没有遗留进程；明暗外观正常。

## Comments

2026-10-15：拥有者完成 grilling 并确认整体方案，本单由规划阶段建立。
