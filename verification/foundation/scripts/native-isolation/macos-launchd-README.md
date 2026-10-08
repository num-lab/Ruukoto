# macOS launchd 后代回收探针

`macos-launchd-probe.py` 验证工单 26 的一个生命周期候选机制：把受限进程交给 launchd 管理，能否在 `bootout` 后停止脱离原进程组的后代。它不接入产品，不验证完整文件、网络、凭据或 IPC 策略。

在具有当前用户 GUI launchd domain 的真实 macOS 上运行：

```bash
python3 verification/foundation/scripts/native-isolation/macos-launchd-probe.py
```

需要宿主 Node、`/usr/bin/python3`、`sandbox-exec` 和 `launchctl`。缺少能力、启动失败、无有效心跳对照或清理不能核实，退出 2；有效对照下停止失败，退出 1；本脚本两项生命周期验证通过才退出 0。报告写入 `verification/foundation/results/native-macos-launchd.json` 与 `.md`。

脚本只创建本次唯一 label 的临时 GUI job，设置 `RunAtLoad=true`、`KeepAlive=false`、`ExitTimeOut=1`、`AbandonProcessGroup=false`。job 经 `sandbox-exec` 启动，测试策略仅禁止网络。Python `start_new_session=True` 与 Node `detached:true` 分别创建后代；后代忽略 SIGTERM，在临时目录持续写入虚拟心跳，另有 20 秒自停上限。

停止前先证明后代在执行，停止后同时核实 job 已移除、父进程退出、后代存活状态与心跳变化。清理仅操作本次 job，并要求捕获 PID 的 argv 包含本次唯一临时目录才允许发送 SIGKILL；随后核实 PID 退出和心跳冻结。父进程已经启动但子进程 spawn 回执缺失，或无法核实清理时保留临时目录，不能通过删除心跳掩盖残留。

2026-10-08 在 macOS 27.0 / Darwin 27.0.0 / arm64 / Node 24.15.0 上，两条路径均得到有效运行对照，随后均失败：`bootout` 退出 0、job 查询退出 113、父进程已退出，脱离组的后代仍继续写入。最终所有临时 job 与捕获进程清理完成。该结果否决本次 launchd 回收候选，不代表所有特权原生管理方式均不可行，也不能作为工单 26 原生替换完成的依据。
