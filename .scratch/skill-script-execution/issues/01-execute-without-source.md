# 技能脚本直接执行且源码默认不进入上下文

Status: ready-for-agent

## 目标与边界

拥有者于 2026-10-29 要求制定方案，将技能附带脚本从“只能作为文本返回、不能直接执行”改为“可以执行、源码不主动进入上下文”，模型使用脚本无需理解实现。本轮交付方案与实施交接，尚未开始代码实现；行为、取舍与失败保证见[决策提案](../../../.agents/notes/proposed/feature/2026-10-29-skill-script-execution.md)。本任务涉及执行资源与恢复证据，采用[开发流程](../../../.agents/skills/development-workflow/SKILL.md)重流程。

拥有者逐项确认并最终确认整体方案：默认不读源码，审计或排障必要时可读；沿用任务现有执行资格、审批与沙箱规则；个人主会话仍委派；执行磁盘当前脚本，不复制技能包；复用 bash/run_command，受限环境只读开放本次发现的各技能真实目录，接受命令可读同包其他文件。新增可见性仅限技能资源，不开放整个 HOME，也不替代原权限校验。

不新增执行工具、配置开关、模板语法、解释器或依赖管理，不调整技能来源和仅显式调用资格，不改写历史，不提交、部署或发布。方案确认不等于已经完成实现及外部验收。

## 方案

| 步骤 | 实现入口与必须覆盖的调用方 | 交付要求 |
| --- | --- | --- |
| 1. 调整模型使用方式 | `packages/agent/src/skills.ts`；`apps/ruukoto/src/personal-skills.ts`；`personal-command-work.ts` 的 run_command 说明；按需核对 `session-factory.ts` 中当前政策 | 更新目录、正文、引用、显式展开和工具描述；正文加载/显式展开提供目标实际目录，引用路径以此解析；保持 cwd 与输出归属。skill 只读，按需源码读取和仅显式调用资格保留；新工具说明能解释旧历史禁令。 |
| 2. 接入 Coding 技能根 | `packages/agent/src/driver.ts`、`tool-router.ts`，复用技能库与 `LaunchSpec.readRoots` | 从原任务库取得候选，不在命令时重新发现技能；先算基础 spec，再按最终 mode 选择可用根。共享选择逻辑只处理新增技能根，保留原 roots/grants 的失败。最终资源及身份进入 worker key，变化后先停止核实再建。 |
| 3. 接入 Personal 原选择 | `apps/ruukoto/src/personal-model.ts` 的 `personalModelRequestSelection`；`personal-skills.ts` 的原 snapshot 核实；`personal-command-work.ts` 接纳、准备、恢复 | 从原请求 snapshotEntry 固定技能资源与身份，保存到命令原证据，不取 current。更新恢复精确校验；不修改命令工具名称、参数或主/子职责。仅在确需传递现有 readRoots 时改 `personal-command-execution.ts`。 |
| 4. 保留历史恢复 | 两产品技能加载、`expandSkillCommand` 与 PA `originalExpansion`；PA 新旧命令记录 | 保留精确旧展开生成路径；旧记录无新增字段时仍按旧结构验证，拒绝伪造与不支持版本；不重算或重写旧正文/哈希，不用当前库补历史挂载。 |
| 5. 测试与文档 | 下表用例；`docs/usage.md`、`docs/modules/agent-context.md`、`agent-tools.md`、`execution.md`、`personal-durable.md` | 同步真实调用说明、资源可见性、主/子职责与恢复；以实际最终范围更新本工单和提案，再进行独立实现审查。涉及的检查入口同步开发说明和 pre-push-checks；没有命令变化时不机械扩改 README。 |

根选择复用原生执行的保护校验：逐技能 realpath、去重，已被授权覆盖则保持原权限；拒绝新增会覆盖文件系统根或宿主 HOME 的根（包括技能符号链接的真实目标），新增根与可写根冲突、缺失、受保护或存在不安全文件别名时按技能报告不可用，不拖累其他普通命令。真正完全访问不因技能增加 readRoots；源任务完全访问而实际验证 spec 为 confirm 时仍补技能根。原工作区或原授权自身无效直接失败，不能当坏技能过滤。

目录复核与停止沿既有机制，最后复核后的并发变化仍可明确失败；不在已开始的执行失败后自动重试。新模型可见目录和诊断须进入实际工具结果/展开或现有持久证据，满足输入可重建要求。不得为此新增并行持久化状态机或把 skill 工具改为执行入口。

## 验收与证据

| 验收要求 | 最窄验证落点 |
| --- | --- |
| 无源码预读即可使用脚本 | 在临时 HOME 的技能夹具中放独有源码标记、同包资源和独有运行结果；扩展 `test/56-skills.test.ts`、`test/59-system-prompt.test.ts`、`test/personal-skills.test.ts`，核实正文/显式展开/请求不含源码标记，执行链没有源码读取，结果可核实；另验证按需读取仍有效。 |
| 正常工作与权限 | 执行真实脚本读同包资源、向原工作目录输出，拒绝向新增只读技能根写入及访问未授权包外资料；指向 HOME/祖先的技能链接不得增加整根可见性，原有授权完整覆盖时不收窄。覆盖 confirm/auto-review/full_access、最终降为 confirm 的验证步骤；`test/101-native-execution.test.ts`、`test/native-mount-protection.test.ts`、来源能力及工具资格用例按影响选择。 |
| 根故障与 worker 生命周期 | `test/100-worker-stop.test.ts` 覆盖符号链接、目录相等/嵌套、坏技能根隔离、目录身份变化、先停止再重建及停止未核实拒绝替代；已有工作区/grants 无效仍拒绝，效果未知不重放。 |
| Personal 原请求及历史 | `test/personal-command-work.test.ts`、`test/personal-skills.test.ts` 覆盖接纳后重启/刷新下一请求、原 snapshot 与 current 不混用、资源/身份篡改拒绝、旧无字段命令与旧显式展开恢复；按调用方影响追加 `personal-command-execution` 与 `personal-command-worker` 用例。 |
| 当前政策与工具资格 | 带旧禁令的 Code 历史恢复请求仍有当前执行说明；个人主会话仍只能委派，子 Agent 及 Code 的既有来源限制生效，仅显式技能未被模型自主加载。按影响选 `test/62-tool-availability.test.ts`、`test/subagent-source-capabilities.test.ts`、`test/111-workflow-capabilities.test.ts`。 |
| 实际执行和上下文效果 | macOS/Linux 分别真实验证受限根、同包读取、原目录输出与写/网络拒绝；个人命令的真实执行环境使用 `ssh tx`。复用现有 smoke 夹具完成两产品真实模型闭环，显式 `RUN_MODEL_CHECK=1` 且使用隔离档案/HOME；检查原请求快照与工具序列，记录前后 systemPrompt/toolSchemas 估算和代表性读取源码/直接执行链路的上下文差异。未执行或缺模型/平台前提记待验证，不记通过。 |

实施最小检查先 `npm run build:worker`，再按修改范围选择上表文件，执行 `npm run check:static`；原生平台前提与串行要求沿[检查集](../../../.agents/skills/pre-push-checks/SKILL.md)与[开发说明](../../../docs/development.md)。仅因明确要求、CI 诊断或实际跨全仓改动才跑完整 `npm run check`。旧 `56-skills` 的源码按需读取断言继续有效，`59-system-prompt` 中固定要求旧禁令的断言应替换。

本轮仅落盘方案，验证结果在[方案审查与检查记录](../evidence/plan-review.md)。实现工程验收待验证；两产品真实模型和必要平台证据未完成前保留缺口。没有新增主观视觉要求，人工视觉产品验收不适用；模型是否直接使用脚本属于闭环验收，不能因此豁免。全库根扫描可能增加启动成本，记录代表性库的观察结果，不设无依据的性能或 token 节省比例。

## 进展与交接

- 当前角色与阶段：方案交付；拥有者已确认全部范围，独立落盘方案审查通过、无阻断，不含实现。文档/笔记检查通过，完整静态检查受其他队列任务类型错误阻断，详见证据。
- 下一角色与动作：实施者从本入口开始，核实当前检出及其他任务的类型检查状态，按方案实现并留证；此次聊天只交付方案。
- 当前内容：基点与 HEAD 为 `5c55e96b5de38f068eabb0aa58b7885e9e085781`；本任务修改仅本工单、方案审查记录、proposed 笔记及 HOME 发现/个人技能历史两篇的提案互链，均未提交。其他 coding-message-control、core/runtime/legacy-import 与 sdk-steering 未提交改动属于其他工作，实施前重新核实影响，不能将 HEAD 视为完整待审内容。
- 阻塞与恢复条件：无方案阻断或待拥有者决定；实施前核实其他队列任务的未提交变更与静态缺口，实现及外部验收仍待执行。

## Comments

2026-10-29：拥有者逐项回答 Q1–Q5 选择推荐方案，并对 Q6 整体边界回复“确认”。只读探索已核实旧脚本文本禁令、原生目录可见性、PA 原请求选择与旧展开恢复约束；本工单承载确认后的当前方案。

2026-10-29：独立上下文 review_skill_script_plan 亲读落盘内容、相关源码与旧决定，结论为通过，无阻断和新增用户决策；原生文件别名须按最终授权集合判断的实施提醒及内容哈希见方案审查记录。工单仅回填状态与交接，方案和验收未改变。
