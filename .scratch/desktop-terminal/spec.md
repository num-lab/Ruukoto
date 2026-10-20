# Desktop 右栏集成终端

Status: in-review

## 目标与边界

为 desktop 客户端右栏新增集成终端标签：PTY 跑在 Electron 主进程 / MyGo Node sidecar（DesktopHost 所在进程），renderer 用 xterm.js 渲染。多终端实例，cwd 为工作区根目录；resize、明暗主题、SIGTERM→500ms→SIGKILL 回收当前可追踪进程组。

非目标：终端不经控制面协议（本机能力，不依赖后台连接）；不持久化终端会话（关闭标签即销毁）；Personal 目标不开放；不做 shell 选择 UI。

已确认取舍（拥有者 2026-10-20）：node-pty + xterm.js；MyGo 首版同步支持；可开多个终端。

## 方案

见 `.scratch/desktop-terminal/issues/01-integrated-terminal.md`。要点：

- 终端 op 走 host.request 本地分支（desktop_browser_open 先例），输出经 platform.publish 推送 `{type:"terminal"}` update；MyGo 侧 request/update 双透传，Go 增加渲染进程崩溃回收回调。
- 主进程 TerminalManager（新文件 `apps/desktop/src/main/terminal.ts`）：node-pty 工厂构造注入，16ms 输出合并和发送节流、64KiB 单帧、pending 达64KiB暂停PTY，上限 8 个，TERM→500ms→KILL。
- 构建链 4 处：两种构建 vendor node-pty runtime JS、本平台 pty.node 和 macOS spawn-helper；check-build 精确放行终端引用并核实文件与执行位；electron-builder 解包 native/helper，MyGo resources 包含完整 vendor。

## 进展与交接

- 2026-10-20：方案批准并完成实现；当前待返工后的独立复审与真实双壳体验，检查证据见实施工单。

## 验收与证据

工程和产品验收以[实施工单](issues/01-integrated-terminal.md)为准。
