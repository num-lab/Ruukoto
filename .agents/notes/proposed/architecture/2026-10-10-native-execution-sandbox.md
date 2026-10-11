# Agent Note: ruukoto-code 的受限执行改用原生沙箱，macOS 接受窄回收残留

Status: proposed

## 问题

ruukoto-code 的受限执行当前是按任务建立的 Docker 容器（见[工具工作进程与按任务容器](../../implemented/architecture/2026-09-20-tool-worker-per-task-container.md)）。代价集中在 macOS：受限边界靠 Docker Desktop 的 Linux VM 提供，开发机为此常驻一台虚拟机，还引入与原生 Linux 不同的挂载权限和 inode 语义，使 macOS 上的目录身份复核只能按路径进行。[工单 26](../../../../.scratch/agent-direction/issues/26-native-sandbox.md) 要求换成宿主原生沙箱，并把两平台的完整边界实测列为第一阶段。

第一阶段 2026-10-08 未通过，卡在两个前置条件：macOS 上脱离进程组的后代回收不了；Linux 上 bubblewrap 的 35 项边界全部不可验证。这两条的性质在 2026-10-10 的复核中被区分开，结论不同：

- **Linux 的阻塞是环境缺项，不是平台限制。** 旧探针把 bwrap 解包到 `/tmp` 运行，而 Ubuntu 的非特权 userns 限制按可执行文件路径匹配 AppArmor profile，`/tmp` 下的副本拿不到 `userns` 权限。这与[工单 03](../../../../.scratch/agent-direction/issues/03-execution-boundary-proof.md) 把 `/tmp` 当作 `/private/tmp` 的那次否决属同一类错误：环境搭建缺项被记成了能力缺失。装到 `/usr/bin/bwrap` 并加载 profile 后，工单要求的边界全部通过，包括脱离进程组的后代回收。
- **macOS 没有非特权可用的不可逃逸进程成员集合。** Linux 的回收确定性来自内核维护的 PID namespace 与 cgroup 成员关系，进程无法自行退出；macOS 的进程组和会话可以被 `posix_spawn` 的属性位换掉，`kqueue NOTE_TRACK` 返回 ENOTSUP，launchd `bootout` 不覆盖已换会话的后代。唯一确定的成员集合是 UID，而非特权进程换不了 UID，要用它就得引入 root 守护进程。

失败条件不变：原生能力缺失或边界无法核实时必须明确失败，不能静默降级到 Docker、`local` 或后台账户执行。

## 方案

产品接入以[停止未核实结果保留](../bug-fix/2026-10-11-preserve-unverified-worker-stop.md)落地为前置：原生启动器提供平台核实结果，共享生命周期负责让启动失败、临时 worker 和任务收尾保留该结果。平台边界探针可先独立进行。

**Linux 用 bubblewrap，把 AppArmor profile 列为部署前置。** 受限工作进程经 `bwrap --unshare-all --die-with-parent` 启动，宿主工具链以只读 bind 提供，不开放拥有者主目录。`--unshare-all` 同时给出文件、网络、PID 与 IPC 边界，`--die-with-parent` 加 PID namespace 拆除承担整个执行单元的回收。`systemd-run --user --scope` 的 `cgroup.kill` 作为第二道回收，覆盖 bwrap 自身异常退出后的残留。

部署前置两项，缺一即 `execution_unavailable`，不降级：`/usr/bin/bwrap` 存在，且加载了授予 `userns` 的 profile。包内不含该 profile，需单独安装：

```
abi <abi/4.0>,
include <tunables/global>
profile ruukoto-bwrap /usr/bin/bwrap flags=(unconfined) {
  userns,
}
```

`/dev/null` 必须单独给读写：缺它 `git` 直接以 `could not open '/dev/null'` 失败。

**macOS 用 Seatbelt，接受窄回收残留并如实报告。** 受限工作进程经 `sandbox-exec` 启动，沿用现有 profile（含 `(deny syscall-unix (syscall-number SYS_setsid SYS_setpgid))`）。所有文件规则必须先 `realpath` 规范化再写入 profile——`/tmp`、`/var/folders` 都是符号链接，未规范化的规则不匹配真实目标且不报错，这是前两次误判的共同根因。

停止先发进程组信号，再核实。核实手段的选择面已被实测收窄：`ps -Ewwo` 读不到同 UID 进程的环境变量（SIP），唯一标记法不可用；`lsof +D <workspace>` 对存活后代返回 0 行，占用检测不可靠。因此核实靠任务存活期间轮询进程树、累积后代集合，停止时对集合内仍存活者补发信号。集合内仍有存活、或轮询窗口内可能漏记时，保留工作区目录占用并报告，复用 `task.tool_process_unreaped` 与 `mode_switch_unverified`，不自动重放效果未知的操作。

**正式入口默认 native，显式旧值报错。** CLI 参数与 `RUUKOTO_EXECUTION_BACKEND` 中的 `container`、`local` 明确报错并给出改为 native 或移除覆盖的指引，不自动转换。测试继续在库层注入 `local`。完全访问保留专用执行身份与控制面分离，本决定不改它。

### 已实测的边界

Linux，tx 实跑（Ubuntu 24.04.4、Linux 6.8.0-117-generic、x86_64、UID 1003，`kernel.apparmor_restrict_unprivileged_userns=1` 全程未改）：

| 探针 | 结果 |
| --- | --- |
| 宿主敏感文件读、`$HOME` 列目录 | DENIED:ENOENT（未 bind 即不存在） |
| 回环 TCP connect | DENIED:ECONNREFUSED |
| UDP 外发 | DENIED:ENETUNREACH |
| abstract Unix socket | DENIED:ECONNREFUSED |
| SysV IPC | DENIED:ENOENT |
| 可见 PID 数 | 2（宿主同时 156） |
| node / git / python3 | 全部可用，仅靠只读 bind |
| 双重 fork + setsid + 忽略 TERM 的后代 | 心跳存活期增长 18→23，`kill -9` bwrap 后冻结、存活 0 |

macOS，本机实跑（macOS 27.0、Darwin 27.0.0、arm64），各条脱离路径：

| 方式 | 结果 |
| --- | --- |
| 直接 `setsid()` | DENIED errno=1 |
| `Popen(start_new_session=True)` | PermissionError errno=1 |
| `bash -c 'nohup … & disown'` | contained，PGID 与根一致，进程组信号可回收 |
| 显式 `posix_spawn` + `POSIX_SPAWN_SETSID` | ESCAPED，`killpg` 后存活 |

即残留仅限刻意使用 `posix_spawn` 属性位的代码；该逃逸后代的文件与网络拒绝仍生效（2026-10-08 报告记录 errno 均为 1），属资源泄漏与无法核实停止，不是隔离被突破。

## 备选方案

- **Linux 用 Landlock 取代 bubblewrap** — 非特权可用，不需要 namespace，因此完全绕开 AppArmor 的 userns 限制，零管理员前置；实测 ABI 4 可用，工作区读写放行、`$HOME` 列目录 EACCES、回环 TCP connect EACCES，且 `setsid` 脱离后代仍受同一约束、无法卸除。不选，是因为缺口过不了工单的网络与 IPC 要求：UDP 外发放行、abstract Unix socket 可达、宿主 PID 可见、SysV IPC 不受限，而「默认无网络」要覆盖任意 Shell 及后代。控制面用文件路径 socket（`packages/control/src/connect.ts` 的 `control.sock`），Landlock 能按路径拒绝，但这只补上一处，补不齐 UDP。保留为装不了 profile 时的降级候选，启用须明记缺口。
- **macOS 用专用 UID 加特权助手回收** — UID 是 macOS 上唯一不可逃逸的成员集合，非特权进程换不了 UID，`pkill -U` 能确定地停掉整个执行单元，包括 `posix_spawn` 逃逸的后代，回收不再有残留和竞态。不选，是因为它要引入 root 守护进程或 setuid 助手来换 UID，并连带改造工作副本的文件归属，等于为一条窄残留在受限路径上新增一个特权入口；拥有者 2026-10-10 选择接受残留。前提变化时这是首选的加固方向。
- **把 `kernel.apparmor_restrict_unprivileged_userns` 设为 0** — 一条 sysctl 就能让 bwrap 在任何路径下工作，不必维护 profile，开发机上最省事。不选，是因为它对整机解除非特权 userns 的加固，影响范围远超 ruukoto；按可执行文件授予 profile 是 Ubuntu 自己的做法（`/etc/apparmor.d/` 已有百余篇同类 profile），范围只限 `/usr/bin/bwrap`。
- **把 `/usr/bin/bwrap` 设为 setuid root** — bubblewrap 的 `README.Debian` 给出的另一条路，在不允许非特权 userns 的内核上也能用。不选，是因为包文档同时说明该配置下 bubblewrap 与 Flatpak 的部分安全特性会失效，等于用更大的特权面换取兼容性。
- **用 `systemd-run --user` 的 `IPAddressDeny=any` 作网络边界** — 不需要 namespace，和 cgroup 回收同一机制，配置只有一行。不选，是因为实测在非特权用户单元下未生效：加了该参数仍能连通 1.1.1.1。
- **换 Podman、Apple `container` 或 lima** — 都比 Docker Desktop 轻，Podman 还免去常驻守护进程，且沿用现有容器启动器的语义，接入成本最低。不选，是因为在 macOS 上它们仍落到虚拟机，恰好是本决定要摆脱的那部分成本；Apple `container` 每个容器一台轻量 VM，更换运行时也解决不了 macOS 的后代回收问题，还违反工单「不引入额外跨平台 sandbox runtime」的范围。
- **保留 Docker 容器不动** — 边界已在两个平台验证并上线，`--network none`、`--cap-drop ALL`、PID 与 IPC 隔离一次性满足全部要求，回收经 `docker inspect` 核实确定。不选，是因为 macOS 的 VM 成本和语义差异是本决定的动机本身；Linux 侧的容器实现继续服务个人 Agent 的部署，不受本决定影响。

## 验收标准

沿用[工单 26](../../../../.scratch/agent-direction/issues/26-native-sandbox.md) 的验收项，其中整单元停止一项按平台分别判定：

- Linux：脱离进程组的后代实际停止，以有效运行对照加心跳证明，已实测通过。
- macOS：进程组内后代实际停止；轮询累积集合内的存活后代实际停止；集合外残留不得静默忽略，必须保留目录占用并报告。不要求 `posix_spawn` 属性位逃逸的后代被停止。

其余按工单：无 Docker 条件下完成真实 read/edit/write/bash 与代码检查，主任务、SubAgent、worktree 创建与改动汇总全部走原生边界；未授权宿主文件与控制面材料不可读写，只读授予与共享 Git 目录不可写，任意 Shell 及后代默认无网络；越界操作沿用审批与单次消费；启动取消、模式或授予范围变化时完成回收与重建；默认 native 且显式 container/local 被拒并给迁移指引；两平台均通过前不得宣称替换完成。

## 风险

- **`sandbox-exec` 已被 Apple 标记弃用。** 它是 macOS 受限边界的唯一依赖，移除或行为变更会直接断掉该平台的受限执行。没有同等的公开替代；真的失效时退路是专用 UID 加特权助手，或该平台暂不提供受限执行。
- **macOS 残留会泄漏算力并可能在停止后改写工作区。** 逃逸后代读不到宿主文件、连不上网络，但仍可占用 CPU 与内存，且工作区在 profile 中可写，它重新打开工作区内路径仍能写入。这是保留目录占用并报告、而非直接释放的原因。
- **轮询累积有竞态窗口。** 一个进程在单个轮询间隔内完成创建、换会话并让父进程退出，就不会进入集合。缩短间隔只能压缩窗口，消不掉；刻意计时的载荷可以绕过。
- **bwrap 证据来自单台 Ubuntu 24.04。** 其他发行版、更严格的策略环境、以及 AppArmor 之外的 LSM 配置都需复跑；profile 的 `abi <abi/4.0>` 在旧 AppArmor 上需要调整。
- **部署前置从「装 Docker」换成「装 bwrap 并加载 profile」，并没有消失。** 收益是去掉 macOS 的常驻 VM 与两处语义差异，代价是 Linux 侧多一条需要 root 的一次性安装步骤，且预检必须能区分「缺 bwrap」「缺 profile」「真实拒绝」三种情况，否则下一次又会把环境缺项记成平台限制。
