# 原17/36停止与native101未归因项：最小诊断交接

本轮只读已存原日志和源码；临时C探针在/tmp编译，替换全部libproc列表、身份与原子信号接口，不调用监督器main。没有新SSH，没有枚举或向OS进程发信号，没有恢复旧运行，没有改根工作区。旧失败仍未精确归因，以下证据不能记为A1通过或组合批次通过。

## 已能确定的范围

| 原现场 | 最早可定位事实 | 仍缺什么 |
| --- | --- | --- |
| 17 macOS六输入verify_3 | native supervisor=90761、worker=90762，identity_unavailable后stopVerified=false；工作流保留占用并以write_result_missing暂停；后续整项回报超时是传播结果 | 首个失败调用位置、实际查询PID、返回长度/errno、当时运行或停止阶段 |
| 38 macOS 101控制通道关闭回收已累计后代 | 原始状态只有started pid=92332后stopped reaped=false reason=identity_unavailable；已有started可排除capability/baseline拒绝和startup_identity_unavailable分支 | 启动之后sample/list/identity、signal_member核实或alive_members复核中的首故障，以及实际PID |
| 17 Linux change_2 | local process_group=3165125的stopVerified=false；不是native user scope；随后busy和回报超时属于传播 | worker原组查询、命令组查询及完整stopped回执与exit/EOF的顺序；不能证明已修复尾帧竞态就是旧原因 |

macOS首个不确定原因由mark_uncertain保存且从不清除；正常运行循环已调用sample，故最终identity_unavailable不等于“停止时身份查询失败”。owner_processes把proc_listpids失败、列表容量/形态异常、分配失败、任一同UID候选identity不可用、身份列表追加失败都折叠为false，sample再统一写identity_unavailable。该候选不必属于已累计执行后代。signal_member与alive_members也写同一reason。查询失败即停止核实是现有安全边界，不能改为忽略无关候选或把未知视作退出。

历史native-identity-eperm.log实证另一次count=0/errno=EPERM，不能证明原17或38同因。该日志returned=0/target_uid=0/unique=0/stat=0不能证明目标变成root；失败的身份结构没有有效返回。旧CI约59166次短命进程与后续基点/当前窄绿测均不能恢复原场景。旧PID窗口的统一日志/journal均未补回首故障；原生候选PID未知时重复旧PID查询不会区分上述分支。

Linux宿主最终结论是unitReaped与命令组完整回执的AND。unitReaped可能是非ESRCH的kill(-pgid,0)错误、ps失败/超时/不能解析，或预算内仍有可执行成员；命令组childrenReaped可在较早的bash结束/abort时因killTrackedChild失败而粘性置false并缓存。36已经证明旧版exit先于成功stdout尾帧会造成错误false，现有补等3秒修复和100/独立探针覆盖该边界，但原现场无时序，不能反向精确归因。

## 最小下一诊断

先给诊断构建加只记录首故障的结构字段；不修改重试、观察/TERM/KILL/尾帧预算，不吞失败，不改变身份或占用规则。无需再跑现有绿组来判断原原因。

macOS三条可检验假设按直接性排序：H1正常sample中的列表或非成员身份查询失败；H2已累计成员的signal_member或alive_members身份查询失败；H3列表增长/形态/内存分配失败被折叠为同一reason。它们均与现有日志相容，只有首故障位置能区分，不能依据约2.2秒总耗时排序OS根因。

首故障最少记录单调时间、supervisor/worker关联、运行或TERM/KILL/settle阶段、callsite、查询PID（无PID则列表/分配操作）、proc_pidinfo尝试号、返回长度/期望长度及立即保存的errno；owner_processes列表操作需needed/count/capacity/增长尝试号。完整身份返回才记录PID/uniqueid/start/pidversion有效性，不从零化或不完整结构推断身份。保留原stopped机器reason，stderr结构诊断不要替换原结论。只记录首次故障可避免每10ms遍历产生大量日志或保存环境、参数和正文。

Linux最少记录任务/单元关联、单调时间；worker/命令两层PGID、TERM/KILL阶段、首个异常查询类别与errno、末次alive/null/false；shutdown请求、worker exit、完整stopped帧及reaped、stdout end/close/error、额外等待结束原因，以及最终AND与缓存建立时间。缺这些字段时当前已存材料不足以再缩小旧触发。

有诊断构建且协调唯一原生夹具时，先只运行原38的单个helper用例：RUN_MODEL_CHECK=0 node --import tsx --test --test-name-pattern='^macOS 控制通道关闭回收独立进程组内忽略 TERM 的已累计后代$' test/101-native-macos-helper.test.ts。只用新隔离夹具，首红保留，不与100/helper失父夹具并行。该命令会使用监督器既有UID快照算法，必须由负责原生复现的执行者协调运行；本轮未运行。若窄用例仍绿，下一步由失败分组确认的原100→101串行顺序补一轮，仍不能叫原宽批次复现；未获首故障时不要用更多重复绿测关闭归因项。

Linux待连接前提由负责agent恢复后再安排一轮新隔离122并绑定上述两层事件；不新SSH、不恢复或重放旧write_result_missing运行，不把新122绿当作原17原因解释。

## 本轮补充的不变式证据

/tmp/ruukoto39-native-identity-invariants.c包含当前未改C源码，mock proc_listpids/proc_pidinfo/proc_signal_with_audittoken；自定义main不启动监督器。测试假设：H1非成员候选与列表错误会造成首reason粘性且后续完整sample不洗白；H2未知、复用和明确已退出身份不发信号，同一进程exec后使用当前pidversion；H3未知成员计为alive，后来明确退出仍不清除曾经的不确定。编译使用-std=c11 -Wall -Wextra -Werror -O2，执行exit0；日志与结果在同名前缀.log及-result.json。它补调用方安全边界，不能验证真实内核、解释历史原因或计入原验收矩阵。

复现探针：/usr/bin/clang -std=c11 -Wall -Wextra -Werror -O2 /tmp/ruukoto39-native-identity-invariants.c -I /tmp/ruukoto39-native-batch -o /tmp/ruukoto39-native-identity-invariants，然后执行/tmp/ruukoto39-native-identity-invariants。未跑全仓check、真实模型、真实IM、Node矩阵或新的真实OS停止；无新增生产修复依据。

## 主要证据入口

- .scratch/personal-pi-durable/evidence/17-macos/coding-diagnostic/{README.md,failure.json,regression-excerpt.log}
- .scratch/personal-pi-durable/evidence/17-linux/extra122.log
- .scratch/personal-pi-durable/evidence/36-coding-regression/{README.md,old-host-source.json,independent-code-review.json}
- .scratch/personal-pi-durable/evidence/38-product-entry/{check-exclusive-failure.log,native101-diagnostic/summary.json}
- .scratch/agent-workflow/acceptance-evidence/native-identity-eperm.log
- .scratch/ci/2026-10-11-previous-ci-failures.md
- packages/agent/src/execution/native-macos-supervisor.c:76,112,140,156,185,198,257,293
- packages/agent/src/managed-processes.ts:51,75；packages/agent/src/tool-worker/host.ts:135,226,337,376；packages/agent/src/tool-worker/worker.ts:90,104,142
