# Linux 创建与预存硬链接边界探针

时间：2026-10-11T07:03:18.874282+00:00
环境：Linux-6.8.0-117-generic-x86_64-with-glibc2.39
结果：failed；通过 2 / 4；虚拟材料清理 True。

只读授权与共享 Git 各测试沙箱内创建 alias、启动前预存 alias；全部资料为临时虚拟文件。

bubblewrap 完整 namespace、只读 bind 与当前网络 seccomp；不经过产品硬链接输入拒绝。

预存 alias 绕过只否决按路径挂载的候选，不代表有输入拒绝的产品仍允许此材料。
该探针不修改系统设置，也不访问真实资料与凭据。

| 探针 | 结果 | 证据 |
| --- | --- | --- |
| files.readonly-create-hardlink-write-denied | PASS | {"control": {"started": true, "stage": "operation", "ok": true, "errno": null}, "original_content": "virtual-readonly-create-material\n", "control_content": "mutated-by-workspace-alias\n", "restricted": {"started": true, "stage": "operation", "ok": false, "errno": 18}, "restricted_content": "virtual-readonly-create-material\n", "same_identity_after_attempt": false, "identity": {"dev": 64770, "ino": 315398, "nlink": 1}} |
| files.readonly-preexisting-hardlink-write-denied | FAIL | {"control": {"started": true, "stage": "operation", "ok": true, "errno": null}, "original_content": "virtual-readonly-preexisting-material\n", "control_content": "mutated-by-workspace-alias\n", "restricted": {"started": true, "stage": "operation", "ok": true, "errno": null}, "restricted_content": "mutated-by-workspace-alias\n", "same_identity_after_attempt": true, "identity": {"dev": 64770, "ino": 315399, "nlink": 2}} |
| files.shared-git-create-hardlink-write-denied | PASS | {"control": {"started": true, "stage": "operation", "ok": true, "errno": null}, "original_content": "virtual-shared-git-create-material\n", "control_content": "mutated-by-workspace-alias\n", "restricted": {"started": true, "stage": "operation", "ok": false, "errno": 18}, "restricted_content": "virtual-shared-git-create-material\n", "same_identity_after_attempt": false, "identity": {"dev": 64770, "ino": 315400, "nlink": 1}} |
| files.shared-git-preexisting-hardlink-write-denied | FAIL | {"control": {"started": true, "stage": "operation", "ok": true, "errno": null}, "original_content": "virtual-shared-git-preexisting-material\n", "control_content": "mutated-by-workspace-alias\n", "restricted": {"started": true, "stage": "operation", "ok": true, "errno": null}, "restricted_content": "mutated-by-workspace-alias\n", "same_identity_after_attempt": true, "identity": {"dev": 64770, "ino": 315401, "nlink": 2}} |
