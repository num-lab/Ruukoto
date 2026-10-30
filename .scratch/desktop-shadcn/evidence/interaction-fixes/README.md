# Desktop 交互问题验收记录

> 本文部分原始证据已移出 Git；原路径保留用于查找原件，见[归档说明](../../../git-history-cleanup/archive.md)。

日期：2026-10-17。环境：macOS arm64、Node v24.15.0。基点为 `53fad806549622b2fb599550a79beff08cadc130`，检验对象包含基点后尚未提交的 Desktop v4 迁移和本轮修复；本轮沿用已有内容，不提交、不推送。文件指纹见 `sha256.json`。

## 结果与证据层级

| 要求 | 结果 | 证据与限制 |
| --- | --- | --- |
| 拖动 Tab 偶发交叉重叠 | 完整生命周期回归通过；Demo 实际排序、拖出取消通过 | `tab-drag-lifecycle-repro.mjs` 重放实际 hook，检查预览后离开、重进、取消、落下与组切换；回程期间源项保持隐藏。`demo-drag-after.png`、`demo-drag-after.ax.txt` 和 `demo-drag-cancel.ax.txt` 记录实际浏览器交互；标记清除由 hook 断言验证，最后恢复原标签顺序后的实际 DOM 检查另存 `demo-restored-dom.json`，所有排序／源隐藏标记为null、位移为0，截图见 `demo-restored.png`。原生 MyGo 鼠标拖动未验证。 |
| 快速滚动时消息出现未绘制区域 | 重复排序与 Markdown 元素复用回归通过；已加载消息保留真实布局 | 实际 Conversation SSR 的50／300条样本，有序 flow 读取由52／302次降为各1次，见 `render-red.log`、`render-green.log`。耗时26.1→26.85ms、72.33→67.06ms只作样本信息，不宣称稳定加速比。`conversation-cache-repro.mjs` 使用实际组件并替换 Markdown 为探针，证明元素复用和依赖失效，不证明实际解析次数或屏幕帧率。CSS 覆盖屏外延迟布局，保留共享组件原样。原生逐帧快速滚动仍待验收。 |
| 文件树反映磁盘新增／删除 | 原生 MyGo 实际界面通过 | 活动 Files 面板根与展开 `src` 中各新增一个文件，定时刷新自动显示；删除后自动消失，未手动刷新。见 `native/tree-added.png`、`native/tree-added.ax.txt`、`native/tree-removed.png`、`native/tree-removed.ax.txt`。`desktop-live-files.test.ts` 覆盖去重、关闭、离线、失败保留树与迟到响应；`hidden-files-repro.mjs` 核实隐藏实际组件不发目录请求。 |
| 外部 Read 路径预览 | 真实工具捕获及读取通过；前端模型与拒绝回归通过 | 使用真实 Runtime、worker 与 canonical read，将346字节 `/tmp` 文本捕获为唯一 artifact，删除源文件后读取产物仍逐字相同；见 `native/read-capture.json`。前端校验产物 id／task／session、状态、编码、256 KiB上限；缺失或多义记录明确不可预览。展示捕获版本，不新增任意系统路径读取。原生 Read 行点击尚未验证。 |
| 新会话继承 mode／model／effort | 实际 Runtime 与 Desktop 状态链路通过 | `desktop-session-settings.test.ts` 覆盖四种模式、四类创建入口、非默认模型／档位、保存中／未知、关最后标签、实例切换、丢答固定原键、重放首次成果优先、无效模型拒绝。额外红转绿覆盖“降权已保存但丢答，核实又失败，恢复队列不能清除未知设置”；核实快照后继承 confirm。原生点击创建后的菜单值未另验收。 |

## 已执行检查

| 命令 | 结果 | 日志 |
| --- | --- | --- |
| `npx tsx --test test/desktop-interaction-regressions.test.ts test/desktop-live-files.test.ts test/desktop-session-settings.test.ts test/43-desktop-demo.test.ts` | 最后补充未知设置回归前48／48通过；该组其余内容之后未改 | `regressions-before-final-settings.log` |
| `npx tsx --test test/desktop-session-settings.test.ts test/38-desktop-main.test.ts test/40-desktop-creation.test.ts` | 最终97／97通过，包含新增未知设置回归 | `settings-final.log` |
| `npx tsx --test test/01-concurrency.test.ts test/03-lifecycle.test.ts test/04-crash-recovery.test.ts test/05-overflow-db.test.ts` | 14／14通过 | `core.log` |
| `npx tsx --test test/18-model-selection-store.test.ts` | 初始字段、事件及模型存储4／4通过 | `store-settings.log` |
| `npx tsx --test test/41-desktop-stream.test.ts test/desktop-inspector-tools.test.ts test/desktop-tool-activity.test.ts test/40-desktop-creation.test.ts test/38-desktop-personal.test.ts test/desktop-mygo.test.ts test/66-control-seam.test.ts` | 112／112通过；最后只加 resume 的未知设置守卫，其覆盖见最终97项 | `desktop-integration.log` |
| `npm run check:static` | 最终代码通过 | `static.log` |
| `npm run check:docs` | 最终文档通过 | `docs.log` |
| `npm --prefix .scratch/desktop-shadcn/demo run check` | 通过；已有大 chunk 提示 | `demo-check.log` |
| `go test -race ./...`（`apps/desktop/mygo`） | 通过 | `go-race.log` |
| `npm run desktop:mygo:build`、`npm run desktop:build` | 最终代码均通过 | `mygo-build.log`、`electron-build.log` |
| `codesign --verify --deep --strict`（两个构建 bundle） | 两者 exit0 | `signatures.json` |

永久回归入口 `test/desktop-interaction-regressions.test.ts` 执行本目录四个断言脚本。它们在内存里装配实际组件／hook，避免增加产品依赖或导出测试专用接口。对组件的探针不是原生体验证据。

## 独立审查

方案审查纠正了 artifact 没有 kind 字段的假设：只能使用成功 canonical read 的唯一捕获产物并核实身份，不能解析产物的人类名称。实施审查分别覆盖 Tab／Conversation、文件刷新／快照与 Session 设置。两处阻断均已修复并独立复核：隐藏 Files 仍挂载目录 effect；恢复队列可能覆盖未知降权标记。设置阻断的永久用例修复前失败证据见 `settings-unknown-red.log`，修复后在 `settings-final.log`。当前代码审查无未解决阻断，体验证据缺口如下。

## 原生环境与未验证项

`native-fixture.mts` 只启动隔离配置的 MyGo 与临时 Code／PA Runtime、ControlServer；模型为本地确定性 MockModelServer。SSH 是本机替身，只转发临时 socket 与隔离 token，未连接真实服务器、未调用真实模型。验收40条长 Markdown，共183826字节；相关事实见 `native/ready.json`、`native/scroll-fixture.json`。验收应用来自本轮渲染修复后构建，最终仅增加的 resume 守卫不影响该文件树界面；最终两个产品构建已包含该守卫。

原生 AX 按钮操作可用，但坐标点击、拖动及滚动调用均报窗口不可用；原生消息区 AX 未暴露工具行。因此原生拖动全过程、快速滚动的逐帧空白、Read 路径点击和创建后菜单值仍待恢复鼠标自动化或人工验收，不能用截图／SSR／Mock通过替代。曾使用单独的 Vite 调试页面装配300条富 Markdown；点击无关刷新后该浏览器调试页崩溃，后续被浏览器 URL 策略阻止访问。该页不是产品构建，不能据此认定产品崩溃，也没有可用的解析计数或帧率结论；调试服务已停止，未绕过限制。

终止本轮 fixture 后，应用正常退出，临时目录移除，`remainingSshPids=[]`、`runtimeErrors=[]`，见 `native/cleanup.json`。本轮性能调试服务已停止；用户 Demo 保持原始标签顺序，日常应用和后台未重启。新增初始设置参数使用协议30，Desktop 与后台需要匹配升级；大量已加载历史保留真实布局会增加布局工作量，超大记录的实际帧率仍需上述原生验收。
