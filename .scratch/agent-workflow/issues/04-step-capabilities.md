# 工作流步骤权限与成果汇总

Status: resolved

## 目标与边界

落实[规格 A1、A2、A5、A6、A11、A12](../spec.md)，依[实施计划](../implementation-plan.md)二、三、六节把已保存的来源授权接到真实 Agent、业务工具与工作副本；不把普通 SubAgent 的工具范围一起放宽。

## 实施与交付

1. 增加由宿主绑定的步骤身份/执行画像，逐处核实工具装配、Driver.verifyMainBinding、host-data Accessor、SourceResolver、MCP、应用数据、scheduler、service 和跨步骤产物读取；列出来源与步骤可用能力的测试矩阵。
2. 每次模型请求与实际工具调用复核资料范围、配置代次和步骤收窄。记录所有新增模型输入；不复制主聊天历史、控制凭据或单次批准。
3. 接入文本/JSON 最终输出与 typebox 校验，保存原始结果及失败事实；格式错误不能证明此前工具未执行，不能触发有副作用步骤重跑。
4. 复用独立工作副本，宿主在停止核实与占用保护下冻结补丁字节、摘要和基线；独立验证者读取该成果，需要写入的检查在独立验证副本/临时区运行。验证记录绑定冻结成果与验证任务。汇总时占用副本和目标，重核当前摘要与验证一致，只套用冻结补丁，再在目标占用下检查组合结果；变化必须重新验证。
5. 回归普通委派、复用/关闭、MCP/服务审批、原生与完全访问、取消保留及不同来源的资料隔离。

主要落点为 core 身份与绑定、agent 的 tool-availability/driver/host-tools/source-ref 处理、runtime 的 SubAgentManager/work-copy、channels 的 SourceResolver、两产品的专属工具装配。

## 验收与交接

2026-10-13 工程验收通过，独立实现审查无未解决阻断。本单按重流程核实 03 的前置并沿已确认方案实施；权限接线与冻结成果在独立工作副本中实现后汇总。下一责任人为 05 的实施者，产品体验及真实模型/IM 联合验收由 07 持有，本单不声明其通过。

[03](03-runtime-and-store.md) 已于 2026-10-13 完成持久执行基础、真实本地宿主 worker 与独立工程审查，前置解除。当前已有宿主注入的 Agent/汇总适配器、步骤身份绑定、文本/有界 JSON 校验及原始输出保存；本单须将它们接到真实 Driver 与逐层权限门，不把基础库通过当作实际工具已获准。接口与事实见[工作流模块](../../../docs/modules/workflows.md)和[实施决定](../../../.agents/notes/implemented/architecture/2026-10-13-workflow-runtime-and-store.md)。

真实 Agent 适配器先登记 starting 句柄，再启动实际单元，stop 等待启动完成并保留真实身份；活动期间更新实际身份，取消后的身份更新须沿已登记句柄收尾，不能再登记新单元。03 的 109 只覆盖启动完成后的只读崩溃，04 补启动中取消、迟到身份及停止 false 的真实 Driver 验证，沿原 Task 与同一操作账本保留占用。

新用例覆盖来源能力、资料撤销、非法宿主身份、运行间产物隔离、验证者与修改者独立、汇总竞争和副作用未知。按实际改动选跑 `test/07-real-tools.test.ts`、`test/08-approvals.test.ts`、`test/10-access-modes.test.ts`、`test/63-approval-gate.test.ts`、`test/64-tool-op-ledger.test.ts`、`test/80-subagent-delegation.test.ts`、`test/83-subagent-worktrees.test.ts`、`test/84-subagent-integrate.test.ts`、`test/95-work-copy.test.ts` 和 `test/91-release-acceptance.test.ts`；模型上下文变化加 `test/60-context-prefix.test.ts`、`test/61-context-compaction.test.ts`。

负例必须包括验证通过后改动副本字节、续派产生新成果、验证命令写待审成果、脚本伪造通过记录，以及冻结补丁和工作当前摘要不符；旧验证不得放行新字节。还须验证父任务结束后的工作副本操作及该阶段停止未核实保留。按已确认的 A12，非 Git 批量修改在产生写入前拒绝，非 Git 分析及其他获准业务工具仍可用，两类路径分别覆盖。

`npm run check:static` 通过；agent-context、agent-tools、core、runtime、execution、products、scheduler、workflows 与开发测试导航同步。真实 Driver、Git、macOS/Linux 原生验证 worker 已验；模型为本地替身，不证明真实模型已经正确选择与运用工作流。04 不含主观界面或回报体验，因此本单产品验收不适用；双产品完整入口与真实模型/IM 验收仍待 05–07。

## 交付与证据

实际接线由 [WorkflowSteps](../../../packages/runtime/src/workflow-steps.ts) 与[实施决定](../../../.agents/notes/implemented/architecture/2026-10-13-workflow-step-capabilities.md)持有。Runtime 默认使用真实 Driver，保存实际来源能力、授权 ID、配置摘要和目录身份；装配、模型发送、意图、实际工具与宿主 Git 调用共同守门。main 仅取得原受控修改委派的五个编码工具，普通 SubAgent 不扩权。技能、依赖值、工作目录与显式资料读取可重建，记忆预览来源也持久记录并沿依赖闭包复核撤销。

修改成果冻结为原始补丁产物及摘要/基线，独立验证者在重建副本内执行；验证命令即使来源完全访问也使用原生沙箱，宿主文件写旁路关闭。通过记录绑定真实验证任务及账本，普通汇总入口拒绝工作流成果。汇总持续占用源、副本与目标，只套冻结字节并检查组合结果；变化、冲突、检查失败与副作用未知保留事实。启动中取消、迟到身份、停止 false 和父任务结束后的宿主操作沿原 Task 与同一账本收尾。

| 验证 | 实际结果与范围 |
| --- | --- |
| `npm run check:static`、`git diff --check` | 通过：全 workspace 类型、lint、笔记、文档与空白检查 |
| `npx tsx --test test/105-workflow-runtime.test.ts test/106-workflow-host.test.ts test/107-workflow-runtime-wiring.test.ts test/108-workflow-import.test.ts test/109-workflow-cold-recovery.test.ts test/110-workflow-workcopy.test.ts test/111-workflow-capabilities.test.ts test/112-workflow-real-steps.test.ts test/113-workflow-source-capabilities.test.ts` | 86/86 通过；之后新增输入汇总超限暂停用例，受影响 105/111/113 最新 52/52 复核通过 |
| 任务、权限、上下文、普通委派及副本回归 | 01、03、04、05、07-real-tools、08、10、18-model-selection、60、61-context-compaction、63、64、80、81、83、84-subagent-integrate、91、95-work-copy，共 170/170 通过 |
| MCP、个人工具、调度、服务与任务收尾 | 24、25、51-generic-scheduler、37、77-im-approvals、78、79、94 共 159/160 初验；37 的旧正文快照回归暴露业务行修订不该撤销快照，修复后该文件 22/22 通过，其余 138 项已过；28-main-data 加 113 共 47/47 通过 |
| 独立实现审查 | 审查者亲读规格、实际代码、文档和证据，执行 108 条不同用例；112/113 的 19 条复核通过，最后输入超限及目录创建失败边界也独立通过。权限交集、验证写回、普通汇总绕过、来源配置、取消和恢复的阻断全部关闭 |
| Linux `ssh tx` 隔离验证 | Node 24.21.0，110/112/113 初验 25/27，双产品端到端在默认 15 秒等待超时；核实每例约 15–16 秒后调整测试等待，两条 2/2 复验通过。真实 Git、worker、原生验证写保护和业务/MCP 隔离均覆盖；没有把初次超时记为通过 |

Linux 隔离副本的 `setup -- --skip-hooks` 在 foundation 的依赖安装遇到 ENOSPC，未记 setup 通过；根依赖安装成功，`build:native`、`build:worker`、`build:script` 实际通过后执行上述最窄用例，新增临时依赖已清理。没有跑全量 `npm run check`，没有合并、部署或发布。schema 更新为 37，旧档案按既有规则拒绝启动、不补造来源授权。

05 可以接人工回答、最终回报与调度整项收尾；运行默认已有真实步骤适配器和冻结汇总入口，05 不需重复放宽工具清单。真实模型、真实 IM 与完整产品体验仍保留为 07 的外部验收，恢复条件是完成 05/06 产品入口并具备模型/平台前提。
