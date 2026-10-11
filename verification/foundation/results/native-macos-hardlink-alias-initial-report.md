# macOS 目录别名硬链接计数反例

结果：failed；原生授权树检查放行了含未授权外部硬链接的工作区。
记录时间：2026-10-11T16:10:22+0900。

虚拟 workspace/file 与 private/secret 是 nlink=2 的同一文件；同时传入 workspace 与其 /System/Volumes/Data 别名作为读写授权。两个目录及其中的文件经 samefile 核实为相同 dev/ino，实际 assertNativeFileLinks 返回 GUARD_ALLOWED，tsx 退出 0。虚拟材料已清理。

该记录保存修复前实际回执，不经过完整worker。
守护检查按路径计数同一目录条目两次，掩盖未授权private目录中的原条目。
同inode的只读与读写权限仍须判冲突；按目录对象去重不能丢掉权限事实。
