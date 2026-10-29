# 步骤 1：MyGo 原生探针证据

步骤 1 的隔离 fixture 位于 `../probe/`（独立 go.mod，不进构建与静态检查范围）。架构即提案主路线：`WindowOptions.Content` 原生布局内放前端 WebView（`mygo://`、可信路由）加两个浏览器 WebView（`http://127.0.0.1`、无 preload、无 TrustedOrigins），浏览器页经 `ui.WebView.Absolute` 按前端上报的占位矩形放置，隐藏仅摘出渲染不销毁。

## 环境

- macOS 27.0.1（arm64），Go go1.27.2，`github.com/egoist/mygo` v0.5.5（go.sum 固定），未打包 `go build` 二进制、`mygo.IsDev()=true`。
- 主轮命令：`go build -o /tmp/mygo-probe . && /tmp/mygo-probe -report ../evidence/probe-report.json -shots ../evidence/shots`；二次启动 `/tmp/mygo-probe -persist` 只跑 P17。
- 截图新鲜度判定：页面把计数器渲染成 12bit 黑白位块，PNG 解码后与 DOM 值比对（`decodeCounter`），不依赖哈希差异。
- 已验证 macOS 版本仅此一机 27.0.1 arm64；更低版本与发布打包形态未验，不扩大结论。

## 自动检查（P01–P17 全过）

报告原文：`probe-report.json`（主轮 16 项）、`probe-report-persist.json`（P17）；截图：`shots/`。

| 检查 | 实测结论 | 支撑 |
| --- | --- | --- |
| P01 矩形上报→原生放置 | 前端 `getBoundingClientRect`+ResizeObserver 上报占位矩形（495×688@605,0，窗口 1100×720，dpr=2），原生按矩形放置浏览器页 | A2/A3 |
| P02 双会话页独立与现场保持 | A/B 两页各有独立计数器与 `__mark`，切显示目标往返后同一文档连续（计数 4→9），页面不销毁不重建 | A2 |
| P03 EvalContext 恰好一次 | 含显式 `return` 的函数体脚本每次调用副作用恰好一次，无双执行 | EvalContext 契约 |
| P04 显示态截图基线 | `CapturePage` PNG 解码位块==DOM 值（scale=2.00 的 Retina 尺寸换算正确） | A1/A2 |
| P05 隐藏执行与新鲜截图 | 收栏隐藏与切会话隐藏下 fetch/计时器/动态 import 继续执行；两种隐藏下截图位块仍==递增后的 DOM 值，未冻结 | A2 核心 |
| P06 原生模态遮挡 | 原生模态覆盖期间页面继续执行，截图新鲜；指针拦截走 Content covers 命中机制（真实点击核验列 M1） | A2 |
| P07 缩放与矩形跟随 | `SetSize(1100→880)` 后前端重新上报矩形（495→396），缩放后截图仍新鲜 | A3 |
| P09 焦点 | `Page.Focus()` 获得键盘焦点，隐藏后焦点收回不残留 | A3 |
| P10 设备权限 | `SetPermissionHandler` 拒绝生效，页面 getUserMedia 得 no-api | A7 |
| P11 React 受控表单 | 合成 InputEvent/change/click 驱动 React 19 受控表单成功：中文姓名、多行 textarea、radio、checkbox、提交值全部正确 | A1 页面侧 |
| P12 会话间 Cookie | B 页 `document.cookie` 与服务端回显均见 A 设置的 `probe_login`/`probe_persist`，`Cookies.List` 亦命中——defaultDataStore 跨 WebView 共享 | A9 |
| P13 IPC 隔离与定向 | 浏览器页调 `Probe.Secret` 经路由到达 handler 但被 Page 身份拒；`Emit`（窗口广播）浏览器页可收到（0→1）——证实前端事件必须 `EmitPage`；`EmitPage` 精确命中 | A3/A7 |
| P14 导航与弹窗闸门 | 页面自发起 `/blocked` 与 `mygo://` 导航被 `OnWillNavigate`+PreventDefault 拦截，`window.open` 被 `SetWindowOpenHandler` 拒绝 | A7 |
| P15 同 URL 不同 Page 身份 | 浏览器 WebView 加载同一 `mygo://` URL，`Probe.SetRect`/`Secret` 均被 Page 身份拒，定向事件不到达 | A3/A7 |
| P16 外部 https 引擎层拒绝 | example.com 加载成功（`title=Example Domain`），页内 `mygo.call` 被引擎层拒「this page is not allowed to call Go methods」，handler 未执行 | A7 核心 |
| P17 跨启动持久 Cookie | 第二次启动 `Cookies.List` 命中 `probe_persist`——未打包进程的 defaultDataStore 已跨启动落盘 | A9 |

## 未覆盖项与人工核验

- M1 真实鼠标点击在 covers 命中区域的拦截：机制面已见，需人工点击复验。
- M2 浏览器页持键盘焦点后转 Agent 控制时的键盘收回：需人工。
- M3 接管后 IME 中文输入：合成事件 DOM 层由 P11 覆盖，IME 路径需人工。
- M4 右栏动画/菜单/Retina 视觉对齐：几何与 scale 已记录，肉眼核验留给体验验收。
- `OnWillDownload` 路径只核对了 API 存在，未实测真实下载事件；跨源子 frame 的 bridge 注入行为未单独验证（P16 已证顶级外部页拒绝）。
- 未打包 dev 形态；发布 `production=1` 构建下可信路由判定与 dataStore 行为需在 A7/A9 复验。
- macOS 支持下限未验证：本机 27.0.1 通过，正式验收按发布矩阵补。

## 结论

提案主路线全部未证假设成立：隐藏页面持续渲染且截图新鲜（P05/P06）、React 合成事件驱动受控表单（P11）、EvalContext 无副作用双执行（P03）、每会话页面/矩形跟随/身份隔离/IPC 定向成立（P02/P07/P15/P13）、外部页与伪前端 URL 被引擎层与 Page 身份双重拒绝（P14/P15/P16）、共享 Cookie 跨页与跨启动可见（P12/P17）。原生子集满足 A1 页面侧与 A2/A3/A7/A9 前置要求，步骤 2 MyGo 页面宿主可以沿主路线开始。
