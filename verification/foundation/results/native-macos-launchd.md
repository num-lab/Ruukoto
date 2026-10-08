# macOS launchd 后代回收验证

状态：FAIL

环境：macOS-27.0-arm64-arm-64bit-Mach-O；Node v24.15.0。时间：2026-10-08T21:56:54+0900。

| 路径 | 运行对照 | bootout | job 查询 | 停止后心跳 | 结果 |
| --- | --- | --- | --- | --- | --- |
| python-setsid | [0, 3] | 0 | 113 | [6, 9] | FAIL |
| node-posix-spawn | [0, 3] | 0 | 113 | [5, 8] | FAIL |

临时 job 使用 sandbox-exec（仅禁止网络），RunAtLoad=true、KeepAlive=false、ExitTimeOut=1、AbandonProcessGroup=false。后代忽略 SIGTERM，并持续写入临时虚拟心跳。该探针只验证生命周期候选机制，不验证完整文件、凭据或 IPC 策略。

清理核实：{"verified": true, "temporary_directory_removed": true, "errors": []}。捕获 PID 的 argv 必须包含本次临时目录才允许发送 SIGKILL；同时核实 PID 退出与心跳冻结。

复跑：`python3 verification/foundation/scripts/native-isolation/macos-launchd-probe.py`。PASS=0、真实边界失败=1、基础设施缺失或运行/清理对照无效=2。

Apple 的 [launchd.plist 说明](https://github.com/apple-oss-distributions/launchd/blob/main/man/launchd.plist.5)将 AbandonProcessGroup 的清理范围限定为与 job 相同的进程组；本报告用真实后代确认了该限制。[XNU coalition 系统调用](https://github.com/apple-oss-distributions/xnu/blob/main/bsd/kern/sys_coalition.c)要求调用者属于 privileged coalition；[coalition_request_terminate_internal](https://github.com/apple-oss-distributions/xnu/blob/main/osfmk/kern/coalition.c)请求在成员归零后通知，不能据此声称已停止所有当前成员。未验证其他特权原生管理机制，不能把本报告扩写为所有原生方案均不可行。
