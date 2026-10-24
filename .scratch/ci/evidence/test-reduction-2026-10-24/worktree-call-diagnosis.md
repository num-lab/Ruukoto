# 83 integrate/call 目标阶段超时：诊断结果

对象为当前 macOS 完整检查中的“后台停止覆盖 SDK 中的 integrate 临时 worker call 阶段，重连资料保留占用与现场”。主工作区没有被本审查者修改；所有诊断变体、提议补丁与状态快照都在本目录。真实上游失败仍未归因，以下正常补跑和人为反例均不改写这项结论。

## 可确定的失败位置

`/tmp/ruukoto-reduction-after-28c033f7.log` 最终堆栈明确为 `waitFor` 的“目标临时单元已产生”，位于83:876，测试耗时60226.441416ms；尚未进入本例的 `await rt.stop("test_backend_stop")`。因此标题中的“后台停止”不是本次已知卡点。原 `28c033f7` 同例5792.918792ms通过；整个 operation×phase 测试块当前与基线逐字相同，SHA-256 `f1f069053c0f1250f60eb4bbbdfb2c0e1e5a5c674cc05c96ec08731b8d157243`。

原 finally 已关闭并删除测试档案，原失败前的父/子状态、工具结果和占用未留下。只有总超时，不能反推出原例究竟在准备、子任务、ready后校验还是模型下一轮失败。Linux当前83文件通过也不能独自证明是macOS产品缺陷或资源竞争。

## 实际执行

环境为 macOS arm64 / Node24.15.0，RUN_MODEL_CHECK=0、RUN_BACKGROUND_BROWSER_CHECK=0。诊断副本保留原成功断言和60秒/15秒预算，helpers引用主仓库，生产代码及真正的Git准备/子任务没有替换；额外阶段快照写入独立/tmp目录。父或非成功子任务已终态且目标尚未出现时，临时诊断会提前打印具体状态，避免再等不可能出现的帧。命令和外部进程墙钟见同名result.json。

| 运行 | 结果 | 完整进程秒 |
| --- | --- | --- |
| 首次目标单例 | 1/1 | 6.346 |
| 有界序列三轮目标单例 | 三轮均1/1 | 5.863 / 4.633 / 5.138 |
| 同进程四个backend-stop兄弟用例 | 4/4 | 10.801 |
| 原并发2：目标单例＋84真实多副本汇总 | 2/2 | 20.570 |
| 实际文件别名受控反例 | 1失败，退出1；父中断，init后无tool_call | 5.643 |
| 准备launcher拒绝受控反例 | 1失败，退出1；父失败，controlled零启动 | 2.094 |

首次成功快照显示：capture/create约4.7秒完成，子任务约4.96秒为completed且摘要成功、只剩父目录占用；约5.00秒controlled已产生init和tool_call，rt.stop约7ms完成，原停止未核实/占用/文件/唯一事件断言全通过。其余无扰动运行没有自然复现，不记为已修好。

## 两个反例区分什么

文件别名例在子副本完成后，为source.txt在未授权目录建立第二个真实硬链接；不改产品校验。controlled启动一次，ready和init成功，但ToolWorkerHost.call的native文件别名核实拒绝发送tool_call。原模拟stop=false使父和宿主任务中断、占用保留；请求只有init、shutdown。明确说明integrate/ready通过不能证明ready后的call前检查可过。该硬链接是人为注入，不是原失败现场发现。

准备拒绝例仅在真正的worktree准备launcher将接到-wt_任务时抛带code的拒绝；不改变SDK、工具账本或停止实现。宿主准备failed，subagent_delegate返回具体捕获失败；原模型responder随后取不存在的work.id而报HTTP500，父最终failed，controlled的specs/requests均为零。原外层只等tool_call会掩盖这个已结束的失败，直到60秒。该拒绝同样是人为注入，不能当成原失败的已知原因。

两类无tool_call都可变成同一旧超时，但父/host/ops状态不同。这证明需要在原清理前保存它们，也证明不能仅凭旧超时选其中一项修复。

## 摘要与真实就绪

普通SubAgent结果摘要在任务终态后登记；Driver.finalize先等待受管进程停止聚合，再提交终态与占用。因此成功摘要通常并不抢在原worker停止之前。失败/中断或停止未核实的终态也有摘要，原every(resultSummary!==null)不证明成功；这种分支需根据实际状态和占用诊断，不能简单多等或把摘要条件改强称作根因修复。

当前未发现需要调整产品权限、停止顺序或预算的证据，不建议新增macOS独占、延时、重试或削减停止断言。

## 最小永久诊断提议

`diagnostic-only.patch` 只给原目标wait加catch。原等待predicate、预算、responder、成功断言不变；失败时在既有finally之前输出父/子/host状态、work、占用、工具操作结果、controlled请求类型及最近模型工具结果，然后原样throw原error。没有新通用helper、自动重试或额外宽限。本提议是失败可见性改进，不是原自然失败的修复。

提议基于83文件SHA-256 `6e76df008909b1e763e025642e180daf6493378fa12331a0f7b0e1ee9be24588`，候选SHA-256 `68f54743a7a643cc39682c095c2fc1d8c228896f5f785a8e2543020e39d9e862`。TypeScript静态解析无诊断；它尚未由本审查者应用或作为完整候选运行。两受控反例已验证诊断状态可区分，未为写报告重复执行。

## 证据索引与下一步

`prepared.json`、`controlled-variants.json`保存源文件和变体哈希；`first-result.json`、`series-results.json`、`four-siblings-result.json`、`paired-integration-result.json`、`controlled-results.json`保存命令/退出码/墙钟。原始输出为同名log。`evidence-index.json`将原/tmp快照路径映射到本目录的`snapshots/`，可整体持久保存，不只留下临时绝对路径。

下一轮固定候选完整检查若复发，必须据新catch保存的实际状态继续定位；若通过，仍须将本历史失败记为上游未归因，不能倒推已有根因修复。所有本轮诊断进程已结束；未运行全仓检查，未改主工作区。
