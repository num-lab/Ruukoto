# macOS Data 卷别名的虚拟资料对照

时间：2026-10-11T15:17:38+0900
环境：macOS-27.0-arm64-arm-64bit-Mach-O / 27.0.0

本次只使用自动清理的虚拟资料；宿主证明 canonical 与 /System/Volumes/Data 别名为同 dev/ino。旧宽 /System 与较窄 /System/Library 候选的 alias read/write 均已启动并返回 EPERM，未观察到此路径绕过；不把较宽策略的未测路径写成已证明安全。

| 操作 | 策略 | 结果 | 证据 |
| --- | --- | --- | --- |
| read | control | PASS | {"operation": "read", "policy": "control", "started": true, "pass": true, "ok": true, "detail": "操作完成"} |
| read | wide-canonical | PASS | {"operation": "read", "policy": "wide-canonical", "started": true, "pass": true, "ok": false, "errno": 1, "detail": "[Errno 1] Operation not permitted: '/private/var/folders/y4/36h8kvvd4q52vjptp522rzfc0000gn/T/ruukoto-system-data-alias-vou38h6j/virtual-owner-material'"} |
| read | wide-alias | PASS | {"operation": "read", "policy": "wide-alias", "started": true, "pass": true, "ok": false, "errno": 1, "detail": "[Errno 1] Operation not permitted: '/System/Volumes/Data/private/var/folders/y4/36h8kvvd4q52vjptp522rzfc0000gn/T/ruukoto-system-data-alias-vou38h6j/virtual-owner-material'"} |
| read | narrow-canonical | PASS | {"operation": "read", "policy": "narrow-canonical", "started": true, "pass": true, "ok": false, "errno": 1, "detail": "[Errno 1] Operation not permitted: '/private/var/folders/y4/36h8kvvd4q52vjptp522rzfc0000gn/T/ruukoto-system-data-alias-vou38h6j/virtual-owner-material'"} |
| read | narrow-alias | PASS | {"operation": "read", "policy": "narrow-alias", "started": true, "pass": true, "ok": false, "errno": 1, "detail": "[Errno 1] Operation not permitted: '/System/Volumes/Data/private/var/folders/y4/36h8kvvd4q52vjptp522rzfc0000gn/T/ruukoto-system-data-alias-vou38h6j/virtual-owner-material'"} |
| write | control | PASS | {"operation": "write", "policy": "control", "started": true, "pass": true, "ok": true, "detail": "操作完成"} |
| write | wide-canonical | PASS | {"operation": "write", "policy": "wide-canonical", "started": true, "pass": true, "ok": false, "errno": 1, "detail": "[Errno 1] Operation not permitted: '/private/var/folders/y4/36h8kvvd4q52vjptp522rzfc0000gn/T/ruukoto-system-data-alias-vou38h6j/virtual-owner-material'"} |
| write | wide-alias | PASS | {"operation": "write", "policy": "wide-alias", "started": true, "pass": true, "ok": false, "errno": 1, "detail": "[Errno 1] Operation not permitted: '/System/Volumes/Data/private/var/folders/y4/36h8kvvd4q52vjptp522rzfc0000gn/T/ruukoto-system-data-alias-vou38h6j/virtual-owner-material'"} |
| write | narrow-canonical | PASS | {"operation": "write", "policy": "narrow-canonical", "started": true, "pass": true, "ok": false, "errno": 1, "detail": "[Errno 1] Operation not permitted: '/private/var/folders/y4/36h8kvvd4q52vjptp522rzfc0000gn/T/ruukoto-system-data-alias-vou38h6j/virtual-owner-material'"} |
| write | narrow-alias | PASS | {"operation": "write", "policy": "narrow-alias", "started": true, "pass": true, "ok": false, "errno": 1, "detail": "[Errno 1] Operation not permitted: '/System/Volumes/Data/private/var/folders/y4/36h8kvvd4q52vjptp522rzfc0000gn/T/ruukoto-system-data-alias-vou38h6j/virtual-owner-material'"} |
