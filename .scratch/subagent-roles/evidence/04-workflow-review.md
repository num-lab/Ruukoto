# 04 工作流接线独立实现审查

> 本文部分原始证据已移出 Git；原路径保留用于查找原件，见[归档说明](../../git-history-cleanup/archive.md)。

当前审查对象未发现未解决阻断；可信注入执行器回归已修正并亲自执行窄回归验证。审查以工单 04、规格 R1/R7/R10/R12–R14、执行计划第四节及 04 起点源码为依据；主工作区只读，执行探针与测试均在本目录的隔离副本。最初试验发现的零工具资格与已完成步骤缺角色/执行快照的冷恢复漏洞已修复，最终反例重新执行通过。

## 审查对象

04 起点为 `/var/folders/y4/36h8kvvd4q52vjptp522rzfc0000gn/T/ruukoto-04-baseline-lu5od7hu/source`。审查覆盖 runtime 的 `workflows.ts`、`workflow-steps.ts`、`runtime.ts`、`workflow-library.ts`、`subagents.ts`，agent 的 `subagent-tools.ts`、`workflow-tools.ts`、`tool-router.ts`，core 的工作流定义、schema/控制协议版本及相关导入约定；沿调用链读取 Driver 的来源预检、实际工具集合、启动与停止，以及 WorkCopyManager 的冻结、验证副本、基线和汇入检查。

`04-review-inputs.json` 固定实际运行测试的生产文件；`04-review-current-inputs.json` 固定审查结束前的生产和文档对象。首轮测试后另有 Note 锚点、提示澄清与可信注入执行器验证装配修复；后者由 `04-adapter-review-inputs.json` 固定，并执行修补前后回归与默认严格消费负例。新集成测试由另一上下文独立编写和执行，本审查只读核实其证明力度，最终文件已固定到结束输入清单。

## 契约核实

- 工作流按固定 roleCatalog 的 role 选择定义，省略为 general；preflight、任务登记和恢复绑定采用同一定义。能力画像复用 subAgentSourceProfile；来源能力、模型和配置不由角色名或工作流身份提供。
- target 与角色独立；有代码目标准备 Git 当前内容副本，无目标与无 verify 时仍可在独立目录使用来源允许的工具。verify 必须依赖引用步骤并与 target 互斥，始终叠加 confirm、protectSource、原生验证启动器和编码工具限制，自定义 full_access 角色不能放宽宿主限制。
- 验证资格需要独立 Task、合法输出、至少一次真实编码工具调用和全部账本操作成功；空账本、失败、缺结果和效果未知均不能由 passed:true 覆盖。汇入再次核实账本、两步角色/来源绑定、工作与运行、停止结论、快照摘要、冻结产物和实际补丁字节。底层 03 的目标基线与组合检查被保留。
- assertExecution 不要求 Task 仍在运行，因此可核实已完成结果；冷恢复、排队启动、resume、依赖结果消费和汇入均复核持久定义、执行快照和目标基线，缺记录不补当前配置、不换 Task 或请求键。
- 普通工具和 Runtime 委派拒绝 mode，工作流在具体调用校验时拒绝 mode；角色文件 permissions.mode 继续表达访问策略。普通汇入、继续及复用不能接管工作流成果。
- 定义/运行接口版本为 2，新摘要包含版本，旧摘要保留；未标记命名文件按旧接口可查，显式保存后才有新版资格。旧运行可查和取消，不能恢复。schema45、协议26沿原严格拒绝政策，导入不丢弃工作流绑定或补授权。
- 计划第四节与当前实现一致；未发现需要改变已确认目标、权限或验收边界的方案问题。

## 亲自执行的最小验证

| 对象 | 实际结果 | 证据 |
| --- | --- | --- |
| 零工具 verifier 仅返回 passed:true | partial；verification.passed=false；账本为空；merge skipped；来源仍为 base | `workflow-audit-probe.mts`、`04-zero-tools.log` |
| 已完成验证后移除角色定义，停止并冷启动 | paused/definition_missing；resume 按具体 code 拒绝；0 新模型请求；来源仍为 base | `workflow-recovery-audit-probe.mts`、`04-cold-corrupt.log` |
| 已完成验证后移除执行快照，停止并冷启动 | paused/execution_missing；resume 拒绝；0 新模型请求；来源仍为 base | 同上 |
| 私有基线文件丢失，停止并冷启动 | paused/snapshot_corrupt；resume 拒绝；0 新模型请求；来源仍为 base | 同上 |
| `test/117-workflow-library.test.ts`、`test/workflow-interface-version.test.ts`、`test/subagent-role-runtime.test.ts` | 13/13 通过，0 跳过 | `04-version-role-tests.log` |
| 可信注入的 109 只读冷恢复与 115 dev 最终回报 | 修补前 0/2，修补后 2/2；证明回归检查会捕获原错误 | `04-adapter-before-fix.log`、`04-adapter-targeted.log` |
| 装配修复后默认 Driver 的已完成依赖缺定义或 execution | 两相均拒绝 ask 回答为 stale_answer；问题仍 pending，模型 calls=1、attempts=1 不变 | `workflow-default-consume-probe.mts`、`04-default-consume.log` |

冷恢复探针使用已实际 write 的修改 Task 和已实际 read 的验证 Task，然后在 ask 阶段损坏单个记录；不是用宿主替身直接写入 passed 资格。以上 Runtime/Driver/worker 与 macOS 原生沙箱实际运行，模型由本地替身驱动。

## 独立测试审阅与返工

只读审阅 `workflow-role-integration.test.ts`：双产品 reviewer 检查真实 bash、精确工具集合、同来源快照、roleDigest、固定正文、当前 staged/unstaged/new 文件、来源写入被拒及副本产物；general 与自定义 full_access 的 verify 检查宿主收紧和零工具失败；冷恢复检查原 Task/尝试/执行记录和字节不变；旧 mode 在已有写入后失败检查不重放。

已反馈并由测试作者修正的两处夹具错误：definition TEXT NOT NULL 的缺失模拟应写 JSON 文本 null；合并接口版本拒绝后，旧 mode 暂停的 resume 应断言拒绝，不能期待脚本恢复执行。另发现并反馈主仓 `test/125-agent-wait.test.ts` 活跃脚本残留 mode:verify，主仓已移除。新九例文件已核实上述返工实际落实。另建议的低成本 target/verify 互斥、verify 未声明依赖与未知效果消费现均已落实：105 新六例分别拒绝旧 analyze/modify/verify、verify+target、缺依赖与未知角色，断言旧 progress 保留、attempts=0、无 Agent 执行/SubAgent；112 的 ledger_unknown 先确认真实验证已通过，再只改变工具账本 effect_unknown，要求汇入以 verification_required 拒绝且源字节保留，直接证明消费时重验账本。新增 SDK 负例通过真实模型工具调用验证 mode 字段未被 schema 静默丢弃，错误结果含 role/target/verify 升级指引，且无工作或 SubAgent 登记。

九例作者分组日志已逐项核对：04-role-test-author.log 记录 6/9，通过的六项未受后续 reviewer 夹具修正影响；双产品 reviewer 在 04-role-reviewer-author.log 为 2/2，definition_missing 在 04-role-definition-author.log 为 1/1。可据此说九例各有通过证据，不能把初轮整组称为全绿。最终 reviewer responder 只增加独立最终汇报分支，原四次审查请求的精确工具、固定正文、来源保护及计数断言保留，不降低原审查证明。

## 已修复：可信注入执行器回归

另一独立审查的跨用例检查发现 109 与 115 的可信注入路径失败，根因是 Runtime 对可信 workflowAgent 刻意关闭 Driver preflight/verifyExecution，而新 verifyResultSources 无条件要求 Driver execution 快照。这是装配回归，不是环境缺口。修复复用宿主提供的 verifyExecution 回调，使共同来源引用重核沿预检相同的可信装配选择执行证据策略；默认 Driver 在 WorkflowSteps 与 Coordinator 均固定安装 assertExecution，agent()/integrate() 仍直接严格核实，不能根据记录是否存在降级。可信注入执行器继续承担自己的账本和停止合同，不能凭返回 passed 文本获得默认冻结汇入资格。文档和笔记已同步该责任。

我在修补前的独立副本亲自得到 109 readonly 与 115 dev 回报两例超时，更新四行装配后同断言 2/2 通过；随后专门在默认装配下移除已完成依赖的角色和执行快照，两相均拒绝消费。因此该修复既恢复已有可信注入合同，也未重开前述缺记录漏洞。

## 收尾材料复核

只读核对主仓 `04-params-runtime-tests.log` 的 44/44、`04-old-mode-sdk-test.log` 的 1/1、进行中的 `04-native-workflow-tests.log` 中 ledger_unknown 已通过条目，以及九例作者原始分组日志和说明。未另起 native 测试，避免干扰实施者的最终串行 native 组。最终生产相对已测对象只增加具类型错误的捕获判别、Note 锚点和文字澄清；默认 Driver 的严格装配与冻结汇入条件没有放宽。

HTTP 审批的两个零调用断言在 208 项跨组首次检查失败，随后 `04-http-recheck.log` 孤立 2/2 通过；原因尚未证明，不归为已排除的环境噪声，也不把跨组首次检查记为通过。该限制须随工程记录交付。此报告未找到它们对应于 04 生产差异的具体实现缺陷；必要进一步诊断仍由实施者及联合验收持有。

## 未覆盖范围

未重复全仓检查，未运行 Linux、真实模型或真实 IM；未把仍在运行的最终 native 组预记通过。这些不由本报告冒充通过，双产品真实模型与组合产品验收仍归 05。本报告证明当前离线工程接线与所列回归，文档及新集成测试发生后续实质变化须复核受影响部分。
