# Agent Note: MyGo 右栏浏览器由 Coding 主 Agent 与拥有者接替操作

Status: implemented

交付形态与逐项验收见[工单](../../../../.scratch/mygo-agent-browser/issues/01-integrate-browser.md)；原生行为依据见[探针证据](../../../../.scratch/mygo-agent-browser/evidence/probe.md)与[宿主证据](../../../../.scratch/mygo-agent-browser/evidence/host-probe.md)。

## 问题

Coding Agent 的 browser 工具操作 Runtime 持有的 Chrome，MyGo 右栏只显示隔离 iframe；Agent 不能读取或操控拥有者眼前的同一页面。拥有者需要在桌面中完成本地前端验收，并能显式接管、交还页面。

## 决定

### 原生页面与宿主隔离

MyGo 外壳用 `WindowOptions.Content` 承载前端 WebView，每个主会话另持一个浏览器 WebView 由 `apps/desktop/mygo/browser.Manager` 管理：页面按会话池化，矩形由可信前端上报并做窗口边界裁剪，原生遮挡盖（`ui.Box` 参与命中）在 Agent 持页时裁掉人工指针与键盘输入。浏览器页不装 preload、无 TrustedOrigins，`OnWillNavigate` 拒绝协议越界；`EmitPage(frontend.Page())` 定向事件，不广播到网页。可信调用核实精确前端 Page 身份与 `mygo://localhost/` URL，外来 WebView 调 `Browser.*` 被身份检查拒绝。

### 归属与工具资格

控制面 v47 增 `push:"request"` 反向通道与 `desktop_browser_register/event/chunk` 三个 op，浏览器命令只下达到登记的 socket，应答只认发出请求的连接。`submit`/`continue`/`owner_question_answer` 经登记连接提交时，与任务同事务写 `task_browser_bindings`，来源由服务端按 socket 写定，幂等重放不能偷换。新增 `desktop_browser` 工具族仅装配给 `task_browser_bindings` 命中 + dev 会话 + 完全访问 + 非 Plan/SubAgent/后台来源的任务，与旧 `browser` 由 Driver 收窄互斥；TUI、Electron、Personal 路径保持原 Chrome 工具。

动作集为 status/open/navigate/back/forward/reload/snapshot/screenshot/click/fill/select/check/uncheck/press/scroll/wait/close，按 `connectionId|session` 串行。页面交互经 Go `eval` 的固定宿主脚本；eval 结果、截图（`transfer` 分块 ≤256KiB、总量 ≤8MiB、sha256 装配验签）与超 24k 字符快照进 ArtifactStore。快照引用绑 (任务, 页面代次)，导航或闸门代次翻转变为 `stale_ref`。`unknown`/`disconnected` 记效果未知，不静默重发；断线撤销登记、页面标 gone、释放在途等待。

### 接管与交还

拥有者点「接管」：`browser.Manager` 收回闸门、翻代次并 `EmitPage` gate 事件，后台把 Agent 调用挡在 `awaitGate`；持有时拥有者的地址栏导航、后退/前进、刷新同样被拒，`接管`/`关闭` 始终可用。Driver 在 `finishTurn`/`prepareNextTurnWithContext`/`prepareRequest`/`handleToolCall` 四边界检查闸门：持有时发 `task.browser_wait` 并等待，任务保持 running，取消/断线/页面消亡立即解除等待。「交还 Agent」是唯一交还入口：宿主 eval 取 DOM 观察（失败写 unavailable 事实）、`appendMarker("ruukoto_browser_observation")` 落会话 JSONL、装配层把 marker 投为 `browserObservation` 参考块并按 observationId 记录交付；未交付观察时 `checkBeforeSend`/`prepareRequest` 拒绝旧上下文发送，`mustRejudge` 强制一次续轮，每次交还只触发一次。

### 前端

`renderer/native-browser-panel.tsx` 的 `.native-browser-host` 占位区只上报几何不绘制页面；ResizeObserver、MutationObserver 与 scroll/resize 上报 `rect` 与 `state(session, shown, covered)`，隐藏页保持运行但按遮挡分闸。`browser_event` 投影到 `code-browser` 标签的 `NativeBrowserState`，普通浏览器与文件预览标签保持原 iframe 路径。`Window.ruukoto` 类型声明在 `shared/bridge.ts`，根 typecheck 程序与桌面程序共用同一来源。

## 既有决定

与 [MyGo 外壳](../architecture/2026-10-17-desktop-mygo-experiment.md) 部分重叠：本篇把外壳扩为 Content + 原生页面宿主，原传输、构建与 Electron 对照保留。与 [原浏览器](2026-10-14-agent-browser.md) 部分重叠：TUI/Personal Chrome 生命周期与暂停规则不动，桌面专属工具互斥装配。与 [本机文档](2026-10-17-desktop-local-browser.md)、[present 展示](2026-10-25-code-present.md)、[展示权限](2026-10-25-present-preview-access.md) 部分重叠：能力根、释放与拥有者入口保持。

## 备选方案

- 保留 iframe 由宿主定向执行脚本：MyGo 无子 frame 执行能力、隐藏 iframe 无独立截图，不满足范围。
- 现有 Page 窗口加窄 Darwin WKWebView 适配：需自持布局、导航、权限与截图，探针证实 Content 路线已足。
- 复用独立 Chrome 展示截图或另开窗口：不满足操控同一右栏页面，不作自动降级。
- 同一 browser 名称下泛化 Chrome/WKWebView manager：进程与暂停规则不同，采用互斥装配。

## 后果

每个会话页占一份 WebView 内存，收栏不回收，拥有者可主动关闭。共享 WebKit 登录数据使一个会话的登录/退出影响其他网页。接管边界后的工作不能撤销先前发出的外部动作。真实模型闭环与人工可视项（A1、A3 视觉、A5 整链路）在工单验收表中逐项记录，离线检查不替代。

## 验证

原生探针 P01–P17 与生产宿主探针 H01–H08 全过（macOS 27.0.1 arm64，mygo v0.5.5）：矩形/隐藏执行/新鲜截图/Cookie 共享/合成事件驱动 React 表单/`Emit` 广播隔离/https 页引擎拒绝/跨启动持久化；宿主侧闸门/代次/身份/事件定向实测。`desktop-browser-control.test.ts` 4 例与 `desktop-browser-manager.test.ts` 7 例覆盖登记应答、断线解绑、分块完整性、来源归属、资格互斥、一次消费、串行、代次作废与观察投影。`npm run desktop:mygo:build` 全量构建通过。
