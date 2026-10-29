# 步骤 2：生产页面宿主证据

步骤 2 交付 `apps/desktop/mygo/browser/`（`Manager` + 绑定面 `Frontend`）与 `main.go` 的 `WindowOptions.Content` 迁移：前端 WebView（`mygo://`、preload、TrustedOrigins）加每会话浏览器 WebView（无 preload、无可信路由），矩形经可信前端上报、钳制后按 `ui.WebView.Absolute` 放置；Agent 持有时在同矩形上叠 `ui.Box` 透明盖，原生命中测试把它计入 webview 的 covers，指针落到原生层不进页面；键盘在接管转持有时经 `Focus` 收回前端页。

## 环境

- macOS 27.0.1（arm64），Go go1.27.2，`github.com/egoist/mygo` v0.5.5；未打包 `go build` 二进制、`mygo.IsDev()=true`。
- 单测：`go test ./...` 与 `go test -race ./browser/`（`apps/desktop/mygo/`），含矩形钳制、身份与代次校验、闸门与释放、命令调度（fake handle + 同步 Update seam）。
- 宿主探针：`/tmp/mygo-probe -host -report ../evidence/probe-report.json`（host 模式自动改写为 `probe-report-host.json`），经 probe `go.mod` 的 `replace` 引入生产 `browser` 包，在真实 Content 窗口内驱动生产 Manager 与 `BindAs("Browser", …)` 绑定面。

## 自动检查（H01–H08 全过）

报告原文：`probe-report-host.json`。

| 检查 | 实测结论 | 支撑 |
| --- | --- | --- |
| H01 后台 open 建页并持有 | `Command("open")` 创建会话页并置 Agent 持有，sidecar 收到 `gate` 事件 | 页面生命周期/持有权 |
| H02 前端矩形/展示状态 | 真实 `mygo.call("Browser.Rect"/"Shown")` 经生产绑定面到达，矩形钳制后原生放置 | 可信路由+放置 |
| H03 eval/screenshot | `Command("eval")` 在真实页面执行并回报代次；`screenshot` 以该代次返回 35.9KB base64 PNG | 代次绑定命令链 |
| H04 接管 | 前端真实 `mygo.call("Browser.Takeover")` 撤盖、代次推进，后台命令按 `not_owned` 拒 | 接管屏障 |
| H05 交还 | `Browser.HandBack` 恢复持有、代次再推进，旧代次命令 `stale_generation` 拒、新代次放行 | 交还屏障 |
| H06 拥有者地址栏 | 持有态 `Command("navigate")` 以 `page_owned` 拒（拥有者导航入口被闸门约束）；接管后同一调用提交新 URL | 导航闸门 |
| H07 拥有者关闭 | `Command("close")` 销毁页面并上报 `closed`，status 查无会话 | 关闭与引用失效 |
| H08 外来 WebView 身份 | 独立建的 WebView（同窗口、非前端 Page）调 `Browser.Takeover` 被 `ipc_sender` 身份拒 | 身份隔离 |

## 未覆盖项与人工核验

- H09 Agent 持有期间真实指针/滚轮是否被原生盖拦截：covers 命中机制在步骤 1 P06 已证、本步复用同一机制，真实点击留人工核验。
- 渲染进程崩溃（`OnRenderProcessGone`）与下载拦截在生产路径未实测真实事件；单测已覆盖 `gone` 态拒绝逻辑。
- 多会话并存时的真实双页切换在单测与步骤 1 P02 各覆盖一半，生产链路的多会话现场保持待步骤 5 前端接线后端到端复验。
- 发布打包形态（`production=1`）下可信路由与 dataStore 未验，同步骤 1 遗留。

## 结论

生产宿主满足步骤 2 要求：`main.go` 迁 Content、绑定面只暴露可信前端方法且身份校验精确到 Page/窗口/URL、浏览器页无 preload 无可信路由、导航/弹窗/下载/权限在页层拦截、代次与持有权屏障生效、sidecar 失效经 `ReleaseAll` 放开输入并废代次、关闭即销毁。桌面服务与 sidecar 生命周期未动。步骤 3 桌面/控制传输可以开始。
