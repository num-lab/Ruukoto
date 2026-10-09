# 双产品迁移首期发布与验收

首期交付包含开发机上的 Coding Agent `ruukoto-code`、Linux 服务器上的个人 Agent
`ruukoto`、一层通用 SubAgent，以及旧实例的两种离线导入方向。两个产品各自使用档案、
控制面和模型配置。开发本项目时，`npm run dev` 启动隔离的 `ruukoto` 后台，
`npm run code` 启动隔离的 `ruukoto-code` 后台并打开 TUI；两者分别使用
`~/.ruukoto-dev/` 与 `~/.ruukoto-code-dev/` 下的仓库档案，与日常实例分开。
开发实例退出界面后停止后台；下文的 TUI 退出后继续执行指日常产品入口。
产品定位与保留普通开发会话的决定见 [ADR 0017](adr/0017-two-agent-products.md)。

首期验收顺序固定为：本地仓库修改与测试 → IM 服务器管理 → 长任务期间持续响应、
协作、复用与显式关闭。下面汇总工单 01–23 已有证据；本次联合演练、检查结果和
尚未通过的项目单独记录在 [工单 24](../.scratch/agent-direction/issues/24-release-acceptance.md)
的 Comments。此前通过的模拟测试不能替代真实平台验收。
真实 QQ/Telegram 和 macOS 完全访问的正向执行路径仍缺证据，完整发布验收尚未通过。

## 已交付行为

`ruukoto-code` 以工作区和会话组织编码工作，首次打开 TUI 时按需拉起后台，退出 TUI 后
任务继续。受限任务默认使用每任务容器，缺少执行能力时明确失败；完全访问需要独立
执行账户。Git 修改委派按工作生成 worktree，主 Agent 汇总到父工作区待提交区后验证；
冲突时保留双方成果，非 Git 写入按目录占用串行。

`ruukoto` 的 QQ 私聊和 Telegram 共用 main。绑定拥有者可在原平台查看、批准或拒绝
审批；服务器管理目前限定为白名单服务的检查与重启。长期授权绑定入口、主机、单元、
动作和修订，每次使用重新核实；范围不符、撤销或效果未知后恢复人工审批。委派长任务
后 main 可继续回应消息，最终结果沿发起工作时钉定的原入口汇报；离线等待，绑定变化
不改发，效果未知不自动重发。

SubAgent 的身份、工作与执行任务分别保存。任务结束且退出已核实后空闲，主 Agent 可继续原工作或
复用于新工作，同项工作内可通信。关闭需要显式决定；整项取消停止该工作的活动与
排队任务，保留身份、历史、产物与改动，迟到消息或结果不能重启已取消工作。重启后的
普通委派任务记为中断，旧占用无法确认时保持待核实；宿主固定 PR 评审的恢复有独立规则。

固定 coding/chat 新任务入口已退役，旧历史和必要资料标识保留为只读归档。核心忽略
QQ 群消息。跨端共享记忆、邮件、GitHub comment 对话和正式 QQ 群聊外挂继续属于后续
范围；离线导入一次性选入个人记忆不代表跨端同步已经交付。

## 本次联合验收（2026-10-06）

本次先完成本地编码，再演练 IM 服务管理，最后检查协作、恢复与最终汇报。macOS
真实模型只用于下表的编码路径，其余模型使用桩。拥有者确认当前没有独立真实 IM
测试入口，QQ/Telegram 始终通过模拟平台验证，未使用日常绑定进行平台演练。
tx 的服务、helper、策略与 sudoers 使用隔离演练资源，日常后台保持运行，本次资源
在演练后清理。

| 检查 | 本次真实环境 | 结果与模拟边界 |
| --- | --- | --- |
| 场景 1：本地修改、检查、TUI 退出后继续与重连 | macOS arm64、Node 24.15；真实 `mirasim/kimi-k3`、默认容器后端、生产 bin 与 PTY TUI | [smoke-24](../.scratch/agent-direction/smoke-24-release-acceptance.mts) 全程 5/5，含下行的安装升级；原 `check.mjs` 字节不变，修前检查实际失败、修后实际通过，TUI 退出时任务仍 running，重连可查终态与工具产物 |
| 双产品分别安装、升级与停止 | macOS 与 tx 各用两份独立检出执行 `npm ci`，从 `1aba2f1` 逐端替换为当前源码 | macOS 包含于上述 5/5，Linux `--upgrade-only` 4/4；模型为桩。另一端 PID 保持、停端期间任务成功、原历史及 instanceId 保持；两产品档案与控制面分别使用 |
| 受限执行与缺入口拒绝 | macOS Docker Desktop 与 tx 原生 Docker，真实文件、进程、网络与 worker | [smoke-04](../.scratch/agent-direction/smoke-04-desktop-execution.mts) 两端各 6/6；模型为桩；容器内修改/检查、越界单次审批、中断后回收、完全访问缺入口时明确拒绝 |
| Linux Coding Agent 完全访问 | tx `ruukoto-code` 的真实 Runtime，经临时固定 sudo/systemd 入口运行当前 worker，`uid:gid=986:986` | [full-access 演练](../.scratch/agent-direction/release-24-linux-full-access.mts) 一次任务的四次工具操作完成修前失败/修后通过，后台 `owner.token` 与核心库拒读；模型为桩，未使用 macOS 原生完全访问入口 |
| 场景 2：IM 服务管理与限定长期授权 | tx 真实 systemd、sudo、root helper、测试服务与账本 | [smoke-09](../.scratch/agent-direction/smoke-09-linux-service-management.mts) 14/14、[smoke-10](../.scratch/agent-direction/smoke-10-standing-permissions.mts) 14/14；模型、OneBot 与 Bot API 为桩，真实重启和授权保存/使用/撤销/失效有外部效果证据 |
| 场景 3：同项工作协作 | tx 真实 Runtime、控制面、SQLite、独立 JSONL 与受限容器 | [smoke-13](../.scratch/agent-direction/smoke-13-subagent-messaging.mts) 6/6；模型为桩，双向消息、来源、复用后旧资格拒绝、显式关闭与重启记录核实 |
| 场景 3：恢复与原入口最终汇报 | tx 真实容器、CLI、后台重启与 SIGKILL、outbox | [smoke-15](../.scratch/agent-direction/smoke-15-recover-subagents.mts) 首次 Linux 复验 8/8、[smoke-18](../.scratch/agent-direction/smoke-18-im-final-delivery.mts) 7/7；模型和消息平台为桩，持续响应、固定原入口、离线等待、重绑失效与一次汇报已核实 |
| 迁移→重启→协作→取消→冲突→回退联合路径 | macOS 的真实 Runtime、SQLite、JSONL、Git 与文件 | [test/91](../test/91-release-acceptance.test.ts) 1/1；模型为桩，工具后端 local，无隔离证据。两次重启、取消后迟到消息零新模型调用、冲突零写入与成果保全、源库/产物字节不变、活动回退阻挡与干净回退均覆盖 |
| 回退状态修复 | 两方向导入的真实数据库与回执 | [test/85](../test/85-legacy-instance-import.test.ts) 与 [test/86 personal](../test/86-personal-instance-import.test.ts) 合计 12/12；联合检查先捕获旧错误，再验证阻挡响应 `status: applied` 与回执一致，成功才为 `reverted` |

本次发现并修复了两方向回退被阻挡时响应误报 `reverted` 的问题；数据库原本保留
`applied`，现在响应与回执一致。配置中心项目列表的根目录描述也收回到 `ruukoto-code`
产品，个人产品 `ruukoto` 继续平铺项目名称。最终 macOS `npm test` 为 915 项、913 通过、1 跳过、1 失败：
`test/08` 的 DNS 前提在本机不成立，`nonexistent.invalid` 解析到 `198.18.0.71`，
干净基线 `33571b4` 同用例也超时。最终 Linux `npm test` 为 915 项、914 通过、1 跳过、
零失败，两端类型检查和图解检查通过。Linux 首轮的 5 个失败已分别复现并修正：
目录夹具需保证 inode 确实不同、档案路径不应假定检出名、工作进程测试需等待模型门闩，
配置界面需按产品显示根目录。命令、基线对照及最终结果保存在工单 24 Comments 与
[Linux 实机记录](../.scratch/agent-direction/release-24-linux-results.md)；macOS 环境失败不计为全量通过。

工单 24 转为 `ready-for-human`，保留真实 IM 与 macOS 完全访问验证未完成的验收项。

## 已有证据矩阵

表中的“真实环境”说明进程、存储、操作系统或执行边界确实运行过。除明确写出的旧实例
真实资料和容器边界探针外，模型使用桩；涉及 IM、GitHub 或 MCP 的平台使用模拟服务。
“macOS + Linux”中的 Linux 指 `ssh tx` 上的隔离演练，不能据此宣称日常生产实例已经切换。
测试文件按当前仓库文件名列出，详细命令、当时版本与结果在对应工单中保留。

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

开发端在开发机检出代码、安装依赖、构建可信 `ruukoto-worker` 镜像，通过
`ruukoto-code config` 配置本端模型后打开目录。个人端按
[systemd 部署说明](../deploy/systemd/README.md) 配置独立后台账户、执行账户、容器和
可选服务 helper。不要将两个产品指向同一个数据目录；产品归属不符时会拒绝启动。

升级前停止需要升级的产品，保留其档案并替换该端检出。修改 worker 或其使用的核心
代码后重建镜像；`ruukoto-code stop` 后重开 TUI 可拉起新代码，个人端按部署说明重启
systemd 单元。分别安装在各自机器或检出中的产品不要求同时升级，另一端不提供本地
任务执行所需的控制面或存储。协议与 schema 版本以本端代码为准。

迁移时先停止旧实例和目标后台，开发资料使用 `ruukoto-code legacy-import`，个人资料
使用 `ruukoto legacy-import`；依次执行 `preview`、核对计划、`apply`、目标启动查阅。
个人方向必须使用全新目标，核对入口代次、Telegram 偏移、长期授权与发送账本后，把
平台和调度执行权交给目标，旧实例保持停止。命令不会修改或停用源实例。

需要回退时先停止目标并检查 `revert` 的阻挡项。目标切换后的新入站、发送、调度推进、
授权、凭据轮换或资料改写属于新事实，不能用导入回退抹掉。阻挡时响应为
`ok: false`、`status: applied`，回执和目标资料保持原状；成功回退才返回
`status: reverted`。干净回退保留回执和目标备份，复制文件及凭据按回执逐项核对。历史、产物、旧标识和来源授权范围都要核对，
已消费但结局未知的操作先查账和核实外部效果，不能通过回退或重新绑定自动重放。
详细步骤见 [运行文档](runtime.md)“旧实例开发资料迁入”和“旧实例个人资料迁入”。

## 发布验收边界

真实受限执行边界已在 macOS Docker Desktop 与 tx 原生 Linux 取得证据；Linux 个人端
执行账户及服务提权入口已有真实部署验证。本次另在 tx 的 `ruukoto-code` 使用临时
固定入口核实完全访问 `uid:gid=986:986`、代码修改与检查、后台令牌和核心库拒读；模型
为桩，临时入口演练后清理。macOS 完全访问未提供经过验证的本机入口，现有
`createSystemdLauncher` 与 `deploy/systemd` 包装只适用于 Linux；目前缺配置时明确拒绝，
不能把 Linux 脚本直接当作 macOS 部署方案。

真实 QQ/Telegram 审批、消息格式、限流/重投、原入口异步送达，以及 tx 生产库的切换
仍需独立的真实部署演练。Linux TUI 的 IME、缩放和断开重连人工检查也没有由自动
PTY 测试完整替代。这些项目是否在本次补齐，以工单 24 Comments 的实际记录为准。
运行图解见 [部署与验证](visual/deployment.html#acceptance)，完整旧记录仍保存在
[运行文档的验证清单](runtime.md)。
