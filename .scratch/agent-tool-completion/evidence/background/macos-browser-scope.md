# macOS 后台与真实浏览器组合停止

2026-10-21，Darwin 27 / arm64。仅隔离副本修改，主线只读；补丁为 `/tmp/ruukoto-macos-delivery/macos-browser-scope.patch`。

原完整验收红：process_start → browser.start/open/snapshot → 下一拥有者轮 process_status → process_stop。后台 stderr 恰为209字节：`新孤儿 ... (agent-browser-d) ... unknown_new_orphan`；持久回执 `reaped:false, stdoutEof:true, stderrEof:true, outputComplete:true`。不是原管道未闭或退出观察问题。

先尝试按基线宿主的完整血缘正面累计无关进程。真实最小孤儿夹具由红转绿，但真实 Chrome 的 crashpad 存在完全漏采的短命中间父，不能据此核实完整链；该方案撤回。1ms采样也未解决且出现 identity_unavailable，该方案撤回。当前系统再次真实确认 kqueue NOTE_TRACK 注册 errno45 ENOTSUP；SDK sys/event.h 明文 NOTE_TRACK/NOTE_TRACKERR/NOTE_CHILD 自10.5不支持，不作为停止证据。

最终候选仅针对持久完全访问模式，沿已有主动脱离例外界定未知候选范围；受限旧模式不变。记录已正面核实成员每次观察的PGID、SID及PID（PID保守覆盖两次采样间setsid），候选getsid前后核实同一完整寿命身份。历史ID只增加保守拒绝，不用于发信号；所有已知成员仍按uniqueid/开始时间/audit token精确停止。未知原组或历史受管组/会话新孤儿继续保留未核实；未知外组且外SID的主动脱离者只有在原输出管道也确实EOF时才不阻止核实。

真实反例：

1. 普通doublefork、故意漏掉父采样、不调用setsid，保留原PGID：被核实回收。
2. 未观测祖先调用setsid，后代关闭原双管道：不认领/不误杀，夹具通过私有release文件自然退出。
3. 同上但继承管道：EOF不成立，停止保持未核实。
4. 已known A在两采样间setsid，经未观测短命C产生普通B，B关闭管道：历史PID识别潜在新SID，保持未核实。撤掉该历史集合的root-only负控制实际错误返回verified且B alive，回归确能捕获。
5. 已known A在两采样间加入同SID内未观测C创建的新PGID，再经短命父产生B，B未主动脱离且关闭管道：历史SID继续拒绝，保持未核实。

`npx tsx --test --test-concurrency=1 test/101-native-macos-helper.test.ts test/native-macos-identity.test.ts`：20/20通过（19.9s），旧受限未知孤儿保守用例仍通过。clang -std=c11 -Wall -Wextra -Werror、eslint新测试、TypeScript检查和git diff --check通过。

原真实BrowserManager组合验收最终通过：stderr空、partial:false、停止回执reaped:true/双流EOF/outputComplete:true（约4.5s）。测试使用固定官方agent-browser和Google Chrome，无模型或外部业务服务。

未测断电、磁盘满、内核PID/PGID/SID真实回收循环。历史数字复用可能保守误阻塞，不能导致向无关PID发信号；完全访问仍不保证收回未观测祖先主动脱离原组/会话且关闭原管道的外部进程或服务。
