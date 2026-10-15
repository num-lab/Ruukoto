# 桌面客户端规格

本规格的依据：2026-10-14 至 2026-10-15，拥有者在 grilling 会话中逐轮确认了四轮共 22 题（第一轮 6 题、第二轮 5 题、第三轮 7 题、第四轮 4 题，全部按推荐答案），最后对完整结论清单答复“确认”。理由与被否方案见[决策笔记](../../.agents/notes/proposed/architecture/2026-10-15-desktop-client.md)，实施入口是 [issues](issues/)。界面参考 [ui-demo.html](ui-demo.html)；demo 里的数据和功能本身不构成要求，以本规格为准。

## 目标与术语

桌面客户端（应用名 Ruukoto）是控制面的又一个客户端，与 TUI 并存，可以同时连接同一后台。一个窗口内有两个连接目标：Coding Agent（ruukoto-code，本机）与个人 Agent（ruukoto，服务器），界面上的切换标签是「Code」「Personal」。不引入「模式」术语；实施时在 CONTEXT.md 补「桌面客户端」词条。

交付分两个阶段：第一阶段是 Code 目标与共用基础（01–07），第二阶段是 Personal 目标（08–09）。连接层从第一阶段起按两个目标设计，一个连接目标由产品身份、socket 路径与令牌来源组成。

## 已确认要求

| 编号 | 要求 | 验收依据 |
| --- | --- | --- |
| R1 | 首版只在 macOS（Apple Silicon）验收，只供拥有者自用：本地构建、ad-hoc 签名；不出 DMG，不做公证、自动更新与崩溃上报。不为 Linux 适配和测试，但选型不排除 Linux。 | `npm run desktop:build` 产出 `dist/mac-arm64/Ruukoto.app`，`codesign --verify` 通过，在 macOS 上可启动。 |
| R2 | 桌面端只经控制面协议读写后台事实，不读后台数据库、JSONL、工作区文件或 git。唯一例外是 Code 目标的本机系统动作：文件夹选择框与在 Finder 中显示。缺少的能力以新增 op 补齐，TUI 同样可用。 | 主进程中除上述两个系统动作外没有访问工作区路径的代码；两个目标的数据都经同一条请求路径获取。 |
| R3 | 令牌、`ControlConnection`、ssh 子进程与后台拉起只在主进程。preload 只暴露 `subscribe(target)`、`request(target, op, params)`、`pickFolder()`、`reveal(path)`；`request` 只放行桌面端界面实际调用的 op，其余由主进程拒绝。渲染进程开 `sandbox` 与 `contextIsolation`，关闭 `nodeIntegration`；CSP 为 `default-src 'self'`，不加载远程内容：打包页面以 HTML meta 交付；开发页面以响应头交付，只额外放行 dev server 与本次启动的 nonce，不放行 `'unsafe-inline'`；链接经主进程交给系统浏览器，只允许 http 与 https；Markdown 不渲染原始 HTML。 | 单测：名单外的 op 被拒绝，令牌不出现在任何 IPC 载荷中。人工检查：含 `<script>`、`<img onerror>` 与 `javascript:` 链接的模型输出不执行脚本。 |
| R4 | 快照与事件到界面状态的投影放在 `packages/view`（`@ruukoto/view`），TUI 与桌面端共用，语义沿用 [TUI 事件流规格](../tui-event-flow/spec.md)：按 seq 去重、补发、正文分段拼接、思考计时、工具意图与结果配对。该包必须能在浏览器运行：ESLint 拒绝 `node:*` 与 Node 全局（如 `Buffer`、`process`），对其他 workspace 包的值引用只能来自本身不依赖 Node 的模块：view 以浏览器为目标打包，产物只按浏览器全局做 `no-undef` 检查，以此判定。抽取按桌面端需要逐步进行，每抽一块，TUI 就改为引用新位置。 | TUI 既有测试通过；`packages/view` 有自己的单测；lint 能拒绝在 view 中引入 `node:*` 与使用 Node 全局；对打包产物的全局检查能拒绝依赖模块里的 Node 全局；view 以浏览器目标打包后，在不提供 Node 全局的环境中执行投影，中文与 emoji 的字节偏移结果和 Node 下一致。 |
| R5 | 协议版本保持严格相等，不加兼容区间或能力协商。版本不一致时，该目标显示双方版本号与需要更新的一侧，不自动重试。Code 目标客户端较新时，给出人工恢复步骤：以当前控制目录的 `control.sock` 定位监听它的进程，拥有者核对后结束该进程，再重新连接。桌面端不向任何进程发信号。 | 版本信息以结构化字段传出，不靠解析消息文本。服务端较新、客户端较新两种情况都显示两个版本号与正确的更新方向，连接停在失败状态，只有拥有者点“重新连接”才会再连。 |
| R6 | 一个窗口，两条连接同时在线；切换目标不断开另一条。 | 停在 Code 目标时，Personal 目标的新待审批仍会计入角标并触发通知（R12）。 |
| R7 | Code 目标连接日常档案 `~/.ruukoto-code`，路径解析与 TUI 一致，环境变量取自登录 shell。后台未运行时，用登录 shell（`$SHELL -ilc`）解析出的 `node` 执行构建时记录的仓库路径下的 `apps/ruukoto-code/bin/ruukoto-code.mjs server …`。后台脱离运行，退出桌面端不停止后台。`packages/control/src/connect.ts` 的路径解析改为显式接受产品，不再只读全局 `RUUKOTO_PRODUCT`。 | 后台未运行时打开 .app 能拉起后台；TUI 同时连接，能看到同一任务；退出 .app 后后台仍在；仓库路径或 node 不可用时显示可操作的错误。 |
| R8 | 开发入口 `npm run code -- --desktop`：开发启动器以 electron-vite dev 代替 TUI 作为前端，复用开发实例档案（`~/.ruukoto-code-dev/…`）、后台源码变更后自动重启与退出时清理整组进程；桌面端靠 `ControlConnection` 自动重连。受管开发前端只用启动器清洗过的环境，不执行登录 shell，也不自行拉起后台。 | 改后台源码后后台重启，桌面端自动重连；登录 shell 里有日常目录与令牌时，连接的仍是开发档案；后台重载失败或前端重启时，不会多出一个不受启动器管理的后台；退出时没有遗留进程。 |
| R9 | Code 首版功能：工作区与会话树（用文件夹选择框选目录后调用 `open_workspace`）、新建会话、会话标签页、流式对话（正文、思考、工具活动折叠组）、审批卡片、按会话切换模型、切换会话默认模式（Ask for approval、Full access、Auto review、Plan）、中断／取消／继续、队列暂停横幅与恢复（旧排队任务缺模型时先补选模型，与 TUI 一致）、右栏 SubAgent 页（读子会话历史）与 diff 页。 | 人工检查清单逐项通过（见各工单）。 |
| R10 | 首版不做：@File 附件、浏览器页、Spotlight 搜索、模型以外的设置页、工作流侧栏、会话分支、手动压缩、用量与上下文明细、待办面板。demo 中 diff 的 Accept／Reject 删除：编辑是先审批后执行，demo 命令卡片的 Run／Skip 对应审批的 approve／reject。 | 这些项各自另立工单，到时同时改协议与 TUI。 |
| R11 | diff 页按单次工具调用展示 `read_tool_result` 返回的 unified patch：patch 被截断（64 KiB 上限）时标明截断；write 工具只展示写入后的内容，不伪造写入前内容。首版不做语法高亮。 | 编辑、截断编辑、写入新文件三种情况的显示各自正确。 |
| R12 | 两个目标用同一套通知规则：窗口不在前台时，出现新的待审批或任务结束（完成、失败、中断），发系统通知，点击通知跳到对应会话；Dock 角标显示两个目标待审批的总数；窗口在前台时不发通知。 | 人工检查：两个目标各触发一次，角标数与待审批数一致。 |
| R13 | 界面文案用中文，术语按 CONTEXT.md；模式名沿用 TUI 的英文标签。 | 界面中没有残留的 demo 英文文案。 |
| R14 | 外观：`titleBarStyle: 'hiddenInset'` 使用系统原生红绿灯，侧栏用 `vibrancy: 'sidebar'`，明暗跟随系统，沿用 demo 的 CSS 变量。 | 人工检查明暗两种外观。 |
| R15 | Personal 目标只配置 ssh 主机别名（沿用 `~/.ssh/config`）与远端控制目录（默认 `/var/lib/ruukoto/control`），只支持同账户部署（SSH 登录账户就是后台账户）。每次控制面建连前，经 `ssh -o BatchMode=yes` 预检远端控制目录与 socket，并读取 `<控制目录>/owner.token`。令牌只保存在主进程内存，本地不落盘。握手快照携带产品身份，产品不符时停止连接。两条 ssh 命令都显式关闭连接复用、ControlPersist 与认证后转入后台，具体选项见 08。转发命令为 `ssh -N -o BatchMode=yes -o ExitOnForwardFailure=yes -o StreamLocalBindUnlink=yes -o ServerAliveInterval=15 -L <应用数据目录>/<0700 目录>/personal.sock:<控制目录>/control.sock <host>`。ssh 进程退出后，按与 `ControlConnection` 相同的退避策略重启。只支持密钥或 ssh-agent 认证。 | 杀掉 ssh 进程后连接自动恢复；应用数据目录中没有令牌；远端令牌更换后，下次建连可用；关闭后不残留 ssh 进程，本地 socket 也不再接受连接；主机需要密码、或者登录账户不是后台账户时，显示明确错误，不进入重试循环。 |
| R16 | Personal 界面基线：左栏主会话置顶，其余会话平铺并标出类型（角色、调度、开发、只读归档）；中间是与 Code 共用的对话流与输入框；右栏是 SubAgent／工作委托、调度（`schedule_list`）、通知（`notification_list`）三个只读页；IM 入口状态（`qq_status`、`telegram_status`）在左栏底部以小圆点表示；审批卡片与 Code 相同。Personal 阶段开工前，以此为起点另做一轮细节确认。 | 09 开工前完成细节确认并写回本规格。 |
| R17 | 代码放在 `apps/desktop/`，是 workspace 成员，依赖全部列为 devDependencies，服务器的 `npm ci --omit=dev` 不受影响。CI 的 `check.yml` 设 `ELECTRON_SKIP_BINARY_DOWNLOAD=1`，对桌面端只跑 lint、typecheck 与不依赖 Electron 的单测。根级 `npm run build` 不触发 Electron 打包。 | CI 四个 job 不下载 Electron 二进制且全部通过；`npm ci --omit=dev` 不安装 Electron。 |
| R18 | 技术栈：Electron，electron-vite 构建（主进程、preload、渲染进程三个目标），electron-builder `--mac --dir` 打包；React 19、Tailwind v4、`react-markdown` 加 `remark-gfm`（关闭原始 HTML）；diff 用自写的小组件逐行渲染 unified patch。 | 桌面依赖只声明在 `apps/desktop/package.json`，安装更新的是根锁文件，不新增独立锁文件；这些依赖只有 `apps/desktop` 能做值引用。 |
| R19 | 测试：投影层与主进程中的纯逻辑（连接目标配置、ssh 参数拼接、后台拉起参数、op 放行名单）用 `node:test` 写单测，按 `npx tsx --test` 的方式运行；渲染进程首版不写组件测试；GUI 行为按各工单的人工检查清单验收，归外部验收，缺环境时记为不可验证。 | 单测纳入 `npm test`；人工检查清单的结果记录在对应工单中。 |
| R20 | 文档同步：`docs/modules/tui.md` 与 `docs/usage.md` 中“远程使用”的说明改为“登录服务器后启动 TUI，或由桌面客户端经 SSH 转发控制面 socket；不新增远程协议”；`AGENTS.md` 的仓库布局、`docs/architecture.md` 的模块地图与依赖方向、新增 `docs/modules/view.md` 与 `docs/modules/desktop.md`；新命令同步到 `README.md`、`docs/development.md` 与 `.agents/skills/pre-push-checks/SKILL.md`；`CONTEXT.md` 补「桌面客户端」。 | `npm run check:docs` 通过；各文档内容与实现一致。 |

## 范围外

不做对外分发、Linux 与 Windows 验收、服务器端 TCP 或 WebSocket 监听、令牌持久化、后台打包进 .app、协议兼容层、多窗口。

R10 列出的推迟项各自另立工单，不在本规格范围内。
