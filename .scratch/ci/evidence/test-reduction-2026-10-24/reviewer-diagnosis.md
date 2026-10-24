# 最终冻结轮ordinary reviewer等待失败：阶段定位

原完整检查指纹9e2b219，1220.651秒exit1，唯一失败栈为workflow-role-integration:91的“普通审查完成”。delegate已经返回，等待子Task completed；workflow.start在下一行，尚未执行，因此不是工作流review、角色改写或ask阶段。该成功专用predicate也会把failed/interrupted/canceled隐藏成60秒超时。最终错误未记录child状态或ops，不能从65.437秒耗时推出具体原因。

finally先释放父模型门再shutdown；后者停止runtime、关闭mock、删除整个fixture。只读扫描系统tmpdir、/tmp及/private/tmp未发现workflow-reviewer-parity目录，历史任务和模型现场已不能从该目录回收。

隔离diagnostic.test.ts只替换普通等待：failed/interrupted/canceled立即失败，保持原completed条件和60秒预算，在委派/完成/失败时保存父、子、capture/create宿主Task、work、occupancy、tool ops、confirmations、模型末段与JSONL尾段，所有快照仅写本/tmp目录。依赖仍导入冻结主源码；没有修改主工作区。

实际执行两次诊断：

- 原并发2的诊断workflow-role-integration + workspace-snapshot-runtime-boundaries：17/17，目标10.868秒，Node整个命令duration 58.899秒，exit0。ordinary约1.76秒由queued到completed，宿主stopVerified为true，模型请求1→3。
- 原排序尾部从subagent-role-driver至workspace-snapshots共13文件，原并发2：101/101，完整进程80.832秒，exit0，未触发240秒监护。process-marker只记录测试文件进出，证据为tail-processes.jsonl、tail-result.json。目标启动时同跑subagent-workspace-snapshot，随后另一slot切到workspace-snapshot-runtime-boundaries；具体重叠见actual-tail-overlap.json。此事实只属于本诊断轮，历史报告顺序不能证明历史同跑伙伴。

两次均未复现，不能称为已修复或把全绿当归因。曾计划最多6次全新进程冷启动目标，但在audit_legacy发现native-started发布窗口并由root接管测试安排后，序列没有启动；实际目标观察仅上述两次。独占native权限已移交audit_legacy，本agent转为方案审查。

只读核对冷启动：runtimePaths每次native launch都运行，没有所见应用内缓存；helper自检和监督器启动各5秒，ToolWorkerHost在launcher成功后ready预算30秒。删除旧personal循环可能改变进程内JIT/OS缓存热度，但没有历史child错误，不可据此归因。新发现的可信bootstrap半发布竞态由独立受控实验验证，方案审查见/tmp/ruukoto-native-marker-plan-review.md；它也不替代历史socket/Task现场。
