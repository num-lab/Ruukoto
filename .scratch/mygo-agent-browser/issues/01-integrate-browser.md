# MyGo 右栏浏览器接入 Coding 主 Agent

Status: in-progress

## 目标与边界

让 MyGo 中发起的完全访问 Coding 主 Agent 任务，查看并操控所属主会话右栏的同一浏览器页面；首要验收是本地前端开发闭环。拥有者用“接管／交还 Agent”在人工操作与同一任务自动化之间切换。2026-10-29 访谈 Q1–Q10 的决定、理由、备选和关键契约统一由[决策提案](../../../.agents/notes/proposed/feature/2026-10-29-mygo-agent-browser.md)持有，下一角色必须先读；本工单只持有实施与验收。

本轮只提交已制定和审查的方案，不实现或发布。Electron/Personal 自动化、SubAgent、受限模式、计划模式、后台来源、新浏览器配置和通用电脑控制不在首版；TUI Chrome、既有文件预览和 present 的展示授权保持。

## 方案

按以下顺序推进，前一步证据不成立，不扩大下一步实现。实施者先核实当时基点与工作副本，使用独立工作副本；本工单不授权处理无关改动。

| 步骤 | 工作与调用方 | 完成依据 |
| --- | --- | --- |
| 1. 原生探针 | 在隔离 MyGo fixture 中用 Content + 前端 WebView + 两个浏览器 WebView；验证外部网页、常规 React 表单、隐藏执行和截图、共享登录、原生布局与 IPC，另验证变更脚本副作用后抛 SyntaxError 也只执行一次；此时不接正式 Runtime | A1 的页面侧 API 子集及 A2、A3、A7 的原生子集证据，明确支持的 macOS 版本；A1 完整 Agent/模型闭环留步骤 6，探针失败退回方案者，不能删除验收项 |
| 2. MyGo 页面宿主 | apps/desktop/mygo/main.go 与新浏览器 manager：前端 Page 精确身份、定向事件、每会话页面、导航/代次、矩形/遮挡、人工输入闸门和回调收尾；保留系统动作与 Sidecar 生命周期 | A2、A3、A7；MyGo Go 测试与真实窗口探针 |
| 3. 桌面与控制通路 | apps/desktop/src/mygo/sidecar.ts、main/host.ts、main/controller.ts、shared/bridge.ts，packages/control/src/protocol.ts、client.ts、server.ts 及请求处理：连接登记、任务来源、窄命令应答、截图分块与校验、断线解绑、迟到结果拒绝；检查提交、继续、引导与未决请求核实调用方 | A4、A6、A8；保持 1MiB 控制面上限，协议版本/兼容处理按实际格式变更更新，动作不进事件重放 |
| 4. 宿主工具与接管等待 | packages/agent/src/host-tool-families.ts、tool-availability.ts、driver.ts、context-assembly.ts、artifacts.ts，packages/runtime/src/runtime.ts 与 core 的实际来源/绑定存储入口；新增 desktop_browser，互斥装配旧 browser，固定来源、串行、记录、引用、接管等待和交还观察续轮 | A4、A5、A6、A8；沿 finishTurn 的 continue 与既有 marker/参考块方式，不新建通用暂停状态机，不泛化 Chrome manager |
| 5. 前端接线 | inspector.ts、inspector-panels.tsx、inspector-panel.tsx、browser-navigation.ts、browser-document.ts 与公共 Dialog/Dropdown/Select、设置/搜索/工作区弹层；原生占位、接管按钮、等待投影、URL/标题/历史与 present，切目标/会话仅变展示 | A2、A3、A5、A7；不重写聊天与三栏布局 |
| 6. 文档与整体验收 | 同步 docs/modules/desktop.md、control.md、agent-tools.md、runtime.md、agent-context.md、CONTEXT.md 及实际涉及的 core 说明，docs/usage.md、desktop-development.md；新增命令或构建入口时同步 README、development 与 pre-push-checks；入口代码加本提案锚点，实施后按 maintain-notes 转 implemented | A1–A10、独立实现审查和拥有者体验验收；缺前提保留待验收 |

精确新增文件和类型以步骤 1 的探针结果确定，不预造通用接口。跨包类型放所属包的 exports 并声明依赖，不能从 agent 反向依赖 control/desktop；Runtime 注入具名浏览器请求回调。截图复用 ArtifactStore 与既有模型图片协议，不引入第二套会话历史。任务来源与绑定若用版本化 meta，应与事件同事务保存；若确需新增 schema，单调升级并验证旧库，不能只修改内存状态宣称可重建。

模型实际看到的工具定义与结果按 agent-facing-text 验收：说明当前页面、有效引用、接管阻塞和不可用后的下一步；宿主进程/连接标识不进入工具正文，接管时不给模型 resume 入口。实现前后记录实际 prompt 快照中的 toolSchemas/systemPrompt 估算，模拟 provider 与真实模型分别标注。

## 进展与交接

- 当前角色与阶段：实施者，独立工作副本 `mirasim-worktrees/ruukoto/mygo-agent-browser` @ c39b8ddc。步骤 1 原生探针（P01–P17 全过，[探针证据](../evidence/probe.md)）、步骤 2 MyGo 页面宿主（H01–H08 全过，[宿主证据](../evidence/host-probe.md)）、步骤 3 桌面/控制通路、步骤 4 宿主工具/接管屏障、步骤 5 前端接线已完成，进入步骤 6 文档与整体验收。
- 基点漂移：方案基点 fc5acf83 之后 develop 新增 c39b8ddc（持久无工具侧聊），与本方案决定不冲突；其实现触及 driver/runtime/context-assembly/tool-availability/control，步骤 4 实施时已按新 HEAD 核对，侧聊无工具来源在 A4 作负例。
- 探针遗留：M1–M4 与 H09 人工项、真实下载/渲染崩溃事件、跨源子 frame、发布构建形态未验，明细见两份证据「未覆盖项」；已验证 macOS 仅 27.0.1 arm64。
- 下一动作：步骤 6 文档与整体验收——模块文档、决策笔记迁移 implemented、A1–A10 逐项验收（含 MyGo 真实窗口人工/可视项）、独立审查。
- Driver 接管边界已知限制：finishTurn/prepareNextTurn/prepareRequest/handleToolCall 四处屏障的整链路行为（最终回答期间接管后续轮带观察）目前由管理器与装配层单测覆盖，Driver 级真模型/夹具验证并入 A5/A6 验收执行。
- 技术阻塞与恢复条件：探针与宿主假设全部实测通过，无方案阻断；若后续原生行为偏离探针结论须回到本证据与提案重核。

## 验收与证据

目前工程验收：待验证；产品验收：待验收。下列都是未来实施验收，尚未执行。方案审查单独记录于[审查证据](../evidence/plan-review.md)，不能把方案通过写成功能通过。

| 编号 | 必须证明的行为 | 最小证据 |
| --- | --- | --- |
| A1 | Agent 打开本地开发页，拿结构与视口截图，点击并填写 React 表单，页面状态真实改变，再观察并报告；模型没有切换到外部 Chrome | 真实 MyGo + 确定性本地页自动断言与页面截图；另用真实视觉模型完成同一闭环 |
| A2 | A/B 主会话现场独立；切到 B、切其他右栏标签、收栏或被弹层遮挡时，A 仍能操作，截图包含操作后新值；本地 HTML 隐藏后新发出的 module/fetch/相对资源请求仍可成功，离页时才释放 handle；当前会话/焦点不被抢回 | 真实两个 WebView 页面计数、DOM 结果、截图内容和切换记录；本机文档延迟读取/主动关闭回收用例；截图哈希变化本身不足以证明新鲜度 |
| A3 | 右栏拖动/动画、窗口缩放、Retina 坐标、设置/搜索/菜单/选择框、Code/Personal 切换正确；接管后中文输入和普通表单可用 | 真实 MyGo 交互与截图；覆盖浏览器曾获焦点后转 Agent 控制的输入拦截 |
| A4 | 仅 MyGo 来源、完全访问的拥有者主会话有 desktop_browser，旧 browser 不同时暴露；TUI、Electron、Personal、SubAgent、Plan 与后台来源的资格不扩大；排队/继续/引导不偷换目标 | Runtime/Driver 工具快照与来源负例，扩展 test/62-tool-availability.test.ts、browser-tools.test.ts 与来源相关回归 |
| A5 | 接管即阻止新网页动作，任务在模型发送/工具/最终收尾边界等待，交还后仍是同一任务且必须新观察；旧引用和暂停前已准备动作失败；模型无权交还；Agent 持有页面时人工地址栏/导航/刷新同样被挡住，关闭与接管始终可用 | 确定性 barrier 测试覆盖模型流、在途网页动作、工具 batch 和 finishTurn；最终回答期间接管后必须以同 taskId 发出含新观察的模型请求，不能直接 completed；真实按钮闭环，交还 marker/参考块可重建且每次只触发一次续轮 |
| A6 | 接管等待中取消、关页、退出桌面、权限变化不死等；断线/超时/迟到结果不跨页执行、不重发；后台重启中断原任务 | 逐个传输边界断线夹具与动作计数，读失败/未发送/效果未知分类断言；停止时先唤醒 waiter 再 SDK abort |
| A7 | 网页不能调用桌面方法或接收聊天/审批事件；加载伪前端 URL、跨源子 frame、下载/弹窗/设备请求均不越界；截图不含聊天区 | 真实恶意网页探针；Page 身份/EmitPage 负例，原安全测试与本机文档资源范围回归 |
| A8 | 工具来源、页面观察和截图可从记录重建；截图落盘失败不算已看图；大于 1MiB 的图片能在保持单帧上限时成功传输，中途断线/错序/篡块拒绝且不重发；本机文档 loopback 令牌不进工具结果/prompt；present 四模式展示保持，导航清旧引用，接管期间不绕过闸门；重放不执行动作 | 工具账本/图片产物/prompt 快照与有界分块负例；扩展 present-tools.test.ts、desktop-inspector-tools.test.ts、desktop-browser-documents.test.ts 及控制面定向回归 |
| A9 | Code 会话间网站登录共享，重开桌面保留持久 Cookie 但不恢复页面或动作；不复制系统浏览器登录数据 | 真实 MyGo 确定性 Cookie 服务、退出重开与双页登录/退出；不以会话 Cookie 声称永不失效 |
| A10 | 独立实现审查无阻断，拥有者认可接管按钮、等待/交还、后台页面和弹层体验；TUI/Electron/Personal 既有行为通过受影响回归 | 独立审查记录、拥有者体验结论；真实模型/原生前提缺失时保持待验收 |

实施检查按实际 diff 选范围，基础为 npm run check:static，以及 browser-tools/browser-lifecycle、desktop-inspector-tools、desktop-browser-security、desktop-browser-documents、present-tools、62-tool-availability 的受影响用例；Driver 等待另加 94-task-ending、queue-guidance-runtime，控制协议另加控制面与提交幂等用例，具体文件先用 rg 核实。MyGo 运行 go test ./...、受影响并发路径 race 和 npm run desktop:mygo:build；Electron 仅验共享代码受影响的类型/构建与原行为。无需因本功能在 Linux 重跑 WKWebView，用例涉及共享后台时再按改动面验证 Linux。

每处行为改动配最窄回归；新接管与断线测试应能在撤掉对应保护后失败。真实模型外验用显式开关与隔离档案，不把离线 fixture 通过冒充真实模型通过。任务总体验收前保存命令、环境、被测内容摘要、实际结果与未覆盖项。

## Comments

2026-10-29：拥有者 Q1/Q2 采纳推荐，Q3 指定显式接管按钮；第二轮 Q4 指定 MyGo，Q5–Q7 采纳推荐；第三轮 Q8–Q10 全部采纳推荐。本轮授权为制定方案。

2026-10-29：独立方案审查指出本机文档 handle、控制面截图帧预算和探针验收依赖缺口；方案修订并复审通过。作者另补齐最终回答期间接管后的新观察续轮；具体审查对象与检查见审查证据。

2026-10-29：实施者接手，建独立工作副本跑步骤 1 原生探针。P01–P17 自动项全过：隐藏页持续执行且截图新鲜（位块==DOM 值逐帧比对）、React 受控表单合成事件成功、EvalContext 无显式 return 双执行、双会话页独立且切换保现场、`Emit` 广播会到浏览器页故前端事件须 `EmitPage`、外部 https 页被引擎层拒绝且同 URL 伪前端被 Page 身份拒绝、Cookie 跨页跨启动共享。人工项 M1–M4 与下载/子 frame/发布形态列未覆盖项。证据：[probe.md](../evidence/probe.md) 与两份 JSON 报告、shots/。

2026-10-29：拥有者在完整方案交付后要求“提交”，据此记录定稿并提交本功能方案及交叉链接；本轮不开始实施。

2026-10-29：步骤 2 MyGo 页面宿主完成。`main.go` 迁 `WindowOptions.Content`；新增 `apps/desktop/mygo/browser/`：`Manager`（页面池/矩形钳制/导航代次/原生盖输入闸门/定向 EmitPage/RenderProcessGone/ReleaseAll）与绑定面 `Frontend`（Rect/State/Takeover/Return/Navigate/Back/Forward/Reload/Close，`BindAs("Browser")`，身份精确到 Page+窗口+URL）。`mygo.Bind` 反射绑定全部导出方法，故宿主方法不放在绑定类型上。`preload.js` 加 `window.ruukoto.browser`；sidecar 失效经 `onFail`→`ReleaseAll` 放开输入并废代次。宿主探针 `-host` 模式在生产 Manager 上 H01–H08 全过：真实 `mygo.call` 信任路径、接管/交还闸门与代次、拥有者导航 `page_owned`、外来 WebView `ipc_sender` 拒、关闭销毁。单测 `go test ./...` 与 `-race` 全绿。证据：[host-probe.md](../evidence/host-probe.md) 与 probe-report-host.json。

2026-10-29：步骤 3 桌面/控制通路完成。控制面协议升到 v47（PROTOCOL_VERSION 46→47，SCHEMA_VERSION 55→56 新增 `task_browser_bindings`）：新增 `push:"request"` 服务端→已登记客户端窄请求帧，客户端以 `{v,id,ok,result|error}` 应答；`ControlTransport.onCall` 为可选挂载，Electron/TUI 不受影响。`desktop_browser_register`（幂等登记连接身份，仅 shell:"mygo"）、`desktop_browser_event`（页面事实上行，进 `runtime.onDesktopBrowserEvent`）、`desktop_browser_chunk`（≤256KiB/块、≤8MiB、乱序补齐、index/total/sha256 与应答声明一致性校验、迟到/越界/重复/篡改拒绝）三 op 只服务已登记 socket。`server.callBrowser` 经 `runtime.desktopBrowserCall` 挂接：超时按效果未知、断线 disconnected、未登记 not_sent、应答只认发出 socket。`submit`/`continue`/`owner_question_answer` 经已登记连接提交时与任务同事务写 `task_browser_bindings`（服务端按 socket 归属，客户端不能自称；幂等重放不偷换）。Go 侧 `transport.go` 加 `kind:"request"`→`onRequest`→`browser.Manager.Command`（55s 超时，独立协程）；Node 侧 `sidecar.ts` 加 `goRequest` 通道（60s 超时按效果未知）与 `browser_event` 分发；`browser-bridge.ts` 负责分块拆分/内联上限/错误透传，`controller.ts` 快照后登记、`host.ts` 事件双向转发（控制面+渲染层 `browser_event` update）。`DESKTOP_OPS` 不含 browser ops，渲染层不可达。验证：新测试 `desktop-browser-control.test.ts`（登记/应答/事件/断线/串话/分块完整性/来源归属）与 Go `TestSidecarBrowserRequest` 全过；66/02/06/12/38/control-readiness/desktop-* 回归全绿；tsc/eslint/check:docs/verify-notes 全过。

2026-10-29：步骤 4 宿主工具与接管屏障完成。新增 `desktop_browser` 工具类别与专用族（`desktop-browser.ts` 管理器 + `desktop-browser-tools.ts`）：资格 = `task_browser_bindings` 持久来源 + dev 会话 + 完全访问 + 非 Plan/SubAgent/定时后代；与旧 `browser` 由 Driver 收窄互斥（MyGo 绑定任务只见新族，TUI/其他照旧）。命令按 `connectionId|session` 串行，`execute` 发送边界复核闸门：拥有者持有时 `awaitGate` 等交还（25ms 取消轮询），页面消亡/未绑定/未登记拒绝；`disconnected`/`unknown` 按效果未知记不静默重发。快照引用绑 (任务, 代次)，导航/代次翻转作废，`stale_ref` 要求重新 snapshot；截图走 `transfer` 分块或内联 base64，校验图片签名后 `importImage` 进 ArtifactStore 并记 `recordArtifact`；超 24k 字符快照截断标注并尝试 `importAttachment` 全文产物。接管屏障：Go `gate` 事件 `owned:false→true` 置 `pendingReturn`，Driver 在 `finishTurn`/`prepareNextTurnWithContext`/`prepareRequest`/`handleToolCall` 四边界 `browserGate`：持有时发 `task.browser_wait` 事件并等待，任务保持 running；释放后 `recordBrowserObservation` 先 eval 取 DOM 摘要（失败写 unavailable 事实）、`appendMarker("ruukoto_browser_observation")` 落会话 JSONL 并解析核实、`mustRejudge` 强制一次 `finishTurn` continue；装配层把未投影的最新 marker 投为 `browserObservation` 参考块并按 observationId 记录交付，发送兜底 `checkBeforeSend`/`prepareRequest` 对未交付观察拒绝旧上下文发送。`server.revokeBrowser` 断线时回调 `onDesktopBrowserDisconnected` 标记页面 gone 并释放等待。验证：新测试 `desktop-browser-manager.test.ts` 7 例（资格矩阵、互斥、事件投影/一次消费、断线释放、等待/取消不发送、串行、代次引用作废、观察 marker→参考块投影与 unavailable），control/tool-availability/host-tool-families/task-tool-policy 回归全过；check:static 全绿。

2026-10-29：步骤 5 前端接线完成。新增 `renderer/native-browser.ts`（`NativeBrowserApi` 类型 + `nativeBrowser()` 取 `window.ruukoto.browser`，`NativeBrowserState` 按 session 投影 gate/nav/title/gone/closed 事件）与 `renderer/native-browser-panel.tsx`（右栏原生宿主面板：`.native-browser-host` 占位区只上报几何不绘制页面，ResizeObserver + MutationObserver + scroll/resize 监听经 `reportRef` 上报 `rect` 与 `state(session, shown, covered)`；顶栏按所有权渲染「接管/交还 Agent」按钮与后退/前进/刷新/地址栏/关闭——后退、前进、刷新与地址栏仅 Agent 持有时可用，「接管」「关闭」始终可用；`usePageReporter` 的 rect/state 上报按 `[api, sessionId, visible]` 收窄不逐帧刷屏）。`code-state.ts` 接 `browser_event` update 进 `NativeBrowserState` 并投到 `code-browser` 标签；`inspector-panel.tsx` 的 browser 标签在 `state.pages` 命中时改渲 `NativeBrowserPanel`，命中不了保持原 iframe `BrowserPanel`——普通浏览器/文件预览标签完全不动。`env.d.ts` 暴露 `RuukotoDesktop` 联合类型（原 `DesktopBridge` + 可选 `browser` 面），MyGo preload 已有同名 API。样式 `.native-browser-host`/`.browser-gate-note`/`.native-browser-caption` 加进 style.css 既有 browser 区块。验证：`apps/desktop` tsc、eslint、全量 `desktop:mygo:build`（Go + 前端 + bindings + 签名）全过；真实窗口下的交互验收并入 A1–A3、A5。
