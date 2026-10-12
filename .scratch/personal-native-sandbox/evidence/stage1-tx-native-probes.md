# Linux 原生边界验证

环境：Linux-6.8.0-117-generic-x86_64-with-glibc2.39，UID=996，GID=985
时间：2026-10-12T03:00:22.125635+00:00
判定退出码：0（0=通过，1=失败，2=不可验证）

真实边界：52 项 pass、0 项 fail、0 项 unavailable；对照成功不计为边界通过。

| 探针 | 结果 | 说明 |
| --- | --- | --- |
| controls.fixtures-and-services | pass | 虚拟敏感文件可读写，符号链接/父路径/proc 别名可读；TCP/UDP、文件及 abstract Unix socket、socketpair datagram、FD、SysV/POSIX IPC、宿主 PID 与 C 编译执行对照有效 |
| controls.detached-heartbeat-cleanup | pass | 初始化 ready→release 后心跳实际启动；双重 fork + setsid + 忽略 TERM 的未沙箱后代在主进程 SIGKILL 后继续写入；宿主按唯一 argv 核实并回收后心跳冻结 |
| stop.user-scope-cgroup | pass | started=true，cgroup.kill 后心跳 40→40，populated 0（scope 已移除），残留 PID=[] |
| namespace.user | pass | started=true，宿主 user:[4026531837]，沙箱 user:[4026532299] |
| namespace.mnt | pass | started=true，宿主 mnt:[4026531841]，沙箱 mnt:[4026532234] |
| namespace.net | pass | started=true，宿主 net:[4026531840]，沙箱 net:[4026532239] |
| namespace.pid | pass | started=true，宿主 pid:[4026531836]，沙箱 pid:[4026532237] |
| namespace.ipc | pass | started=true，宿主 ipc:[4026531839]，沙箱 ipc:[4026532236] |
| namespace.uts | pass | started=true，宿主 uts:[4026531838]，沙箱 uts:[4026532235] |
| namespace.cgroup | pass | started=true，宿主 cgroup:[4026531835]，沙箱 cgroup:[4026532238] |
| workspace.identity | pass | dev=64770, ino=407299 |
| subagent.identity | pass | dev=64770, ino=407309 |
| workspace.read | pass | started=true，操作成功，errno=None |
| workspace.write | pass | started=true，操作成功，errno=None |
| grant.read | pass | started=true，操作成功，errno=None |
| grant.read-only | pass | started=true，操作被拒绝，errno=30 |
| grant.read-write | pass | started=true，操作成功，errno=None |
| subagent.read | pass | started=true，操作成功，errno=None |
| subagent.read-only | pass | started=true，操作被拒绝，errno=30 |
| subagent.ungranted-sibling | pass | started=true，操作被拒绝，errno=2 |
| git.shared-read | pass | started=true，操作成功，errno=None |
| git.shared-read-only | pass | started=true，操作被拒绝，errno=30 |
| host.secret-read | pass | started=true，操作被拒绝，errno=2 |
| host.secret-write | pass | started=true，操作被拒绝，errno=2 |
| host.control-read | pass | started=true，操作被拒绝，errno=2 |
| host.symlink | pass | started=true，操作被拒绝，errno=2 |
| host.parent-alias | pass | started=true，操作被拒绝，errno=2 |
| host.proc-root-alias | pass | started=true，操作被拒绝，errno=2 |
| credentials.environment | pass | 仅检查专为本次运行设置的虚拟凭据变量 |
| credentials.inherited-fd | pass | started=true，操作被拒绝，errno=9 |
| control.loopback | pass | started=true，操作被拒绝，errno=1 |
| network.host-interface | pass | started=true，操作被拒绝，errno=1 |
| network.udp | pass | started=true，操作被拒绝，errno=1 |
| control.unix-private | pass | started=true，操作被拒绝，errno=1 |
| control.unix-workspace | pass | started=true，操作被拒绝，errno=1 |
| control.socketpair-sendto | pass | started=true，操作被拒绝，errno=1 |
| control.socketpair-sendmsg | pass | started=true，操作被拒绝，errno=1 |
| control.unix-abstract | pass | started=true，操作被拒绝，errno=1 |
| control.sysv-ipc | pass | started=true，操作被拒绝，errno=22 |
| control.posix-shm | pass | started=true，操作被拒绝，errno=2 |
| control.host-pid | pass | started=true，操作被拒绝，errno=3 |
| subprocess.secret-read | pass | 子探针已启动，errno=2，退出 0 |
| subprocess.loopback | pass | 子探针已启动，errno=1，退出 0 |
| toolchain.node | pass | node-ok |
| toolchain.node-child | pass | child-ok |
| toolchain.git | pass | git version 2.43.0 |
| toolchain.cc | pass | started=true，C 编译退出 0，执行退出 0， |
| stop.detached-descendant | pass | started=true，SIGKILL 后心跳字节数 12→12，残留本次探针 PID=[] |
| stop.launch-window | pass | started=true，SIGKILL 后心跳字节数 0→0，残留本次探针 PID=[] |
| stop.parent-crash | pass | started=true，SIGKILL 后心跳字节数 12→12，残留本次探针 PID=[] |
| stop.mode-change | pass | started=true，SIGKILL 后心跳字节数 12→12，残留本次探针 PID=[] |
| mode.rebuild | pass | started=true，旧单元已停止，替代沙箱读/写：[{'denied': False, 'errno': None}, {'denied': False, 'errno': None}] |
| stop.grant-change | pass | started=true，SIGKILL 后心跳字节数 12→12，残留本次探针 PID=[] |
| grant.rebuild-narrowed | pass | started=true，旧单元已停止，替代沙箱读/写：[{'denied': True, 'errno': 2}, {'denied': True, 'errno': 2}] |

验证边界：
- 尚未接入产品；未验证 WorkerLauncher、审批消费或任务占用恢复。模式/授予变化仅验证控制器先停旧单元、再启动替代沙箱。
- 工作区中的宿主 Unix socket 必须不可达；纯文件 bind 与网络 namespace 不足时此项将失败。
- 启动窗口使用 sandbox Python 的 ready 握手和延迟初始化；不代表完整产品启动竞态已通过。

运行前置：

- 正式 `/usr/bin/bwrap` 可用：True；实际选择 `/usr/bin/bwrap`。
- user systemd：running；cgroup v2：True。
- AppArmor profile 文件与实际启动输出保存在 JSON；进程必须实际完成完整 namespace 的 started 握手。
- 策略：{"seccomp": true, "denied_syscalls": ["socket", "connect", "sendto", "sendmsg", "sendmmsg", "io_uring_setup"], "inherited_fixture_fd": false, "passed_fds": [9]}。
- 本次探针 SHA-256：`fddba1b83fe78b9d0b50595625af495eb5435816cb26b075112e58ab58ae7c86`。
