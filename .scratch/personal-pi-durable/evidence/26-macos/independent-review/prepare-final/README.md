# 同步准备机械提取的最终复核

生产唯一变化为把完全访问的同步准备体提取到 prepareFullAccess，公开入口在 try 中只调用该同步函数。mechanical-extract-comparison.json 与 prepare-extract.diff 记录前后哈希及逐句比较；去掉缩进后原准备语句完全相等，原受限分流、返回形态、验证顺序和 command_prepare_failed 包装保持。

基于最终生产字节另建独立副本，只运行“完全访问宿主：returned”。baseline.log 为最终基线 1/1；仅撤宿主 full_access 准入后 withdrawn.log 按 command_record_invalid 失败、退出 1；恢复冻结字节后 restored.log 为 1/1。命令与退出码见 commands.json，唯一负例差异见 withdrawn.patch，前后源码及哈希见 frozen-manifest.json、mutation.json 和两份源码。

restored-production-comparison.json 核实恢复后的副本与最终生产一致，共享执行源码也仍匹配冻结哈希。node_modules 只是依赖链接，共享生产文件未改。本次未重跑矩阵；原独立审查中的 section 取消/fallback、跨模式复用及全部流程结论仍有效。此前证据保持在 /tmp/rk-full-access-independent-review-czlwytme。

prepare-extract.diff 原文压缩为 prepare-extract.diff.gz，空白上下文行及内容保持不变；evidence-manifest.json 对该项记录的是解压后的长度与 SHA-256。
