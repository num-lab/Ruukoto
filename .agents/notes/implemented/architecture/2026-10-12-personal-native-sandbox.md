# Agent Note: 个人 Agent 复用原生受限执行并退役 Docker worker

Status: implemented

## 问题

两个产品共享 worker 和任务生命周期，却仍交付两套受限执行方式：Coding Agent 使用原生沙盒，个人产品的生产模板使用 Docker 镜像。拥有者要求个人产品也使用原生执行，消除任务对 Docker 与 worker 镜像的部署依赖。个人产品的能力声明实际默认 local，正式 CLI 缺省只允许 local/container，因此修改生产变量并不足以交付同一执行契约。

原生 Linux 能力已经存在，但其 user scope 依赖 user manager、用户 bus 和 cgroup 委派；个人后台则是指定账户的系统服务。交互终端下的已有验证不能证明开机后、无人登录时仍具备这些前提，也不能证明后台系统单元的 KillMode 能回收另一个 user scope。迁移还会取消原容器 `/tmp` 的 64 MiB 上限，必须明确这项可观察差异。

确认范围见[规格](../../../../.scratch/personal-native-sandbox/spec.md)，执行与证据由[工单](../../../../.scratch/personal-native-sandbox/issues/01-personal-native-sandbox.md)持有。本决定接管个人受限执行与交付；被部分取代笔记保留原决定及真实历史结果，适用范围说明当前事实。

## 决定

### 唯一正式受限后端

两个产品的能力声明均以 native 为唯一正式受限后端，CLI、server 和开发入口沿用声明。显式 container/local 参数或环境覆盖拒绝并提供迁移指引；缺少原生能力明确失败，不退回 Docker 或后台自由执行。共享包按能力接线，不新增产品名判断。

个人产品继续面向 Linux，复用现有 WorkerLauncher、bubblewrap 的完整 namespace、seccomp 和 user scope/cgroup。worker 协议、任务账本、审批单次消费、保护根、授权目录身份、只读共享 Git 与停止结论传播继续由现有模块持有。native 使用宿主工具链，不为运行工具而开放整个 HOME、源码根或未知安装父目录。

覆盖普通开发会话、main/独立定时会话委派的 SubAgent，以及 worktree 创建和汇总。main 与独立定时根任务的业务工具仍在宿主执行，不增加编码工具或直接调用不可信 Git；完全访问沿用[当前账户执行](../../implemented/feature/2026-10-12-full-access-current-account.md)，local 保留为该实现和离线测试入口。

### 常驻前提与停止

优先保留个人后台现有的系统级 service，显式配置运行账户 user manager 的开机与退出登录存活、runtime dir/user bus 环境以及启动顺序。仅可信 launcher 接触这些管理入口，受限 worker 环境继续剔除控制变量、凭据、代理、SSH agent 与 user bus。安装和系统策略调整由部署步骤完成，任务启动器不自行安装、提权或关闭整机 userns 加固。

默认切换前，在 tx 独立账户的系统服务和可销毁 Ubuntu VM 中核实正式 bwrap/profile、cgroup v2、可委派 scope 和 cgroup.kill，并覆盖无登录冷启动、退出登录后触发、取消、后台强杀及来宾真实重启。实际后代停止按 PID namespace、scope 和 cgroup 结果核实；backend service 的 KillMode、worker 主 PID 消失或调用 kill 成功都不能替代该结果。

失败分类和状态归属沿用[停止未核实保留](../../implemented/bug-fix/2026-10-11-preserve-unverified-worker-stop.md)：启动后错误交出单元身份，停止未知保留占用和现场，拒绝替代环境；后台重启保留中断与暂停状态，效果未知不重放。常驻验证发现的诊断原因丢失在原 worker 持有者修复；不放宽超时、保护根或停止要求。

原生 worker 的 ready/init 失败保留标准 `Error.cause` 中的原始 `ExecutionError`，供内部按 code 区分超时、fatal、退出与通道失败；对外仍采用 `execution_unavailable` / `worker_failed`，保留单元身份和停止结论，不解析错误文本。材料分析即使没有额外只读路径，也显式下发空 `readRoots`，使只读工具钉定到子目录；这不为完全访问的普通开发或修改任务新增沙箱。

### 删除范围与资源语义

移除 Docker worker launcher、后端取值、专属环境配置、容器 UID/GID 和 VM inode 例外、镜像构建及失效活跃检查入口。把有价值的执行、协作、恢复与原入口汇报场景迁到 native；旧真实结果作为历史保留，不重新标为原生通过。服务管理 helper 和它对 Docker 等基础设施目标的禁止规则有独立用途，继续保留；其他软件的容器部署不属于本决定。

临时资料沿用现有 native 的独立 HOME/TMPDIR，无单任务容量限制；核实停止后清理，未核实则保留。取消 Docker `/tmp` 的 64 MiB 上限是拥有者确认的取舍，不宣称资源限制等价。现有 launcher 都没有应用显式 CPU、内存、PID 或工作区配额，本次不另建资源限制机制；若后续要求硬限额或出现不可接受的磁盘占用，再单独设计资源策略及验收。

升级采用先停旧后台、按实例核实旧 worker、再换代码和配置的方式。保留资料与异常占用，不在线换活动执行环境，不自动删除容器或卸载服务器 Docker。部署前提与真实切换说明随工单交付；隔离演练没有操作在线实例，生产切换另行安排。

## 既有笔记审计

按 native、原生沙盒、bubblewrap、Docker/container、执行后端及相关模块检索活跃笔记；检索时没有 proposed/rejected 目录。归类如下，历史测试中出现 Docker 不表示该决定仍要求保留实现。

| 笔记 | 归类与处理 |
| --- | --- |
| [按任务容器](../../implemented/architecture/2026-09-20-tool-worker-per-task-container.md) | 部分取代个人容器后端和临时空间选择，互链；保留原决定及完整 worker、有界协议、审批与停止原则的归属 |
| [Coding Agent 原生执行](../../implemented/architecture/2026-10-10-native-execution-sandbox.md) | 部分重叠并扩大产品使用范围，互链；平台机制、路径/环境限制及 macOS 已接受的局限继续由原篇持有 |
| [两个产品](../../implemented/architecture/2026-10-02-two-agent-products.md) | 部分取代个人产品容器部署，互链；产品身份、Linux 定位、会话与能力边界保留 |
| [访问模式](../../implemented/feature/2026-09-19-explicit-access-modes.md)、[自动审查](../../implemented/feature/2026-09-22-auto-review-mode.md)、[开发入口](../../implemented/process/2026-10-09-dev-launchers.md) | 部分重叠的是后端默认和接线事实，互链；模式、审查与开发实例规则保留，当前适用范围同步事实，不重写其独立决定 |
| [worktree](../../implemented/architecture/2026-10-04-subagent-worktrees.md)、[改动汇总](../../implemented/feature/2026-10-05-integrate-worktree-results.md) | 部分重叠的是容器身份例外和执行接线，互链；写入目标、宿主不直接执行 Git 与成果保留仍归原篇，历史 Docker 验证不改写 |
| [当前账户完全访问](../../implemented/feature/2026-10-12-full-access-current-account.md)、[停止未核实保留](../../implemented/bug-fix/2026-10-11-preserve-unverified-worker-stop.md) | 沿用的独立决定，不由本决定取代；旧 native/container 篇里的专用完全访问账户已被前者取代，本次不能恢复该旧要求 |
| [服务 helper](../../implemented/architecture/2026-10-03-service-management-helper.md)、[IM 审批与汇报](../../implemented/feature/2026-10-02-im-approval-and-final-report.md)、[工作委托](../../implemented/architecture/2026-10-03-work-delegation-subagent-task.md)、[复用关闭](../../implemented/feature/2026-10-04-subagent-reuse-close.md)、[工作内消息](../../implemented/feature/2026-10-05-subagent-messaging.md)、[工作取消](../../implemented/feature/2026-10-04-cancel-work.md)、[重启恢复](../../implemented/architecture/2026-10-05-subagent-restart-recovery.md) | 与后端选择无关；沿用身份、授权、生命周期和结果语义，Docker 历史用例不形成保留后端的要求 |
| [GitHub 评审](../../implemented/feature/2026-09-24-github-event-review.md)、[退役核心群聊](../../implemented/simplification/2026-10-02-retire-core-group-chat.md)、[workspaces 分包](../../implemented/architecture/2026-10-11-in-repo-workspace-packages.md)、[文档分工](../../implemented/process/2026-10-09-split-agent-and-human-docs.md) | 命中主要是历史证据或构建上下文，与本决定的运行边界选择无关；同步当前构建事实时保留原理由与历史记录 |

没有完全吸收或需要拒绝/归档的既有提案。上述八篇笔记在适用范围说明当前接线并互链；原决定、备选理由与历史验证保持原样。

## 备选方案

- 保留显式 Docker 备用：可复用现有容器证据，在缺原生前提的服务器继续运行；拥有者选择唯一正式受限后端，因此不保留双部署路径，也不自动降级。
- 只切个人入口，把旧 Docker worker 留给以后清理：本次 diff 更小，可以单独安排删除；两个产品都不用该后端后，它仍拖住类型、配置、镜像和验证入口，拥有者选择同一工单完成清理并迁移场景。
- 保留 64 MiB 临时空间硬上限：能保持原容器的容量边界，降低单任务占满宿主临时磁盘的可能；现有原生后端没有该机制，需要增加挂载或配额设计，拥有者选择沿用原生目录及部署说明，需要硬限额时再重访。
- 移除整套部署中的 Docker：可统一服务器运维方式；其他服务是否使用容器及其迁移风险不属于工具执行问题，拥有者将范围限定为任务 worker。

## 验证

[第一阶段报告](../../../../.scratch/personal-native-sandbox/evidence/stage1-server-report.md)记录 tx Ubuntu 24.04.4/systemd 255/Node 24.21 的独立系统服务及 54 项真实 Linux 原生探针。新账户无 Docker socket 权限；无登录定时修改、登录退出后唤起、启动取消、正常停止、setsid 后代心跳与 cgroup 清空均通过。后台 SIGKILL 后旧 scope 停止，任务中断、效果未知与 paused/occupancy_unverified 保留，不重放。可销毁 Ubuntu 24.04.5 VM 执行真实 guest reboot，boot ID 改变后 enabled 系统服务在无登录账户下自动运行真实写入/bash 并核实 cgroup 为空。

缺 runtime/bus、bwrap/profile 的真实负例均拒绝；新 UID 995 的 Delegate=no 使 user manager 无法创建 init.scope，launcher 返回 execution_unavailable/policy_missing，无 scope、残留 PID 或回退。manager 可用但 scope 没有 ControlGroup 或 cgroup.kill 不可写的具体分支由两个定向替身用例验证，不声称这些分支经过真实内核复现。

[第二阶段报告](../../../../.scratch/personal-native-sandbox/evidence/stage2-report.md)记录个人 native 04/13/15/18/28：普通修改四工具、实际活动父任务的协作与材料读取、恢复、原 IM 汇报、main 双 worktree 与汇总、独立定时 confirm/auto-review/full_access 的委派均通过。模型、QQ/Telegram 和通知为确定性桩；进程、文件、systemd scope、socket、SQLite 与 JSONL 是真实。main 强杀的精确异常占用与初次失败记录保留。

Docker 删除后的[第三阶段生产回归](../../../../.scratch/personal-native-sandbox/evidence/stage3-production-report.md)为 102/102、汇总 13/13；[共享 Linux 回归](../../../../.scratch/personal-native-sandbox/evidence/stage3-report.md)中的 Coding Agent worker 10 项、worktrees 8 项均通过。macOS 的相同真实原生 worker/worktree、入口、权限审批、Plan、调度、消息、恢复与联合发布用例，以及构建、foundation、静态检查由[最终报告](../../../../.scratch/personal-native-sandbox/evidence/stage4-report.md)持有。

双产品升级使用协议兼容的 8bccb8f 独立安装并构建旧版与新版，保持另一端运行。实际旧审批的批准消费记录、产物字节、JSONL 与修改副本保全；升级后两端默认 native 并真实写入，旧参数/环境覆盖拒绝。异常占用按裸 SQLite 播种，升级后中断、效果未知、SubAgent unverified 与暂停均保留，不将此场景当作真实强杀证据，现场不自动删除。

## 后果

两个产品共用现有原生执行与宿主工具链，删除 Docker worker 启动器、专用类型/配置、镜像与活跃检查依赖。个人服务器需持续可用的 user manager、正确的 user bus 环境、bwrap/profile 与 cgroup 委派；linger 使账户开机后与退出登录后仍常驻，后台系统服务停止与 scope 生命周期不是同一事件。

宿主工具安装布局、补充组和 ACL 决定实际可用性；权限预检采用实际账户 accessSync，不使用旧容器 UID/GID 位运算。授权树硬链接检查随目录规模增长；临时目录和停止未核实现场使用宿主磁盘，没有单任务容量或新增 CPU/内存/PID 配额。取消原 Docker /tmp 的 64 MiB 上限是已确认取舍，出现不可接受的磁盘占用或需要硬限额时再设计资源策略，不静默回退。

删除旧启动器不会停止旧版本遗留的容器。升级前先以旧版本停止后台并按实例核实 worker，备份配置与资料；未知状态保留占用，不能删除记录推进切换。回滚同样先核实新单元停止。本次没有生产切换、真实模型或真实 IM 外发；Linux 实测范围为 Ubuntu 24.04 x64，不能扩大为所有 Linux 部署。
