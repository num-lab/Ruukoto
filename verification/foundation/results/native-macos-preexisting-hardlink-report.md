# macOS 预存硬链接边界探针

时间：2026-10-11T15:43:10+0900
环境：macOS-27.0-arm64-arm-64bit-Mach-O
结果：failed；通过 0 / 2；虚拟材料清理 True。

只测试本轮虚拟只读授权与共享 Git 文件，预先创建同 inode 的 workspace 硬链接。

失败只否决按路径开放 workspace 写入的被测 Seatbelt 策略。
该探针不经过产品授权装配；产品可在启动前拒绝有多重硬链接的可写材料。
原生主探针的创建硬链接拒绝不能代替本项预存别名写入口。

| 探针 | 结果 | 证据 |
| --- | --- | --- |
| files.readonly-preexisting-hardlink-write-denied | FAIL | {"same_identity": true, "identity": {"dev": 16777232, "ino": 65284913, "nlink": 2}, "control": {"stage": "operation", "started": true, "ok": true, "detail": "操作完成"}, "control_changed_original": true, "restricted": {"stage": "operation", "started": true, "ok": true, "detail": "操作完成"}, "restricted_changed_original": true, "explicit_readonly_deny": {"stage": "operation", "started": true, "ok": true, "detail": "操作完成"}, "explicit_deny_changed_original": true} |
| files.shared-git-preexisting-hardlink-write-denied | FAIL | {"same_identity": true, "identity": {"dev": 16777232, "ino": 65284918, "nlink": 2}, "control": {"stage": "operation", "started": true, "ok": true, "detail": "操作完成"}, "control_changed_original": true, "restricted": {"stage": "operation", "started": true, "ok": true, "detail": "操作完成"}, "restricted_changed_original": true, "explicit_readonly_deny": {"stage": "operation", "started": true, "ok": true, "detail": "操作完成"}, "explicit_deny_changed_original": true} |
