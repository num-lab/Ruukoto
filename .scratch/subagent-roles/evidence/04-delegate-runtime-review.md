# 工单 04 独立实现审查（版本作者审查非本人实现）

审查角色：独立实现审查。结论：所列范围无未解决阻断；发现的注入执行器回归已修复并复核。

## 范围与依据

相对 `/var/folders/y4/36h8kvvd4q52vjptp522rzfc0000gn/T/ruukoto-04-baseline-lu5od7hu/source` 审查普通委派旧 mode 替换补丁，以及主实施者的 workflow/runtime/ToolRouter 接线。依据是工单 04、规格 R1/R7/R10/R12–R14、实施计划第四节及 development-workflow。被审源码摘要见同目录 `independent-review-inputs.json`。本审查者实现的 core/workflow、schema、protocol 常量与 workflow-library 不计为独立审查通过范围。

## 已核实

普通 delegate 在工具与管理器入口显式拒绝 mode（含属性存在但值为 undefined），不登记新工作或任务；target 纳入幂等摘要，角色仍由已保存快照及来源能力决定。工作流 agent 以 role/target/verify 选择行为；verify 与 target 互斥，验证始终按宿主受限策略、编码工具与账本形成资格；普通续派、汇入、取消不能接管工作流执行。新运行保存接口版本；launch、角色目录读取、实际执行绑定、恢复与结果消费使用对应版本及快照，不读取最新版角色或重放旧步骤。取消、等待与唯一汇报仍沿各自原持有者。

## 发现及返工

首次在隔离副本运行 105、109、subagent-role-runtime 共 48 条时，47 过、1 失败；109 的“只读 Agent 真实崩溃后先核实占用与脚本，再恢复为一次新的执行尝试”连续单跑复现：第二 Task 已 completed，步骤 completed/resultRecorded=true，但交付为空且运行 paused/source_invalid。根因是 verifyResultSources 新增无条件 assertExecution，误要求可信注入 workflowAgent 的合成执行拥有真实 Driver 快照，而原装配明确不为注入执行器运行 Driver preflight。

主实施者将执行证据核实作为 WorkflowStepsDeps.verifyExecution 回调，与已有 preflight/Coordinator.verifyExecution 的可信宿主装配边界对齐。默认 Driver 路径仍安装严格 assertExecution；没有按记录是否存在跳过，也没有模型/控制面宽松参数；Steps.agent 与 integrate 的直接断言保留。该修复已静态复核，并以下述重验解除阻断。

## 独立执行证据

隔离副本为 `/tmp/ruukoto-04-version.Gz2kbA/source`，未修改主工作区。测试执行时未把 stdout 重定向到独立文件；结论依据是本轮工具实际响应。事后归档的响应摘录为本目录 `review-*-tool-output.log`，命令、退出码、源码阶段与环境限制见 `independent-review-provenance.json`，归档没有重跑测试。首次失败阶段未保存完整源码摘要，修复后对象摘要见 `independent-review-inputs.json`。

- `npx tsx --test test/subagent-role-runtime.test.ts test/105-workflow-runtime.test.ts test/109-workflow-cold-recovery.test.ts`：首次 47/48，失败如上；105 与普通角色组全部通过。
- 修复后 `npx tsx --test --test-name-pattern='Runtime 的运行授权独立|只读 Agent 真实崩溃' test/107-workflow-runtime-wiring.test.ts test/109-workflow-cold-recovery.test.ts`：2/2。
- 修复后 `npx tsx --test test/subagent-role-runtime.test.ts test/107-workflow-runtime-wiring.test.ts`：12/12，含共享三个名额、暂停/恢复、宿主操作只执行一次、人工等待及唯一汇报。
- 修复后 `npx tsx --test --test-name-pattern='ask 后冷恢复遇到 execution_missing' test/workflow-role-integration.test.ts`：1/1，默认真实 Driver 的已完成验证缺执行快照时暂停，恢复拒绝，旧 Task、尝试、记录及字节不变。

## 未覆盖

未作为独立证据重验本人实现的 core/library；未跑全量检查、真实模型或 Linux。真实模型、双产品组合及完整外部验收仍归工单 05；文档和决策笔记由另一独立审查范围核实。
