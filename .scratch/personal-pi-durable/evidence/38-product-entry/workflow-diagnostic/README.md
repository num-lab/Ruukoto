# 112 运行中高 CPU 只读诊断

对象为本轮 remaining app 批次自有 PID 49528，未启动额外测试，未修改源代码、依赖或断言。macOS sample 1 秒显示同步目录遍历；在主代理确认仅作用于本轮自有测试进程后，确认 9229 无 listener，再为该进程开 inspector，录制约 1 秒 CPU profile，仅使用 Profiler 与 inspector.close，不暂停或读取业务对象。

780 samples 中 prepareNativeLaunch/assertGrantNotProtected/isProtectedPath 占 779，identityCovers 占 774；主要 self samples 为 lstat 470、readdir 242。这精确定位采样瞬间的同步保护目录身份扫描；不直接证明 112 各断言失败机制，也不认定它与 native101 或 issue36 原失败同因。

Runtime.protectedRoots 包含 CODE_ROOT。identityCovers 对目录递归 lstat/readdir，发现符号链接即跳过。主树 node_modules 是真实目录，docs/tests 隔离副本是链接，pack 副本是独立真实安装。作者调用方 115 项来自 pack 副本，独立 44 项来自主树，均不能以“链接跳过依赖树”概括。新增证据目录位于 CODE_ROOT 也会被扫描，但本轮没有量化其增量影响。

112 正常退出前流式结果为 14 项中 6 过 8 败：前两项个人/Code 修改验证流程、完全访问写回拒绝、stale/check_failure/snapshot_missing/snapshot_mismatch/ledger_unknown。外层 runner 收尾后已刷出：个人首项 reason=script_cpu_limit，其余7项为等待超时，完整分组另见 /tmp/ruukoto38-app-rest-failure-analysis/。最终 npm run check 已失败，不被本诊断或此前窄测覆盖。

首次 inspector.close 调用后 WS 过早关闭，初始 summary 的 listenerClosed 字段不足以独立证明收尾；后续专用 close 脚本重新验证同 PID listener 并等待关闭，close.json 确认空 listener。PID 49528 正常退出后再次 ps/lsof 核实 PID 和 9229 listener 均不存在。外层 app 日志出现 Debugger listening/attached 是本次诊断产生的行。没有停止未知进程。

源文件与基点等价、依赖目录形态、112 结果摘录和最终收尾见 environment-observation.json。approved-ops/native/runtime/skills/112/122 均与 12b1a66c 字节相同；testkit 的薄产品声明导入是 38 改动，Code 用例显式覆盖该默认产品。这里只读审阅其语义，不据此认定所有失败均属既有问题。
