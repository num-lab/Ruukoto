# PTY 工作流画面等待的 Linux 验证

环境为 `oracle-4c24g`、Linux arm64、Node 24.15.0，独立目录 `/tmp/ruukoto-reduce-linux-20261024.G82oCL/pty-fixture-gates{,-v2}`。本轮未修改主工作区或远端正式 `src/test/15-tui-pty.test.ts`；最后复核原文件仍为 `ae688ea6e4c32b3d247f11cecdcc5486e9b19d17aa3308f7fdcd6f388634eeee`。后续同步最终主文件与模型替身属于另一轮增量。

受控扰动只在真正 TUI 命令前增加固定 12 秒启动延迟，随后 exec 原命令。原版和候选均保留 21 个动作、分段索引、所有业务与缩放断言、驱动 40 秒及工作流用例 60 秒期限；没有新增重试或扩大预算。外部监督只记录完整退出和自有后代进程，不替代原用例期限。

| 对象 | 实际结果 | Node 汇总 | 完整进程 |
| --- | --- | --- | --- |
| 原版 + 12 秒延迟 | 1 项失败；TUI exit 0，22 segments，但有序业务标记 0/6 | 33.837s | 33.996s，exit 1 |
| v1 + 同一延迟 | 最后画面条件未满足，随后原驱动清理报告 timeout | 49.752s | 49.950s，exit 1 |
| v1 增加结果落盘诊断 | 仍在最后条件停住；21 segments、5/6，仅 `/quit` 尚未发送 | 记录于日志 | 49.974s，exit 1 |
| v2 + 同一延迟 | 全部原断言通过；TUI exit 0，22 segments、6/6 | 19.704s | 19.930s，exit 0 |
| v2 无延迟完整文件 | 4/4 通过、0 跳过；覆盖 FakeTerminal、compact、工作流和原数值时间 PTY 路径 | 51.789s | 52.022s，exit 0 |

每一轮均未触发外部监督超时，最终跟踪的自有进程为空。v1 的驱动期限耗尽与监督器超时不是同一事实；其原有清理路径 kill 后以零剩余时间 wait，报告清理错误。该失败没有被隐藏或改为通过。

v1 等待最后 Esc 之后再次输出“连接：在线”。真实分段显示终端采用增量重绘，未变化的连接行不会重画；末段已经回到普通聊天，包含 `CHAT-OK:宽屏聊天` 和 `mock/mock-model`。v2 只把最后条件换成这两个实际新输出的标记。前一段根列表不能同时满足它们。v1 诊断只在原 PTY JSON 解析后、清理错误判断前落盘，不改任何驱动动作；v2 探针保留相同观测，并在 `observation-manifest.json` 记录变换前后指纹。

v2 延迟用例测试体为 16.441s；无延迟工作流测试体为 4.183s。无延迟整文件其余测试体为 FakeTerminal 0.002s、compact 10.892s、原 80×24 PTY 33.490s。不能把单项测试体时间冒充完整文件耗时，也不把受控 12 秒延迟声称为旧 CI 或本机历史失败的实际延迟。

v1 候选 SHA-256 为 `f15591e0fccda31594060e4cf348c1c8dacaeab38964a3752416e3b5996ed4b1`，patch 为 `3f0bbeb3709c78bc1a88b2baa632a4470057308ab80ec4d07cb366f4ba190813`。v2 候选为 `9bc371a8ddedc1a2239333c665e86fd85ce5303e938e720c9c5dd0e83984b8ba`，patch 为 `2412e8fde77da35780d14ee56e2159c8092c1adf4590989e82b9c42b1f132f8e`；完整生成探针指纹另见两版 `manifest.json` 与 v2 `observation-manifest.json`。

本地证据为 `/tmp/ruukoto-pty-workflow-fixture-fix/pty-fixture-gates/`、`pty-fixture-gates-v2/`，包为 `linux-evidence.tar.gz`。各 `run-*` 目录保存完整 stdout、监督结果和进程观察；`*.result.json` 与 `*-driver-results.jsonl` 保留完整终端文字及分段。依赖符号链接未进入归档。
