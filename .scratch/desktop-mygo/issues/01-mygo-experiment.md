# MyGo 桌面外壳试验

Status: resolved

## 目标与边界

拥有者于 2026-10-17 要求试验性把 Electron 桌面 GUI 换成 MyGo，再决定是否保留。交付可启动的 macOS Apple Silicon MyGo 应用，复用现有 React 界面与控制面行为；保留 Electron 入口作为对照和退路，拥有者随后明确「确认保留，提交然后并入 codex/desktop-demo-ui 分支」，完成保留决定并授权本地提交和合并。本轮不改变控制面协议、数据库、会话历史和后台实现；没有发布或推送授权。

## 方案

新增显式 `desktop:mygo` 与 `desktop:mygo:build` 入口，固定 MyGo v0.5.5（Go ≥ 1.27.1），复用已安装的 Vite/esbuild，不要求 Bun。先以构建后的本地资源运行，开发时改动重建重开即可，不另造 HMR 启动器。Go 宿主使用 WKWebView；将现有 main/index.ts 内的连接、订阅、请求、通知编排提取为 Electron 与 Node 子进程共用的 DesktopHost，具体系统动作由宿主注入。Electron 保持现有启动方式；MyGo 通过私有 stdin/stdout JSONL 管道调用 Node 子进程，保留 CodeController、SubmissionGuard、Personal SSH、附件限制及错误分类，不增加监听端口或向 renderer 发送令牌。

MyGo 的 renderer 适配只实现现有 DesktopBridge；调用与流式更新先注册监听后订阅。Go 仅向本地顶层文档开放宿主接口，远程 iframe 无 IPC、Node 或文件读取权；保留 CSP、导航／弹窗／下载与权限拒绝。文件与目录必须经原生选择器，附件路径由宿主直接交 Node，不经 renderer 传入任意路径。会话仍由后台存储；MyGo 使用独立应用数据目录，避免同时打开两个外壳争用未决提交记录。

跨进程失败按实际交付分类：尚未交付 Node 为 not_sent，交付后没有取得 DesktopResult 的请求为 unknown 或 disconnected；EOF、坏帧、退出、超时均完成全部 pending calls，并向 renderer 发布 failed。绝不以普通 Error 经 serializeFailure 降为 not_sent，不自动重放；submit／continue 由已有落盘记录用原键核实，审批只核实。Node stdin EOF 先关闭 DesktopHost／SSH；Go 等待退出，必要时有界升级 TERM／KILL，不重启未知结果的 sidecar。绑定方法额外校验 CallerWindow 与精确 mygo://localhost/ 文档 URL，全部 window.open 拒绝，主文档外链经窄方法打开；子 frame 由 sandbox、生产 CSP 与原生 main-frame IPC 限制共同隔离，并加真实探针。

构建把当前 process.execPath 作为绝对 Node 路径写入应用资源，Go 据此启动子进程，因此 Finder 的最小 PATH 不影响启动；沿现有 environment.ts 在 Node 内仅执行一次登录 shell，受管环境不执行。此实验与 Electron 同样依赖构建时仓库位置，且额外依赖该 Node 路径仍有效；路径失效明确报错并提示重建，不尝试未知 node。

MyGo 窗口、文件夹／附件选择、Finder reveal、通知／Dock、退出清理按框架 API 接入；任何 API 不能满足既有权限边界时先修订受影响方案，不通过隐藏失败降低标准。退出关闭 Node 子进程及 Personal SSH；日常 Code 后台继续运行。实验产物放 dist 独立目录，不覆盖 Electron 应用。

## 影响范围与文档

调用方：apps/desktop/src/main/index.ts、preload、shared/bridge.ts、renderer 入口；新增 Go 宿主、Node 子进程与 JSONL 请求应答、Vite/esbuild 构建脚本；根与 desktop 的 package.json／锁文件及 ignore。测试覆盖共用 DesktopHost、传输错误／退出、构建与真实 WKWebView。文档更新 README、docs/development、desktop-development、usage、modules/desktop、pre-push-checks；架构现有模块地图同步宿主表述。新决定按 maintain-notes 记录，旧 Electron 提案保留并互链，既有 GUI 冻结、投影及安全决定继续成立。

## 进展与交接

代码、文档和真实窗口验收已完成，独立终审通过；拥有者已确认保留 MyGo。实施基点为 30f02b8；实际内容以包含本工单的提交及[源码摘要](../evidence/content-sha256.json)核对。根代理是唯一写入者，辅助代理只读研究和审查。当前交付动作是本地提交后在目标工作副本 fast-forward 合入 codex/desktop-demo-ui；目标起点同为 30f02b8，初始工作区干净。未解决的实现阻断为无。

## 验收与证据

工程检查通过：check:static、桌面直系回归与 MyGo 新测试、Go race、Electron 与 MyGo 构建及签名。真实 WKWebView 已在隔离 Runtime／本地确定性模型验证快照、历史、输入与附件、文件预览、明暗、iframe 隔离、故障可见性与退出。完整方法、截图、任务和限制见[验收](../evidence/verification.md)。应用包占盘约 9.86 MiB 与 289.3 MiB，只比较当前产物；未测统一条件下内存或启动时间。外部真实模型、Personal 真 SSH、系统通知送达、IME 和长流滚动明确未验证。

独立方案审查：2026-10-17，独立只读审查者复核原始要求、代码与修订工单后通过；跨进程失败分类和 Finder 首启 Node 发现两项阻断已补齐并复审解除。独立实现审查已发现并跟进修复管道阻塞、附件选择期间换实例和关闭后迟到 online 三项问题，独立复核与入库回归均通过；最终实现、文档与证据独立终审通过，无未解决阻断；29 项源码摘要全部匹配，最终 check:static 全部通过。产品验收：拥有者明确确认保留 MyGo，并授权提交合入；未验证的外部环境与具体体验项目仍按上述限制保留，不因该决定记为已执行。

## Comments

2026-10-17：方案审查补齐传输交付分类与固定 Node 路径。实施审查的三项生命周期问题已修复；正常关闭不再发布 failed，旧 Electron 构建排除 out/mygo。真实网页探针与 UI 结果见验收材料，未以模拟通过替代外部条件。

2026-10-17 终审：独立审查者直接核对最终源码、29 项摘要、真实截图／AX、iframe 与任务记录，并亲验最终 Go race、恢复提示定向用例和两个应用严格签名；工程验收通过。产品体验与最终选型待拥有者，本工单保留 ready-for-human。未提交、未推送、未发布。

2026-10-17 拥有者确认：「确认保留，提交然后并入codex/desktop-demo-ui分支」。据此完成产品取舍，授权本地提交与合并；复用原工程验收，提交钩子执行静态门禁，按提交检查补根构建。目标工作副本初始干净、与实施基点相同，采用 fast-forward 合入，不创建额外行为变更。
