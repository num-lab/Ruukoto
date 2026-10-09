# 原生执行边界的第一阶段验证

这些脚本验证[工单 26](../../../../.agents/scratch/agent-direction/issues/26-native-sandbox.md)的原生候选。它们创建临时虚拟资料、服务和进程，不读取真实凭据，不调用模型，不接入 WorkerLauncher。两平台完整边界通过后才能实施产品替换；当前第一阶段未通过。

从仓库根运行：

```bash
# macOS：Seatbelt 文件、网络、凭据、IPC 与进程组停止候选
bash verification/foundation/scripts/native-isolation/macos-run-probes.sh

# macOS：独立验证 launchd 能否回收脱离进程组的后代
python3 verification/foundation/scripts/native-isolation/macos-launchd-probe.py

# 真实 Linux：bubblewrap 与宿主 namespace 能力
python3 verification/foundation/scripts/native-isolation/linux-native-probes.py
```

旧入口 `bash .agents/scratch/agent-direction/macos-sbx-probe.sh` 复用第一条命令，Linux 的独立 bwrap 路径、自检和部署前置说明见 [linux-README.md](linux-README.md)。报告默认写入 `verification/foundation/results/native-*.{json,md}`。退出码 0 表示脚本列出的被测项通过，1 表示真实边界失败，2 表示启动、能力、对照或判定不可验证；启动失败和缺失项不会计作隔离通过。复跑会覆盖相应报告，应与代码一起保存需要保留的证据。

macOS 文件规则使用规范化路径，并保留未规范化 `/tmp` 规则的反例对照。每次敏感操作先在未沙箱环境验证目标可访问，再检查沙箱程序自己的 started 标记与实际操作 errno。TCP、Unix socket、Mach 服务、共享内存与目标进程均由脚本创建。运行时只读根、被测策略、系统版本与具体结果写入 JSON，不能把某一策略失败扩大为所有 Seatbelt 策略不可能。

停止验证先证明后代实际持续写心跳，再停止候选单元，随后观察心跳是否冻结。主 PID 消失、job 消失或 kill 成功都不单独构成通过证据。清理只能处理本次临时任务，清理不能核实时保留现场。

2026-10-08 的 macOS 27.0 / Darwin 27.0.0 / arm64 实测确认：规范化后的文件拒绝生效；`posix_spawn` 的 setpgroup/setsid 属性仍可绕过 `SYS_setpgid/SYS_setsid` 拒绝规则，让后代脱离原进程组；停止原组后心跳继续增长。`kqueue NOTE_TRACK` 为 `ENOTSUP`，临时 launchd job 的 bootout 也未停止逃离的后代。具体证据见 [Seatbelt 报告](../../results/native-macos-report.md)与 [launchd 报告](../../results/native-macos-launchd.md)。

Linux tx 的未沙箱对照有效，但在 `/tmp` 解包的 Ubuntu bubblewrap 0.9.0 无法建立所需 namespace，未启动实际边界探针，整体退出 2。未修改系统策略，尚不能确定安装到正式路径后的结果；[Linux 报告](../../results/native-linux-report.md)将缺项列为 unavailable。

这些记录不覆盖产品的 read/edit/write/bash、审批单次消费、SubAgent 委派/worktree/汇总、授权变化重建与后台恢复。工具链版本命令通过也不能替代实际修改与检查。当前产品默认仍为 container；原生候选的失败不授权 local 或后台账户执行。

macOS 本轮还没有验证 SysV IPC、生命周期启动窗口、后台父进程异常和模式或授予变化。报告的 missing=0 只表示脚本列举的被测项都运行过，不表示工单要求已经全部覆盖。最终 Seatbelt 候选为 56 项、53 通过、3 失败；失败足以阻止切换默认后端，缺项仍需后续补验。
