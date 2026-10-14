# 为两个 Agent 产品接入 Vercel agent-browser

Status: ready-for-human

人工验收：挂起。按拥有者要求，等待 [bash 后台生命周期问题](../../../.agents/notes/proposed/feature/2026-10-14-bash-background-lifecycle.md)解决并通过对应回归与真实执行验收后，再恢复本工单的人工体验验收；挂起不等同于验收通过。

## 目标与边界

让 `ruukoto` 的 main 和两个产品的普通开发会话直接完成「打开网站 → 操作 → 截图 → 根据截图继续操作」，操作覆盖登录后的导航、搜索、表单填写和提交。本轮交付浏览器功能、截图完整导出及验收证据。技术取舍见[决策记录](../../../.agents/notes/implemented/feature/2026-10-14-agent-browser.md)，事实见[接入调查](../research.md)。

### 拥有者已确认

| 访谈 | 已确认要求 |
| --- | --- |
| Q1–Q3 | 两个产品都要；主 Agent 直接操作；基本流程是打开网站、操作、截图 |
| Q4–Q5 | 独立浏览器和接管已有浏览器都要；支持登录、填写和提交 |
| Q6 | 模型能看图，保存可完整取回的文件；不要求 IM 直接发图 |
| Q7–Q8 | 首版仅完全访问，各自只控制所在机器的浏览器 |
| Q9–Q11 | 同一会话跨轮保留页面和登录；拥有者先人工登录；空闲回收或后台重启后保留登录资料，不保证恢复原页面，不重放点击或提交 |
| Q12 | 复用现成人工入口：开发机有头窗口或 Chrome 调试授权；Linux 用官方 dashboard 经 SSH 转发完成登录/验证码 |
| Q13–Q14 | 只用官方正式 release，不维护补丁、不从未发布提交自行构建；写操作等待包含防重发修复的正式版本 |
| Q15 | 确认整体范围并按本工单交接，接受默认空闲 60 分钟回收及首版会话/交付范围 |

来源为 2026-10-14 本次 grill-me 访谈。拥有者在 Q15 回答「确认，按此工单交接」，整体共同理解已确认；实施者按以下范围推进，技术细节可在不改变目标、契约和验收的前提下调整。

版本前置：官方 [v0.39.1](https://github.com/vercel-labs/agent-browser/releases/tag/v0.39.1) 已于 2026-10-13T19:52:20Z 正式发布，包含 [PR #2085](https://github.com/vercel-labs/agent-browser/pull/2085) 的防重发修复；tag 为 `1165952d74ceed98fdc2dd97190ad41f44dd0e24`。2026-10-14 拥有者要求接手实施，版本等待已解除；阶段 0 的校验、故障与生命周期探针仍是进入阶段 1 的前置。完整网页操作仍是最终验收目标。原方案独立审查见[证据](../evidence/plan-review.md)。

### 首版契约

1. 仅完全访问的拥有者 main / 普通开发会话可用；请求确认、自动审查、计划模式、普通 SubAgent、独立定时会话、工作流步骤和 GitHub 评审不被顺带开放。装配、发送前检查、调用门与执行前有效模式复核保持一致。
2. 使用包含防重发修复的固定官方 release 原生程序，保持宿主 Node 22/24 支持；不直接引入声明 Node >=24 的 npm 包。v0.39.0 仅作为受控调查的反例基线，不作为功能交付版本。程序、版本或 Chromium 不满足时报告准备步骤，其他能力仍可使用；模型任务不自动安装或提权。
3. 独立浏览器的 profile、socket、会话名按产品档案和 Ruukoto 会话隔离，跨任务保持进程。默认空闲 60 分钟回收；显式关闭、后台停止时关闭自有浏览器，保留 profile、历史和截图。
4. 附接只使用显式 loopback CDP 或拥有者启用并允许的本机 Chrome 调试发现。Cookie 属于被接管浏览器，不宣称独立 profile 隔离；同一浏览器一次只允许一个 Ruukoto 会话自动化，跨产品占用也要核实。退出只断开连接，不关闭拥有者浏览器或标签。
5. 人工登录期间暂停自动化，拥有者通过新消息继续；密码不进入模型输入。浏览器存活时继续当前页面；已回收时按保留 profile 重新打开，不恢复或重放旧操作。
6. 截图先保存为不可变图片产物，再返回模型视觉块与产物引用。原图、实际模型输入、JSONL 和 prompt 快照可对应；落盘失败、图像超限或模型不支持视觉时明确失败，不能声称模型已看图。文件导出必须完整。
7. 点击、导航、提交开始后遇到超时、断线或取消，无法核实结果时记 `effect_unknown`，不自动重发。停止或连接归属未核实时保留不可用状态，不新开实例来掩盖旧操作可能仍在执行。

首版不交付通用 stdio MCP、跨机器控制、云浏览器、自己的登录界面、密码库、IM 图片外发、插件平台或上传下载等额外能力。常规网页交互以验收页面的链接、输入、选择、勾选、滚动、提交与标签切换为准。

## 方案

### 阶段 0：先证实接入路线

在隔离测试目录使用固定官方原生二进制和 Chrome for Testing，分别在 macOS/Linux（需要时 `ssh tx`）做真实浏览器探针，不接入真实账号。记录校验值、Chrome/OS/Node 版本、命令、进程身份与结果。正式修复版发布前可用 v0.39.0 调查基础行为、复现重发反例；这些结果不能替代最终交付版本的探针。

- 证明宿主 Node 22/24 可调用固定程序；连续 open、snapshot、click、screenshot 能跨两轮任务保留页面。
- 原版内部传输重试与不重放契约存在已知冲突。等待包含 PR #2085 或等价修复的正式 release，注入「已执行请求但 daemon 响应被丢弃」，覆盖 EOF、读超时和 reset；服务端提交计数只能为一次，返回结果未知。未经修复或未通过探针的 CLI 不得进入阶段 1，不能用自编译提交或本地补丁替代。
- 覆盖 daemon 自动启动、配置指纹变化导致重启、连接失败再启动；核实归属与停止方式。不能靠内部前台入口或复制上游私有指纹算法假定受管成立。
- 验证自有浏览器 close、取消在途动作、空闲、后台正常停止与强杀后的恢复；PID 复用或身份不符不能误杀别的浏览器。
- 附接独立测试 Chrome，证明 close/SIGTERM 仅断开；用户进程和标签保留；同一目标跨会话/跨产品的重复接管拒绝，本地地址解析不能导向远程目标。
- 实测官方 dashboard 的无桌面登录输入、暂停/继续、SSH loopback 转发与实例会话隔离，不公开到外网。
- 用无敏感信息的测试 Cookie 断言 profile 在 close/后台重启后仍保存登录资料。

产物为[生命周期证据](../evidence/lifecycle-probe.md)与 `probes/` 可复现入口；macOS/Linux 固定原生程序的生命周期、故障注入和人工入口已实测，实际管理器与组合的证明见[实现检查](../evidence/implementation-checks.md)。若停止核实、附接不关窗、排他控制或人工入口在任一目标平台无法成立，退回方案者修订并独立复审，不能做阶段 1 或降低要求后记为通过。

### 阶段 1：浏览器归属与共享工具

- 在 `packages/agent/src/` 增加浏览器适配模块与宿主工具族，使用固定程序和参数数组调用，不拼 shell；可执行程序、配置来源、namespace、profile、截图目录由宿主决定，模型不能覆盖。
- Runtime 持有按会话分区的浏览器管理器，任务只认领当前调用。现有 Driver registry 每任务清理，不承载跨轮浏览器。关闭、取消、模式切换、后台停止与冷恢复统一回到管理器。
- 落盘绑定区分自有/附接、目标标识、代次、进程归属与停止是否核实，状态和事件在 core 同事务保存；profile 由 Chromium 管理，不声称与 SQLite 原子。需要改 schema 时遵守单调版本与新库拒绝启动。
- 提供一个 `browser` 宿主工具，用类型化动作覆盖 start/attach、open、snapshot、click/fill/select/check/press/scroll/wait、tabs、screenshot、status、close。复用上游元素引用与命令行为，不重做网页自动化引擎或开放任意 CLI 管理参数。
- 在类别、执行画像和任务收窄中明确身份与有效模式，调用门再次核实。两个产品经共享 runtime 装配；main 不因此获得 bash 或全部 MCP。
- 复用调用绑定、操作账本、完全访问真实授权、取消及未知效果记录。快照/截图等可证明无外部写入的动作才用无效果分类，click/open 不能按名字当成只读。
- 跨层失败使用带 code 的 BrowserError；不可用、绑定失效、元素失效、上游 outcome_unknown 和停止未核实分别判别，不解析 message。已发送后丢响应映射到效果未知，不能据失败消息自动重复动作。
- 输出当前会话的人工进入方式与继续指引；dashboard 只承担人工操作，不接入它的额外模型聊天功能。现有 Chrome 接管说明调试授权前提，不默认占用任意用户窗口。

### 阶段 2：截图与完整导出

复用 `ArtifactStore.importImage/readImage`、宿主 `recordArtifact` 和既有模型发送链路。宿主分配截图文件名，校验实际 MIME、字节数和 SHA-256；实际模型输入进入 JSONL/prompt 快照。沿用图片上限，大图超限明确报告并给出视口截图这一可选下一步，不静默丢图。

给现有 `read-artifact` 增加完整文件导出入口（建议 `--output <file>`），按既有控制 API 分页，校验完整字节数与图片哈希；保留 offset/length 的切片语义。下载中断时不得把半张图片覆盖到目标文件。

### 影响范围与文档落点

| 改动面 | 调用方、文件与要求 |
| --- | --- |
| 领域与落盘 | `packages/core/src/types.ts`、必要的绑定存储/schema；复用会话身份，不存 Cookie/密码正文 |
| 浏览器执行 | 新 agent 浏览器模块；`host-tool-families.ts`、`tool-availability.ts`、`driver.ts`、`tool-op-ledger.ts` |
| 生命周期 | `packages/runtime/src/runtime.ts` 的共享装配、停止与冷恢复；覆盖取消、模式切换与 shutdown |
| 图片 | 现成 ArtifactStore 与 SDK/历史链路；优先复用，不另造图片记录格式 |
| 文件导出 | `packages/tui/src/cli.ts` 的 read-artifact；控制面优先复用分页 API，确有不足才扩协议 |
| 产品 | 核实两个 `apps/*/src/product.ts` 的共同装配；没有差异时不重复修改 |
| 人类文档 | `docs/modules/agent-tools.md`、`execution.md`、`runtime.md`；落盘涉及 core、CLI 涉及 tui 时同步对应模块；`docs/usage.md` 写安装、人工登录、接管、导出和排查 |
| 命令与验收 | README、`docs/development.md`、pre-push-checks 同步受影响命令和测试入口；职责地图变化才改 `docs/architecture.md` |

### 验证方法

新增 `test/browser-tools.test.ts`、`test/browser-lifecycle.test.ts`、`test/browser-screenshots.test.ts`（可按实际职责收敛），每条行为配会因该回归失败的窄用例。CLI 替身检查参数、并发、错误和重复发送；真实浏览器探针验证 CLI/Chromium/进程事实，不能互相代替。

相关回归选 `test/62-tool-availability.test.ts`、`test/10-access-modes.test.ts`、`test/63-approval-gate.test.ts`、`test/64-tool-op-ledger.test.ts`、`test/07-read-images.test.ts`、`test/09-artifacts.test.ts`、`test/29-cli-entry.test.ts`、`test/03-lifecycle.test.ts`、`test/04-crash-recovery.test.ts`；实际触及 schema、协议、SubAgent 或工作流过滤时按[最小检查集](../../../.agents/skills/pre-push-checks/SKILL.md)追加。修改中跑 check:static；构建/依赖变化时加 build、lint、typecheck，不默认全量 check。

真实模型验收仅显式 `RUN_MODEL_CHECK=1` 时运行：在受控网页完成表单，并根据截图回答随机展示内容，分别经两个产品主入口。缺模型配置、Linux、Chrome 或必要 IM 前提时报告缺口；不以模拟结果替代。网页本身不需要真实账号。

## 进展与交接

- 当前角色与阶段：工程交付收尾；阶段 0–2 已实现，独立实现审查无未解决阻断。真实视觉模型双产品验收已通过；人工产品体验挂起，等待 bash 生命周期问题解决。
- 下一角色与动作：先解决 bash 生命周期问题并完成其工程验收，再恢复拥有者的人工登录/继续、接管与截图取回验收。Linux 生产前提另由环境拥有者补齐；本轮没有授权实施 bash 提案。
- 当前内容：分支 `Eitrous/agent-browser`，起点 `9e050ec`；两产品共用固定 native 管理器/宿主工具，CLI 完整分页导出落地，原提案迁入 implemented。拥有者授权本轮提交代码、docs、决策与证据并合入本地 `develop`，不包含推送或部署；合入不改变人工验收挂起状态。
- 未验收项：人工体验、真实账号、Linux Node 22 和 OS 重启没有通过证据。tx 生产机器需持久磁盘、系统库和可用 sandbox，隔离校准的 noSandbox 不作为产品默认值。

## 验收与证据

| 要求 | 最窄可证行为 | 当前证据 |
| --- | --- | --- |
| 双产品直接使用 | ruukoto main / code dev 真实浏览器流程；main/dev 截图输入；受限/Plan、SubAgent、scheduled、workflow、GitHub来源收窄 | [真实 Browser+Runtime+SDK 组合](../evidence/runtime-sdk-macos-node24.json)，模型为脚本 mock；正式 browser-tools、62、111 回归 |
| 独立与附接 | 两轮延续页面、profile 隔离、附接不关用户窗、同 UUID 跨产品/别名重复接管拒绝 | [阶段 0](../evidence/lifecycle-probe.md)与 [Node 22/24/Linux 实际管理器](../evidence/implementation-checks.md) |
| 登录与恢复 | dashboard 键鼠/SSH、本机持久 Cookie 请求头、关闭后保留、SIGKILL 冷恢复不重放 | 同上真实程序；标准 session Cookie 不保证跨关闭，无真实账号验收 |
| 操作与取消 | EOF/30秒超时/Linux reset与在途取消，实际 POST=1；状态保存失败不掩盖未知效果；停止未核保持不可用 | 平台 JSON 与 browser-lifecycle 正式负例；[独立实现审查](../evidence/implementation-review.md) |
| 人工继续 | 暂停前已接受/排队的输入不能 resume；IM 沿原 registered 顺序；暂停后新消息换代清引用 | browser-tools 真实 Runtime/SDK 接受屏障；独立队列反例与修后复核 |
| 模型看图 | 图片原图、provider请求、JSONL、prompt同源；纯文本/超限/落盘失败明确报错 | 真实程序+mock模型组合和正式回归；[真实视觉模型双产品 2/2 通过](../evidence/real-model-acceptance.json) |
| 文件取回 | 大于720KiB PNG完整导出，SHA/0600；失败保留原目标 | 29-cli-entry 两产品正式bin，Node22/24及[独立导出审查](../evidence/export-independent-review.json) |
| 安装与环境 | 官方SHA/版本固定，宿主22/24；缺准备只影响browser；Linux实现校准 | [release](../evidence/release-v0.39.1.json)、管理器三平台证据；生产依赖/sandbox仍待准备 |

工程检查与独立审查已通过；必要真实模型双产品已通过，产品人工验收挂起、环境前提仍待，不标 resolved。[实现检查](../evidence/implementation-checks.md)列出实际命令、初次缺构建失败及后续定向通过；不把模拟视觉链路记为真实模型通过。原方案审查只覆盖当时快照，最终实现以[独立审查](../evidence/implementation-review.md)及源码指纹为准。

拥有者补充的真实会话在本地网页测试中先后触发 file 协议拒绝和临时 HTTP 服务随 bash 返回被回收，导航失败再触发保护暂停；后续 HTTP 导航与两次截图已成功。真实 worker 和隔离 native/Manager 对照均复现原因，见[会话失败诊断](../evidence/owner-session-diagnosis.md)。诊断还发现模型工具说明未明确 URL 前提与 bash 后台进程生命周期，本次只记录问题，未变更提示或失败分类。

## Comments

### 2026-10-14 — 实现与独立返工

真实探针推动宿主持有 Chrome、单动作 stdin batch、opaque sidecar 指纹和 UUID 排他路线；不改拥有者目标或附接保留窗口契约。共享 Runtime、browser 动作、不可变图片和文件导出已落地。独立审查复现并推动修复排队模式误关闭、审批升权白名单、状态保存掩盖未知效果、慢流 discovery 取消、保存失败跳过回收及暂停前排队消息提前恢复；每处已有会回归失败的正式窄用例，最终审查无未解决实现阻断。

拥有者提供显式 models.json 用于真实视觉验收，双产品 2/2 通过，随机图码正确且各 POST=1，原图/JSONL/prompt 一致。首轮严格验收发现裸 eN 形态不兼容，修正规范化后保持原验收标准重跑通过；独立补审确认不扩大 selector 或旧引用。配置正文与凭据没有入库。本轮不提交、推送或部署。


### 2026-10-14 — 实施者接手

拥有者：「agent-browser已发布v0.39.1，现在由你来接手工单」。官方 release API、发布说明及 tag 源码确认正式版本包含 #2085；macOS arm64 资产哈希 `cc18fac41d9dc9821918340a136e643286ea05544c4dd35671b796f1a874cdef` 与官方 asset.digest 一致。按既有重流程先执行阶段 0，macOS 与 `ssh tx` Linux 环境均可访问；不把版本发布或源码核查记作生命周期验收通过。

### 2026-10-14 — 需求与访谈

原始需求：「$grill-me 我需要为这个agent添加vercel的agent-browser，由你来建立工单并制定方案」。Q1「两个产品都要」；Q2「打开网站、进行操作、截图」；Q3「两个产品的主 Agent 直接操作」；Q4「两种都必须支持」；Q5「包含登录、填写和提交」；Q6「模型能看图 + 保存截图文件」；Q7「首版只支持完全访问」；Q8「各自控制所在机器的浏览器」；Q9「跨轮保留页面和登录态」；Q10「我先登录，Agent 复用登录态」；Q11「保留登录资料，不保证恢复原页面」；Q12「采用这些现成人工入口」。

首轮独立审查发现传输重发后，Q13「只用官方版本，写操作等待官方修复」。补查发现官方修复已合入但未发版，Q14「等待官方正式 release」。完整功能要求保留，版本依赖明确列为前置。

独立复审完成后，Q15「确认，按此工单交接」。整体范围、默认 60 分钟空闲回收、首版不扩到 SubAgent/定时/工作流/IM 图片外发及官方正式版本前置均已确认。

### 2026-10-14 — 人工验收挂起与提交授权

拥有者要求：「将本工单的人工验收挂起，等待bash生命周期问题解决后再开启。然后提交改动并并入develop分支」。人工验收的恢复以相关生命周期修正及工程验收完成为条件，原浏览器验收清单保留；本轮授权提交与合入本地 develop，不把合并视为产品验收通过，也不实施尚为 proposed 的 bash 生命周期提案。
