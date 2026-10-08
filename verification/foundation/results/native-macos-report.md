# macOS 原生沙箱真实探针

时间：2026-10-08T22:05:11+0900
环境：macOS-27.0-arm64-arm-64bit-Mach-O / 27.0.0 / arm64
结果：failed。本记录不能替代完整产品验收。

候选 deny-default 文件/网络/IPC 策略；生命周期候选为 syscall 拒绝 + PGID 回收。

通过 53 / 56；失败 3；不可用 0；缺失 0。

仅当前 macOS 版本；未验证产品 WorkerLauncher、审批、恢复及 SubAgent 集成。
宿主工具链仅测试 --version 启动，不等价于真实 Git 操作或编译验收。
未实测 SysV IPC、生命周期启动窗口、父进程异常及模式或授予范围变化时的回收。
missing_probes=0 仅代表本脚本列举的探针无缺失，不代表覆盖工单全部要求。
失败只否决被测策略，不据此宣称所有 Seatbelt 策略都不可能。

| 探针 | 结果 | 证据 |
| --- | --- | --- |
| probe.profile-parse-classification | PASS | {"stage": "profile-parse", "rc": 65, "detail": "sandbox-exec: unbound variable: undefined-probe-rule at <input string>, line 1, column 13\n\nBacktrace: \n<input string>:1:13:\n\tundefined-probe-rule"} |
| probe.launch-failure-classification | PASS | {"stage": "launch", "rc": 71, "detail": "sandbox-exec: execvp() of '/opt/homebrew/Cellar/python@3.14/3.14.5/Frameworks/Python.framework/Versions/3.14/bin/python3.14' failed: Operation not permitted"} |
| legacy.canonical-read-literal | PASS | {"control": {"stage": "operation", "ok": true, "detail": "操作完成"}, "restricted": {"stage": "operation", "ok": false, "errno": 1, "detail": "[Errno 1] Operation not permitted: '/private/tmp/ruukoto-native-macos-ecz3q9_z/owner/material'"}} |
| legacy.canonical-read-subpath | PASS | {"control": {"stage": "operation", "ok": true, "detail": "操作完成"}, "restricted": {"stage": "operation", "ok": false, "errno": 1, "detail": "[Errno 1] Operation not permitted: '/private/tmp/ruukoto-native-macos-ecz3q9_z/owner/material'"}} |
| legacy.canonical-read-regex | PASS | {"control": {"stage": "operation", "ok": true, "detail": "操作完成"}, "restricted": {"stage": "operation", "ok": false, "errno": 1, "detail": "[Errno 1] Operation not permitted: '/private/tmp/ruukoto-native-macos-ecz3q9_z/owner/material'"}} |
| legacy.canonical-write | PASS | {"control": {"stage": "operation", "ok": true, "detail": "操作完成"}, "restricted": {"stage": "operation", "ok": false, "errno": 1, "detail": "[Errno 1] Operation not permitted: '/private/tmp/ruukoto-native-macos-ecz3q9_z/owner/material'"}} |
| legacy.canonical-file-star | PASS | {"control": {"stage": "operation", "ok": true, "detail": "操作完成"}, "restricted": {"stage": "operation", "ok": false, "errno": 1, "detail": "[Errno 1] Operation not permitted: '/private/tmp/ruukoto-native-macos-ecz3q9_z/owner/material'"}} |
| legacy.grandchild-file-denial | PASS | {"control": {"stage": "operation", "ok": true, "detail": "操作完成"}, "restricted": {"stage": "operation", "ok": false, "errno": 1, "detail": "[Errno 1] Operation not permitted: '/private/tmp/ruukoto-native-macos-ecz3q9_z/owner/material'"}} |
| legacy.noncanonical-rule-demonstration | PASS | {"control": {"stage": "operation", "ok": true, "detail": "操作完成"}, "restricted": {"stage": "operation", "ok": true, "detail": "操作完成"}} |
| files.workspace.read | PASS | {"control": {"stage": "operation", "ok": true, "detail": "操作完成"}, "restricted": {"stage": "operation", "ok": true, "detail": "操作完成"}} |
| files.workspace.write | PASS | {"control": {"stage": "operation", "ok": true, "detail": "操作完成"}, "restricted": {"stage": "operation", "ok": true, "detail": "操作完成"}} |
| files.grant-ro.read | PASS | {"control": {"stage": "operation", "ok": true, "detail": "操作完成"}, "restricted": {"stage": "operation", "ok": true, "detail": "操作完成"}} |
| files.grant-ro.write | PASS | {"control": {"stage": "operation", "ok": true, "detail": "操作完成"}, "restricted": {"stage": "operation", "ok": false, "errno": 1, "detail": "[Errno 1] Operation not permitted: '/private/tmp/ruukoto-native-macos-ecz3q9_z/grant-ro/material'"}} |
| files.grant-rw.read | PASS | {"control": {"stage": "operation", "ok": true, "detail": "操作完成"}, "restricted": {"stage": "operation", "ok": true, "detail": "操作完成"}} |
| files.grant-rw.write | PASS | {"control": {"stage": "operation", "ok": true, "detail": "操作完成"}, "restricted": {"stage": "operation", "ok": true, "detail": "操作完成"}} |
| files.shared-git.read | PASS | {"control": {"stage": "operation", "ok": true, "detail": "操作完成"}, "restricted": {"stage": "operation", "ok": true, "detail": "操作完成"}} |
| files.shared-git.write | PASS | {"control": {"stage": "operation", "ok": true, "detail": "操作完成"}, "restricted": {"stage": "operation", "ok": false, "errno": 1, "detail": "[Errno 1] Operation not permitted: '/private/tmp/ruukoto-native-macos-ecz3q9_z/shared-git/material'"}} |
| files.outside.read-denied | PASS | {"control": {"stage": "operation", "ok": true, "detail": "操作完成"}, "restricted": {"stage": "operation", "ok": false, "errno": 1, "detail": "[Errno 1] Operation not permitted: '/private/tmp/ruukoto-native-macos-ecz3q9_z/owner/material'"}} |
| files.outside.write-denied | PASS | {"control": {"stage": "operation", "ok": true, "detail": "操作完成"}, "restricted": {"stage": "operation", "ok": false, "errno": 1, "detail": "[Errno 1] Operation not permitted: '/private/tmp/ruukoto-native-macos-ecz3q9_z/owner/material'"}} |
| files.symlink.read-denied | PASS | {"control": {"stage": "operation", "ok": true, "detail": "操作完成"}, "restricted": {"stage": "operation", "ok": false, "errno": 1, "detail": "[Errno 1] Operation not permitted: '/private/tmp/ruukoto-native-macos-ecz3q9_z/workspace/escape'"}} |
| files.symlink.write-denied | PASS | {"control": {"stage": "operation", "ok": true, "detail": "操作完成"}, "restricted": {"stage": "operation", "ok": false, "errno": 1, "detail": "[Errno 1] Operation not permitted: '/private/tmp/ruukoto-native-macos-ecz3q9_z/workspace/escape'"}} |
| files.tmp-alias.read-denied | PASS | {"control": {"stage": "operation", "ok": true, "detail": "操作完成"}, "restricted": {"stage": "operation", "ok": false, "errno": 1, "detail": "[Errno 1] Operation not permitted: '/tmp/ruukoto-native-macos-ecz3q9_z/owner/material'"}} |
| files.tmp-alias.write-denied | PASS | {"control": {"stage": "operation", "ok": true, "detail": "操作完成"}, "restricted": {"stage": "operation", "ok": false, "errno": 1, "detail": "[Errno 1] Operation not permitted: '/tmp/ruukoto-native-macos-ecz3q9_z/owner/material'"}} |
| files.parent-traversal.read-denied | PASS | {"control": {"stage": "operation", "ok": true, "detail": "操作完成"}, "restricted": {"stage": "operation", "ok": false, "errno": 1, "detail": "[Errno 1] Operation not permitted: '/private/tmp/ruukoto-native-macos-ecz3q9_z/workspace/../owner/material'"}} |
| files.parent-traversal.write-denied | PASS | {"control": {"stage": "operation", "ok": true, "detail": "操作完成"}, "restricted": {"stage": "operation", "ok": false, "errno": 1, "detail": "[Errno 1] Operation not permitted: '/private/tmp/ruukoto-native-macos-ecz3q9_z/workspace/../owner/material'"}} |
| files.readonly-symlink-write-denied | PASS | {"control": {"stage": "operation", "ok": true, "detail": "操作完成"}, "restricted": {"stage": "operation", "ok": false, "errno": 1, "detail": "[Errno 1] Operation not permitted: '/private/tmp/ruukoto-native-macos-ecz3q9_z/workspace/readonly-alias'"}} |
| files.hardlink-source-denied | PASS | {"control": {"stage": "operation", "ok": true, "detail": "操作完成"}, "restricted": {"stage": "operation", "ok": false, "errno": 1, "detail": "[Errno 1] Operation not permitted: '/private/tmp/ruukoto-native-macos-ecz3q9_z/owner/material' -> '/private/tmp/ruukoto-native-macos-ecz3q9_z/workspace/hardlink'"}} |
| subagent.assigned-read | PASS | {"control": {"stage": "operation", "ok": true, "detail": "操作完成"}, "restricted": {"stage": "operation", "ok": true, "detail": "操作完成"}} |
| subagent.sibling-read-denied | PASS | {"control": {"stage": "operation", "ok": true, "detail": "操作完成"}, "restricted": {"stage": "operation", "ok": false, "errno": 1, "detail": "[Errno 1] Operation not permitted: '/private/tmp/ruukoto-native-macos-ecz3q9_z/workspace/material'"}} |
| subagent.assigned-write-denied | PASS | {"control": {"stage": "operation", "ok": true, "detail": "操作完成"}, "restricted": {"stage": "operation", "ok": false, "errno": 1, "detail": "[Errno 1] Operation not permitted: '/private/tmp/ruukoto-native-macos-ecz3q9_z/workspace/assigned/material'"}} |
| network.loopback-denied | PASS | {"control": {"stage": "operation", "ok": true, "detail": "操作完成"}, "restricted": {"stage": "operation", "ok": false, "errno": 1, "detail": "[Errno 1] Operation not permitted"}} |
| network.unix-in-workspace-denied | PASS | {"control": {"stage": "operation", "ok": true, "detail": "操作完成"}, "restricted": {"stage": "operation", "ok": false, "errno": 1, "detail": "[Errno 1] Operation not permitted"}} |
| network.grandchild-loopback-denied | PASS | {"control": {"stage": "operation", "ok": true, "detail": "操作完成"}, "restricted": {"stage": "operation", "ok": false, "errno": 1, "detail": "[Errno 1] Operation not permitted"}} |
| credentials.environment-scrubbed | PASS | {"control": {"stage": "operation", "ok": true, "detail": "只检查测试注入的虚拟环境变量"}, "restricted": {"stage": "operation", "ok": false, "detail": "只检查测试注入的虚拟环境变量"}} |
| credentials.descriptor-closed | PASS | {"control": {"stage": "operation", "ok": true, "detail": "只检查测试注入的虚拟描述符"}, "restricted": {"stage": "operation", "ok": false, "errno": 9, "detail": "[Errno 9] Bad file descriptor"}} |
| control-plane.signal-denied | PASS | {"control": {"stage": "operation", "ok": true, "detail": "操作完成"}, "restricted": {"stage": "operation", "ok": false, "errno": 1, "detail": "[Errno 1] Operation not permitted"}} |
| control-plane.pidpath-denied | PASS | {"control": {"stage": "operation", "ok": true, "detail": "操作完成"}, "restricted": {"stage": "operation", "ok": false, "errno": 1, "detail": "[Errno 1] proc_pidpath"}} |
| control-plane.process-environment-denied | PASS | {"control": {"stage": "operation", "ok": true, "detail": "操作完成"}, "restricted": {"stage": "operation", "ok": false, "errno": 1, "detail": "[Errno 1] sysctl(KERN_PROCARGS2)"}} |
| ipc.mach-lookup-denied | PASS | {"control": {"stage": "operation", "ok": true, "mach_code": 0, "detail": "bootstrap_look_up"}, "restricted": {"stage": "operation", "ok": false, "mach_code": 1100, "detail": "bootstrap_look_up"}} |
| ipc.shared-memory-denied | PASS | {"control": {"stage": "operation", "ok": true, "detail": "操作完成"}, "restricted": {"stage": "operation", "ok": false, "errno": 1, "detail": "[Errno 1] shm_open"}} |
| toolchain.node | PASS | {"control": {"stage": "operation", "ok": true, "detail": "v24.15.0"}, "restricted": {"stage": "operation", "ok": true, "detail": "v24.15.0"}} |
| toolchain.git | PASS | {"control": {"stage": "operation", "ok": true, "detail": "git version 2.54.0"}, "restricted": {"stage": "operation", "ok": true, "detail": "git version 2.54.0"}} |
| toolchain.clang | PASS | {"control": {"stage": "operation", "ok": true, "detail": "Apple clang version 21.0.0 (clang-2100.3.34.2)\nTarget: arm64-apple-darwin27.0.0\nThread model: posix\nInstalledDir: /Applications/Xcode.app/Contents/Developer/Too"}, "restricted": {"stage": "operation", "ok": true, "detail": "Apple clang version 21.0.0 (clang-2100.3.34.2)\nTarget: arm64-apple-darwin27.0.0\nThread model: posix\nInstalledDir: /Applications/Xcode.app/Contents/Developer/Too"}} |
| lifecycle.setpgid-syscall-denied | PASS | {"control": {"stage": "operation", "ok": true, "detail": "操作完成"}, "restricted": {"stage": "operation", "ok": false, "errno": 1, "detail": "[Errno 1] Operation not permitted"}} |
| lifecycle.setsid-syscall-denied | PASS | {"control": {"stage": "operation", "ok": true, "detail": "操作完成"}, "restricted": {"stage": "operation", "ok": false, "errno": 1, "detail": "[Errno 1] Operation not permitted"}} |
| lifecycle.kqueue-descendant-tracking | FAIL | "NOTE_TRACK 未支持 errno=45，无法用它补齐后代跟踪" |
| lifecycle.normal-file-inheritance | PASS | {"pid": 58399, "errno": 1, "control": "主探针已证明同一虚拟目标可访问"} |
| lifecycle.normal-network-inheritance | PASS | {"pid": 58399, "errno": 1, "control": "主探针已证明同一虚拟目标可访问"} |
| lifecycle.setpgroup-file-inheritance | PASS | {"pid": 58400, "errno": 1, "control": "主探针已证明同一虚拟目标可访问"} |
| lifecycle.setpgroup-network-inheritance | PASS | {"pid": 58400, "errno": 1, "control": "主探针已证明同一虚拟目标可访问"} |
| lifecycle.setsid-file-inheritance | PASS | {"pid": 58401, "errno": 1, "control": "主探针已证明同一虚拟目标可访问"} |
| lifecycle.setsid-network-inheritance | PASS | {"pid": 58401, "errno": 1, "control": "主探针已证明同一虚拟目标可访问"} |
| lifecycle.stop-normal-descendant | PASS | {"name": "normal", "pid": 58399, "pgid": 58398, "sid": 58398, "file_denial_errno": 1, "network_denial_errno": 1, "heartbeat_grows_after_group_kill": false, "pid_exited": true, "worker_pgid": 58398, "worker_sid": 58398} |
| lifecycle.stop-setpgroup-descendant | FAIL | {"name": "setpgroup", "pid": 58400, "pgid": 58400, "sid": 58398, "file_denial_errno": 1, "network_denial_errno": 1, "heartbeat_grows_after_group_kill": true, "pid_exited": false, "worker_pgid": 58398, "worker_sid": 58398} |
| lifecycle.stop-setsid-descendant | FAIL | {"name": "setsid", "pid": 58401, "pgid": 58401, "sid": 58401, "file_denial_errno": 1, "network_denial_errno": 1, "heartbeat_grows_after_group_kill": true, "pid_exited": false, "worker_pgid": 58398, "worker_sid": 58398} |
| lifecycle.probe-cleanup | PASS | {"heartbeat_frozen": true, "captured_pids_exited": true, "all_spawn_receipts_verified": true} |
