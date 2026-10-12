# Agent Note: 个人 Agent 复用原生受限执行并退役 Docker worker

Status: proposed

## 问题

两个产品共享 worker 和任务生命周期，却仍交付两套受限执行方式：Coding Agent 使用原生沙盒，个人产品的生产模板使用 Docker 镜像。拥有者要求个人产品也使用原生执行，消除任务对 Docker 与 worker 镜像的部署依赖。个人产品的能力声明实际默认 local，正式 CLI 缺省只允许 local/container，因此修改生产变量并不足以交付同一执行契约。

原生 Linux 能力已经存在，但其 user scope 依赖 user manager、用户 bus 和 cgroup 委派；个人后台则是指定账户的系统服务。交互终端下的已有验证不能证明开机后、无人登录时仍具备这些前提，也不能证明后台系统单元的 KillMode 能回收另一个 user scope。迁移还会取消原容器 `/tmp` 的 64 MiB 上限，必须明确这项可观察差异。

确认范围见[规格](../../../../.scratch/personal-native-sandbox/spec.md)，执行与证据由[工单](../../../../.scratch/personal-native-sandbox/issues/01-personal-native-sandbox.md)持有。本提案尚未落地，不将旧笔记的个人容器规则改写为已经迁移。

## 方案

### 唯一正式受限后端

两个产品的能力声明均以 native 为唯一正式受限后端，CLI、server 和开发入口沿用声明。显式 container/local 参数或环境覆盖拒绝并提供迁移指引；缺少原生能力明确失败，不退回 Docker 或后台自由执行。共享包按能力接线，不新增产品名判断。

个人产品继续面向 Linux，复用现有 WorkerLauncher、bubblewrap 的完整 namespace、seccomp 和 user scope/cgroup。worker 协议、任务账本、审批单次消费、保护根、授权目录身份、只读共享 Git 与停止结论传播继续由现有模块持有。native 使用宿主工具链，不为运行工具而开放整个 HOME、源码根或未知安装父目录。

覆盖普通开发会话、main/独立定时会话委派的 SubAgent，以及 worktree 创建和汇总。main 与独立定时根任务的业务工具仍在宿主执行，不增加编码工具或直接调用不可信 Git；完全访问沿用[当前账户执行](../../implemented/feature/2026-10-12-full-access-current-account.md)，local 保留为该实现和离线测试入口。

### 常驻前提与停止

优先保留个人后台现有的系统级 service，显式配置运行账户 user manager 的开机与退出登录存活、runtime dir/user bus 环境以及启动顺序。仅可信 launcher 接触这些管理入口，受限 worker 环境继续剔除控制变量、凭据、代理、SSH agent 与 user bus。安装和系统策略调整由部署步骤完成，任务启动器不自行安装、提权或关闭整机 userns 加固。

先在隔离服务实例核实正式 bwrap/profile、cgroup v2、可委派 scope 和 cgroup.kill，并覆盖无登录冷启动、退出登录后触发、取消、后台强杀及重启，再切换默认。实际后代停止按 PID namespace、scope 和 cgroup 结果核实；backend service 的 KillMode、worker 主 PID 消失或调用 kill 成功都不能替代该结果。

失败分类和状态归属沿用[停止未核实保留](../../implemented/bug-fix/2026-10-11-preserve-unverified-worker-stop.md)：启动后错误交出单元身份，停止未知保留占用和现场，拒绝替代环境；后台重启保留中断与暂停状态，效果未知不重放。若常驻验证揭示共享实现缺口，先修复并验证；不能降低边界来达成默认切换。

### 删除范围与资源语义

移除 Docker worker launcher、后端取值、专属环境配置、容器 UID/GID 和 VM inode 例外、镜像构建及失效活跃检查入口。把有价值的执行、协作、恢复与原入口汇报场景迁到 native；旧真实结果作为历史保留，不重新标为原生通过。服务管理 helper 和它对 Docker 等基础设施目标的禁止规则有独立用途，继续保留；其他软件的容器部署不属于本提案。

临时资料沿用现有 native 的独立 HOME/TMPDIR，无单任务容量限制；核实停止后清理，未核实则保留。取消 Docker `/tmp` 的 64 MiB 上限是拥有者确认的取舍，不宣称资源限制等价。现有 launcher 都没有应用显式 CPU、内存、PID 或工作区配额，本次不另建资源限制机制；若后续要求硬限额或出现不可接受的磁盘占用，再单独设计资源策略及验收。

升级采用先停旧后台、按实例核实旧 worker、再换代码和配置的方式。保留资料与异常占用，不在线换活动执行环境，不自动删除容器或卸载服务器 Docker。部署前提与真实切换说明随工单交付，当前规划不操作在线实例。

## 既有笔记审计

按 native、原生沙盒、bubblewrap、Docker/container、执行后端及相关模块检索活跃笔记；检索时没有 proposed/rejected 目录。归类如下，历史测试中出现 Docker 不表示该决定仍要求保留实现。

| 笔记 | 归类与处理 |
| --- | --- |
| [按任务容器](../../implemented/architecture/2026-09-20-tool-worker-per-task-container.md) | 部分取代个人容器后端和临时空间选择，新增提案互链；保留原决定及完整 worker、有界协议、审批与停止原则的归属 |
| [Coding Agent 原生执行](../../implemented/architecture/2026-10-10-native-execution-sandbox.md) | 部分重叠并扩大产品使用范围，互链；平台机制、路径/环境限制及 macOS 已接受的局限继续由原篇持有 |
| [两个产品](../../implemented/architecture/2026-10-02-two-agent-products.md) | 部分取代个人产品容器部署，互链；产品身份、Linux 定位、会话与能力边界保留 |
| [访问模式](../../implemented/feature/2026-09-19-explicit-access-modes.md)、[自动审查](../../implemented/feature/2026-09-22-auto-review-mode.md)、[开发入口](../../implemented/process/2026-10-09-dev-launchers.md) | 部分重叠的是后端默认和接线事实，互链；模式、审查与开发实例规则保留，实施时就地同步事实，不重写其独立决定 |
| [worktree](../../implemented/architecture/2026-10-04-subagent-worktrees.md)、[改动汇总](../../implemented/feature/2026-10-05-integrate-worktree-results.md) | 部分重叠的是容器身份例外和执行接线，互链；写入目标、宿主不直接执行 Git 与成果保留仍归原篇，历史 Docker 验证不改写 |
| [当前账户完全访问](../../implemented/feature/2026-10-12-full-access-current-account.md)、[停止未核实保留](../../implemented/bug-fix/2026-10-11-preserve-unverified-worker-stop.md) | 沿用的独立决定，不由本提案取代；旧 native/container 篇里的专用完全访问账户已被前者取代，本次不能恢复该旧要求 |
| [服务 helper](../../implemented/architecture/2026-10-03-service-management-helper.md)、[IM 审批与汇报](../../implemented/feature/2026-10-02-im-approval-and-final-report.md)、[工作委托](../../implemented/architecture/2026-10-03-work-delegation-subagent-task.md)、[复用关闭](../../implemented/feature/2026-10-04-subagent-reuse-close.md)、[工作内消息](../../implemented/feature/2026-10-05-subagent-messaging.md)、[工作取消](../../implemented/feature/2026-10-04-cancel-work.md)、[重启恢复](../../implemented/architecture/2026-10-05-subagent-restart-recovery.md) | 与后端选择无关；沿用身份、授权、生命周期和结果语义，Docker 历史用例不形成保留后端的要求 |
| [GitHub 评审](../../implemented/feature/2026-09-24-github-event-review.md)、[退役核心群聊](../../implemented/simplification/2026-10-02-retire-core-group-chat.md)、[workspaces 分包](../../implemented/architecture/2026-10-11-in-repo-workspace-packages.md)、[文档分工](../../implemented/process/2026-10-09-split-agent-and-human-docs.md) | 命中主要是历史证据或构建上下文，与本提案的运行边界选择无关；同步当前构建事实时保留原理由与历史记录 |

没有完全吸收或需要拒绝/归档的既有提案。上述实现笔记的互链只说明已确认的新提案，不表示实现完成。

## 备选方案

- 保留显式 Docker 备用：可复用现有容器证据，在缺原生前提的服务器继续运行；拥有者选择唯一正式受限后端，因此不保留双部署路径，也不自动降级。
- 只切个人入口，把旧 Docker worker 留给以后清理：本次 diff 更小，可以单独安排删除；两个产品都不用该后端后，它仍拖住类型、配置、镜像和验证入口，拥有者选择同一工单完成清理并迁移场景。
- 保留 64 MiB 临时空间硬上限：能保持原容器的容量边界，降低单任务占满宿主临时磁盘的可能；现有原生后端没有该机制，需要增加挂载或配额设计，拥有者选择沿用原生目录及部署说明，需要硬限额时再重访。
- 移除整套部署中的 Docker：可统一服务器运维方式；其他服务是否使用容器及其迁移风险不属于工具执行问题，拥有者将范围限定为任务 worker。

## 验收标准

- 正式个人入口默认且只接受 native；旧覆盖有明确拒绝与迁移指引，无 Docker 时仍完成普通任务、个人委派与 worktree 链路。
- 实际服务账户在无登录、退出登录、冷启动与重启条件下具备原生前提；真实后代、文件/网络/IPC/控制面和停止未知状态经过验证，不能由模拟测试替代。
- 无正式或活跃检查路径依赖 Docker worker；场景测试已迁移，当前账户完全访问及 Coding Agent 共享路径通过对应回归。
- 升级保留既有资料和异常占用，临时空间语义准确说明；工单持有可复跑命令、环境、结果与未测范围，全部验收完成后才转 implemented。

## 风险

收益是两个产品共用现有原生执行与宿主工具链，减少镜像、容器权限和双后端维护。代价是个人服务器需持续可用的 user manager、正确的 user bus 环境、bwrap/profile 与 cgroup 委派；退出登录和后台系统服务停止与 scope 生命周期并非同一事件，必须有真实证据。

宿主工具安装布局、补充组和 ACL 会影响实际可用性，不能从旧镜像成功推定原生成功。授权树硬链接检查随目录规模增长；临时目录和停止未核实现场使用宿主磁盘，没有新增配额。若需要确定的容量边界或当前部署方案不能维持受限执行，应重访具体要求，不静默回退。

删除旧 worker 启动器不等于已停止旧版本留下的容器。升级前必须按实例核实；查询失败不能释放占用，更不能通过删除数据库记录掩盖残留。现有真实 Linux 原生证据限定 Ubuntu 24.04 x64，不能扩大为所有 Linux 环境或无人登录常驻都已通过。
