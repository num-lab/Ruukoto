# Linux 原生边界探针

`linux-native-probes.py` 是工单 26 的第一阶段真实验证工具。它创建临时虚拟资料、宿主 TCP/Unix socket、SysV/POSIX IPC 和进程，不读取真实凭据，也不接入产品执行后端。

在真实 Linux 上运行：

```bash
python3 verification/foundation/scripts/native-isolation/linux-native-probes.py
```

指定正式 bwrap 和隔离报告目录：

```bash
python3 verification/foundation/scripts/native-isolation/linux-native-probes.py \
  --bwrap /usr/bin/bwrap \
  --output-dir /tmp/probe/results
```

脚本不会安装 bwrap 或调整系统策略。管理员安装与移除步骤见[原生沙箱前置](../../../../deploy/native/README.md)。退出码 0 表示本脚本列出的真实边界通过，1 表示实际边界操作与要求不符，2 表示能力、对照或探针缺失而不可验证。未沙箱对照必须先证明敏感目标存在且可访问；bwrap 未打印 `started` 时，其边界项记为 `unavailable`。独立的 user scope 回收另行记录。两层 Shell 的子探针也必须打印自己的启动标记和操作 errno，不能把命令不存在或 Python 未启动算作隔离成功。

候选只读开放宿主 `/usr` 及运行所需 `/bin`、`/sbin`、`/lib`、`/lib64`，不开放整个宿主或拥有者主目录。`cc` 的 `/etc/alternatives/cc` 别名仅以规范化 symlink 指向已开放的编译器，避免文件 bind 改变 GCC 的自身路径而导致找不到 `cc1`。工作区可写，额外只读/读写授予、SubAgent 单文件读取范围及共享 Git 目录分别挂载。其余目标包括符号链接、父路径和 `/proc` 路径别名；工作区和 SubAgent 资料的 dev/ino 与宿主原身份比较。固定虚拟凭据变量和 FD 100 用于检查环境及 FD 泄漏；父进程仅继承 seccomp 数据描述符，不能依赖 bwrap 自动清除已传入的 FD。

网络探针只连接本脚本创建的服务，覆盖宿主回环地址、宿主网卡地址、UDP、私有路径/工作区路径 Unix socket 和 abstract Unix socket。另有 socketpair datagram 的 `sendto`/`sendmsg` 宿主成功对照与沙箱拒绝。候选通过 `--seccomp FD` 拒绝 `socket`、`connect`、`sendto`、`sendmsg`、`sendmmsg` 与 `io_uring_setup`，保留 Node 子进程管道需要的 `socketpair`；架构不符及 x32 syscall 被拒绝，未知宿主架构不启动。构造支持 x86_64/aarch64，真实 OS 证据来自 x86_64；aarch64 只有过滤器判定自检。完整 user/mnt/net/pid/ipc/uts/cgroup namespace 标识逐一与宿主比较。SysV/POSIX IPC 及宿主 PID 使用独立虚拟资源。

停止探针用双重 fork、setsid 和忽略 TERM 的后代持续写心跳，同时检查 SIGKILL、启动窗口和父进程异常。启动窗口要求同次 sandbox Python 完成 ready 握手后等待初始化；缺握手时不能把零字节心跳算作通过。未沙箱对照先证明 ready→release 能实际启动心跳，并证明主进程退出后后代仍活动。清理时以本次唯一 argv 路径、宿主 UID、进程启动时刻识别测试进程，再用标准库 pidfd 固定实际进程后送 SIGKILL，终止后核实心跳冻结；缺 pidfd 能力时不启动后代。无法核实则保留临时资料，不删除文件掩盖残留；控制器或清理异常即使发生在全部边界行输出之后，也使整体退出 2。

模式变化的控制器先核实旧单元停止，再启动等价替代沙箱；授予收窄还核实新沙箱无法读写已移除的原授予。第二道回收独立使用 `systemd-run --user --scope --property Delegate=yes`，按执行进程自报且与随机 unit 名匹配的 cgroup 路径写 `cgroup.kill`。停止前核实脱离后代仍在该 scope 内持续写入；停止后核实心跳冻结、同次探针进程为空、`populated 0` 或 scope cgroup 已清空移除。这些控制器证据不代替产品的 WorkerLauncher、审批消费与占用恢复测试。

2026-10-11 在 `ssh tx` 的 Ubuntu 24.04.4 LTS / Linux 6.8.0-117-generic / x86_64 / UID 1003 上，拥有者授权安装正式 bubblewrap 0.9.0-1ubuntu0.3 并加载 `ruukoto-bwrap` profile；`apparmor_restrict_unprivileged_userns=1` 保持不变。实际沙箱打印 profile 身份 `ruukoto-bwrap (unconfined)`。最新[报告](../../results/native-linux-current-report.md)与[JSON](../../results/native-linux-current-report.json)记录 52 项真实边界及 2 个宿主对照全部通过，含 Node 子进程、C 编译执行和两道整单元停止；报告中的 SHA-256 对应本次脚本。

旧 2026-10-08 的[报告](../../results/native-linux-report.md)和[JSON](../../results/native-linux-report.json)保留当次 35 项 `unavailable`：当时 bwrap 仅解包在 `/tmp`，不匹配正式路径的 AppArmor userns profile。它不能说明 Ubuntu 不支持 bubblewrap。另保留本轮未加 seccomp 且显式继承虚拟 FD 的[对照报告](../../results/native-linux-namespace-only-report.md)，其 4 项失败分别是 pathname Unix socket、socketpair sendto/sendmsg 与继承 FD；没有把这些真实失败改记为不可验证或降低验收要求。

同脚本可复跑较弱策略，仅作失败对照，不能用于产品执行：

```bash
python3 verification/foundation/scripts/native-isolation/linux-native-probes.py \
  --namespace-only --inherit-fixture-fd --output-dir /tmp/ruukoto-probe-baseline
```

当前策略生成 `native-linux-current-report.json` / `.md`，较弱对照生成 `native-linux-namespace-only-report.json` / `.md`，不会改写旧报告。原生前置缺失时不能回退到共享网络、local、Docker 或后台账户执行；边界探针通过后还需完成产品接入验收。

判定逻辑可单独自检：

```bash
python3 verification/foundation/scripts/native-isolation/linux-native-probes.py --self-check
```
