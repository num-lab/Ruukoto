Status: ready-for-agent

# 26 — 将 ruukoto-code 的受限执行替换为原生沙箱

**What to build:** 在 macOS 与 Linux 上，以原生沙箱替换 ruukoto-code 的 Docker 受限执行后端，使用宿主工具链，并保留现有文件、网络、凭据、控制面与任务生命周期边界。

**Blocked by:** [27 — 保留工具执行单元停止失败的核实结果](27-preserve-unverified-worker-stop.md)（原生接入前须完成；第一阶段边界探针可独立继续）。两平台的原生边界验证是本工单的第一阶段；按已确认口径验证未通过，不切换默认后端、不降低验收要求。

依据：[产品规格](../spec.md)、[CONTEXT.md](../../../CONTEXT.md)、[ADR 0004](../../../.agents/notes/implemented/architecture/2026-09-20-tool-worker-per-task-container.md)、[ADR 0017](../../../.agents/notes/implemented/architecture/2026-10-02-two-agent-products.md) 与 [ADR 0021](../../../.agents/notes/implemented/architecture/2026-10-04-subagent-worktrees.md)。

## 背景与已核实事实

ruukoto-code 当前默认使用 container。工具 worker 承载 read/edit/write/bash，模型调用、审批与持久化由宿主后台负责。同一任务按需启动并复用 worker；受限 SubAgent、Git worktree 创建与改动汇总也经这一执行边界完成。单独替换主任务入口不能消除该产品的 Docker 依赖。

[工单 03](03-execution-boundary-proof.md) 曾依据旧探针否决 macOS sandbox-exec。2026-10-08 的最小本机复核发现，旧脚本以 /tmp 字串生成文件规则，而真实目录位于 /private/tmp。规范化路径后，literal/subpath 读写拒绝四项及两层 Shell 的子进程读取拒绝均生效，共 5/5；原 /tmp 规则的四项读写均未拒绝。因此旧记录不能作为 Seatbelt 文件机制无效的依据。该复核环境为 macOS 27.0、Darwin 27.0.0、arm64，只使用临时虚拟文件并已清理；它未验证完整产品策略、网络、脱离进程组的后代回收或其他系统版本。

现有 local 启动器没有操作系统级文件与网络隔离，不能作为原生沙箱的替代。现有 systemd 启动器用于完全访问，不能直接当作已实现的 Linux 受限后端。

## 已确认的产品与实现范围

- 仅替换 ruukoto-code 的受限执行。macOS 采用 Seatbelt / sandbox-exec，Linux 采用 bubblewrap，直接接入现有 WorkerLauncher，复用 LaunchSpec、工具 worker、通信协议、审批和审计，不引入额外跨平台 sandbox runtime。
- 使用宿主已安装的 Node、Git、Python、编译器等工具链。必要的运行依赖可以只读开放；不得因此默认开放整个拥有者主目录、凭据、后台数据或控制面。依赖超出授权范围时明确说明并沿用授权机制。
- 原生是 ruukoto-code 唯一受限后端，正式入口默认 native，拒绝显式 container 和 local。CLI 参数及 RUUKOTO_EXECUTION_BACKEND 中的旧覆盖值明确报错，给出改为 native 或移除覆盖的指引，不自动转换显式选择。测试继续在库层注入 local。
- 覆盖请求确认、自动审查和计划模式所使用的受限执行。完全访问保留用户显式选择、专用执行身份和控制面分离；缺少其既有执行入口仍明确失败，本工单不把完全访问改为拥有者账户执行。
- 覆盖普通开发任务、只读与修改 SubAgent、worktree 创建、共享 Git 目录只读访问和改动汇总。宿主不会因为更换后端而直接执行不可信仓库中的 Git 命令。
- macOS 与 Linux 同属本工单，分别先验证后接入。原生能力缺失、受系统策略限制或无法核实边界时明确拒绝，不能回退到 Docker、local 或后台账户执行。两平台均完成验收才标记 resolved。
- 共享的容器与执行账户实现仍须满足 ruukoto 的现有产品契约；不得因本工单改变个人 Agent 的部署行为。

## 实施与验证要求

先建立可复跑的真实边界验证。修正旧 macOS 探针的路径规范化，并区分命令未启动、配置解析失败和操作确实被沙箱拒绝。未沙箱对照应证明目标文件可访问、测试服务可达；对照无效或基础设施缺失不能记为边界通过。验证使用临时虚拟资料，不读取真实凭据内容。

文件边界须覆盖授权工作区读写、额外只读及读写授予、SubAgent 限定读取范围、共享 Git 目录只读，以及未授权路径、符号链接和路径别名。宿主工具链的可用性不能通过开放整个宿主文件系统实现。环境变量、继承描述符、Unix socket、回环端口及平台 IPC 均须检查，不能使工具取得后台或拥有者控制面身份。默认无网络继续覆盖任意 Shell 及后代；批准的结构化越界操作仍取审批中固定参数并单次消费。

停止必须处理整个执行单元，包括后台后代、忽略信号及脱离原进程组的进程。使用实际运行对照和持续写入或心跳证明后代已停止，不能仅以 worker 主 PID 消失、父进程退出或一个 kill 调用成功判定。覆盖启动窗口、取消、模式或授权范围改变时的回收重建，以及后台异常后的占用恢复；无法核实旧执行已停止时保留目录占用并明确报告，不自动重放效果未知的操作。

产品接入包括默认后端与合法配置值、按需拉起后台、后端说明与握手展示、执行身份和目录可读写预检、受管单元登记及所有受限 worker 调用点。原生进程的宿主身份与文件系统语义须重新核实，不能套用 Docker Desktop 的 VM 权限或 inode 假设。升级沿用后台重启与任务恢复机制，不在线替换活动任务的执行环境，不删除工作副本、历史、产物或审批记录。

## 验收标准

- [ ] macOS 与 Linux 各有真实环境、可复跑的原生边界验证，覆盖文件、网络、凭据与控制面、子进程继承和整个执行单元的停止；记录已测系统、限制及缺失能力的拒绝行为。
- [ ] 在没有可用 Docker 的条件下，ruukoto-code 能按需启动后台，在授权目录内完成真实 read/edit/write/bash、代码修改与检查；主任务、SubAgent、worktree 创建和改动汇总全部使用原生边界。
- [ ] 未授权宿主文件和控制面材料无法读取或修改，只读授予及共享 Git 目录无法写入，任意 Shell 与后代默认无法联网；越界操作沿用原审批及单次消费规则。
- [ ] 任务取消、启动中断、模式或授予范围变化时完成回收与必要重建。整单元停止按平台判定：Linux 脱离进程组的后代实际停止；macOS 进程组内后代与轮询累积集合内的存活后代实际停止，集合外残留不得静默忽略，不要求 `posix_spawn` 属性位逃逸的后代被停止（2026-10-10 拥有者裁定，依据见下方评论与[原生执行沙箱](../../../.agents/notes/proposed/architecture/2026-10-10-native-execution-sandbox.md)）。异常后无法核实退出时保留占用，恢复不自动重放未知效果。
- [ ] ruukoto-code 默认 native，显式 container/local 从正式入口被拒绝并给出迁移指引；测试库层 local 注入、完全访问的既有身份契约和 ruukoto 部署行为通过相关回归验证。
- [ ] 修正旧探针，并在旧工单与运行文档中追加更正依据，保留历史记录；明确修订 ADR 0004 的 ruukoto-code 后端选择，更新 ADR 0017/0021 的相关实现说明及 docs/visual 图解。
- [ ] 完成与变更相匹配的自动化测试、类型检查和仓库规定检查；真实边界证据与模型打桩或 local 测试分别记录。两平台通过前不得宣称原生替换已完成。

## Comments

### 2026-10-08：规格访谈

本工单经 grilling 与 ponytail 核实。拥有者在 Q1—Q6 确认：原生为唯一受限后端、使用宿主工具链、同一工单覆盖两平台、直接接入 Seatbelt/bubblewrap、显式旧 container 配置报错并提供迁移指引、正式入口拒绝 local。拥有者在 Q7 确认最终规格，状态登记为 ready-for-agent。

### 2026-10-08：第一阶段真实验证与未通过的前置条件

本轮按工单要求先建立可复跑边界探针。第一阶段没有通过，当前没有修改 `src/` 或 `deploy/`、没有切换默认后端、没有将工单标记 resolved。以下均为真实文件、进程、OS 沙箱与自建服务验证，不使用模型打桩或 local 冒充原生边界；报告会明确列出未启动或尚未验证的项目。

**交付与复跑**

- [运行说明](../../../verification/foundation/scripts/native-isolation/README.md)：命令、退出码、被测策略与尚未覆盖的产品验收。
- [macOS Seatbelt 探针](../../../verification/foundation/scripts/native-isolation/macos-probe.py)与[报告](../../../verification/foundation/results/native-macos-report.md)：规范化后的文件规则、授权与只读授予、SubAgent 范围、共享 Git 目录、路径别名、符号链接、网络、环境、FD、信号/进程信息、Mach/共享内存、工具链启动和后代停止。
- [macOS launchd 探针](../../../verification/foundation/scripts/native-isolation/macos-launchd-probe.py)与[报告](../../../verification/foundation/results/native-macos-launchd.md)：独立验证 job 消失是否代表脱离进程组的后代停止。
- [Linux bubblewrap 探针](../../../verification/foundation/scripts/native-isolation/linux-native-probes.py)、[运行说明](../../../verification/foundation/scripts/native-isolation/linux-README.md)与[报告](../../../verification/foundation/results/native-linux-report.md)：包含有效宿主对照、完整 namespace 候选、文件/grants/IPC/FD/子进程/停止、启动缺项与系统策略诊断。
- 旧 `.scratch/agent-direction/macos-sbx-probe.sh` 入口复用新 macOS 脚本；保留工单 03 的旧记录并追加路径错误及判定错误的更正。探针退出 0 为被测项通过，1 为真实边界失败，2 为不可验证；没有 started、无效对照和清理失败均不能算通过。

**macOS 的确定发现**

环境为 macOS 27.0 / Darwin 27.0.0 / arm64。旧 `/tmp` 字串没有匹配 `/private/tmp` 中的真实目标；规范化后的 literal/subpath/regex 读取拒绝、写入拒绝及两层 Shell 继承均生效。新策略按必要运行时目录只读开放，没有默认开放拥有者主目录或整个文件系统。每个拒绝结论均有本轮虚拟资料的成功宿主对照，使用实际操作 errno，程序启动失败另列。

最终被测集合为 56 项：53 通过、3 失败、0 unavailable，整体退出 1；file* 旧规则覆盖也已恢复。失败为 NOTE_TRACK 不支持、posix_spawn 的 setpgroup/setsid 后代停止失败；相同严格策略下逃离后代的文件与网络拒绝仍生效。报告 missing=0 只表示本脚本列举项都已运行；SysV IPC、生命周期启动窗口、父进程异常与模式/授权变化尚未实测，产品 WorkerLauncher 等验收也未开始。

`(deny syscall-unix (syscall-number SYS_setsid SYS_setpgid))` 能拒绝直接调用，但 `posix_spawn(setpgroup=0)` 和 `posix_spawn(setsid=True)` 能创建新的 PGID/SID。原组 SIGKILL 后，逃离后代仍持续写本次心跳；普通组内后代停止并不能覆盖这些后代。`kqueue NOTE_TRACK` 实测 errno 45（ENOTSUP），与 [Apple XNU filt_procattach](https://github.com/apple-oss-distributions/xnu/blob/main/bsd/kern/kern_event.c) 的拒绝分支相符。这个结果只否决被测回收策略，尚未证明所有 Seatbelt 原生机制均不可能。

另外独立创建了临时唯一 launchd job（RunAtLoad=true、KeepAlive=false、ExitTimeOut=1、AbandonProcessGroup=false）。Python setsid 与 Node detached 两案都有真实运行对照；`bootout` 返回 0，job 查询返回 113 且父 PID 退出后，后代心跳仍增长。probe finally 只按本次 argv/PID 身份清理，验证进程退出与心跳冻结；job 消失不能用来判整单元退出。精确数值及清理结果保存在 JSON。

**Linux 的确定发现**

通过 `ssh tx` 在 Ubuntu 24.04.4 LTS / Linux 6.8.0-117-generic / x86_64 / UID:GID 1003:1003 实跑。系统没有已安装 bwrap，仅在 `/tmp` 解包官方 Ubuntu bubblewrap 0.9.0-1ubuntu0.3；没有改 AppArmor、sysctl 或在线个人 Agent。虚拟文件、别名、FD、TCP/Unix socket、SysV/POSIX IPC 与宿主 PID 对照实际成功；另有双重 fork + setsid + 忽略 TERM 的心跳对照，证实父退出后后代仍在运行，清理后心跳冻结。

完整 bwrap 在探针 started 前退出 1：`loopback: Failed RTM_NEWADDR: Operation not permitted`。拆分 user/pid/ipc 的启动在 uid_map 阶段 Permission denied；net、完整 unshare-all 与临时 user-systemd service 同样失败；`unshare -Ur true` 也被拒。AppArmor enabled=Y、apparmor_restrict_unprivileged_userns=1、unprivileged_userns_clone=1。当前是 2 个对照通过、35 个真实边界全部 unavailable，整体退出 2；不能算 Linux 边界通过。尚不能确认把 bwrap 安装到正式路径后的结果，需要在满足管理员系统策略的环境复跑。

**接入范围核查与后续前置条件**

接入必须覆盖 `launchers.ts` 的 backend/kind/LaunchSpec、CLI 默认及显式旧 flag/env 拒绝、Runtime 的入口预检与 executionInfo、ToolRouter 的 native dev/ino 复核、受管单元登记/停止/恢复、WorkCopyManager 的执行身份、worktree 创建与汇总的共享 Git 目录，以及相应测试和图解。现有 macOS Docker Desktop 的 inodeOpaque 与 VM 权限例外不适用于 native；ruukoto 的 container/systemd 与完全访问的专用身份仍需保留。

静态核查还发现共享生命周期会丢弃停止失败：ready 失败后 stop(false) 被忽略，starting 占位将启动失败当作已回收，重复 stop 在句柄置空后返回 true，worktree 临时 worker 没有受管登记且忽略停止失败。按 visual-docs 的记录要求登记为[工单 27](27-preserve-unverified-worker-stop.md)，本轮未修实现；这些发现不作为真实 OS 边界通过的证据。

继续接入前须先提供并实测 macOS 的完整后代回收机制，并在允许完整 namespace 的 Linux 环境跑完真实边界。然后才能进行无 Docker 的 read/edit/write/bash、SubAgent/worktree/汇总、审批单次消费、启动取消、授权变化重建与后台恢复验收。当前证据不足，不勾选完整验收项。

**文档核实与仓库检查**

- 更新 `docs/visual/deployment.html#execution` 与 `#dev-deploy`：正文、SVG/aria-label、图例、验证表格同步更正旧 Seatbelt 否决；标明原生尚未接入，并列出停止失败传播的既有限制。
- 核实锚点：`createLauncherFor` / `createLocalLauncher` / `createContainerLauncher` / `createSystemdLauncher`，`ToolRouter.ensureWorker` / `launchSpecFor`，`ToolWorkerHost.start` / `stop`，`killProcessGroup` / `Driver.killManagedProcesses`，`Runtime.createWorktreeInContainer`、`cli.runServer`、`dev.buildChildEnv` / `devProfileFor` / `BACKEND_KILL_GRACE_MS`，以及执行包装、Dockerfile 与现有真实验证报告。页面继续描述当前实现，ADR 0004/0017/0021 和 runtime.md 只追加验证门槛与证据，未把计划写成已实施。
- 修正的文档不一致：旧图把 Seatbelt 文件规则 0/6 当作机制失效，实际是路径规则未匹配；旧图把所有停止入口的返回值都等同于整单元核实，实际存在上述传播缺口与 local 仅查主 PID 的限制。
- `npm run typecheck` 通过；`npm test` 共 1008 项，1007 通过、1 跳过、0 失败；新脚本的语法与判定自检另跑，真实原生探针的失败/不可验证按报告记录，不混入库层回归通过数。图解枚举/锚点/链接检查 4/4 通过，渲染核实见下。

图解渲染检查已完成：运行 `.agents/skills/visual-docs/shoot.sh docs/visual/deployment.html` 并逐张检查全部 16 张切片，本次修改的图、表与文字无溢出、遮挡或箭头问题；发现既有 `#service` sudoers 卡片中的长路径略超卡片右边界，未改本次范围外的布局。新探针经独立只读审查，修正了子程序未启动被误判拒绝、遗漏回执、清理失败未影响判定等问题；Linux 自检通过，macOS 同轮包含策略解析失败与程序启动失败分类的真实自检。

旧 macOS 入口最终由主代理独立复跑：56 项、53 通过、3 失败、0 unavailable、缺失集合为空，实际退出 1；核实虚拟资料已清理。两次结果都符合真实失败的退出约定。

### 2026-10-10：探索性复核——Linux 前置条件是缺 AppArmor profile，不是平台不支持

本轮只做探索与取舍核实，没有改 `src/`、`deploy/` 或默认后端，没有勾选验收项。所有结论都来自本轮实跑；对 tx 的系统改动在同一脚本内回滚并核实（见末尾）。

**推翻上一轮的 Linux 结论**

上一轮「35 项全部 unavailable」的根因不是 Ubuntu 24.04 不支持 bubblewrap，而是 bwrap 被解包到 `/tmp` 运行：Ubuntu 的 userns 限制按**可执行文件路径**匹配 AppArmor profile，`/tmp` 下的副本拿不到 `userns` 权限。这与工单 03 的 `/tmp` 与 `/private/tmp` 属同一类错误——环境搭建缺项被记成了平台能力缺失。

已核实：`bubblewrap` 0.9.0-1ubuntu0.3 包内**不含** AppArmor profile，只有 `/usr/lib/sysctl.d/50-bubblewrap.conf`，而该文件只设 `kernel.unprivileged_userns_clone=1`，不触及 `kernel.apparmor_restrict_unprivileged_userns`。所以单纯 `apt install` 不够，必须另加 profile：

```
abi <abi/4.0>,
include <tunables/global>
profile ruukoto-bwrap /usr/bin/bwrap flags=(unconfined) {
  userns,
}
```

对照实跑（Ubuntu 24.04.4、Linux 6.8.0-117-generic、x86_64、UID 1003、`apparmor_restrict_unprivileged_userns=1` 全程未改）：

| 条件 | 结果 |
| --- | --- |
| 装到 `/usr/bin/bwrap`，无 profile | `bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted`（与上一轮同一错误） |
| 同上，加载上述 profile | namespace 建立成功，错误变为 `execvp true: No such file or directory`（仅因未 bind `/bin`） |

**加载 profile 后的真实边界（`--unshare-all --die-with-parent` + 只读 bind 宿主工具链）**

| 探针 | 结果 |
| --- | --- |
| workspace.write / devnull.write | ALLOWED |
| host.secret-read / host.home-listdir | DENIED:ENOENT（未 bind 即不存在） |
| control.loopback-tcp | DENIED:ECONNREFUSED |
| network.udp-external | DENIED:ENETUNREACH |
| control.unix-abstract | DENIED:ECONNREFUSED |
| control.sysv-ipc | DENIED:ENOENT |
| pid-namespace.visible-pids | 2（宿主同时 156） |
| toolchain.node / git / python3 | 全部 ALLOWED（仅靠只读 bind，未开放宿主主目录） |
| stop.detached-descendant | **STOPPED** |

停止一项用有效对照单独复跑：双重 fork + `setsid` + 忽略 TERM/HUP 的后代，心跳在 bwrap 存活期间确实增长（18→23），`kill -9` bwrap 后心跳冻结在 23、存活计数 0。宿主视角确认该后代与 bwrap 同 PGID 组外；是 PID namespace 拆除而非进程组信号完成回收。这正是 macOS 侧失败的那一类。

**Linux 的无管理员备选：Landlock（有记录在案的缺口）**

`/sys/kernel/security/lsm` 含 landlock，ABI = 4，非特权可用、不需要 namespace，因此完全绕开 AppArmor userns 限制。实跑：工作区读写放行，`$HOME` 列目录 `EACCES`，回环 TCP connect `EACCES`，且 **`setsid` 脱离后代仍受同一 Landlock 约束**（`tcp: DENIED:13`，无法卸除）。但缺口是真实的：`network.udp-send` ALLOWED、`control.unix-abstract` ALLOWED、宿主 PID 可见、SysV IPC 不受限。另：`/dev/null` 必须单独给读写，否则 `git` 直接报 `could not open '/dev/null'`。

控制面已核实用文件路径 socket（`src/control/connect.ts:38` 的 `control.sock`），Landlock 可按路径拒绝；但「默认无网络」在 Landlock 下只覆盖 TCP，UDP 外发仍可达。因此 Landlock 只能作为无法安装 profile 时的降级方案，且须明记缺口。

补充两项实测：`systemd-run --user --scope` 的 `cgroup.kill` 能停掉已 `setsid` 换组的后代（心跳冻结、无存活），可作为 bwrap 之外的第二道回收；但 `systemd-run --user -p IPAddressDeny=any` 在非特权用户单元下**未生效**（仍连通 1.1.1.1），不能当网络边界。

**macOS：残留逃逸面比上一轮记录的更窄，但确实无法在非特权下补齐**

沿用仓库现有 profile 的 `(deny syscall-unix (syscall-number SYS_setsid SYS_setpgid))`，在 macOS 27.0 实跑各条脱离路径：

| 脱离方式 | 结果 |
| --- | --- |
| 直接 `setsid()` | DENIED errno=1 |
| Python `Popen(start_new_session=True)` | PermissionError errno=1（惯用写法被拒） |
| `bash -c 'nohup … & disown'` | contained，PGID 与根一致 → 进程组信号可回收 |
| 显式 `posix_spawn` + `POSIX_SPAWN_SETSID` | **ESCAPED**，`killpg` 后存活 |

即残留仅限**刻意**使用 posix_spawn 属性位的代码；直接 setsid、Python 惯用脱离、Shell 后台/disown 全部被拒或留在原进程组。且该逃逸后代在上一轮已记录仍受完整约束（文件与网络 errno 均为 1）——这是资源泄漏与「无法核实已停止」，不是隔离被突破。

检测手段两项被否决：`ps -Ewwo` 读不到同 UID 进程的环境变量（SIP），唯一标记法不可用；`lsof +D <workspace>` 对该存活后代返回 0 行，占用检测不可靠。可行的是任务存活期间轮询进程树累积后代集合（有竞态窗口），或引入专用 UID + 特权助手做 `pkill -U`（非特权无法换 UID，故需 root 守护进程，并牵动工作副本文件归属）。

**取舍结论（待拥有者裁定）**

继续原生、不换方案。Linux 的阻塞项是一次性管理员前置条件而非平台限制；macOS 的隔离本身成立，只有整单元停止存在窄残留。改用 Podman / Apple `container` / lima 在 macOS 仍落到虚拟机，恰好是要摆脱 Docker Desktop 的那部分成本，解决不了 macOS 的回收问题。

需要拥有者定夺的一处验收口径：第 4 条「脱离进程组的后代实际停止」在 Linux 可达（PID namespace 已实测），在 macOS 非特权下不可达。三选一：(a) 接受窄残留 + 轮询累积 + 无法核实即保留占用并报告（零管理员，推荐）；(b) 专用 UID + 特权助手，回收确定但需 root 安装与归属改造；(c) 虚拟机，与本工单目标冲突。

**风险与未验证项**

`sandbox-exec` 官方已弃用，长期可用性是战略风险，须在 note 中登记。本轮未测：node `detached:true`（测试脚本自身 cwd 问题导致未启动，非安全结论）、产品接入、审批单次消费、SubAgent/worktree/汇总、启动窗口与授权变化重建。bwrap 结果来自单台 Ubuntu 24.04；其他发行版与更严格策略环境需复跑。

**tx 系统改动与回滚**

`bubblewrap` 由脚本安装后 `apt-get purge`（原本未安装），临时 profile `apparmor_parser -R` 后删除；退出时核实 `which bwrap` 为空、profile 已移除、`kernel.apparmor_restrict_unprivileged_userns` 仍为 1、探针后代存活计数 0。未改 sysctl、未改在线个人 Agent、未动数据库。

### 2026-10-10：拥有者裁定与决策笔记

拥有者选择方案 (a)：接受 macOS 的窄回收残留，用任务存活期轮询累积后代集合做核实，无法核实即保留工作区目录占用并报告，不引入专用 UID 与特权助手。据此修订上方验收第 4 条，按平台分别判定整单元停止；原措辞「脱离进程组的后代实际停止」在 macOS 非特权条件下不可达，保留在本评论中以存历史。

决策与被否方案记在[原生执行沙箱](../../../.agents/notes/proposed/architecture/2026-10-10-native-execution-sandbox.md)（Status: proposed），同时在 [ADR 0004 笔记](../../../.agents/notes/implemented/architecture/2026-09-20-tool-worker-per-task-container.md)的「何时重访」加了指针。笔记记录的部署前置是 `/usr/bin/bwrap` 加授予 `userns` 的 AppArmor profile，缺任一项以 `execution_unavailable` 失败、不降级；预检须能区分「缺 bwrap」「缺 profile」「真实拒绝」，否则会重犯把环境缺项记成平台限制的错误。

第一阶段剩余前置：Linux 已在允许完整 namespace 的条件下跑完真实边界（见上一条评论）；macOS 的回收口径由本次裁定确定，不再等待完整回收机制。接入仍未开始，`src/` 与 `deploy/` 未改，默认后端未切换，验收项未勾选。

### 2026-10-11：停止核实修复作为原生接入前置

拥有者要求先将[工单 27](27-preserve-unverified-worker-stop.md)升为 ready-for-agent。方案 (a) 的占用保留与报告依赖共享生命周期保留停止未核实结果，故上方阻塞关系登记 27；先完成该修复再接入原生后端，第一阶段边界探针可独立继续。
