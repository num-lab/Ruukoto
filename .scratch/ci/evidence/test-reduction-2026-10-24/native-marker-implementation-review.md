# macOS启动标记原子发布：独立实现审查

结论：当前生产修复及永久回归没有阻断。亲自运行原版反例退出1、主工作区修复最窄例1/1退出0；native独占已释放。历史ordinary reviewer的失败仍缺Task现场，不能把确定marker竞态的修复写成那次失败的唯一归因。

## 生产修改

除Note锚点外只改bootstrap一行：native-started.tmp完整写入并关闭、同目录rename、随后原动态import。已核实与受审方案一致；读取端、两份启动事实、Seatbelt profile、5000ms启动/12000ms停止和机器错误原因均不变。每次launch独立mkdtemp的0700归属与固定tmp合理性见原方案审查 `/tmp/ruukoto-native-marker-plan-review.md`。

write或rename同步抛错时不执行import；final缺失/坏值仍沿原路径处理；未把tmp当作证据。作者的write/rename探针分别留下partial/started临时内容，final均未发布、workerImported=false、execution_unavailable/sandbox_rejected，最终退出与stop结论独立记录。本人读取这些额外探针而未重复执行。读端严格逻辑完全未改，因此把额外invalid循环留在诊断材料、永久测试只扩展已有成功bootstrap与原缺标记拒绝，覆盖完整且不增加每次正常运行的故意未知停止。

## 回归与失败清理

真实Seatbelt子Node通过NODE_OPTIONS preload只控制两个已知标记路径的write；先open创建/截断，再原子发布opened门，等宿主真实read触发后放行。宿主mock仍调用原read，finally才释放子Node，因此原版确定读到0字节，候选确定读到ENOENT；没有合成成功内容、提前创建final或延长启动预算。随后原敏感FD不继承、内容started、真实stop=true及原无标记sandbox_rejected/unit身份断言保留。

当前只持一个LaunchedUnit。初次launch错误先保存error.unit；正常启动后先核实stop=true、等待unit.exit与stdout/stderr finished才清空该引用。finally先释放停点，再处理剩余unit；stop抛错时局部stopped仍为false，并在finally通过 `reaped = stopped && reaped` 累计。exit或流等待失败也会进入外层finally，恢复nodeFs mock、syncBuiltinESMExports并关闭secret FD。只有reaped仍为true才删除目录，stop=false不会被后续实际退出覆盖。

非阻断的最小健壮性建议已发root：原缺标记assert.rejects回调当前在assert reason之后才保存error.unit；建议在instanceof断言后立即 `unit = error.unit ?? null`，再断言reason和unit。这样将来错误分类回归触发断言时仍能进入同一清理路径；不改当前成功行为或生产代码。root若采纳应在当前组合结束后统一改动，不能改正在受检的源码。

## 本人独立红绿

环境macOS arm64/Node24.15。顺序执行，无其他native旁路；每个命令有45秒外部期限，均自然退出且未触发监护。

| 对象 | 结果 | 完整进程墙钟 |
| --- | --- | --- |
| 隔离原bootstrap + 最终最小回归及额外只读观察 | exit1，真实0字节被refreshMarker拒绝；execution_unavailable/sandbox_rejected，stop=false | 0.337s |
| 当前主工作区101 bootstrap最窄例 | 1/1，exit0，零跳过/取消 | 0.453s |

红例不是导入或配置失败；失败栈明确为native-macos.original.ts的failed←Timeout.refreshMarker。观察记录保留原stop=false；同一unit随后exit0、stdout/stderr均EOF，supervisor78623与worker78624经kill(pid,0)均不存在。测试按未知停止保留 `/private/tmp/rk-native-bootstrap-kYnTio`，本人先保存证据及PID核实，再只删除这个自有目录；没有修改stop结论。主工作区绿例没有新增遗留fixture目录。

产物均在 `/tmp/ruukoto-native-bootstrap-publication/`：`independent-original.log`、`independent-main.log`、`independent-original.observations.json`、`independent-cleanup-verification.json`、`independent-results.json`、`independent-source-identity.json`。Node22/24作者红绿以及额外故障材料继续保留，未冒称本人在Node22重跑。

## 文档与后续

05工单、独立bug-fix笔记和execution模块说明区分完整标记、两份启动事实、停止身份与历史归因限制，和一行实现一致。没有降低产品权限或预算；远端四格仍由02持有。当前报告只证明该局部修复，root负责后续helper整文件/reviewer/快照组合及新固定候选全量。

另已提供 `/tmp/ruukoto-workflow-reviewer-diagnosis/ordinary-failure-diagnostic.patch`：failed/interrupted/canceled即时失败，completed条件与60秒保持；超时或失败统一打印Task状态/error/interrupt、该Task工具账本摘要和最后模型tool文本后重抛。该补丁只改善下一次失败可见性，不作为ordinary历史失败的修复。
