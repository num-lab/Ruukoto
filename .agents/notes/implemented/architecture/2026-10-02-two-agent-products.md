# Agent Note: 两个 Agent 产品独立运行，固定 coding 与 chat 角色退役

Status: implemented

原编号：ADR 0017

## 问题

旧 main/coding/chat 同后台架构把本机编码、个人服务器事务和群聊处理绑定在一起。固定 coding 与开发工具的能力重复，核心 chat 又把通用个人助手限定为群聊用途；开发机与个人服务器需要各自运行、停止和升级，并保留旧历史、来源关系与权限边界。

## 决定

Ruukoto Agent 由同一仓库中的两个产品组成。`ruukoto-code` 在开发机器运行，以 TUI 为主要入口，重心是 Agentic coding，首期支持 macOS 与 Linux；`ruukoto` 在专用 Linux 服务器运行，以绑定拥有者的 QQ 私聊、Telegram 等 IM 为主要入口，面向多样化个人事务。两个产品可以独立安装、运行和升级，一端停止或两端失联不阻止另一端执行本地任务。现状以一个代码包提供两条 bin 入口，各实例按自己的节奏重启；独立打包制品不是当前交付范围。

产品入口固定身份，数据目录在核心库 `meta` 中登记 `product.type`，跨产品打开同一目录以 `product_mismatch` 拒绝。日常档案分别是 `~/.ruukoto` 与 `~/.ruukoto-code`，路径变量分别使用 `RUUKOTO_*_DIR` 与 `RUUKOTO_CODE_*_DIR`，锁、socket、pending 随档案隔离；`RUUKOTO_OWNER_TOKEN` 与 `RUUKOTO_OWNER_TOKEN_FILE` 是共用名称的控制面身份变量。Coding Agent 不启动 QQ/Telegram 连接或个人调度，但旧调度记录仍可读。Coding Agent 的原入口名 `ruukoto-dev` 已改为 `ruukoto-code`，bin、产品身份、档案根与环境变量前缀一起使用现名；开发本项目的实例另见[开发启动入口](../process/2026-10-09-dev-launchers.md)。

固定 coding 与核心 chat 角色退役。编排器只引导 main，普通分析、修改与 GitHub 评审均走通用 SubAgent；`coding_delegate`、旧委派与自动重试、GitHub 旧 coding 评审接管分支删除。旧 coding/chat 角色行、会话与任务只读保留，拒绝新任务；升级启动取消其排队任务，在途任务按恢复规则中断、补记一次结果与唤醒，不重放。`coding_result` 保留只读查阅。存储 CHECK、`AgentRoleId` 的旧取值和 `qq_group` 会话类别保留，因为它们对应真实历史行。

QQ 群聊由独立可选程序自行管理群会话、历史和发送状态，通过有限接口向 ruukoto 提供结果，可以仍在同仓库；停用外挂不影响主会话。核心群消息直接忽略，旧群资料只读归档，`chat_result_*` 及发送前来源复核保留，详见[核心群聊退役](../simplification/2026-10-02-retire-core-group-chat.md)。外挂接口与正式交付属于后续范围。

两个产品使用相同的一层 SubAgent 模型：主 Agent 与拥有者交互，SubAgent 不直接与拥有者交互、不能创建下一层。通信限于同一主 Agent 下当前参与同项工作的协作者，消息不扩大权限；跨用户会话、工作区和机器的直接 Agent 通信暂不加入。工作委托可以跨多轮对话和多个任务，每次执行有独立记录、工具、目录、资料范围及有效授权，前一次单次批准不延续。SubAgent 完成后空闲，保留身份与上下文；同一主 Agent 在同一用户会话内可以继续原工作或复用到新工作，重新确定协作资格。主 Agent 或拥有者显式关闭后仍保留历史和产物；任务结束、退出 TUI 或空闲超时均不自动关闭，空闲不要求持续运行模型或工具进程。取消整项工作停止其活动与排队子任务，不影响其他工作；迟到结果保留但不重启取消工作，未汇总改动与产物保留。持久化、复用、通信、取消与恢复的细节分别见[工作委托](2026-10-03-work-delegation-subagent-task.md)、[复用与关闭](../feature/2026-10-04-subagent-reuse-close.md)、[工作内通信](../feature/2026-10-05-subagent-messaging.md)、[整项取消](../feature/2026-10-04-cancel-work.md)和[重启恢复](2026-10-05-subagent-restart-recovery.md)。

`ruukoto-code` 采用工作区 → 会话，工作区是拥有者选择的开发根目录，可以包含多个仓库。临时 worktree 是执行副本，旧项目组织关系按[旧工作区归属](2026-10-03-legacy-workspace-org-attribution.md)映射。日常 TUI 首次启动按需拉起本机后台，退出后任务继续，显式停止才结束后台；崩溃保留记录并提示恢复，不自动重放效果未知操作。任务与交互终端分离的规则见[后台任务](2026-09-19-detach-terminal-from-task-runtime.md)。

同一份工作文件只有一个 Agent 写入。并行编码使用独立 Git worktree，由主 Agent 汇总并验证，非 Git 写任务串行；上下文独立不证明文件隔离。按工作的写入目标首次钉定、父目录与子目录占用判定、按 taskId 释放、宿主不直接执行 git、保留副本且不提供删除入口等约束见[SubAgent worktree](2026-10-04-subagent-worktrees.md)。按工作 ID 汇总完整差异、预检成功才套用、冲突零写入、already/empty 结论与事件账本核实见[汇总工作成果](../feature/2026-10-05-integrate-worktree-results.md)；main 也可发起修改委派，取消或关闭不阻止找回并汇总保留成果。

`ruukoto` 只有一个与拥有者持续对话的 main 会话，QQ 私聊与 Telegram 共享它；SubAgent 有独立工作上下文，main 委派长任务后继续响应新消息。完成或失败的最终结果由 main 汇总并自动回复原入口、原拥有者，审批及时通知，普通进度按需提供，不广播到其他入口。该授权只适用于已接受委托的最终汇报；原目标停用或绑定变化不改发，暂时离线等待，发送效果未知不自动重试。实现的收尾事务、`owner_reply` 发送槽、幂等键和取消不汇报边界见[IM 审批与最终汇报](../feature/2026-10-02-im-approval-and-final-report.md)。GitHub 评审使用宿主登记的独立工作/SubAgent、任务限定的只读 MCP 与固定通知，沿用其[独立评审规则](../feature/2026-09-24-github-event-review.md)，不继承 IM 最终汇报授权。

Personal Agent 经专用账户按明确授权管理服务器；宿主核实绑定拥有者私聊的审批身份与范围。具体操作和目标可保存可查看、可撤销的[长期授权](../feature/2026-10-03-standing-permissions.md)，范围外仍审批，不默认授予任意 root 长期权限；服务管理经过[固定 helper](2026-10-03-service-management-helper.md)。Coding Agent 在 macOS/Linux 受限任务必须有技术边界，边界缺失明确拒绝，不静默降级；完全访问由拥有者显式选择，仍只使用执行账户已有权限，见[访问模式](../feature/2026-09-19-explicit-access-modes.md)与[执行边界](2026-09-20-tool-worker-per-task-container.md)。

共享只限明确选定的个人偏好和通用经验，由 Agent 提候选、拥有者确认发布或修改；本端记忆积累不依赖另一端在线。项目约定保留所属范围，完整历史、日程和任务进度不默认同步，共享记忆不自动开放其来源历史和产物。同步机制、版本冲突、撤销传播与离线副本处理在共享阶段确定。邮件与 GitHub comment 通用交流、跨端记忆及正式 QQ 外挂按实际需要后续交付。

## 兼容与实施范围

旧 `.scratch/daily-agent/spec.md` 的固定角色同后台方向由本决定取代；已交付机制仍是迁移基础。旧开发实例资料迁入 Coding Agent 的只读源快照、原 ID、allow-list 导入、无凭据迁移、无重放、回执与回退见[旧实例导入](2026-10-04-legacy-instance-import.md)。主会话与服务状态迁入全新 Personal Agent 的完整身份、凭据冲突拒绝、交接不重放、目标活动阻挡回退见[个人实例导入](2026-10-05-personal-instance-import.md)。

ruukoto 保留普通开发会话，Coding Agent 仍是编码主要入口；旧项目的新建入口只在 ruukoto-code 改为工作区提示，详见[保留开发会话](../feature/2026-10-05-ruukoto-keeps-dev-sessions.md)。退出开发 TUI 即结束本次开发运行的独立生命周期见[开发启动入口](../process/2026-10-09-dev-launchers.md)。

完整历史与有界模型上下文分开管理，单主会话不要求所有工作串行，见[有损上下文压缩](2026-09-26-lossy-context-compaction.md)。角色退役不放宽资料身份、群资料隔离、外发或拥有者认证规则。原来把所有后台固定在 Linux、把 IM 审批留在 TUI、把 coding/chat 作为固定执行路径的阶段约束各由上述产品和模块决定修订。

## 验证

首期按本地仓库修改与测试、IM 服务器管理、后台长任务持续响应的顺序验收；[方向规格](../../../../.scratch/agent-direction/spec.md)记录 Q1–Q19 拥有者确认与场景，不代表所有后续能力已验收。[产品入口工单](../../../../.scratch/agent-direction/issues/01-independent-products.md)记录 `npx tsc --noEmit` 通过、test/71 当时 14/14，以及 macOS 真实 bin/文件/socket/SQLite、模型打桩的双后台并存、独立停止和跨产品目录拒绝冒烟 10 项；当时全量检查另有既有 TUI 失败和并发抖动，不能写成全绿。入口继承相反产品变量导致停止错误后台的缺陷也已修复并加入真实双后台回归。

[固定角色退役工单](../../../../.scratch/agent-direction/issues/23-contract-legacy-roles.md)记录 `npm run typecheck` 通过、test/67 4/4，以及旧/新真实后台、控制面与 SQLite、模型打桩的 macOS/tx 冒烟各 5/5；全量 889 项中 886 通过、1 跳过、2 失败，分别是干净基线复现的 DNS 超时与单跑通过的协作消息负载抖动。未涉及真实 QQ/Telegram/GitHub。

Seatbelt / bubblewrap 原生候选只建立真实探针，尚未接入产品、未切换 container 默认值。旧 macOS `/tmp` 路径别名造成的否决依据已更正；macOS 脱离进程组的后代回收、tx namespace 能力仍未满足前置验收，具体证据与切换门槛见[执行边界](2026-09-20-tool-worker-per-task-container.md)。本记录迁移不把这些缺口改写为已完成。

## 备选方案

保留 main/coding/chat 同后台可以直接复用旧委派与群聊路径，旧职责迁移成本较低；拥有者要求开发机与服务器分开部署和交互，固定 coding 又与开发产品重复，核心 chat 的耦合限制独立演进，因此职责迁入两个产品、通用 SubAgent 和可选外挂。真实历史方向保存在[daily-agent 规格](../../../../.scratch/daily-agent/spec.md)与[方向访谈](../../../../.scratch/agent-direction/spec.md)。

任务完成立即关闭 SubAgent 可以让任务与身份同步结束，是第二轮访谈原建议；拥有者明确要求继续委托原 Agent，故默认空闲、保留身份上下文，只显式关闭。三轮访谈同时确认新工作复用后重算协作资格。该备选的详细决定另见[复用与关闭](../feature/2026-10-04-subagent-reuse-close.md)。

每个产品拆成独立 package 可以各自产出制品；[产品入口工单](../../../../.scratch/agent-direction/issues/01-independent-products.md)选择单代码包、两条 bin 以满足当前独立运行与重启需求，只有确需独立打包和发货时才重访拆包。该条件未成立，但产品差异缺少显式落点与模块边界漂移另有驱动，重访的具体方案见[同仓 workspaces 分包](../../proposed/architecture/2026-10-11-in-repo-workspace-packages.md)。

## 后果

两个产品的任务不依赖跨端连接，已复用的存储、审批、历史、模型上下文与执行机制继续承担共同契约。代价是旧角色职责、资料来源和入口必须逐条迁移，不能靠全局改名或改写历史完成；读兼容标识持续存在，仍需分产品核实执行边界和部署。

共享、更多渠道与外挂协议仍有明确实施缺口。原生隔离候选未完成验证前，受限执行依赖当前已验证后端；跨端共享不可用只影响信息新鲜度。[架构总览](../../../../docs/architecture.md)描述当前产品能力与模块划分。
