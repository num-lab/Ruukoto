# 工作流共享角色、冻结验证与旧接口升级

Status: planning

## 目标与边界

实现[规格 R1、R7、R10、R12–R14](../spec.md)，工作流使用同一角色库与来源能力，并保留不可伪造的冻结验证和汇入资格。拥有者已确认 Q1、Q6、Q9 及整体契约。依赖 01–03；不合并工作流与普通委派生命周期，不重开工作流 08、10。

## 方案

1. 按[计划第四节](../implementation-plan.md#四工作流验证与接口替换)替换 agent 步骤的 mode 参数，接 role/target 与运行固定的角色目录；保留 verify 引用作为宿主验证操作语义，与任意 target 互斥。
2. 冻结捕获基线上的子增量，在独立验证副本中执行；始终采用宿主受限验证策略与编码验证工具，角色不能放宽。验证任务、工具账本、基线和冻结摘要共同形成验证记录。
3. 汇入重新核实冻结字节、目标基线与组合检查；普通 integrate/续派不能接管工作流成果。取消、恢复、结果消费与唯一汇报继续各归原持有者。
4. 普通工具和工作流参数入口明确拒绝旧 mode；命名定义/运行保存接口版本，旧定义可查而新启动需保存新版本。更新 workflow_instructions、所有调用、示例、fixture 和 smoke；历史文件不改写。
5. 同步 workflows、runtime、agent-tools、core/control 实际改动及 usage/README 命令说明；若 schema/协议改变，同步双向导入和旧客户端拒绝，不为旧记录补授权。

## 进展与交接

独立方案审查已通过，无未解决阻断；实现前置 01–03 尚未完成，当前不标可实施。规划基点和当前 HEAD 为 `ec45979fc94f9828cd902620752c059867b4de15`，分支 `Eitrous/agent-workflow`；本单为未提交规划文件，内容由[审查输入清单](../evidence/plan-inputs.sha256)固定，方案结论见[独立审查](../plan-review.md)。下一角色核实 01–03 接口与基线后转 ready-for-agent 并接线；发现冻结记录不能证明实际汇入字节时退回 03/本单，不降低 R10/R12。保留工作流归属拒绝普通入口接管的现有保护。

## 验收与证据

工程待验证，产品待验收。相同 reviewer 普通审查与工作流验证都能运行；verify 使用 general 或自定义角色仍受宿主隔离；伪造通过文本、缺工具、工具失败、未知效果、冻结后修改、换目标及原工作区并发变化均不能获得汇入资格。冷恢复不读取角色最新版，不因旧接口重放副作用。

运行 npm run check:static，定向选择 test/105-workflow-runtime.test.ts、test/108-workflow-import.test.ts、test/109-workflow-cold-recovery.test.ts、test/110-workflow-workcopy.test.ts、test/112-workflow-real-steps.test.ts、test/117-workflow-library.test.ts、test/118-workflow-entries.test.ts；触及工具提示与来源再加 111/113/62 对应文件。agent_wait 与侧栏按实际接口变化补 125/126 用例，不机械重跑不受影响体验。

实现须独立审查，05 负责真实模型、双产品及组合验收；旧 07/08/10 的通过不能复用为新角色执行通过。

## Comments

2026-10-14：verify 是冻结成果验证语义，移出角色模式后仍须由宿主提供证据，不能退化成 reviewer 的 prompt。
