# Linux 原生边界探针

`linux-native-probes.py` 是工单 26 的第一阶段真实验证工具。它创建临时虚拟资料、宿主 TCP/Unix socket、SysV/POSIX IPC 和进程，不读取真实凭据，也不接入产品执行后端。

在真实 Linux 上运行：

```bash
python3 verification/foundation/scripts/native-isolation/linux-native-probes.py
```

指定独立下载解包的 bwrap 和报告目录：

```bash
python3 verification/foundation/scripts/native-isolation/linux-native-probes.py \
  --bwrap /tmp/probe/extracted/usr/bin/bwrap \
  --output-dir /tmp/probe/results
```

脚本不会安装 bwrap 或调整系统策略。退出码 0 表示本脚本列出的真实边界通过，1 表示实际边界操作与要求不符，2 表示能力、对照或探针缺失而不可验证。未沙箱对照必须先证明敏感目标存在且可访问；bwrap 未打印 `started` 时，全部边界项记为 `unavailable`。两层 Shell 的子探针也必须打印自己的启动标记和操作 errno，不能把命令不存在或 Python 未启动算作隔离成功。

候选只读开放宿主 `/usr` 及运行所需 `/bin`、`/sbin`、`/lib`、`/lib64`，不开放整个宿主或拥有者主目录。工作区可写，额外只读/读写授予、SubAgent 单文件读取范围及共享 Git 目录分别挂载。其余目标包括符号链接、父路径和 `/proc` 路径别名；工作区和 SubAgent 资料的 dev/ino 与宿主原身份比较。固定虚拟凭据变量和一个文件描述符用于检查环境及 FD 泄漏。

网络探针只连接本脚本创建的服务，覆盖宿主回环地址、宿主网卡地址、私有路径/工作区路径 Unix socket 和 abstract Unix socket。宿主服务的 Unix socket 即使位于可写工作区，也不能成为取得宿主控制面身份的通道；这个探针不会把该路径已挂载当作允许通信。SysV/POSIX IPC 及宿主 PID 也使用独立虚拟资源。

停止探针用双重 fork、setsid 和忽略 TERM 的后代持续写心跳，同时检查 SIGKILL、启动窗口和父进程异常。启动窗口要求同次 sandbox Python 完成 ready 握手后等待初始化；缺握手时不能把零字节心跳算作通过。未沙箱对照先证明 ready→release 能实际启动心跳，并证明主进程退出后后代仍活动。清理时以本次唯一 argv 路径、宿主 UID、进程启动时刻识别测试进程，再用标准库 pidfd 固定实际进程后送 SIGKILL，终止后核实心跳冻结；缺 pidfd 能力时不启动后代。无法核实则保留临时资料，不删除文件掩盖残留；控制器或清理异常即使发生在全部边界行输出之后，也使整体退出 2。

2026-10-08 在 `ssh tx` 的 Ubuntu 24.04.4 LTS / Linux 6.8.0-117-generic / x86_64 / UID 1003 上，系统未安装 bwrap，仅在 `/tmp` 解包官方 Ubuntu bubblewrap 0.9.0-1ubuntu0.3。完整 bwrap 候选在进入探针前报 `loopback: Failed RTM_NEWADDR: Operation not permitted`。拆分 user/pid/ipc 均在 uid_map 阶段报 `Permission denied`，net 和完整隔离在 loopback 阶段报 EPERM；临时 user-systemd service 的同一命令也失败。`unshare -Ur true` 实际失败，AppArmor enabled 为 Y，`apparmor_restrict_unprivileged_userns=1`，`unprivileged_userns_clone=1`。这些是能力拒绝证据；本次未修改策略，尚不能确认仅安装正式路径的 bwrap 能否改变结果。

实际报告在 `verification/foundation/results/native-linux-report.json` 和 `.md`：2 个对照成功，35 个真实边界全部 `unavailable`，整体退出 2。能力缺失时不能回退到共享网络、local、Docker 或后台账户执行，也不能据此切换产品默认后端。须在满足管理员既有策略、能运行完整 namespace 的 Linux 环境重新跑本脚本，并继续完成 WorkerLauncher、真实工具调用、审批消费、授权变化重建和占用恢复的产品验证。

判定逻辑可单独自检：

```bash
python3 verification/foundation/scripts/native-isolation/linux-native-probes.py --self-check
```
