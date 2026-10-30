# Scheduled 桌面构建与离线浏览器核验

> 本文部分原始证据已移出 Git；原路径保留用于查找原件，见[归档说明](../../../git-history-cleanup/archive.md)。

2026-10-26，独立工作副本 `/tmp/ruukoto-code-scheduled-desktop`，桌面修复内容为 `d469a786`，基础实现为 `de6dba56`、`23b167be`。环境为 macOS arm64、Node 24.15.0、Go 1.27.2，Clang 来自 Xcode；原始环境输出见 `environment.log`。

## 构建

`npm run desktop:build` 与 `npm run desktop:mygo:build` 均成功退出；修正样式后重新执行两种构建，最终日志为 `electron-build-final.log`、`mygo-build-final.log`。对最终两个 `.app` 分别执行 `codesign --verify --deep --strict`，退出码均为 0，原始结果见 `signatures-final.json`。构建产物位于本工作副本的 `dist/mac-arm64/Ruukoto.app` 与 `dist/mygo/darwin-arm64/Ruukoto MyGo.app`。

## 浏览器

使用真实 Chromium 156.0.8078.48、正式 Desktop renderer 与现有 Vite/React/Tailwind 入口，命名会话为 `ruukoto-code-scheduled-desktop`。`window.ruukoto` 由 `browser-init.js` 注入离线夹具；夹具模拟计划应答并在浏览器 localStorage 保存样例，不连接 Code 后台或 Personal，不调用真实模型，不读取日常档案或 Keychain。页面重载后的样例列表恢复只证明前端重新读取夹具，不能记作后台持久性或真实外壳验收。

已完成：1280×900 明暗、640×820 窄窗；每天默认表单、每周周一/五与一次性日期；工作区搜索后 Enter 选择；Permission 用方向键选择；模型从 Reasoner/High 切换 Fast 后回落 Off，再选择 Low；点击保存及 Title 中 Enter 保存；New chat 往返后草稿保留；暂停、恢复、取消；Escape 关闭取消框且未发送取消。实际表单输出的七项配置、请求键、一次性时区转换、控制请求次数与未创建额外会话的断言见 `browser-flow-assertions.log`，断言代码见 `browser-assertions.js`。

窄窗现场测量：页面与主画布均无横向溢出，权限文字宽约 82.6px、clip-path 为 none；工作区图标、文字和箭头中心线一致，选择工作区没有 `create_session` 或 `open_workspace` 请求。最初只有 favicon 404 资源错误；重载后的控制台为 0 error、0 warning，见 `browser-console-final.log`。

## 截图

| 文件 | 内容 |
| --- | --- |
| `dark-weekly-filled.png` | 深色，每周表单，Fast/Low、Auto review、周一/五 |
| `light-weekly-filled.png` | 同一表单浅色 |
| `light-weekly-narrow.png` | 640px 窄窗，星期自动换行、权限文字保留 |
| `dark-once-narrow.png` | 深色窄窗，一次性日期/时间与固定时区 |
| `light-cancel-dialog-narrow.png` | 窄窗取消确认，明确包含当前整项运行 |
| `dark-current-list.png` | 当前计划列表 |
| `dark-history-list.png` | 已取消计划历史，保留记录 |
| `dark-after-reload.png` | 重载后从离线夹具重新读取当前列表 |
| `before-fix-dark-new-daily.png` | 修复前证据：工作区控件堆叠；不是最终样式 |

## 修复与边界

真实浏览器发现工作区控件的样式仍限定新对话页面，以及窄容器的权限文字隐藏规则未限定 composer；`d469a786` 把共享控件样式用于两个页面并收窄隐藏规则，同时移除表单中重复的新建按钮。`test/desktop-composer.test.ts` 与 `test/desktop-scheduled.test.ts` 共 27 条通过；提交钩子的完整 `check:static` 通过。

未验证真实 Electron/WKWebView 业务交互、系统通知、真实模型、到期执行、审批/回答、关闭窗口后后台继续和真实后台重连；这些仍须单独验收。浏览器夹具不证明调度、权限或外部效果。拥有者的主观产品验收与独立实现审查没有由此自动通过。
