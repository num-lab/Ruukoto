# 工作流步骤权限与成果汇总

Status: ready-for-agent

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

[03](03-runtime-and-store.md) 已于 2026-10-13 完成持久执行基础、真实本地宿主 worker 与独立工程审查，前置解除。当前已有宿主注入的 Agent/汇总适配器、步骤身份绑定、文本/有界 JSON 校验及原始输出保存；本单须将它们接到真实 Driver 与逐层权限门，不把基础库通过当作实际工具已获准。接口与事实见[工作流模块](../../../docs/modules/workflows.md)和[实施决定](../../../.agents/notes/implemented/architecture/2026-10-13-workflow-runtime-and-store.md)。

真实 Agent 适配器先登记 starting 句柄，再启动实际单元，stop 等待启动完成并保留真实身份；活动期间更新实际身份，取消后的身份更新须沿已登记句柄收尾，不能再登记新单元。03 的 109 只覆盖启动完成后的只读崩溃，04 补启动中取消、迟到身份及停止 false 的真实 Driver 验证，沿原 Task 与同一操作账本保留占用。

新用例覆盖来源能力、资料撤销、非法宿主身份、运行间产物隔离、验证者与修改者独立、汇总竞争和副作用未知。按实际改动选跑 `test/07-real-tools.test.ts`、`test/08-approvals.test.ts`、`test/10-access-modes.test.ts`、`test/63-approval-gate.test.ts`、`test/64-tool-op-ledger.test.ts`、`test/80-subagent-delegation.test.ts`、`test/83-subagent-worktrees.test.ts`、`test/84-subagent-integrate.test.ts`、`test/95-work-copy.test.ts` 和 `test/91-release-acceptance.test.ts`；模型上下文变化加 `test/60-context-prefix.test.ts`、`test/61-context-compaction.test.ts`。

负例必须包括验证通过后改动副本字节、续派产生新成果、验证命令写待审成果、脚本伪造通过记录，以及冻结补丁和工作当前摘要不符；旧验证不得放行新字节。还须验证父任务结束后的工作副本操作及该阶段停止未核实保留。按已确认的 A12，非 Git 批量修改在产生写入前拒绝，非 Git 分析及其他获准业务工具仍可用，两类路径分别覆盖。

每次实际修改运行 `npm run check:static`，同步 agent-context、agent-tools、runtime、execution、products 与受影响个人业务模块说明。工程与真实执行验收待执行，不把假 Agent 证据写成模型已经正确运用工作流。
