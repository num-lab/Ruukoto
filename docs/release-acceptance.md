# 双产品迁移首期发布与验收

首期交付包含开发机上的 Coding Agent `ruukoto-code`、Linux 服务器上的个人 Agent `ruukoto`、一层通用 SubAgent，以及旧实例的两种离线导入方向。两个产品各自使用档案、控制面和模型配置。开发本项目时，`npm run dev` 启动隔离的 `ruukoto` 后台，`npm run code` 启动隔离的 `ruukoto-code` 后台并打开 TUI；两者分别使用`~/.ruukoto-dev/` 与 `~/.ruukoto-code-dev/` 下的仓库档案，与日常实例分开。开发实例退出界面后停止后台；下文的 TUI 退出后继续执行指日常产品入口。产品定位与保留普通开发会话的决定见[两个 Agent 产品](../.agents/notes/implemented/architecture/2026-10-02-two-agent-products.md)。

首期验收顺序固定为：本地仓库修改与测试 → IM 服务器管理 → 长任务期间持续响应、协作、复用与显式关闭。下面汇总工单 01–23 已有证据；本次联合演练、检查结果和尚未通过的项目单独记录在 [工单 24](../.scratch/agent-direction/issues/24-release-acceptance.md)的 Comments。此前通过的模拟测试不能替代真实平台验收。真实 QQ/Telegram 和 macOS 完全访问的正向执行路径仍缺证据，完整发布验收尚未通过。

## 已交付行为

`ruukoto-code` 以工作区和会话组织编码工作，首次打开 TUI 时按需拉起后台，退出 TUI 后任务继续。受限任务默认使用每任务容器，缺少执行能力时明确失败；完全访问需要独立执行账户。Git 修改委派按工作生成 worktree，主 Agent 汇总到父工作区待提交区后验证；冲突时保留双方成果，非 Git 写入按目录占用串行。

`ruukoto` 的 QQ 私聊和 Telegram 共用 main。绑定拥有者可在原平台查看、批准或拒绝审批；服务器管理目前限定为白名单服务的检查与重启。长期授权绑定入口、主机、单元、动作和修订，每次使用重新核实；范围不符、撤销或效果未知后恢复人工审批。委派长任务后 main 可继续回应消息，最终结果沿发起工作时钉定的原入口汇报；离线等待，绑定变化不改发，效果未知不自动重发。

SubAgent 的身份、工作与执行任务分别保存。任务结束且退出已核实后空闲，主 Agent 可继续原工作或复用于新工作，同项工作内可通信。关闭需要显式决定；整项取消停止该工作的活动与排队任务，保留身份、历史、产物与改动，迟到消息或结果不能重启已取消工作。重启后的普通委派任务记为中断，旧占用无法确认时保持待核实；宿主固定 PR 评审的恢复有独立规则。

固定 coding/chat 新任务入口已退役，旧历史和必要资料标识保留为只读归档。核心忽略QQ 群消息。跨端共享记忆、邮件、GitHub comment 对话和正式 QQ 群聊外挂继续属于后续范围；离线导入一次性选入个人记忆不代表跨端同步已经交付。

## 本次联合验收（2026-10-06）

本次先完成本地编码，再演练 IM 服务管理，最后检查协作、恢复与最终汇报。macOS真实模型只用于下表的编码路径，其余模型使用桩。拥有者确认当前没有独立真实 IM测试入口，QQ/Telegram 始终通过模拟平台验证，未使用日常绑定进行平台演练。2026-10-06 的本地演练记录注明，上传副本先经[额外准备](../verification/archive/release-24-prepare.py.txt)改写系统资源路径，再清理本次独立后台、测试服务、档案及改写后的 helper、策略、sudoers 和账本。当前 Git 归档保存未经这一步改写的 09/10 源码，它们覆盖并保留固定共享路径的系统资源；可安全复跑的系统隔离仍待改造，不能把历史准备过程当作当前脚本已有的保证。

| 检查 | 本次真实环境 | 结果与模拟边界 |
| --- | --- | --- |
| 场景 1：本地修改、检查、TUI 退出后继续与重连 | macOS arm64、Node 24.15；真实 `mirasim/kimi-k3`、默认容器后端、生产 bin 与 PTY TUI | [smoke-24](../verification/smoke/smoke-24-release-acceptance.mts) 全程 5/5，含下行的安装升级；原 `check.mjs` 字节不变，修前检查实际失败、修后实际通过，TUI 退出时任务仍 running，重连可查终态与工具产物 |
| 双产品分别安装、升级与停止 | macOS 与 tx 各用两份独立检出执行 `npm ci`，从 `1aba2f1` 逐端替换为当前源码 | macOS 包含于上述 5/5，Linux `--upgrade-only` 4/4；模型为桩。另一端 PID 保持、停端期间任务成功、原历史及 instanceId 保持；两产品档案与控制面分别使用 |
| 受限执行与缺入口拒绝 | macOS Docker Desktop 与 tx 原生 Docker，真实文件、进程、网络与 worker | [smoke-04](../verification/smoke/smoke-04-desktop-execution.mts) 两端各 6/6；模型为桩；容器内修改/检查、越界单次审批、中断后回收、完全访问缺入口时明确拒绝 |
| Linux Coding Agent 完全访问 | tx `ruukoto-code` 的真实 Runtime，经临时固定 sudo/systemd 入口运行当前 worker，`uid:gid=986:986` | [full-access 历史源码](../verification/archive/release-24-linux-full-access.mts.txt) 一次任务的四次工具操作完成修前失败/修后通过，后台 `owner.token` 与核心库拒读；模型为桩，未使用 macOS 原生完全访问入口 |
| 场景 2：IM 服务管理与限定长期授权 | tx 真实 systemd、sudo、root helper、测试服务与账本 | [smoke-09 历史源码](../verification/archive/smoke-09-linux-service-management.mts.txt) 14/14、[smoke-10 历史源码](../verification/archive/smoke-10-standing-permissions.mts.txt) 14/14；模型、OneBot 与 Bot API 为桩，真实重启和授权保存/使用/撤销/失效有外部效果证据 |
| 场景 3：同项工作协作 | tx 真实 Runtime、控制面、SQLite、独立 JSONL 与受限容器 | [smoke-13](../verification/smoke/smoke-13-subagent-messaging.mts) 6/6；模型为桩，双向消息、来源、复用后旧资格拒绝、显式关闭与重启记录核实 |
| 场景 3：恢复与原入口最终汇报 | tx 真实容器、CLI、后台重启与 SIGKILL、outbox | [smoke-15](../verification/smoke/smoke-15-recover-subagents.mts) 首次 Linux 复验 8/8、[smoke-18](../verification/smoke/smoke-18-im-final-delivery.mts) 7/7；模型和消息平台为桩，持续响应、固定原入口、离线等待、重绑失效与一次汇报已核实 |
| 迁移→重启→协作→取消→冲突→回退联合路径 | macOS 的真实 Runtime、SQLite、JSONL、Git 与文件 | [test/91](../test/91-release-acceptance.test.ts) 1/1；模型为桩，工具后端 local，无隔离证据。两次重启、取消后迟到消息零新模型调用、冲突零写入与成果保全、源库/产物字节不变、活动回退阻挡与干净回退均覆盖 |
| 回退状态修复 | 两方向导入的真实数据库与回执 | [test/85](../test/85-legacy-instance-import.test.ts) 与 [test/86 personal](../test/86-personal-instance-import.test.ts) 合计 12/12；联合检查先捕获旧错误，再验证阻挡响应 `status: applied` 与回执一致，成功才为 `reverted` |

本次发现并修复了两方向回退被阻挡时响应误报 `reverted` 的问题；数据库原本保留`applied`，现在响应与回执一致。配置中心项目列表的根目录描述也收回到 `ruukoto-code`产品，个人产品 `ruukoto` 继续平铺项目名称。最终 macOS `npm test` 为 915 项、913 通过、1 跳过、1 失败：`test/08` 的 DNS 前提在本机不成立，`nonexistent.invalid` 解析到 `198.18.0.71`，干净基线 `33571b4` 同用例也超时。最终 Linux `npm test` 为 915 项、914 通过、1 跳过、零失败，两端类型检查和图解检查通过。Linux 首轮的 5 个失败已分别复现并修正：目录夹具需保证 inode 确实不同、档案路径不应假定检出名、工作进程测试需等待模型门闩，配置界面需按产品显示根目录。命令、基线对照及最终结果保存在工单 24 Comments 与[Linux 实机记录](../.scratch/agent-direction/release-24-linux-results.md)；macOS 环境失败不计为全量通过。

工单 24 转为 `ready-for-human`，保留真实 IM 与 macOS 完全访问验证未完成的验收项。

## 当前复跑入口

关键验收脚本及 PTY 助手已经进入 `verification/smoke/`，完整 clone 可按[运行说明](../verification/smoke/README.md)复跑。先在根目录完成 `npm run setup` 与`npm run check`；Docker 验收先运行 `npm run build:worker-image`，再运行`npm run test:docker`。升级使用 `npm run test:upgrade`；真实模型编码验收显式指定配置和模型，避免读取某位开发者的固定档案：

```bash
npm run test:release-model -- --models /path/to/models.json --model provider/model
```

真实模型编码与安装升级分开运行，执行其中一个不会自动完成另一个。真实模型入口在启动 TUI 前离线核实所选模型的配置、认证、思考档位与预算；配置须能独立认证，不继承模型 API key 环境变量或读取个人及相邻的 `auth.json`。前提缺失退出 2，不计为验收通过。具体配置契约见上述脚本运行说明。

上节是 2026-10-06 的历史证据，链接指向迁入 Git 的当前脚本或历史源码，历史结果不代表当前检出已经复跑。当前升级脚本默认从 `60fa19e` 检查已有 `ruukoto-code` 产品身份的升级；旧基点 `1aba2f1` 使用此前的 Coding Agent 名称，不能以当前脚本将跨产品名称迁移判为通过。指定其他基点前先核对它具备当前产品身份和入口。

Linux systemd / sudo 演练的六份相关源码保存在[特权脚本归档](../verification/archive/README.md)。旧脚本包含固定系统路径写入，完整准备与清理尚未成为独立安全入口；本轮只归档源码与前提，特权隔离另做一批。当前开发检查的范围和实测基线见 [开发说明](development.md)。

## 已有证据矩阵

表中的“真实环境”说明进程、存储、操作系统或执行边界确实运行过。除明确写出的旧实例真实资料和容器边界探针外，模型使用桩；涉及 IM、GitHub 或 MCP 的平台使用模拟服务。“macOS + Linux”中的 Linux 指 `ssh tx` 上的隔离演练，不能据此宣称日常生产实例已经切换。测试文件按当前仓库文件名列出，详细命令、当时版本与结果在对应工单中保留。

| 工单与能力 | 已有自动检查 | 已有真实环境证据 | 覆盖边界 |
| --- | --- | --- | --- |
| [01 双产品入口](../.scratch/agent-direction/issues/01-independent-products.md) | [test/71](../test/71-product-entry.test.ts) | macOS 两份 bin 后台并存，单端停止与跨产品数据目录拒绝 | 模型为桩；安装和升级的联合演练见工单 24 |
| [02 按需后台](../.scratch/agent-direction/issues/02-coding-daemon.md) | [test/72](../test/72-on-demand-backend.test.ts) | macOS 真实后台、socket、SQLite 与 PTY 启停/复用 | PTY 冒烟不调用模型；人工 IME 与缩放检查未逐项覆盖 |
| [03 执行边界](../.scratch/agent-direction/issues/03-execution-boundary-proof.md) | 容器启动器冒烟与 Linux 隔离探针 | macOS Docker Desktop 与 tx 原生 Linux 的真实文件、进程、网络与 UID 边界 | macOS 完全访问执行账户未部署验证 |
| [04 开发机执行](../.scratch/agent-direction/issues/04-desktop-execution.md) | [test/73](../test/73-desktop-execution.test.ts)、[test/07](../test/07-real-tools.test.ts) | macOS + Linux 容器中修改、检查、越界审批、停止回收 | 完全访问缺入口时拒绝已测；Linux 执行账户正向证据沿用既有部署实测 |
| [05 工作区与会话](../.scratch/agent-direction/issues/05-workspace-sessions.md) | [test/74](../test/74-workspace-sessions.test.ts) | macOS 真实 bin、目录身份、控制面与历史 | 模型为桩 |
| [06 工作区配置](../.scratch/agent-direction/issues/06-workspace-settings.md) | [test/75](../test/75-workspace-settings.test.ts) | macOS 两工作区、版本冲突、授权撤销与重启持久化 | 外部模型、MCP/Jev 服务未实测 |
| [07 旧工作区组织](../.scratch/agent-direction/issues/07-legacy-workspace-data.md) | [test/76](../test/76-legacy-workspace-data.test.ts) | macOS + Linux CLI 预览/应用，历史与产物字节核对、回退与重启 | 组织映射不扩大原来源授权；不是跨实例同步 |
| [08 IM 审批](../.scratch/agent-direction/issues/08-im-approvals.md) | [test/77](../test/77-im-approvals.test.ts) | macOS + Linux 真实后台、审批/outbox 账本与恢复 | OneBot 与 Bot API 为桩，真实 QQ/Telegram 未实测 |
| [09 服务管理](../.scratch/agent-direction/issues/09-linux-service-management.md) | [test/78](../test/78-linux-service-management.test.ts) | tx 真实 systemd、sudo、root helper、测试服务重启与身份拒绝 | IM 与模型为桩；操作只涵盖检查与白名单 restart |
| [10 长期授权](../.scratch/agent-direction/issues/10-standing-permissions.md) | [test/79](../test/79-standing-permissions.test.ts) | tx 真实服务保存/使用/撤销授权，效果未知后失效 | IM 为桩，未验证真实平台限流和重投 |
| [11 通用委派](../.scratch/agent-direction/issues/11-subagent-delegation.md) | [test/80](../test/80-subagent-delegation.test.ts) | macOS + Linux 独立 JSONL、容器读取、父会话持续响应与结果回传 | 模型为桩，真实 IM 未实测 |
| [12 复用与关闭](../.scratch/agent-direction/issues/12-subagent-reuse-close.md) | [test/81](../test/81-subagent-reuse-close.test.ts) | macOS + Linux 真实容器复用后拒绝旧范围，CLI 关闭及历史保留 | 单次批准不延续；模型为桩 |
| [13 工作内消息](../.scratch/agent-direction/issues/13-subagent-messaging.md) | [test/86 messaging](../test/86-subagent-messaging.test.ts) | macOS + Linux 双向消息、来源、幂等、CLI 与重启 | 协作加入限只读工作；消息不扩大权限 |
| [14 整项取消](../.scratch/agent-direction/issues/14-cancel-work.md) | [test/82](../test/82-subagent-cancel-work.test.ts) | macOS + Linux CLI 取消、真实容器退出、其他工作继续、迟到结果保留 | 取消不关闭 SubAgent；迟到同级消息联合路径见工单 24 |
| [15 重启恢复](../.scratch/agent-direction/issues/15-recover-subagents.md) | [test/86 recovery](../test/86-subagent-recovery.test.ts) | macOS 真实容器、SQLite、CLI resume-queue | 原交付未执行 Linux 冒烟；崩溃形态按库内容置位 |
| [16 并行 worktree](../.scratch/agent-direction/issues/16-parallel-worktrees.md) | [test/83](../test/83-subagent-worktrees.test.ts) | macOS + Linux 两副本并行，父工作区保持、Git 元数据只读、非 Git 串行 | 子任务不提交或推送；模型为桩 |
| [17 改动汇总](../.scratch/agent-direction/issues/17-integrate-worktree-results.md) | [test/84 integrate](../test/84-subagent-integrate.test.ts) | macOS + Linux 真实 git 与容器，幂等、冲突零写入、取消/关闭后找回、父仓库自身为 worktree | 汇总不代提交；共享 Git 目录补挂已实测 |
| [18 原入口最终汇报](../.scratch/agent-direction/issues/18-im-final-delivery.md) | [test/84 delivery](../test/84-im-final-delivery.test.ts) | macOS + Linux 真实后台、容器、outbox、离线与重绑、SIGKILL 恢复 | 模型和两平台为桩；真实 QQ/Telegram 未实测 |
| [19 PR 评审](../.scratch/agent-direction/issues/19-github-subagent-review.md) | [test/42](../test/42-github-webhook.test.ts) 至 [test/46](../test/46-github-recovery.test.ts) | macOS + Linux 真实后台、容器、修订与恢复路径 | GitHub 投递、MCP 与通知平台为桩；comment 对话未交付 |
| [20 核心群聊退役](../.scratch/agent-direction/issues/20-retire-core-group-chat.md) | [test/85 group](../test/85-retire-core-group-chat.test.ts) | macOS + Linux 旧代码真实产生记录后升级、收尾与幂等 | 真实 QQ 群/NapCat 未实测；正式外挂未交付 |
| [21 开发资料导入](../.scratch/agent-direction/issues/21-migrate-coding-instance.md) | [test/85 import](../test/85-legacy-instance-import.test.ts) | macOS + Linux 进程冒烟；macOS `~/.ruukoto` 代表性真实资料导入/查阅/回退 | tx 生产库未演练；凭据不迁入 Coding Agent |
| [22 个人资料导入](../.scratch/agent-direction/issues/22-migrate-personal-instance.md) | [test/86 personal](../test/86-personal-instance-import.test.ts) | macOS + Linux 进程冒烟；macOS 真实资料导入/查阅/回退 | 真实资料无平台配置/调度/记忆，平台偏移与交接由桩覆盖；tx 生产库未演练 |
| [23 固定角色收尾](../.scratch/agent-direction/issues/23-contract-legacy-roles.md) | [test/87](../test/87-retire-coding-role.test.ts) | macOS + Linux 两版本真实 bin 升级、SIGKILL、旧任务收尾 | 旧 CHECK/角色标识保留读取；ruukoto 普通开发会话按拥有者决定保留 |

## 安装、升级与切换

开发端在开发机检出代码、安装依赖、构建可信 `ruukoto-worker` 镜像，通过`ruukoto-code config` 配置本端模型后打开目录。个人端按[systemd 部署说明](../deploy/systemd/README.md) 配置独立后台账户、执行账户、容器和可选服务 helper。不要将两个产品指向同一个数据目录；产品归属不符时会拒绝启动。

升级前停止需要升级的产品，保留其档案并替换该端检出。修改 worker 或其使用的核心代码后重建镜像；`ruukoto-code stop` 后重开 TUI 可拉起新代码，个人端按部署说明重启systemd 单元。分别安装在各自机器或检出中的产品不要求同时升级，另一端不提供本地任务执行所需的控制面或存储。协议与 schema 版本以本端代码为准。

迁移时先停止旧实例和目标后台，开发资料使用 `ruukoto-code legacy-import`，个人资料使用 `ruukoto legacy-import`；依次执行 `preview`、核对计划、`apply`、目标启动查阅。个人方向必须使用全新目标，核对入口代次、Telegram 偏移、长期授权与发送账本后，把平台和调度执行权交给目标，旧实例保持停止。命令不会修改或停用源实例。

需要回退时先停止目标并检查 `revert` 的阻挡项。目标切换后的新入站、发送、调度推进、授权、凭据轮换或资料改写属于新事实，不能用导入回退抹掉。阻挡时响应为`ok: false`、`status: applied`，回执和目标资料保持原状；成功回退才返回`status: reverted`。干净回退保留回执和目标备份，复制文件及凭据按回执逐项核对。历史、产物、旧标识和来源授权范围都要核对，已消费但结局未知的操作先查账和核实外部效果，不能通过回退或重新绑定自动重放。详细步骤见[操作手册](usage.md#6-导入旧实例)“旧实例开发资料迁入”和“旧实例个人资料迁入”。

## 发布验收边界

真实受限执行边界已在 macOS Docker Desktop 与 tx 原生 Linux 取得证据；Linux 个人端执行账户及服务提权入口已有真实部署验证。本次另在 tx 的 `ruukoto-code` 使用临时固定入口核实完全访问 `uid:gid=986:986`、代码修改与检查、后台令牌和核心库拒读；模型为桩，临时入口演练后清理。macOS 完全访问未提供经过验证的本机入口，现有`createSystemdLauncher` 与 `deploy/systemd` 包装只适用于 Linux；目前缺配置时明确拒绝，不能把 Linux 脚本直接当作 macOS 部署方案。

真实 QQ/Telegram 审批、消息格式、限流/重投、原入口异步送达，以及 tx 生产库的切换仍需独立的真实部署演练。Linux TUI 的 IME、缩放和断开重连人工检查也没有由自动PTY 测试完整替代。这些项目是否在本次补齐，以工单 24 Comments 的实际记录为准。运行图解见 [部署与验证](visual/deployment.html#acceptance)。完整的历史验证清单见下节。

## 历史验证清单

下表保留各次已有记录，按当时的代码版本与覆盖范围填写；命令与环境的现状说明见[开发说明](development.md)。真实进程或容器通过不代表真实 IM 平台已通过，历史命令的覆盖范围也不能当作当前代码通过的证据。

| 检查 | 环境 | 结果 |
| --- | --- | --- |
| 全部离线集成验证（43 项：issue 02 的 16 项 + 真实工具路由×3、审批×11（含崩溃恢复区分、DNS 前置、v1→v2 迁移）、产物×5、模式与认证×8） | macOS 本机（Node 24.15.0，local 执行后端） | 通过 |
| issue 04 离线验证（37 项：历史读取×11、连接恢复与待确认×13、TUI 状态与终端安全×7、TUI 应用集成×5、PTY 端到端×1） | macOS 本机（mock 模型 + 假终端 + pty） | 通过（81 项总计含 issue 02/03 回归） |
| TUI 真实终端人工检查（80×24 布局、中文输入法、缩放、滚动） | macOS 终端 | 部分：PTY 自动化覆盖输入/流式/退出/终端恢复；人工交互细节（IME 候选窗、缩放重排）未逐项人工核对 |
| Linux 真实工具后端的"提交—查看—退出—重连—检查"全流程 | 目标 Linux 服务器 | 部分通过（tx 2026-09-21：CLI 提交—容器执行—产物落盘—status 查看 经真实模型完成；TUI 断开重连交互未在目标机人工跑） |
| 真实模型连通性（经完整运行时路径，一次短往返） | macOS 本机 | 未在本次运行（凭据缺失时跳过） |
| node:sqlite v1→v2 事务迁移 + 崩溃后重开 | macOS 本机 | 通过（08 的迁移用例：旧任务默认请求确认、旧未决审批失效、历史与事件保留） |
| Linux 容器边界探针（32 项：文件/子进程/网络/凭据/控制面/身份） | Docker Desktop Linux VM | 32/32 通过（`npm run linux:probes`，含就绪与完整性判定） |
| 任务容器端到端：镜像构建 + 经真实容器启动器的 bash 路由、网络拒绝、宿主路径不可见、非 root、只读根、cap 清零、容器回收；按宿主原路径挂载（pwd、宿主绝对路径 read、只读授予路径可读不可写） | Docker Desktop Linux VM；tx | 9/9 通过（Docker Desktop，`npx tsx verification/foundation/scripts/linux-isolation/container-worker-smoke.mts`；镜像 `ruukoto-worker:0.85.1`）；13/13 通过（tx 2026-09-26，issue 28 新增同路径挂载 4 项，RUUKOTO_CONTAINER_UID/GID=1003） |
| 同一容器镜像内的真实模型短编码任务（容器后端跑 07 场景） | tx（Ubuntu 24.04，容器后端 + deepseek-flash） | 通过（2026-09-21：confirm 任务经容器写文件，产物归属拥有者 uid 1003；RUUKOTO_CONTAINER_UID/GID=1003） |
| systemd 执行账户入口（提权包装、固定身份、cgroup 回收） | tx（Ubuntu 24.04，systemd 255） | 通过（2026-09-21：sudo 链路与 uid 986 env_keep 传递、worker 以 ruukoto-exec 运行、参数注入/非授权调用拒绝、stop 幂等；修复 exec-stop 包装退出码与启动器约定相反的问题。2026-09-26 issue 23：经部署控制面的真实模型完全访问任务端到端通过——`id -un` 为 ruukoto-exec、按 ACL 写工作区且拥有者可改、git 接受拥有者仓库、HOME 可写、读拥有者令牌被拒、结束后单元 inactive） |
| Git worktree 外部元数据显式授予路径挂载 | 部分（tx） | 授予路径校验/幂等已覆盖；容器内按宿主原路径挂载的只读授予路径已经冒烟实测（tx 2026-09-26）；worktree 共享 Git 元数据场景未专门实测 |
| 目标服务器宿主前提（发行版、内核、rootless、docker/systemd） | tx（Ubuntu 24.04，内核 6.8，Docker 29.5.2） | 通过（2026-09-21：`npm run linux:probes` 32/32 + 容器冒烟 9/9；原生 Linux bind mount 无 uid 映射，容器 uid 与工作区写权限按部署说明第 5 步处理） |
| 真实模型短编码任务（真实凭据） | tx（经部署控制面，deepseek-flash） | 通过（2026-09-21，confirm 模式容器执行；`RUN_MODEL_CHECK=1 npm run test:model` 形式未单独跑） |
| issue 06 GitHub 集成（19 项） | — | 已随 issue 17 退役删除（专用模块移除，通用保障迁移至 08/17/24） |
| issue 17 GitHub 模块退役（4 项：全新库不建旧表、v8 样本库升级的审批失效与发布操作终态、草稿归档产物与无秘密清单、重跑幂等、旧控制入口不可达、旧凭据不变、历史事件重放） | macOS 本机（v8 样本库 + 真实运行时/控制面路径） | 通过 |
| 全部离线集成验证（125 项，逐文件顺序执行） | tx（Ubuntu 24.04，Node 24.21.0） | 通过（2026-09-21，17/17 文件 0 失败；修复 15-tui-pty 的 npx 孙进程持有管道导致文件级挂起——detached 进程组 + 整组回收，macOS 回归同过） |
| 真实 GitHub MCP 只读连通（一次已授权仓库的只读调用，记录工具/权限/结果） | 需拥有者配置独立只读 PAT | 未验证（issue 16 遗留；配置具备时按操作手册的 MCP 步骤验收，不以模拟测试冒充） |
| issue 20 Web Search（9 项：默认启用与来源/查询时间保留、参数校验与限额、每任务 5 次上限可核对、项目禁用/任务清单冻结/任务内禁用立即生效、401/429/500/畸形/超大响应与产物归属、超时与取消不重发、提示注入有界处理、凭据脱敏与 host/用途限制、schema v6→v7 迁移） | macOS 本机（本地模拟 Tavily API，经真实宿主工具与运行时路径） | 通过（184 项总计含既有回归，0 失败，1 项真实模型门控跳过） |
| issue 07 QQ 群聊入口（20 项：连接鉴权/身份核对/掉线重连与接收缺口、白名单与结构化 @ 触发、收件去重、登记-入队与遗留发送的崩溃恢复、同群 FIFO 与跨群隔离、排队过期、停用/撤群、发送失败与结果未知不重发、响应乱序、撤回处理、记忆/指令/工具隔离、拥有者 QQ 发言不获控制面能力、qq_group 资料身份） | macOS 本机（进程内模拟 OneBot WebSocket + mock 模型，经真实适配器/Runtime/发送控制路径） | 通过；真实 NapCat 接入与 Linux 部署未验证（需拥有者授权的真实群闭环）。核心群聊已退役，群消息被忽略，见下行 |
| agent-direction issue 20 核心群聊退役与旧群资料保全（test/85 共 6 项验收：新核心不引导 chat、群消息零新增且私聊/Telegram 照常、归档可查与只读边界、无 chat 角色行时隔离不扩大、通知/调度复核撤回与篡改（source_revoked）、排队/在途/待发/未派发一次性收尾与三次启动幂等；test/26 保留传输状态、配置与资料身份边界，test/40 覆盖私聊连接鉴权与重连，test/49 播种归档覆盖接收/审批/撤回复核） | macOS 本机（进程内模拟 OneBot WebSocket + 模拟模型 + 播种助手按 v24 形态写归档；真实 Runtime/SQLite/socket） | 通过；旧代码真实产生数据的升级路径与真实 Linux 后台见 `.scratch/agent-direction/smoke-20-retire-group-chat.mts`（tx）记录；真实 QQ 群/NapCat 无入口，未实测 |
| agent-direction issue 15 后台重启恢复 SubAgent（test/86 共 3 项：排队委派任务重启定 interrupted 且不自动继续/不当作新委派（零模型请求）、补记一次重复启动不重复登记、结果归属保持、Agent 回 idle 可继续委派且 dev 父会话注入；遗留占用保留与 occupancy_unverified 暂停不被启动恢复解除、unverified 拒绝委派、拥有者 resume-queue 后回 idle 可委派；宿主固定评审排队任务不中断、启动恢复自动解除子会话暂停并继续执行） | macOS 本机（mock 模型 + 临时目录 + 进程内真实 Runtime 重启（stop→Runtime.start，含崩溃形态 SQL 置位）+ realTools local 后端） | 通过（2026-10-05，3/3；模拟环境。真实容器/CLI 证据见下行） |
| agent-direction issue 15 冒烟（verification/smoke/smoke-15-recover-subagents.mts：真实 Runtime/控制面/SQLite + 真实受限容器后端与镜像 + 真实 CLI resume-queue——排队委派任务重启中断零容器零模型请求、结果归属、dev 注入、沿 work_id 真实容器继续；遗留占用保留与暂停不被启动恢复解除、unverified 拒绝委派、CLI resume-queue 后回 idle 可继续；带来源事件的评审排队任务自动恢复真实完成；重复重启不重复登记、无残余容器） | macOS 本机 Docker Desktop（真实容器；模型为模拟，消息平台不启用；崩溃形态按库内容置位，判定输入与真实崩溃一致） | 通过（2026-10-05，8/8）；冒烟期间发现并修复：backend_restart 暂停叠加持占用会话不再被启动恢复自动释放（runtime 守卫） |
| 真实 Tavily 连通性（一次受控查询，记录端点/调用次数/限制与来源） | 需拥有者配置 tavily_search 凭据 | 未验证（未配置凭据；不以模拟结果宣称真实接入完成） |
| 双产品入口与同机并存（agent-direction issue 01；test/71 进程级用例：两 bin 分别启动真实后台、握手与查询、ruukoto-code 无 QQ/Telegram 适配器、停一端另一端照常应答、跨产品打开数据目录被 product_mismatch 拒绝） | macOS 本机（真实 bin 进程/真实文件/真实 socket 与 SQLite，模型打桩） | 通过（2026-10-02；可复现于 test/71 进程级用例；同路径手动冒烟（10 项）亦通过，记录在工单评论；模型层为模拟，进程/存储/控制面为真实环境） |
| 双产品离线集成（test/71：产品身份与按产品的目录解析、环境变量隔离、开发实例环境清洗、Runtime gating 与归属登记、旧计划记录可读、bin 进程冒烟） | macOS 本机（mock 模型 + 临时目录） | 通过（2026-10-02，14/14；全量 npm test 含既有回归见上各行统计） |
| ruukoto-code TUI 按需拉起后台（agent-direction issue 02；test/72 进程级用例：后台不在时拉起、并发两个终端收敛为单实例（含锁竞败者等慢胜者复用）、已运行不重复拉起、启动失败附 spawn.log 尾部、后台在运行但令牌不符的认证指引、关闭客户端不停止后台/取消任务、重开看到同一任务与幂等键核实） | macOS 本机（真实 bin 进程/真实文件/真实 socket 与 SQLite，模型打桩） | 通过（2026-10-02，8/8；模拟结果与真实环境分列：模型层为模拟，进程/存储/控制面为真实环境） |
| TUI 真实入口按需拉起冒烟（.scratch/agent-direction/smoke-02.sh：pty 下真实 runTui 生产默认路径——首次拉起、关闭 TUI 后台不停、再开复用、stop 后重开再度拉起、无模型配置时非零退出并附启动失败状态） | macOS 本机（真实 pty/bin/文件/socket/SQLite；models.json 结构合法但指向死端口，冒烟不提交任务、不发生模型调用） | 通过（2026-10-02，5/5） |
| 开发机受限执行边界产品级冒烟（agent-direction 工单 03；经真实容器启动器 + ruukoto-worker 镜像 + 宿主 ToolWorkerHost：容器内 bash、非 root 1000、工作区写入宿主可见、无外网出口、工作区外宿主真实文件不可见、只读根、CapEff 清零、nohup 逃逸孙进程实际运行（对照）且停止后心跳冻结、停止核实容器移除、宿主原路径挂载、只读授予路径可读不可写） | macOS 本机 Docker Desktop 4.x/29.8.0（Linux VM aarch64）；/var/folders 与 /Users 两种工作区各一遍 | 通过（2026-10-02，16/16 ×2；`npx tsx verification/foundation/scripts/linux-isolation/container-worker-smoke.mts`——真实 docker/镜像/文件/进程/网络路径，无模拟层） |
| macOS sandbox-exec 旧探针（.scratch/agent-direction/macos-sbx-probe.sh） | macOS 27.0 (arm64) | 2026-10-02 的"文件规则 0/6 静默未执行"结论于 2026-10-08 更正：旧规则用 `/tmp`，目标实际位于 `/private/tmp`；旧结果不能证明 Seatbelt 文件机制失效。已修正规范化路径与启动/拒绝判定，复跑见工单 26；文件拒绝通过不代表完整产品边界通过 |
| 原生 Seatbelt 候选及 launchd 后代回收（agent-direction 工单 26 第一阶段） | macOS 27.0 / Darwin 27.0.0 / arm64；仅临时虚拟资料、自建服务和真实进程，无模型 | 未通过：文件规范化更正生效；`posix_spawn` 后代可脱离进程组且停止原组后仍写心跳；`kqueue NOTE_TRACK` 为 `ENOTSUP`；临时 launchd job 移除后逃离后代仍活动。复跑及逐项证据见 [原生探针说明](../verification/foundation/scripts/native-isolation/README.md)，未接入产品 |
| 原生 bubblewrap 候选（agent-direction 工单 26 第一阶段） | tx：Ubuntu 24.04.4 / Linux 6.8.0-117-generic / x86_64 / UID 1003；临时解包 bubblewrap 0.9.0 | 不可验证：2 个未沙箱对照通过，35 个真实边界项 unavailable；namespace 建立时 `RTM_NEWADDR` / `uid_map` 被拒，探针尚未启动，退出 2。系统策略未修改；[完整报告](../verification/foundation/results/native-linux-report.md)。不能切换默认后端 |
| SubAgent 修改委派冒烟（.scratch/agent-direction/smoke-16-parallel-worktrees.mts：真实 Runtime/控制面/SQLite + 真实容器后端与镜像 + 真实 git 仓库——容器内建副本、两子任务同一仓库并行 worktree（同时 running、不同分支）、主工作区字节与未提交改动不变、safe.directory 环境容器内 git status/diff 可用、git commit 与写 hooks/config 真实失败（共享 Git 只读挂载）、非 Git 目录与父会话串行、植入 fsmonitor 只在容器内被只读挡住（宿主不执行）、副本创建与任务容器零残余） | macOS 本机 Docker Desktop 29.8.0（真实容器；模型为模拟，消息平台不启用） | 通过（2026-10-04，9/9）；Linux 远端（tx，uid/gid 1003，经 `--remote` 自包含跑完全程）通过（2026-10-04，9/9）；流程教训：worker 代码打进镜像（deploy/worker-image 构建阶段复制 packages/agent/src/tool-worker 与 src/core 后 esbuild 打包），改 tool-worker 必须重建镜像才进容器 |
| SubAgent 改动汇总冒烟（.scratch/agent-direction/smoke-issue17.mts：真实 Runtime/SQLite + 真实容器后端与镜像 + 真实 git 仓库——宿主容器创建 worktree 副本、子任务容器真实 edit/write、汇总容器 add -N→diff→apply --check→apply 落入父工作区待提交区、父 HEAD 不变、`work_delegation.integrated` 事件登记、already 幂等不重复登记、冲突零写入点名文件双方保留、取消+关闭后汇总不拦、父仓库本身是 worktree 时共享 Git 目录补挂读写、副本创建与汇总照常、`ruukoto-task-*` 容器零残余） | macOS 本机 Docker Desktop（真实容器边界；模型为模拟）；tx（Ubuntu 24.04 原生 Linux，Docker 29.5.2，uid/gid 1003，RUUKOTO_CONTAINER_UID/GID=1003） | 通过（2026-10-05，7/7 ×2）；离线断言在 test/84（local 后端模拟边界，git 语义为真实 git）；流程教训：副本创建与汇总在「父仓库本身是 worktree」时必须把共享 Git 目录补挂读写（issue 17 起生效），否则容器内 git 无法解析 `.git` 指针 |
| Linux 容器边界探针复核（linux:probes，当前脚本） | macOS Docker Desktop 29.8.0（Linux VM aarch64） | 通过（2026-10-02，全部预期探针，0 不一致 0 缺失） |
| Linux 原生复核与现有部署盘点（linux:probes 原生 Linux；launchers/部署/探针机制文件哈希对照 2026-09-26 验证快照；systemd 生效配置、受保护提权入口、令牌权限位盘点） | tx（Ubuntu 24.04，内核 6.8.0-117，Docker 29.5.2，systemd 255） | 通过（2026-10-02）：探针 32/32；机制文件（launchers.ts、deploy/**、宿主/探针脚本）与验证快照逐字节一致（worker.ts 仅差异一次 write 展示统计，不改边界语义）；ruukoto-backend active、RUUKOTO_EXEC_UID/GID=986 与 ruukoto-exec 账户一致、RUUKOTO_CONTAINER_UID/GID=1003、owner.token 0600 ruukoto-backend 持有、提权包装在位 |
| 开发机受限/完全访问产品级冒烟（agent-direction 工单 04；verification/smoke/smoke-04-desktop-execution.mts：容器内代码修改与检查、外网出口/未挂载宿主文件/只读根约束、越界读取审批单次消费、完全访问缺执行账户入口执行前拒绝、中断回收容器含启动窗口） | macOS 本机 Docker Desktop 29.8.0（Linux VM aarch64）；tx 原生 Linux（Ubuntu 24.04，Docker 29.5.2，uid/gid 1003） | 通过（2026-10-02，6/6 ×2）：真实容器/镜像/文件/网络与审批路径，模型打桩；`npx tsx verification/smoke/smoke-04-desktop-execution.mts`（TMPDIR 可换工作区位置） |
| ruukoto-code 默认执行后端接入（agent-direction 工单 04；test/73 进程级用例：dev 默认 container、显式 local 打印无隔离警告、环境变量覆盖、完全访问缺入口提交即 execution_unavailable 且不回退、confirm 照常；工作进程启动窗口中断回收执行单元回归 test/07） | macOS 本机（真实 bin 进程/文件/socket/SQLite；模型打桩，无容器依赖） | 通过（2026-10-02）：test/73 4/4、test/07 5/5；全量 npm test 见本轮提交记录 |
| macOS 完全访问执行身份 | macOS 本机 | 未验证（2026-10-02 记录前置与依据）：不能以拥有者 uid 运行——同 uid 进程对 `~/.ruukoto/control/owner.token`（0600 owner，65 字节）test -r 退出 0，即完全访问任务会持有控制面拥有者身份；现有启动器使用 systemd 包装，只适用于 Linux；macOS 未提供经过验证的本机入口；未配置入口时完全访问在执行前拒绝（smoke-04/test/73 覆盖），Linux 完全访问身份仍沿用 2026-09-26 tx 实测结论 |
| 工作区与会话组织（agent-direction 工单 05；test/74：open_workspace 创建/根目录身份落库/快照可读、符号链接与路径变体复用、同名目录不合并、多仓库根目录、请求标识幂等、旧项目认领与改归属拒绝、保护根拒绝、旧 op 与 v18→v19 迁移、创建→执行→历史、TUI 选择面板 ruukoto-code 排除角色与群聊/ruukoto 不变、角色与群聊项目拒绝认领） | macOS 本机（进程内真实 Runtime/socket/SQLite/伪终端；模型打桩） | 通过（2026-10-02，15/15；全量 npm test 见工单评论） |
| 工作区产品级冒烟（.scratch/agent-direction/smoke-05-workspace-sessions.mts：真实 apps/ruukoto-code/bin/ruukoto-code.mjs 后台——多仓库根目录打开、别名与变体复用、同名目录去重、请求标识幂等、旧项目认领、提交执行与历史查看） | macOS 本机（真实 bin 进程/文件/socket/SQLite，模型打桩） | 通过（2026-10-02，6/6；`npx tsx .scratch/agent-direction/smoke-05-workspace-sessions.mts`） |
| 服务器服务管理离线验证（agent-direction issue 09；test/78：QQ/Telegram 检查→逐次审批→批准恰好一次→原入口结果、拒绝/重复决定/篡改目标零执行、非 main 与错误产品/无配置/非 Linux 门、auto-review 转人工、策略与单元修订变化失效、同 ID 重复启动拒绝、取消与跨重启的效果未知不自动重发、产物引用与 partial、后状态查询失败保留命令结果） | macOS 本机（模拟 IM 平台 + mock 模型 + 受控 helper 替身，文件系统模拟 systemd，协议逐字节同生产） | 通过（2026-10-03，22/22；真实 systemd/提权证据非本项，见下行） |
| 服务器服务管理真实 Linux 冒烟（verification/archive/smoke-09-linux-service-management.mts.txt：模拟 IM 平台 + 真实 systemd/sudo/提权/测试服务——部署安装、主链路真实重启（InvocationID 变化、starts 恰 +1、批准消费一次、op 单元实录）、执行账户调用/写策略/读控制面令牌全拒绝、同 hostOpId already_claimed、策略篡改消费前失效、改单元不 daemon-reload 修订拒绝、基础设施目标拒绝、op 已派发时 kill -9 恢复效果未知不自动重发、拒绝零执行） | tx（Ubuntu 24.04，systemd 255） | 通过（2026-10-03，14/14 ×3 轮幂等，末轮为最终代码态复跑；发现并修复 fd3 协议在 sudo 下全断（closefrom=3）改为 stderr 前缀应答；IM/模型为桩，真实 QQ/Telegram 平台未实测） |
