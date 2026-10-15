# Code 工作区、会话与对话流验收

实施基点 `f64ee4a`；环境为 macOS Apple Silicon、Node 24.15.0、Electron 44.7.2。规格与范围见[工单](../issues/04-code-tree-and-stream.md)及[共享规格](../spec.md)。后台探针使用临时 Code Runtime 与 ControlServer，模型使用本地替身，未访问日常档案。

## 实现与影响范围

主进程只新增八个实际调用的 op 放行与 ControlConnection 请求转发，保留结构化 outcome 和令牌隐藏。渲染进程的 CodeState 直接消费共享 view，维护会话标签、历史／任务／正文补读和待完成创建；正文经 react-markdown 与 remark-gfm 显示，正文与思考中的图片仅显示说明。两项依赖仅进入 desktop devDependencies 与根锁文件。未修改协议、后台存储或共享投影，没有新增提交、审批、右栏或 Personal 功能。

每次快照安装清空读取游标与请求集合，所有异步结果和补读循环都核对代次；渲染端也独立比较 instanceId，覆盖人工重连重新创建 ControlConnection 时没有变化标志的情况。创建记录另行保留原键、参数、目标与实例；最多重发一次，在线迟到创建事件也能确认原会话。读取错误独立显示，不覆盖创建结果未知提示。当前会话决定标题与工作区高亮，恢复指引在小窗口内可独立滚动。

## 工程检查

| 检查 | 结果与覆盖 |
| --- | --- |
| 桌面主进程、构建、安全与恢复指引 | `38-desktop-main`、`38-desktop-build`、`39-desktop-recovery-guide` 共 12 项通过；八个 op 放行、名单外拒绝、IPC 失败分类、CSP 与 macOS socket 定位 |
| `40-desktop-creation` | 最终 11/11 通过；两种创建各覆盖在线超时、真实客户端断线后重新认证、明确拒绝、未发送，另含两种跨实例负例及迟到事件 |
| `41-desktop-stream` | 最终 8/8 通过；冷恢复、重连去重、长正文连续 UTF-8 分页、向前翻页、四类旧代次迟到结果、多个截断条目换代、不连续分页拒绝、人工重连换实例 |
| `37-view-browser` | 4/4 通过；共享投影浏览器打包、无 Node 全局及 UTF-8 计数 |
| 静态检查 | 图片安全修复后完整 `npm run check:static` 通过；最终纯样式修订另经 GUI 复核 |
| 构建 | 根 `npm run build` 与 `npm run desktop:build` 通过；根构建不触发 Electron 打包 |
| 产物签名 | `codesign --verify --deep --strict --verbose=2 dist/mac-arm64/Ruukoto.app` 通过 |

## 独立实现审查

不同执行上下文直接读取工单、源码、diff、测试及最终文档；检查了所有 handleRequest 调用方、创建失败与恢复、旧代次请求、工作区归属、Markdown 配置和 UI 状态。独立执行浏览器／主进程／创建／流恢复 28 项通过，新增人工重连回归单独通过；最终创建的真实断线强化后另跑 11/11 通过。desktop typecheck、定向 ESLint、check:docs 与 diff 空白检查均通过。

审查发现并关闭了旧恢复循环跨快照继续补读、迟到创建事件不能解除待核实、标签切换后标题与高亮错配，以及人工重建连接未报告实例变化的缺口。前两项用内存变异探针撤去各自修复后能复现，新回归覆盖原触发条件。独立审查结论：通过，无未解决实现阻断。

真实 GUI 发现本机图片读取后，独立追加安全审查：正文与思考统一替换 img，不透传 src 或其他属性，alt 经 React 文本转义；skipHtml、默认链接过滤及主进程 HTTP(S) 导航限制均保留。安全复审、定向 ESLint、desktop typecheck、check:docs 与 diff 检查均通过。

## 真实 Electron 与交接

真实打包 Electron 经 CUA 与 CDP 验收，后台、另一控制客户端及 TUI 都连接同一临时 Code 档案。CodeState 与流恢复检查使用实际桥接与 ControlServer；明暗使用 prefers-color-scheme 媒体模拟，小窗口使用 760×500 viewport 模拟。图片、脚本与正文均来自受控模型替身。完整检查材料在 `04-electron/`。

| 外部清单 | 结果与证据 |
| --- | --- |
| 添加工作区与同路径独立操作 | 经真实“添加工作区”按钮与系统目录选择框完成；同目录仍只有一个工作区，成功后的新操作新增并打开新会话，见 [后台记录](04-electron/backend-after-native-picker.json) |
| 新建会话与标签 | 真实新建按钮成功；A／B 标签切换时标题和工作区高亮一致，关闭后会话仍在树中且可重开，见 [A](04-electron/tabs-a.json)、[B](04-electron/tabs-b.json)、[关闭](04-electron/tab-close.json)、[重开](04-electron/tab-reopen.json) |
| TUI 同连与实时流 | 真实 TuiApp 加 FakeTerminal 显式选中同一树会话并提交；桌面实际观察到思考计时、执行中的 2 项工具组、正文持续增长与完成；两端最终均为两段思考，各 2 秒，见 [TUI 记录](04-electron/tui-evidence.json)、[桌面时间序列](04-electron/electron-stream-evidence.json) |
| 后台重启 | 真实停止并用原档案重启，观察到重连后恢复；前后 3 条消息、2 段思考、2 个工具条目的内容和数量完全一致，见 [重启记录](04-electron/restart-evidence.json) |
| 脚本与危险链接 | script／img onerror 未生成可执行元素，三个执行标志均为 false，javascript 链接 href 清空，见 [最终安全记录](04-electron/security-images-fixed.json) |
| 本机图片负例 | 修复前，绝对路径和相对路径均实际加载临时自有 PNG，naturalWidth/Height 为 2；修复后正文与思考各含 file、绝对、相对和 HTTP 图片，DOM 图片总数为零且替代说明保留，见 [修复前](04-electron/security-local-image-before-fix.json)与[修复后](04-electron/security-images-fixed.json) |

创建请求幂等、丢答与跨实例回归由上述真实 Runtime／ControlServer 的 11 项检查证明；GUI 另用 IPC 边界替身制造创建 unknown，并同时从真实 ControlServer 触发读取失败，两个提示均持续显示。小窗口恢复区可滚动至重连按钮，见[最终 UI 记录](04-electron/final-ui-evidence.json)与[滚到底部截图](04-electron/final-small-recovery-bottom.png)。明暗截图检查了文字、树、标签、工具组和正文可读性，见[明亮](04-electron/final-stream-light.png)与[深色](04-electron/final-stream-dark.png)；最终长标签关闭按钮宽 28、scrollWidth 等于 clientWidth，见[控件记录](04-electron/final-tab-close-controls.json)。

独立外部验收结论为通过，无未解决阻断；[探针摘要](04-electron/probe-summary.json)记录了环境、模拟范围、令牌检查和进程清理。最终 app.asar SHA-256 为 `c8495b4ead243ee7d980401cdc1396d370bf19db2ddd64d43c0da2c799f4e8c4`。

产品验收不另设确认步骤：本单沿用已确认的外观与功能边界，没有新增待拥有者决定的主观方案；列明的 GUI 行为按真实外部清单验收。

未运行全量 `npm run check`、Linux／Node 22 或真实模型，真实模型不是本单验收前提。03 的其他外部缺口仍留在原工单；拥有者已授权本地提交，未推送或发布。
