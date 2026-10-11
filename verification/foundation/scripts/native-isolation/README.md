# 原生执行边界的第一阶段验证

这些脚本验证[工单 26](../../../../.scratch/agent-direction/issues/26-native-sandbox.md)的原生候选。它们创建临时虚拟资料、服务和进程，不读取真实凭据，不调用模型，不接入 WorkerLauncher。两平台真实边界证据与产品接入验收分别记录，探针通过不能代替实际 worker、SubAgent 或审批验收。

从仓库根运行：

```bash
# macOS：Seatbelt 文件、网络、凭据、IPC 与进程树累积停止
bash verification/foundation/scripts/native-isolation/macos-run-probes.sh

# macOS：预存只读文件硬链接的策略反例，预期退出 1
python3 verification/foundation/scripts/native-isolation/macos-hardlink-probe.py

# macOS：历史 launchd 反例；预期不能回收脱离进程组的后代
python3 verification/foundation/scripts/native-isolation/macos-launchd-probe.py

# 真实 Linux：bubblewrap 与宿主 namespace 能力
python3 verification/foundation/scripts/native-isolation/linux-native-probes.py
```

旧入口 `bash .scratch/agent-direction/macos-sbx-probe.sh` 复用第一条命令，Linux 的独立 bwrap 路径、自检和部署前置说明见 [linux-README.md](linux-README.md)。当前报告分别写入 `native-macos-stage1-report.{json,md}` 与 `native-linux-current-report.{json,md}`，保留旧 `native-macos-report` 与 `native-linux-report`。退出码 0 表示脚本列出的被测项通过，1 表示实际结果与要求不符，2 表示启动、能力、对照或判定不可验证；启动失败和缺失项不会计作隔离通过。复跑会覆盖当前报告，应与代码一起保存需要保留的证据。

macOS 文件规则与实际启动的程序路径均由宿主规范化，并保留未规范化 `/tmp` 规则的反例对照。每次敏感操作先在未沙箱环境验证目标可访问，再检查沙箱程序自己的 started 标记与实际操作 errno。TCP、Unix socket、Mach 服务、POSIX/SysV 共享内存、SysV 信号量/消息队列与目标进程均由脚本创建。运行时只读根、被测策略、系统版本与具体结果写入 JSON，不能把某一策略失败扩大为所有 Seatbelt 策略不可能。

[预存硬链接报告](../../results/native-macos-preexisting-hardlink-report.md)记录两个真实失败：宿主预先把只读授权或共享 Git 文件硬链接进可写 workspace，Seatbelt 允许经别名改写原 inode；追加原只读路径的显式写拒绝也未阻止。同 inode、成功宿主写入对照、沙箱 started 与原文件改写均独立核实，虚拟材料已清理。主探针的创建硬链接拒绝不能覆盖这个入口，产品授权装配须另行拒绝未知外部别名及只读/可写交叉 inode。

停止验证先证明后代实际持续写心跳，再停止候选单元，随后观察心跳是否冻结。主 PID 消失、job 消失或 kill 成功都不单独构成通过证据。macOS 的[生命周期夹具](macos-lifecycle-probe.py)覆盖原 PGID、普通/忽略信号后代、Node detached、直接 setsid、posix_spawn 两类属性、短命中间进程、启动窗口、父进程异常、模式/授予变化及 PID 身份保护。回执与心跳只作独立对照，不参加停止判定：实际判定来自存活期进程树累积、libproc 的 uniqueid/出生时间及停止后的同 UID 新未知孤儿扫描。未知孤儿不发信号，`UNVERIFIED` 保留占用标记并禁止替换 worker；该判断可能把同期外部应用的新孤儿视为未核实。观察中断同样保留占用。信号使用内核核对 pidversion 的审计令牌，错误 pidversion 必须返回 ESRCH 且目标仍存活。

macOS 集合外的 posix_spawn 属性残留按拥有者已接受范围单列为 `UNVERIFIED · 占用保留`，该安全处置通过不代表后代已停止。探针完成记录后，仅凭本次虚拟夹具的身份和专属 argv 清理，清理结果另列，不能改写原停止结论；占用标记与虚拟目录仍保留。清理不能核实时保留现场。Linux 使用 PID namespace 与独立 user scope/cgroup 两道回收，覆盖脱离原进程组的后代。

2026-10-08 的 macOS 27.0 / Darwin 27.0.0 / arm64 实测确认：规范化后的文件拒绝生效；`posix_spawn` 的 setpgroup/setsid 属性仍可绕过 `SYS_setpgid/SYS_setsid` 拒绝规则，让后代脱离原进程组；停止原组后心跳继续增长。`kqueue NOTE_TRACK` 为 `ENOTSUP`，临时 launchd job 的 bootout 也未停止逃离的后代。具体证据见 [Seatbelt 报告](../../results/native-macos-report.md)与 [launchd 报告](../../results/native-macos-launchd.md)。

2026-10-11 在 Linux tx 的 Ubuntu 24.04.4 / Linux 6.8.0-117-generic / x86_64 上，正式 `/usr/bin/bwrap` 与已加载的 AppArmor profile 支持完整 namespace；seccomp 还拒绝 pathname Unix socket 与 socketpair sendto/sendmsg。最新[Linux 报告](../../results/native-linux-current-report.md)记录 52 项边界及 2 个宿主对照通过；整机 userns 限制保持开启。旧 `/tmp` 解包版本缺 profile 的 35 项不可验证结果保留在[旧报告](../../results/native-linux-report.md)，较弱策略的真实失败保留在[namespace 对照](../../results/native-linux-namespace-only-report.md)。

这些第一阶段记录不覆盖产品的 read/edit/write/bash、审批单次消费、SubAgent 委派/worktree/汇总、授权变化重建与后台恢复。产品验收另见[smoke 说明](../../../smoke/README.md)，两平台 worker 各 10 项、worktrees 各 8 项通过后，Coding Agent 正式入口默认且仅允许 native；能力失败不授权 local 或后台账户执行。

2026-10-11 较窄 `/System/Library` 与 `/Library/Developer/CommandLineTools` 候选的完整 88/88 通过证据保存在[原始日志](../../results/native-macos-stage1-88-run.txt)与明确标注 recovered-from-log 的[提取报告](../../results/native-macos-stage1-88-recovered-report.md)：原始 JSON/Markdown 被后续复跑覆盖，日志未记载的元数据没有补填。该次包含 `/System/Volumes/Data` 同 dev/ino 别名读写拒绝与三项真实残留的保留/报告。新增只读授权及共享 Git 的创建硬链接探针均有成功宿主对照、沙箱 started 与 EPERM；[两次 90 项复跑](../../results/native-macos-stage1-concurrent-90-report.md)与[安静窗口复跑](../../results/native-macos-stage1-quiet-census-report.md)分别为 89/90 和 88/90，同期同 UID 新孤儿使普通/短中间进程/启动窗口的停止返回未核实、保留占用，实际夹具已退出且心跳冻结。当前[主报告](../../results/native-macos-stage1-report.md)保持后一次失败，不称 90/90 通过。

初次较宽候选的[86 项报告](../../results/native-macos-stage1-initial-report.md)、旧 56 项的[报告](../../results/native-macos-report.md)及较早[并发运行报告](../../results/native-macos-concurrent-report.md)保持当次结论。独立[Data 卷别名对照](../../results/native-macos-system-data-alias-report.md)的宽/窄策略 canonical/alias 读写均拒绝，未观察到该别名绕过。`missing=0` 只表示列举被测项都运行过，不表示产品验收已完成。macOS 证据仅来自 27.0 / Darwin 27.0.0 / arm64；PID 复用覆盖出生身份不匹配及真实内核 pidversion 拒绝，未强迫内核回卷 PID。
