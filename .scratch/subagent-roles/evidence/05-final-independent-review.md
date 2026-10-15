# 05 最终独立实现审查

结论：本轮发现的目标摘要碰撞、缺来源记录仍自动送达/等待消费两项实现阻断，及相关过期夹具，均已按真实反例完成返工和非作者复验；最终 25 项修改与独立副本逐项同哈希，修复范围内没有未解决的实现阻断。此结论不等于完整 npm run check 通过，也不代拥有者批准产品体验或外部平台效果。原基线完整 check 实际退出 1，49 项失败保留；修后分组验证须按各自对象判断，不能合成一次全量绿。

审查者为独立上下文 `/root/requirements_audit`，不编写生产补丁、不写主工作区；所有独立探针、执行与报告仅在 `/tmp`。接手基线为 `5f9da455072d68180ef19fc92ad02070cea583c1`。直接读取规格、01–04 工单与审查、相关决定、实际源码/调用方/测试和文档，作者总结只作导航。root 接手时逐项匹配的最终 04 清单 40/40 与 77/77 仅支持未被后续改变的范围；本轮 25 项修改由这里的新证据替代旧结论，01–03 已被后续替换的旧清单不继续当作当前哈希证明。精确对象见 `05-final-independent-inputs.json` 与 `.sha256`，不把会继续更新的工单状态或本报告本身放入被审实现清单。

## 已关闭的实现阻断

**目标摘要碰撞，归 04。** 原 `subagent-tools.ts:281` 对 target.trim() 计算摘要，却把原 target 交给 WorkCopyManager 按原路径解析。两个真实非 Git 目录 `foo` 与 ` foo ` 在同请求键下静默返回第一份工作。当前行与 `.scratch/subagent-roles/evidence/04-delegate.patch:79` 相符，归属是 04 普通接口迁移，不笼统归给 02。root 仅让摘要保留原字符串，并扩展真实工具边界断言和模块说明；独立 role-runtime 全文件 8/8。原真实两目录探针修后第二次得到 request_conflict，两摘要不同，原工作、子任务和目标保持一份。原反例和修后输出分别为 `05-target-digest-probe.log`、`05-target-digest-probe-after.log`。

**缺记录仍自动送达和汇报，归 02。** 真实完成子 Task 删除 read_scope.execution 后，原父模型在调用等待前已自动收到该子摘要，agent_wait 又从当前配置/授权补造来源并返回 reason=result、报告归属及 stopVerified=true。当前 `runtime.ts:1136` 按截止目标 Task 的历史和已冻结报告依赖核实角色、完整执行记录、真实归属、权限、资料与记忆；`:1187` 只取原始已保存来源，取消缺记录的当前配置 fallback；`:1224` 复用该核实，不让未来复用的新任务扩大旧报告依赖。消息允许合法额外收紧，不要求实际模式机械等于来源模式。

`ParentDelivery` 的候选装配、普通结果/消息注入、结果登记、唤醒准入及响应消费共用来源核实；Driver 在发请求、调用及接受响应时重核，main/scheduled 唤醒也核实其真实子 Task/消息绑定。新唤醒拒绝保留 execution_missing 等具体原因，不误称 work_canceled；实际取消仍沿原行为。调度收尾把已知坏来源记为失败事实，避免因没有唤醒而永久等待。未知异常上抛，坏记录保留原 Task、结果、账本和字节，不重放、不从当前角色文件猜恢复。拥有者显式 subagent_result 历史查询仍沿原合同，不扩大为删除或隐藏事实。

独立六文件 35/35，包括新增八个真实 Runtime/Driver 正负例、等待报告/介入/分组及 GitHub 45/46。原反例转预期后亲自确认：父请求没有子摘要，等待工具返回 source_invalid/isError=true，原 child 结果不改、不重跑。记录见 `05-independent-source-fix-tests.log` 和 `05-wait-missing-execution-probe-after.log`。新角色、来源撤销、模式绑定、未来复用、响应窗口及唯一报告均有窄断言；并未仅检查工具名或最终模型自述。

## 夹具与调用方闭环

- demo 新增 task.memory_accessed 合成事件并继续由数组自动编号；上下文分类从过期 15 改为 16，并明确断言 subagentRoles 中文标签与零用量。独立同一命令两例修前 2/2 红、修后 2/2 绿，没有改 selector 或事件类型。
- 86-messaging 的 general 工具与真实已钉定 execution.tools 全量精确比较，另断言 bash；三个 busy Task 沿真实 join/a Task 的 readScope、parentTaskId 和 sourcePermissionVersion。首版仅补 scope 时相关六例虽绿，却产生 execution_binding_invalid，因仅等 resultSummary/登记数而掩盖了消息 Task 失败。该原日志保留；最终增加真实 completed 和 CAP-Q 模型调用恰一次断言并补齐父绑定，独立完整 messaging/recovery 13/13，未再出现该来源错误。
- 86-recovery 固定评审由实际 Orchestrator、有效 GitHub 事件、已完成 confirm 父轮及可信 hostReview 入口初建；只暂停已登记子队列制造冷恢复，不再把运行过的普通身份 SQL 改成宿主角色。仍明确无普通 execution、固定角色摘要、恢复模型恰一次；五例单独及最终组合均亲自通过。
- 41 用真实 endedAt 与内容 hash 构造旧资料引用，继续断言授权拒绝；84 保留 TUI/dev 非 IM 委派及零 IM 汇报，内部非拥有者事件改为 source_forbidden 且零新工作/子代理。独立受影响两例 2/2。
- 123 原 low 档在已配置 deepseek/deepseek-flash 启动即 thinking_not_supported，零 Task/模型请求；test-only 改为 off，生产模式不变。首个 off 真实编码场景正确因输出 schema 拒绝合法 passed+reason，未汇入。宿主要求 reason，规格与模块文档允许可选 reason；最终夹具只补可选 reason:string 并同步请求，passed 必填、additionalProperties:false 保留。独立只读真实 Task/JSONL/工具账本，亲自用实际 compileWorkflowOutput 证明旧 schema 拒、修后接收该真实结果，同时缺 passed、错误 reason 类型和未知字段仍拒。原失败场景不恢复；新真实模型场景由 model_acceptance 单列。正式文件离线执行仍 0 pass/2 skip，明确不记真实模型通过。

## R1–R14 最终对应

| 要求 | 代码与调用方依据 | 本次判断与证据界限 |
| --- | --- | --- |
| R1 | 普通/工作流沿 runtime 的共同来源、Driver.preflightSubAgent 和 subAgentSourceProfile | 共用角色与基础能力，工作流仍额外持有编排/冻结验证；两入口分开验证，不凭同名推断。 |
| R2 | subagent-role-library.ts、subagent-roles.ts | 实例目录新增/覆盖、坏覆盖不兜底、非法目录/链接/编码/读取竞态；独立目录用例通过。 |
| R3 | 内置 general/reviewer、默认角色选择、Driver 实际工具装配 | 默认 request/key 与真实 bash 的工程证据由平台执行持有；未把清单或模型说“能执行”当实际调用。 |
| R4 | 角色最小字段解析、任务来源模型、系统 prompt 追加与签名 | 没有模型覆盖/角色继承/模板新面；Runtime/Driver 固定正文、继承及重建用例亲自通过。 |
| R5 | subAgentAccessPolicy、native/protect_source 门、执行器及宿主文件入口 | 策略全矩阵亲自通过；双平台真实原目录/index/别名拒写依平台原日志，不由纯函数通过替代。 |
| R6 | Driver.preflightSubAgent 的 MCP 发现和显式工具缺失原因、发送/调用同一集合 | 亲自执行缺工具/缺远端/schema/配置变更等正负例；真实外部 MCP 未验证。 |
| R7 | SubAgent.definition、工作流 roleCatalog、Driver.verifyRoleDefinition、结果消费核实 | 编辑/删除/复用/消息/冷恢复不换版本；本轮补齐缺记录等待和送达拒绝。 |
| R8 | 来源/grant IDs、记忆读取事件、项目指令/技能版本、prompt/JSONL | 独立通过实际输入重建、资料/记忆/MCP 撤销与旧上下文拒复用；不自动复制完整父聊天。 |
| R9 | 无 target 独立目录，显式 target 才准备代码目标 | 无目标业务不要求 Git；目标原值幂等反例已闭合，角色名不提供目录资格。 |
| R10 | 当前工作区捕获、私有基线/物化、完整文件核实与子增量汇入 | 03/04 机制报告只沿匹配范围使用；最终真实 Git/native 组合由 root/Linux 原证据持有。 |
| R11 | 非 Git direct/gitOnly 拒绝、目录占用、agent_wait 让出/重取 | 真实非 Git 写入等待期间父聊天与占用保留依实际 worker 组合；本轮来源拒绝不删除该能力。 |
| R12 | workflow-steps 的 verify 收窄、非空真实账本与冻结汇入门 | passed 文本不能覆盖失败/未知效果；普通 reviewer 与宿主 verify 保持分开。 |
| R13 | 普通工具/管理器/工作流拒 mode；定义显式接口标记与历史保留 | 真实 SDK 旧字段拒绝、旧定义/运行查询取消、旧协议拒绝亲自通过，不自动转换/复跑。 |
| R14 | 完整快照/摘要、截止依赖、送达重核、停止/效果未知及报告账本 | 两项真实反例已闭合；未来复用不污染旧报告、缺损来源不补造/重放，真实平台与体验限制另列。 |

GitHub 可信固定入口单独核实：HOST_REVIEW_DEFINITION 不经过可覆盖 general/reviewer；保留 completed confirm 来源资格、只读 read/read_artifact/只读 MCP、禁消息、不可普通复用、原键冷恢复及唯一归档。35 例内的 45/46 实际 Runtime/mock MCP 断言伪造 bash、下级委派和写/未知 MCP 不到远端；新校验也不要求宿主评审具有普通 execution，不从通用默认新增 shell。

`docs/usage.md:230–243` 已逐项核对：实例路径、文件名、最小示例、字段/冲突、安全读取、坏覆盖诊断、修后仅新对象生效、固定恢复、Git 不复制忽略依赖及获准位置准备、非 Git 与接口升级。新增来源与目标说明和实际代码一致；未把“缺依赖报告”写成已准备好依赖。角色编辑、错误是否足够清楚及当前内容审查的主观体验仍交拥有者。

## 本上下文亲自执行

各数字是对应实际批次，不累加重复用例。原命令、原 stdout、失败与探针均在归档内。

| 实际检查 | 结果 | 原日志 |
| --- | --- | --- |
| 初始 role-library/definition-core/capabilities/45/46/126 六文件 | 51/51，0 skip | 05-independent-contract-tests.log |
| 来源能力指定十三项，含资料/记忆/MCP/工具/指令重建 | 13/13，0 skip | 05-independent-source-tests.log |
| role-runtime/role-driver/interface-version 三文件 | 13/13，0 skip | 05-independent-role-recovery-tests.log |
| target 修后 role-runtime 全文件与原真实目录探针 | 8/8；第二次 request_conflict | 05-target-independent-tests.log、05-target-digest-probe-after.log |
| demo/分类两条原失败最窄回归 | 2 红 → 2 绿 | 05-independent-stale-fixtures-before.log、05-independent-stale-fixtures-after.log |
| 来源修后八新例+等待/介入/分组/GitHub 六文件 | 35/35，0 skip | 05-independent-source-fix-tests.log |
| 原缺 execution 反例修后预期 | 拒等待、零坏摘要注入、保留结果 | 05-wait-missing-execution-probe-after.log |
| 最终 messaging/recovery 两个整文件 | 13/13，0 skip | 05-independent-final-messaging-recovery.log |
| 最终 41/84 两条受影响调用方 | 2/2，0 skip | 05-independent-final-caller-fixtures.log |
| 真实模型旧输出的实际 schema 正负核实 | 六项断言通过，无新模型调用 | 05-independent-model-schema-probe.log |
| 正式 123 最终文件，RUN_MODEL_CHECK=0 | 0 pass / 2 skip，离线门保留 | 05-independent-model-fixture-final-offline.log |

运行原命令包括 `npx tsx --test test/subagent-role-runtime.test.ts`、`npx tsx --test test/subagent-result-source-boundaries.test.ts test/125-agent-wait-report.test.ts test/125-agent-wait-attention-report.test.ts test/125-agent-wait-group-boundaries.test.ts test/45-github-events.test.ts test/46-github-recovery.test.ts`、`npx tsx --test test/86-subagent-messaging.test.ts test/86-subagent-recovery.test.ts`、`npx tsx --test --test-name-pattern 'QQ 私聊资料边界|非 IM 来源' test/41-qq-private-scope.test.ts test/84-im-final-delivery.test.ts`。独立副本具有自己的 @ruukoto workspace 包解析，第三方依赖复用，生产文件哈希固定；不是在自己的测试路径下偷偷解析到主仓生产实现。

## 全量失败与外部证据界限

原 `npm run check` 针对基线运行 1535.598 秒，退出 1，49 项失败和未执行剩余批次保留。其 HTTP 三项零调用失败已最小定位：完全不 import Ruukoto 的 http.createServer 仍收到 GET /；同步 lsof 明确发送进程为 Mirasim，Accept=text/html,*/*，区别于工具指定路径。127.0.0.2 在本 macOS bind 得 EADDRNOTAVAIL；IPv6 也被同进程探测。没有改 DNS、网络配置或 hits.size 严格原断言。其他 Driver、审批、CPU/超时失败不笼统归给此探测。

本上下文只读核实 root 的最终 macOS native 四文件原日志为 31/31、0 skip、退出 0、393.121 秒；源码三文件与本次固定来源候选相同。root 静态与其他串行组、Linux 原基线 73/73/原 08 19/19/scope 探针及最终组合由相应执行者的原日志与输入持有；不冒称本上下文亲自跑过这些平台检查，也不把基线结果当修后 Linux 组合结果。真实模型原 low 零请求、off 首轮个人成功与编码 schema 阻断均已保留，新正式场景结果由 model_acceptance 单列。

仍未由本上下文执行真实模型、外部 MCP/IM 副作用或拥有者主观体验；没有向他人发消息、提交、推送、合并、部署或修改日常实例。真实模型/平台最终状态、完整 check 失败分类与工单状态由 root 汇总；本独立结论不把必要缺口写成不适用或通过。
