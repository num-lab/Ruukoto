# Linux 原生边界验证

> **2026-10-10 更正**：本报告「35 项全部 unavailable」的根因是 bwrap 被解包到 `/tmp` 运行，而 Ubuntu 的非特权 userns 限制按可执行文件路径匹配 AppArmor profile，`/tmp` 下的副本拿不到 `userns` 权限。**不能据本报告认为 Ubuntu 24.04 不支持 bubblewrap。** 同机复核显示：装到 `/usr/bin/bwrap` 并加载授予 `userns` 的 profile 后，文件、网络（含 UDP）、abstract Unix socket、SysV IPC、PID 可见性与脱离进程组的后代回收全部通过。下方原始记录保留不改，更正依据见 [工单 26](../../../.scratch/agent-direction/issues/26-native-sandbox.md) 的 2026-10-10 评论与[原生执行沙箱笔记](../../../.agents/notes/proposed/architecture/2026-10-10-native-execution-sandbox.md)。

环境：Linux-6.8.0-117-generic-x86_64-with-glibc2.39，UID=1003，GID=1003
时间：2026-10-08T12:58:15.415824+00:00
判定退出码：2（0=通过，1=失败，2=不可验证）

真实边界：0 项 pass、0 项 fail、35 项 unavailable；对照成功不计为边界通过。

| 探针 | 结果 | 说明 |
| --- | --- | --- |
| controls.fixtures-and-services | pass | 虚拟敏感文件可读写，符号链接/父路径/proc 别名可读；TCP、文件及 abstract Unix socket、FD、SysV/POSIX IPC 与宿主 PID 对照有效 |
| controls.detached-heartbeat-cleanup | pass | 初始化 ready→release 后心跳实际启动；双重 fork + setsid + 忽略 TERM 的未沙箱后代在主进程 SIGKILL 后继续写入；宿主按唯一 argv 核实并回收后心跳冻结 |
| workspace.read | unavailable | RuntimeError: bwrap 探针未完整执行（退出 1）：bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted |
| workspace.write | unavailable | RuntimeError: bwrap 探针未完整执行（退出 1）：bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted |
| workspace.identity | unavailable | RuntimeError: bwrap 探针未完整执行（退出 1）：bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted |
| grant.read | unavailable | RuntimeError: bwrap 探针未完整执行（退出 1）：bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted |
| grant.read-only | unavailable | RuntimeError: bwrap 探针未完整执行（退出 1）：bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted |
| grant.read-write | unavailable | RuntimeError: bwrap 探针未完整执行（退出 1）：bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted |
| subagent.read | unavailable | RuntimeError: bwrap 探针未完整执行（退出 1）：bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted |
| subagent.identity | unavailable | RuntimeError: bwrap 探针未完整执行（退出 1）：bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted |
| subagent.read-only | unavailable | RuntimeError: bwrap 探针未完整执行（退出 1）：bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted |
| subagent.ungranted-sibling | unavailable | RuntimeError: bwrap 探针未完整执行（退出 1）：bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted |
| git.shared-read | unavailable | RuntimeError: bwrap 探针未完整执行（退出 1）：bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted |
| git.shared-read-only | unavailable | RuntimeError: bwrap 探针未完整执行（退出 1）：bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted |
| host.secret-read | unavailable | RuntimeError: bwrap 探针未完整执行（退出 1）：bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted |
| host.secret-write | unavailable | RuntimeError: bwrap 探针未完整执行（退出 1）：bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted |
| host.control-read | unavailable | RuntimeError: bwrap 探针未完整执行（退出 1）：bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted |
| host.symlink | unavailable | RuntimeError: bwrap 探针未完整执行（退出 1）：bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted |
| host.parent-alias | unavailable | RuntimeError: bwrap 探针未完整执行（退出 1）：bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted |
| host.proc-root-alias | unavailable | RuntimeError: bwrap 探针未完整执行（退出 1）：bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted |
| credentials.environment | unavailable | RuntimeError: bwrap 探针未完整执行（退出 1）：bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted |
| credentials.inherited-fd | unavailable | RuntimeError: bwrap 探针未完整执行（退出 1）：bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted |
| control.loopback | unavailable | RuntimeError: bwrap 探针未完整执行（退出 1）：bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted |
| network.host-interface | unavailable | RuntimeError: bwrap 探针未完整执行（退出 1）：bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted |
| control.unix-private | unavailable | RuntimeError: bwrap 探针未完整执行（退出 1）：bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted |
| control.unix-workspace | unavailable | RuntimeError: bwrap 探针未完整执行（退出 1）：bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted |
| control.unix-abstract | unavailable | RuntimeError: bwrap 探针未完整执行（退出 1）：bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted |
| control.sysv-ipc | unavailable | RuntimeError: bwrap 探针未完整执行（退出 1）：bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted |
| control.posix-shm | unavailable | RuntimeError: bwrap 探针未完整执行（退出 1）：bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted |
| control.host-pid | unavailable | RuntimeError: bwrap 探针未完整执行（退出 1）：bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted |
| subprocess.secret-read | unavailable | RuntimeError: bwrap 探针未完整执行（退出 1）：bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted |
| subprocess.loopback | unavailable | RuntimeError: bwrap 探针未完整执行（退出 1）：bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted |
| toolchain.node | unavailable | RuntimeError: bwrap 探针未完整执行（退出 1）：bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted |
| toolchain.git | unavailable | RuntimeError: bwrap 探针未完整执行（退出 1）：bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted |
| stop.detached-descendant | unavailable | RuntimeError: bwrap 探针未完整执行（退出 1）：bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted |
| stop.launch-window | unavailable | RuntimeError: bwrap 探针未完整执行（退出 1）：bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted |
| stop.parent-crash | unavailable | RuntimeError: bwrap 探针未完整执行（退出 1）：bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted |

验证边界：
- 尚未接入产品；未验证 WorkerLauncher、审批消费、授权变化重建或占用恢复。
- 工作区中的宿主 Unix socket 必须不可达；纯文件 bind 与网络 namespace 不足时此项将失败。
- 启动窗口使用 sandbox Python 的 ready 握手和延迟初始化；不代表完整产品启动竞态已通过。

启动前置诊断：

| 尝试 | 退出码 | 实际错误 |
| --- | --- | --- |
| bwrap --unshare-user | 1 | bwrap: setting up uid map: Permission denied |
| bwrap --unshare-pid | 1 | bwrap: setting up uid map: Permission denied |
| bwrap --unshare-ipc | 1 | bwrap: setting up uid map: Permission denied |
| bwrap --unshare-net | 1 | bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted |
| unshare_uid_map | 1 | unshare: write failed /proc/self/uid_map: Operation not permitted |
| user_systemd_launch | 1 | bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted |

系统策略的记录值见 JSON environment；本脚本没有改 sysctl、AppArmor 或全局安装包。
