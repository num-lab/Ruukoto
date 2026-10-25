# Agent Note: 桌面浏览器的本机文档能力

Status: implemented

路径名称黑名单由[本机预览职责调整](../simplification/2026-10-25-browser-path-names.md)取代，其余决定继续适用。

## 问题

拥有者要求内置浏览器打开本机 file:// 文档。直接放宽 URL 无法让 HTTP／mygo 顶层的 iframe 读取本机文件，放开原生 file 或 webSecurity 又会扩张远端网页的权限。

## 决定

共用 DesktopHost 先于后台连接与 PA 白名单处理 desktop_browser_open／release，本地预览不依赖后台在线。沿用 generic request 和原顶层 IPC 身份，不增加 Go／preload RPC、控制协议或后台任意路径读取。每份文档建立仅监听 127.0.0.1 的临时 HTTP origin 与 256 bit 随机路径令牌，iframe 使用替代地址，地址栏和历史保留原 file URL；并存文档 origin 不同，端口关闭后可能复用，授权依赖新令牌。

能力根为所选文档的真实父目录，同目录和子目录的相对样式、图片、脚本与数据可读取；不提供目录列表，拒绝越界、链接、敏感元数据与应用 userData。普通文件读取核对目录链、打开句柄和读取前后身份；入口 HTML 使用打开时快照，资源在请求时读取，刷新地址栏重新捕获。每文件最多8MiB，每能力累计32MiB、256个请求，至多8份能力和16个并发资源读取；超出后明确失败并可刷新。普通本地 HTML 保留 CDN 和联网能力。

iframe 继续使用 allow-scripts allow-forms，不增加 allow-same-origin。模块与 fetch 使用有效令牌路由上的 ACAO:null，不允许带凭据的 CORS，普通远端 Origin 拒绝；null来源并不认证某个 frame。令牌只是同目录的能力，已打开的本地脚本与其加载的外部脚本可使用或转交能力，不承诺抵御恶意本地 JS 的防泄密执行。响应无 referrer、无缓存、nosniff，并使用同样的 sandbox CSP；不记录令牌，不改变设备、下载、弹窗、Node 或 IPC 的隔离。

受控地址栏导航、刷新、前进后退、关闭标签与组件卸载撤销旧能力，迟到的打开结果立即释放；Host.close 等待创建与读取完成并清理 listener。opaque iframe 内部自行导航无法可靠感知，因此不承诺任意内部导航即时撤销或加入地址栏历史。传输断开后无法确认某次 release，最终回收由宿主退出负责。普通 Web Demo 仅同步 URL 与展示，file 显示需要桌面宿主，不尝试任意读取本机。

## 既有决定

按 file、iframe、本地预览和内置浏览器检索 implemented／proposed；没有 rejected 目录。与[Demo工具预览](2026-10-16-demo-inspector-tools.md)、[当前迁移](../architecture/2026-10-16-desktop-current-demo.md)、[MyGo宿主](../architecture/2026-10-17-desktop-mygo-experiment.md)和[桌面提案](../../proposed/architecture/2026-10-15-desktop-client.md)部分重叠：本篇补充拥有者新授权的本机文档能力，其余读取、IPC与隔离约定沿用；其他命中属于后台浏览器、权限或文字规范，与本机展示无关。现行交接见[工单24](../../../../.scratch/desktop-shadcn/issues/24-browser-activity.md)。

## 备选方案

直接把 file 加到 parser 和 CSP 最小，但两种浏览器引擎仍可能拒绝 iframe 加载，也不能提供所需资源边界。独立原生 WebView 可以加载本机目录，但 MyGo 当前 React 窗口不能直接加入原生 Content WebView，且要新增坐标与浮层管理。两端自定义协议避免监听端口，但新增适配、共享来源及 CORS 差异；共用 Node loopback 服务保持两端同一能力实现。

## 后果

本机 HTML 能真实渲染相对资源，未新增写入／执行宿主文件的接口。能力根外的资源与敏感配置不加载，格式与预算不足会显示失败；独立浏览器验证 module／fetch 与原生宿主验收分别记证据，HTTP读取测试不能替代 WKWebView／Chromium 的实际显示。
