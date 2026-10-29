# Agent Note: 用 MyGo 试验桌面外壳

Status: implemented

MyGo 右栏的原生页面、Coding 自动化与显式接管见[右栏浏览器决定](../feature/2026-10-29-mygo-agent-browser.md)；本篇描述外壳其余部分。

PA连接与双壳秘密存储见 [Tailscale HTTPS／WebSocket](2026-10-24-personal-tailscale-https.md)；共用Host与私有管道的归属保持，凭据帧不进入界面事件。

## 问题

拥有者希望实际体验比 Electron 更轻的桌面外壳，再决定最终是否保留。已有 React 界面与 Node 控制客户端可分离，直接重写 Go 控制面会扩大试验范围，单纯渲染静态 demo 又无法检验真实工作流。

## 决定

保留 Electron 对照，新增 MyGo v0.5.5 的 macOS Apple Silicon 应用与显式启动／构建命令。Go 使用系统 WKWebView 承载原 renderer；共用 DesktopHost 持有现有连接、提交恢复、Personal SSH 与通知规则。Node 子进程仍运行原 TypeScript 客户端，Go 只持有原生窗口与系统动作。两者通过私有 stdin/stdout JSONL 通信，stdout 专用、诊断走 stderr，单帧至多 16 MiB，请求 ID 只在本次子进程内递增，JSON 以原始字节传递。

未交付的请求是 not_sent；交付后无应答的超时或进程失败是 unknown／disconnected，不自动重放。子进程失败让所有在途调用完成为失败，并报告 failed；重新打开应用后由原提交记录核实。stdin EOF 先回收连接与 SSH，宿主有限等待后升级终止；日常 Code 后台继续独立运行。

Go 方法只接受当前窗口精确 mygo://localhost/ 顶层文档，原生同时拒绝子 frame IPC；不扩大默认可信来源。保留严格生产 CSP 与 iframe sandbox，全部 window.open、下载和网页权限拒绝，主文档外链通过窄方法交系统浏览器。系统选择器返回的附件路径只在 Go 与 Node 间传递，不向 renderer 开放路径上传方法。

构建保存当前 Node 绝对路径；Finder 的 PATH 不负责发现 Node，登录环境仍由既有 Node 逻辑读取一次。MyGo 应用使用独立 userData，避免与 Electron 争用 pending 记录；仍读同一后台事实。构建后的 Node 或仓库路径失效时要求重建。试验不引入自动更新、安装器、Bun 或另一套 HMR。

## 既有决定

按 desktop、Electron、iframe、Node sidecar 检索 proposed、implemented 与 rejected。与[桌面客户端提案](../../proposed/architecture/2026-10-15-desktop-client.md)部分重叠：增加可独立运行的 MyGo 外壳，保留 Electron 对照入口；拥有者于 2026-10-17 明确确认保留 MyGo 实现并授权提交合入。与[当前 GUI](../../implemented/architecture/2026-10-16-desktop-current-demo.md)和[Trace 迁移](../../implemented/architecture/2026-10-16-desktop-trace-migration.md)部分重叠：展示和后台语义沿用，原生适配另验。[同仓分包](../../implemented/architecture/2026-10-11-in-repo-workspace-packages.md)的 Electron 产物约束继续用于对照入口；新 Go module 不进入生产 npm 安装。其他命中为 demo-only 或后台机制，不改变。

## 备选方案

- 直接把控制客户端重写为 Go：可彻底删除 Node 进程，但必须复制协议、SSH 监督与提交恢复，无法把差异归因到外壳；待选型确认后才值得重访。
- 直接替换 Electron 并删除入口：仓库只维护一种壳，但失去同份界面的可运行对照和回退，违背先试再定的目标。
- 仅做静态 MyGo demo：最快看到 WKWebView 外观，但不能验证控制连接、附件、审批与退出，不足以判断是否保留。

## 验证

见[工单](../../../../.scratch/desktop-mygo/issues/01-mygo-experiment.md)。纯逻辑与 Go 传输测试覆盖错误分类、EOF 和清理；实际 .app 在隔离后台安装快照并展示真实会话，验证系统动作、iframe 隔离和退出。生产构建、签名、静态检查与现有桌面回归通过；拥有者确认保留 MyGo，工程及适用的产品验收完成，外部验证缺口仍如实保留。

## 后果

WKWebView 的输入法、滚动、CSS 与 Chromium 有差异，必须实际体验。应用仍依赖外部 Node 和构建时仓库，产物体积比较需注明这一前提；不声称总内存一定降低。两种外壳各自保留 pending 记录，试验时未知提交应在原应用核实后再换壳。MyGo 原生 API 不能照搬 Electron 的子 frame 导航回调，隔离证据来自 CSP、sandbox、绑定校验和真实探针的组合。

环境准备时机与轻量就绪探测由[启动优化](../bug-fix/2026-10-17-desktop-connection-startup.md)持有；本篇其他决定继续适用。
