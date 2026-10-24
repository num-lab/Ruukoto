# 01 删除 PA 旧连接并迁移到 Tailscale HTTPS／WebSocket

Status: ready-for-agent

## 目标与边界

需求来源：拥有者于2026-10-24提出「我计划将pa旧连接删除，改用 Tailscale + HTTPS／WebSocket 连接，需要你来制定方案」，并在方案完成后明确要求提交本次改动。已确认删除旧连接、目标技术、首版范围与应用凭据；本轮交付并提交方案，不实施、部署或修改实际tailnet策略。按架构与权限相关的重流程保存可交接方案并独立审查。

技术契约、理由与备选唯一归属为[决策提案](../../../.agents/notes/proposed/architecture/2026-10-24-personal-tailscale-https.md)。推荐目标是一个 PA HTTPS 地址同时连接新 durable 聊天与设置，Tailscale Serve 终止 TLS，独立私有 socket 入口承载认证、代理与原服务维护，WSS 推送原生状态；Code 不迁移。

### 已确认范围与来源

1. 拥有者于 2026-10-24 回答范围问题：「统一 PA 聊天与设置，删除两条 SSH 连接（推荐）」。同时迁移新 durable 聊天及设置，不再保留旧聊天 SSH 或新设置 SSH。
2. 同次回答连接范围：「仅自己的 tailnet，保持单拥有者使用（推荐）」。本方案沿用现有 Electron/MyGo 桌面，不增加浏览器/手机 UI 或多用户。
3. 拥有者随后回答功能处置问题：「按推荐首版交付，旧专属功能另排」。首版交付文本聊天、完整历史、实时工具状态、提问/审批、工作管理与全部现有设置；旧附件上传、Continue、Context和会话级模型菜单另排。
4. 拥有者确认鉴权：「Tailscale 加独立应用凭据，保留应用级隔离」。每个桌面安装使用独立凭据，Tailscale身份不能单独授权业务；双壳的秘密存储、配对和撤销纳入同一迁移。

### 确认状态

迁移范围、首版功能和鉴权方式均已确认，没有待拥有者选择的设计分支；连接/维护基线及应用凭据增量均已独立审查通过，可交给实施者。方案完成不等于运行代码已实现或真实环境已验收。

### 首版功能边界

| 功能 | 方案与完成条件 |
| --- | --- |
| 主会话 | 连接现有 durable main，与 IM/CLI 共享历史；发送文本、查看接纳/排队/回答、重连后继续观察 |
| 历史和实时状态 | 主会话分页历史、长正文、文字流与工具活动；已完成消息以原 entry 为准，不能只显示 `/messages` 的最近16条 |
| 模型、Skills、MCP | 保留现有三页全部有效配置能力与显式测试/发现；停存启迁到服务器独立入口 |
| 提问、审批与工作 | 显示当前未决；仅处理原业务允许 local 入口处理的动作，IM问题仍可查询/取消、回答须回原平台，原IM批准也不代批；取消后台工作须有原工作身份与回执，不停止整个PA |
| 主聊天停止/继续 | 现有个人 HTTP 没有主 Submission 停止入口；本方案首版暂不新增该入口，与可取消的后台工作分开，不能用 `/stop` 停掉后台冒充聊天停止。旧Continue已确认另排；用户回答未单独指定新增主聊天停止能力 |
| 原旧连接专属能力 | 旧附件上传、旧 Task continue、Context 和会话模型菜单已确认另排，首版PA页面不显示这些无对应入口，Code保留。PA原本不支持Plan；权限控件若保留，使用 `/permissions` 的真实入口默认语义。后续功能另建需求，不在此次连接迁移中实现兼容层 |
| 运维 | 桌面不再运行 ssh；服务器 SSH 登录/应急 CLI 是管理员通道，是否关闭 sshd 不属于本任务 |

不迁移/删除历史，不换个人数据库，不重写 IM 或模型执行，不建立旧协议兼容层，不做公网 Funnel、浏览器 UI、多用户或自动远端安装。

## 方案

### 0. 在隔离环境证明传输与身份前提

使用拥有者指定的测试 tailnet 节点和空档案，记录客户端/服务器 OS、Tailscale 版本和配置范围。先用无业务数据的 HTTP/WS 探针验证 Serve 私有 Unix socket、root 配置、0600/0700 权限、固定用户身份头、非拥有者拒绝、浏览器跨站拒绝、证书链、HTTP/1.1 Upgrade、心跳、断网、策略撤销、节点重启和 Serve 持久配置。输出到本功能 evidence；不把官方源码检查记为实际成功。若环境不支持私有 socket 或无法保证身份来源，退回方案者修订认证设计，不临时开放 TCP 或跳过认证。

同时在两壳隔离测试凭据上验证macOS安全存储、应用访问控制与重建后的授权行为；确认现有electron-builder fuses、MyGo签名资源和固定Node可满足提案的启动约束。正式凭据不用于探针，开发构建不共用生产命名空间；不能因为Keychain调用成功就认定未授权程序无法借外壳读密钥。

### 1. 个人后台与独立远程入口

在 `apps/ruukoto/src/` 增加有界的远程入口与协议定义，入口仍属于个人产品。复用 `personal-control.ts` 的业务处理、`personal-settings.ts`、`personal-maintenance.ts`、`personal-history.ts`、`personal-local-records.ts`；抽取实际重复的路由/协议校验即可，不搭通用多传输框架。`personal-entry.ts`/bin 增加固定启动与配置入口，部署单元将后台、remote 和 tailscaled 分开监督，停止后台不停止 remote。remote 配置、socket 和维护状态固定在现有受保护根内的 `~/.config/ruukoto-remote/`，拒绝符号链接、错误权限及超长 socket；不扩大个人档案顶层格式，锁覆盖 socket 清理，禁止第二 remote 抢同一状态或路径。

握手明确协议、产品、持久remote实例身份、原档案与后台运行代次；remote身份在显式初始化认证状态时生成，进程重启不换，缺失/损坏/未知版本不自动重建。所有写入固定原档案。网络入口采用明确路由及op名单，在线业务仍交唯一Harness；维护时复用原systemd核实和离线锁，不持有第二个Harness。remote不从外部接受任意程序/单元/档案，不把后台令牌发送出去。

实现独立应用凭据登记、校验和撤销，认证状态由remote独占，窗口消费/错误次数/登记/撤销在同一私有状态文件提交，先持久化再应答或放行。新增仅本机可达的admin socket和引导式管理入口，提供短时配对、列表与撤销，不向Serve发布admin。桌面先安全保存候选秘密再兑换；服务端只存摘要、回执与撤销墓碑，丢答凭原候选核实，不引入服务器pending/activation阶段。业务请求及WS须同时满足固定owner和active凭据，队列后实际准入再检查；撤销关闭旧连接但不取消已接纳工作。具体协议与失败归属以决策提案为准。

新增主会话时间线分页与原文补读，WSS 由 `watchEvents` 驱动有界 PA 投影。一次订阅的快照、历史切点和后续事件须可去重衔接；重连与慢消费者重新同步，不增加持久事件库。库依赖用已安装的 `ws`，在消费 workspace 声明；不跨包相对 import 或依赖 `node_modules` 私有路径。

远程入口承接完整单项维护，私有目录按操作键保存摘要、修订、阶段与最终结果，同时最多一条未决，完成回执保留以拒绝迟到重复执行。接受后不受桌面断开影响；重启只核实，不重发保存。设置后台环境检测继续在实际后台执行，原环境不明保持只读。各桌面 Host 负责自己的旧维护记录检查，不能让远程入口声称已证明所有客户端没有本地未决。

### 2. 桌面宿主与 PA 页面

重写 `main/personal-controller.ts` 为 HTTPS/WSS 连接，`personal-settings-controller.ts` 保留需要的表单/错误映射并去掉 SSH 与本机阶段执行，必要时直接合并其重复连接职责。`personal-config.ts` 只保存一个地址及绑定身份，沿 host/ipc 提供原始业务请求；`shared/bridge.ts` 用可辨别的 PA 更新，与 Code 的快照/事件分开。双外壳复用同一个 Host 网络实现，凭据不进入 renderer。

`DesktopPlatform`注入实际需要的凭据读取/保存/删除。Electron在 `main/index.ts` 接入当前safeStorage异步API，私有文件仅存密文；MyGo由Go主进程内的Security.framework持有Keychain权限，`transport.go`与 `src/mygo/sidecar.ts` 处理仅宿主间的专用帧，不能经 `main.go` 界面事件或绑定外发秘密。配对候选和active记录都绑定origin及内部身份；锁定/拒绝/损坏不当成缺失、不自动重配、不回退明文。两壳独立凭据、命名空间和未决关联。

生产构建加提案所列的入口限制：Electron沿现有builder配置fuses和ASAR完整性；MyGo沿现有构建补签名资源校验、固定Node摘要、sidecar环境/参数清洗，拒绝调试或外部代码覆盖后再开放凭据。同步 `apps/desktop/package.json`、`scripts/mygo.mjs`、`mygo/main.go`、`mygo/transport.go`及实际新增原生文件；`main/environment.ts`与Host环境采用路径也需阻止登录shell重新注入宿主，同时保留Code后台/终端的显式环境传递。不扩展Agent执行监督器构建，不新增通用读密钥helper。原生存储操作失败与私有管道断线均保留原请求关联。

renderer 为 PA 建立原生投影，不再实例化旧 PA `CodeState`；复用已有消息、工具、设置组件。统一 `personal-connection-settings/state`、`personal-management-state`、`personal-settings-state/pages` 的连接来源，保存中的表单、档案切换和迟到结果保持原保护。更新 app、composer、conversation、notifications、attachments 的目标判断，让旧按钮不再向新 PA 发旧 op。地址配置按“输入地址→连接核实→完成”引导，程序管理内部身份；问题/审批按来源能力显示实际可用动作。

### 3. 先切通，再删除旧入口

在同一交付中替换所有正式 PA 入口，删除 `personal-ssh.ts` 及仅被它使用的读取令牌/转发/远端程序检测代码；删除旧 PA 的 `ControlConnection`、旧快照和 SSH 设置表单。共享 `packages/control`、Code/TUI 使用的恢复与投影保留。生产构建中不得继续调用 PA 的 ssh，也不得静默 fallback。

新连接使用新的有版本配置记录，不覆盖旧两个配置文件；旧 pending 与损坏记录原地保留。发现旧设置维护未决，先列出需核实的原连接与操作，由服务器原档案/服务事实处理，不能把新连接成功当作旧操作完成。旧聊天未决不导入新 durable 请求。切换前关闭全部旧客户端，分别核查 Electron/MyGo 及实际使用设备的本地记录，并记录原版本、服务配置、可恢复备份与未决清单；新版本有写入后不使用旧备份直接覆盖数据。回退只切兼容的软件/连接配置并保持原档案；若不兼容先停止交付而非硬回滚。

### 4. 文档与交接

实现时同步 `docs/modules/desktop.md`、`personal-durable.md`、`products.md`、`deploy.md`，以及 `docs/architecture.md` 的连接图与依赖说明、`docs/usage.md` 的连接和恢复、`docs/desktop-development.md` 的双壳说明。新增命令/依赖同批更新 README、`docs/development.md`、`.agents/skills/pre-push-checks/SKILL.md`。旧桌面规格 R3/R15/R19/R20 与非目标、新设置规格及工单07加明确的取代关系；已完成历史与原验收证据保留。提案在实现后按事实移入 implemented，旧笔记只改仍成立的事实，不覆写原决定。

### 影响与验证索引

| 改动面 | 调用方/检查 |
| --- | --- |
| PA 本机/远程协议、历史、事件 | `test/personal-cli.test.ts`、`personal-history.test.ts`，新增网络身份、WS投影、分页与断线窄测；本机 CLI/IM 仍走原语义 |
| 维护、配置与锁 | `personal-maintenance.test.ts`、`personal-settings.test.ts`、`personal-settings-blockers.test.ts`、`desktop-personal-settings.test.ts`；新增 remote 崩溃阶段和并发维护负例 |
| 应用凭据与配对 | 新增认证状态/真实HTTP窄测：配对原子性、错误限额、重启失效、同ID重放、丢答恢复、撤销墓碑、排队请求再鉴权、凭据状态写失败关闭入口；管理CLI的列表/撤销使用选择，不要求人输入内部ID |
| 双壳安全存储与私有桥 | Host存储替身覆盖先保存后兑换、origin/档案绑定、拒绝与损坏；`apps/desktop/mygo/transport_test.go`、`test/desktop-mygo.test.ts`覆盖专用帧不进入renderer/事件、代次与坏帧/退出；真实macOS补Keychain与更新授权 |
| 受信外壳启动 | 生产制品负例验证Electron RunAsNode/NODE_OPTIONS/inspect/远程调试/外部renderer拒绝，MyGo替换Node/sidecar/签名资源与环境注入拒绝；开发测试命名空间不能读取生产凭据；Code启动与终端回归按实际影响选取 |
| 受保护根 | 核对 `personal-command-config.ts` 的 `personalProtectedRoots` 与 tools-config/tools/file-search/command/native grants 调用方；复用既有 `.config` 保护，不新增可任意配置的外部状态路径；新增受限模式不能授权/接触remote根、完全访问沿原例外的回归 |
| Host/renderer/两个外壳 | `38-desktop-main.test.ts`、`38-desktop-personal.test.ts`、`desktop-personal-interface.test.ts`、`desktop-personal-settings-pages.test.ts`、`desktop-mygo.test.ts`；另按实际改动加 composer、attachments、notifications 的行为用例 |
| 删除旧链路 | 删除只验证旧 SSH 参数的用例，目标隔离、丢答、令牌不泄漏、Code 不受影响等断言迁入新链路，不能连安全行为一起删 |
| 构建与入口 | 依赖/命令改动后执行 `npm run build`、`npm run check:static`、相关产品入口测试；双壳构建与 MyGo Go 测试按提交前 skill 选取 |
| 真实验收 | Linux 固定 systemd 与 Tailscale、macOS Electron/MyGo、真实模型/IM 另列证据；没有前提写未验证 |

具体文件名在实施时以当前检出重新核实，不因本文索引跑无关全量检查。每处新行为配会因回归失败的最窄用例，命令写完整文件名。

## 进展与交接

- 当前角色与阶段：方案交付完成。迁移范围、首版功能与独立应用凭据已获确认；连接/维护基线及配对、撤销、双壳安全存储、受信启动增量均已独立审查通过，无未解决方案阻断；运行代码未修改。
- 当前内容：方案编写分支为 `develop`，基点为 `e6c97bc0198aadf9fb91c18c76ac546ae8c5b004`。本工单、新proposed笔记、六篇既有笔记的待实施互链、[原审查基线快照](../evidence/reviewed-plan.patch)和[含应用凭据的审查快照](../evidence/reviewed-auth-plan.patch)在同一方案提交中保存。最新快照含全部技术正文，保存后仅补交付状态、验收及提交授权记录；审查哈希不代表这些交接字段的后续更新。
- 下一角色与动作：实施者从阶段0的隔离链路/安全存储探针开始，按实际证据推进服务端、双壳与删除旧连接。设计分支已确认，不再重复请示；本轮提交方案，不开始实现或部署。
- 阻塞与恢复条件：方案阶段无事实调研阻塞；实际实施和生产切换需满足测试节点、管理员配置与真实外壳验收前提。本轮不访问生产或读取令牌。

## 验收与证据

| 编号 | 工程验收要求 | 最窄证据 |
| --- | --- | --- |
| A1 | 固定拥有者加有效应用凭据才允许业务；正确网络身份但无/错/撤销凭据、伪造头、非拥有者、缺头/tagged来源、恶意网页均拒绝且无副作用 | 真实Serve探针+HTTP/WS认证负例；除root/remote运行账户外不能连私有socket；受限任务不能授权或接触remote根；admin socket不被Serve发布 |
| A2 | 单地址可显示新 durable 主会话，与 Code 状态隔离 | 临时真实 Harness+宿主+投影测试；双外壳实际打开 |
| A3 | 同键同参仅一份提交，异参拒绝；丢答、断网、退出重开不新键重发 | HTTP 接纳后断流、指纹提交后 admission 前崩溃、已执行无响应负例 |
| A4 | 先快照后事件；长历史、长正文、慢消费者、后台重启无重复/遗漏已落盘消息 | 超过16条与超帧历史，订阅边界并发提交，队列溢出恢复，旧代次晚到；停机关闭WS/订阅后才释放锁 |
| A5 | 停存启全过程可核实，客户端断开不取消已接纳维护；不强杀、不重存 | 真 systemd；stop/save/start 每阶段断线及 remote 崩溃；并发操作拒绝，saved+启动失败保留；A完成→B完成→迟到A只返原回执 |
| A6 | 逐启动 token 轮换无需桌面重新取密钥，产品/档案/协议错误停止 | 后台重启、身份变更、错误版本与重定向/TLS 负例 |
| A7 | 所有 PA SSH 运行入口删除；旧配置/历史/pending 保留 | 生产引用搜索与宿主禁用 ssh 测试，字节/路径保留断言，Code/CLI 定向回归 |
| A8 | 审批与问题不越过原来源，失联不等于拒绝或批准 | local可用项、IM问题可取消但不能代答/代批，丢答查原回执；工具等待审批而无后续事件仍能刷新提示 |
| A9 | 节点/策略撤销和重启不会留下无限旧流，入口不暴露公网 | 真 tailnet 权限变更与 WSS 寿命/关闭记录，Serve/Funnel 配置、证书与重启探针 |
| A10 | 候选秘密保存成功才兑换；配对消费与登记原子且丢答可恢复 | 保存/读回失败不发请求；并发兑换只一项胜出；超时/超次/新开/重启失效；提交前后崩溃、响应丢失、本机绑定失败均用原candidate核实；相同ID重放无第二凭据 |
| A11 | 撤销持久生效，不能重放激活；已接纳工作不被误取消 | 排队未准入HTTP拒绝、旧WS关闭、已接纳维护继续、迟到配对返回撤销、存储失败关闭入口；owner/origin/档案A→B→A旧凭据仍撤销；remote重启身份不变、状态缺失/损坏不建空状态；其他有效凭据或服务器仍能核实原业务回执 |
| A12 | 秘密不进入renderer/日志/argv/URL，外壳隔离真实成立 | 两壳真Keychain/安全存储：重开、拒绝/锁定/损坏、重建授权、另一个应用取密钥拒绝；MyGo秘密帧不走事件/绑定，安全载荷阻止换origin出站；不得降级明文或仅网络身份 |
| A13 | 受信外壳不能通过启动注入成为密钥读取器 | 实际生产制品的fuses/ASAR与Node/资源校验；RunAsNode/预加载/调试/外部renderer/sidecar替换负例，签名/摘要失败在读密钥前拒绝；Code启动、终端与开发独立凭据仍正常 |

工程实现验收：待验证，本轮没有实现代码。产品验收：待验收，重点是一处连接即可使用聊天和三类设置、离线/维护/未决提示可理解、旧能力裁剪已确认、双壳行为一致。真实模型与 IM 只在显式前提具备时验证，不用 mock 代替。

原方案审查：2026-10-24，独立上下文 `/root/plan_review` 直接核对需求、当前源码与未提交方案。维护终态回执、旧journal检查归属、remote受保护目录三项阻断已修正并复核；当时功能取舍和鉴权选择未定。该结论仍覆盖未改的连接/维护基线，不覆盖此后选定并细化的应用凭据增量。基线提案SHA256为 `1ebf9ee5e747e272c69f7596a7c80571d0eb2c11efbcf41c31044ec3308b33de`，工单为 `51c95ad796aaeaa9409e07528ec4fc33aa6b50a817d5043c5ed01f3d21fe8c99`，对应上述快照。

原鉴权选项说明补审：同日同一独立上下文只复核设备级信任与B草案的状态划分准确；当时提案SHA256为 `d84f6e2831c907c7a73755fcd62895ae2a2ac7329bacc73c0ef1fb230adf641a`，工单为 `0b43ffd471a42bdb3c767542b917dd918df83f61007f5304572e8343c796c0d6`。此结论不是B的完整方案通过；最终应用凭据契约由下列增量审查覆盖。

应用凭据增量审查：2026-10-24，独立上下文 `/root/plan_review` 核对当前源码、用户决定、官方接口和两份方案全文，结论通过，无未解决方案阻断。覆盖先安全保存再登记、原子消费与回执、撤销准入、双壳秘密存储及启动保护；remote身份持久/坏状态拒绝、归属A→B→A旧凭据不复活及登录环境重新注入均已补齐。提案SHA256为 `199a7628f4a765458c7d9e45e61575db42b504efb3c696bf3491980bd8535164`，工单为 `c893900c226809aa16b73e26ac0758fb9b4b8b9e42dcac8ec90d230785a4b399`，对应最新审查快照；随后仅更新交付状态与本记录，技术正文未变。

作者验证：原 `npm run check:static`通过；本次仅方案与笔记更新，最终 `npm run verify-notes`、`npm run check:docs`及 `git diff --check`通过。源码与官方资料核查仅支持方案事实，不是A1–A13通过证据；没有连接真实tailnet、systemd、模型或钥匙串。实施仍须完成真实双壳隔离、启动保护及ad-hoc更新行为验收。

## Comments

2026-10-24：按拥有者请求建立方案。只读调研确认旧聊天与新设置为两条不同 SSH 链路；主要设计选择是独立维护入口、Serve 私有 socket 身份链和 durable 原生快照。提出两项异步范围问题，尚未获得回答；未改生产配置或执行部署。

2026-10-24：拥有者回答上述两项问题，确认统一聊天与设置并删除两条 SSH，只在自己的 tailnet 内单拥有者使用。正文已更新；原问题不重复请示。

2026-10-24：独立方案审查与返工结束，保留可核对基线快照。追加功能处置、鉴权信任层两个异步问题；范围选择尚未回答不影响交付当前方案，但不能据此开始实施。只读审查中关于PA HTTP工具能自填固定头的反例已撤回（该入口有头部白名单）；设备上的其他HTTPS程序与Coding宿主网络调用的身份继承仍是有效鉴权取舍，已写入正文。

2026-10-24：拥有者选择「按推荐首版交付，旧专属功能另排」。已将首版核心功能及旧附件/Continue/Context/会话级模型菜单另排写回工单和提案；这是已审建议的确认，没有改变技术基线。鉴权问题尚未回答，不据此推导应用凭据选择或实施、提交、部署授权。

2026-10-24：拥有者确认「Tailscale 加独立应用凭据，保留应用级隔离」。方案收敛为双重身份检查；采用客户端先安全保存再登记摘要，补全本机配对/撤销管理、配对丢答恢复、撤销准入顺序及双壳存储/启动约束。所有设计分支已决定，当前只补审与完成交接，不将该回答扩为实施或部署请求。

2026-10-24：认证增量独立审查通过，文档检查通过，保存最终审查快照，工单置为ready-for-agent。首版范围与鉴权均已收敛；本轮方案交付完成，A1–A13及生产切换仍由后续实施验收。

2026-10-24：拥有者明确要求「提交」。只读复核确认本次10个文件仅含方案、工单、六篇互链笔记与两份审查快照，没有运行代码、其他任务或真实秘密；按仓库钩子提交到develop，不推送或部署。
