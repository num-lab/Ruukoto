# 工作流共享角色与接口升级工程记录

工单 04 工程实现完成，独立审查无未解决阻断；联合产品、真实模型和最终双平台组合验收归 05。保留 02、03 未提交成果，没有提交、推送、部署或改动日常实例。

## 对象与范围

基点为 `d12eb6329da9fd9128989ef0725ce1243627068d`，分支 `Eitrous/subagent-roles`。接手时逐项核实 03 原输入与实际工作区一致（[69/69 与 38/38 核对日志](../../git-history-cleanup/archive.md?path=.scratch%2Fsubagent-roles%2Fevidence%2F04-inherited-input-check.log)），然后保存 [1378 项接手输入](04-baseline-inputs.sha256)及[原文归档](../../git-history-cleanup/archive.md?path=.scratch%2Fsubagent-roles%2Fevidence%2F04-baseline-originals.tar.gz)；归档回读逐项匹配。本单范围按接手副本比较，不按包含 02/03 的整个 git diff 判断。

[范围清单](04-change-scope.json)与[独立补丁](04-implementation.patch)记录 04 变更；[生产/测试清单](04-production-inputs.sha256)固定 12 个生产文件与 28 个测试/smoke 调用文件，清单 SHA-256 为 `5295b93d01abc7a2c9eb4b5ca3cf14f86c790caa6e77733447cd59d55098659c`。完整要求、规则、源码、文档和本记录由[最终输入](04-implementation-inputs.sha256)固定；审查归属与最终核实由[实现审查汇总](../04-implementation-review.md)持有。历史 03 摘要、补丁和归档不改写；总角色笔记的生命周期及活跃入站链接随本单迁到 implemented。

## 实际行为

工作流按启动时固定的角色目录选择 role，省略为 general，与普通委派共用来源能力和权限计算。target 独立表达目标；verify 引用本运行已冻结步骤，须声明依赖且不能同时给 target。验证始终叠加宿主 confirm、来源保护、独立副本和编码工具，general 或自定义 full_access 角色不能解除。

验证通过同时要求真实独立 Task、合法输出、非空编码工具账本及全部操作有成功结果且效果已知。汇入重新核实角色/执行记录、归属、停止、验证账本、同一基线和冻结摘要，再由 03 机制核实实际字节、目标完整受影响文件及组合检查。普通汇入与续派不能接管工作流成果。

默认 Driver 在排队启动、冷恢复、resume、结果消费和汇入时严格核实已保存定义、执行快照与目标基线；缺失或损坏时保留原 Task、尝试、账本和字节，拒绝猜测恢复。可信宿主注入的 workflowAgent 沿原有装配边界承担自己的执行证据合同，不伪造 Driver 快照；默认冻结汇入仍直接要求真实 Driver 证据。

普通工具、Runtime 委派及工作流调用明确拒绝旧 mode 属性。定义/运行接口版本为 2，新摘要包含版本；命名文件以同一原子替换保存首行接口标记和正文。无标记旧文件可查，显式读取并改用 role/target/verify 后保存新定义才可启动；旧运行可查、取消，不能按新接口恢复。不扫描或改写任意 JavaScript、JSONL 或已引用定义。临时脚本具体旧调用失败之前的真实副作用保留，不换键重放。

schema 45、控制协议 26 沿现行严格版本政策拒绝旧库/客户端；两方向导入继续拒绝工作流执行绑定，不丢掉绑定或补授权。角色文件 permissions.mode 仍表示访问策略，与已移除的派发 mode 不同。

## 要求与证据

| 要求 | 最窄工程证据 |
| --- | --- |
| R1、R7 两入口同源、固定角色 | 新九例在 ruukoto 与 ruukoto-code 实际 Runtime/Driver/native 比较普通 reviewer 与工作流 reviewer 的来源、精确工具、权限、roleDigest 和正文；运行后编辑文件不换角色 |
| R10 当前目标和子增量 | 双产品 reviewer 实际读取 staged/unstaged/new 内容，bash 写副本产物成功、写来源失败；110/112 继续覆盖冻结基线、二进制子增量、冻结后变更、完整受影响文件与组合检查 |
| R12 宿主冻结验证 | general 与自定义 full_access verify 均受限；零工具 passed 文本、工具失败、缺结果、效果未知及冻结不一致不具备汇入资格；112 在保存 passed 后只修改账本未知状态，消费仍拒绝 |
| R13 显式升级 | 105 参数负例、真实 SDK 普通旧 mode 拒绝、版本/命名库用例及先写入后旧调用用例；拒绝不登记新调用、不回滚既有事实、不重放 |
| R14 冷恢复与唯一归属 | 新九例覆盖完成验证后缺 definition、execution、snapshot、旧接口四种 ask 冷恢复；原 Task/尝试/字节不变；107/109/115、125 与侧栏/控制定向集核实恢复、共享名额、取消、等待和唯一汇报 |
| schema、协议、导入与调用面 | 108、版本测试及静态检查；111/113 共享来源，全部活跃调用/fixture/smoke 参数同步；真实模型文件只改调用，未执行真实模型验收 |

## 执行记录

环境见[原始信息](04-environment.json)：macOS arm64、Node 24.15.0；SQLite、Git、SDK、Runtime/Driver/worker 实际运行，模型均为离线 mock。下表按批次记载，有重叠，不相加成唯一用例总数。

| 检查 | 结果与原日志 |
| --- | --- |
| 普通委派、复用、worktree、汇入、发布、生命周期、快照边界与等待，8 文件 | 隔离副本 104/104，[原日志](../../git-history-cleanup/archive.md?path=.scratch%2Fsubagent-roles%2Fevidence%2F04-delegate-tests.log)、[命令与范围](04-delegate-verification.md)；后续只澄清工具文字 |
| 105/108/117/118、版本、普通角色、wait core/view，8 文件 | 88/88，[日志](../../git-history-cleanup/archive.md?path=.scratch%2Fsubagent-roles%2Fevidence%2F04-version-runtime-tests.log)；随后新增的 105 参数与 SDK 用例分别重验 |
| 最终 105 参数/编排用例 | 44/44，[日志](../../git-history-cleanup/archive.md?path=.scratch%2Fsubagent-roles%2Fevidence%2F04-params-runtime-tests.log)，含旧 mode、target/verify 互斥、依赖要求及非法角色 |
| 真实 SDK 普通旧 mode 入口 | 1/1，[日志](../../git-history-cleanup/archive.md?path=.scratch%2Fsubagent-roles%2Fevidence%2F04-old-mode-sdk-test.log)，证明旧字段不会被 SDK 静默丢弃 |
| 107/109/115 可信注入与恢复回报 | 修复后 18/18，[日志](../../git-history-cleanup/archive.md?path=.scratch%2Fsubagent-roles%2Fevidence%2F04-adapter-recovery-tests.log) |
| 106/110/112/122/125 与新角色集成，6 文件 | 最终串行 43/43，0 skipped，[原日志](../../git-history-cleanup/archive.md?path=.scratch%2Fsubagent-roles%2Fevidence%2F04-native-workflow-tests.log)；`npx tsx --test --test-concurrency=1 test/106-workflow-host.test.ts test/110-workflow-workcopy.test.ts test/112-workflow-real-steps.test.ts test/workflow-role-integration.test.ts test/122-workflow-code-acceptance.test.ts test/125-agent-wait.test.ts` |
| 并发、崩溃、真实工具、审批、能力、控制、来源、回报、IM 替身、CLI、wait/sidebar，19 文件 | 首轮 208 项中 201 通过、7 失败，[原日志](../../git-history-cleanup/archive.md?path=.scratch%2Fsubagent-roles%2Fevidence%2F04-cross-tests.log)；5 个 115 失败来自下述已修复回归，两条 HTTP 审批断言另单独重验 2/2，[日志](../../git-history-cleanup/archive.md?path=.scratch%2Fsubagent-roles%2Fevidence%2F04-http-recheck.log) |
| 打包与静态 | 最终 `npm run build` 通过，[日志](../../git-history-cleanup/archive.md?path=.scratch%2Fsubagent-roles%2Fevidence%2F04-build-final.log)；`npm run check:static` 通过，[日志](../../git-history-cleanup/archive.md?path=.scratch%2Fsubagent-roles%2Fevidence%2F04-static-final.log)，交接及笔记生命周期更新后的复核另见 [handoff 日志](../../git-history-cleanup/archive.md?path=.scratch%2Fsubagent-roles%2Fevidence%2F04-static-handoff.log)；最后仅笔记事实澄清再跑 [check:docs](../../git-history-cleanup/archive.md?path=.scratch%2Fsubagent-roles%2Fevidence%2F04-docs-handoff-final.log) 与 [verify-notes](../../git-history-cleanup/archive.md?path=.scratch%2Fsubagent-roles%2Fevidence%2F04-notes-handoff-final.log) 通过；`git diff --check` 与 EOF/链接检查通过 |

独立审查先发现空工具账本可取得验证资格、已完成结果消费缺少快照核实，两处均加真实反例后修复。随后跨用例发现 verifyResultSources 无条件要求 Driver 快照，破坏可信注入执行器的旧合同；通过与原 preflight 相同的宿主装配回调修复。独立审查者亲自执行修补前 0/2、修补后 2/2，并在默认 Driver 下移除完成依赖的定义/执行记录，核实仍严格拒绝。另一个非作者上下文执行默认 execution 缺失冷恢复 1/1；报告和原始探针由独立审查汇总链接。

两条 HTTP 审批首轮均在零调用断言得到 1；未改 HTTP 生产代码或用例，单独原断言 2/2 通过，但首轮根因未证明，不能称整个交叉集全绿或断定是资源问题。新九例作者阶段另保留夹具错误与一次 native 停止 identity_unavailable 的失败，最终主仓完整串行 43/43 未复现；没有生产重试或放宽超时。初轮静态因 README/开发说明预算超限失败；同义导航压缩及有理由的小幅预算调整后通过。

## 模型输入量化

[脚本](04-metrics-probe.mts)捕获两产品实际 SDK 完整 system、工具定义、任务输入，after 另实际执行并记录 workflow_instructions；读取选择记录 estimates。before 是接手前 03 成果，after 是最终生产文字。[main 脚本](04-main-metrics-probe.mts)使用真实 main 身份、两轮请求且只执行 workflow_instructions，没有创建子代理。数值是本地估计，不是服务端账单或真实模型结果。

| 身份 | systemPrompt 前 → 后 | toolSchemas 前 → 后 |
| --- | --- | --- |
| 两产品 dev 父任务 | 1512 → 1506 | 9999 → 9890 |
| 两产品 reviewer | 920 → 920 | 551 → 551 |
| ruukoto main，两轮相同，36 工具 | 1869 → 1866 | 13341 → 13232 |

[父/子 before](../../git-history-cleanup/archive.md?path=.scratch%2Fsubagent-roles%2Fevidence%2F04-metrics-before.log)、[最终 after](../../git-history-cleanup/archive.md?path=.scratch%2Fsubagent-roles%2Fevidence%2F04-metrics-after-final.log)、[main before](../../git-history-cleanup/archive.md?path=.scratch%2Fsubagent-roles%2Fevidence%2F04-main-metrics-before.log)、[main after](../../git-history-cleanup/archive.md?path=.scratch%2Fsubagent-roles%2Fevidence%2F04-main-metrics-after.log)保存完整实际输入。较早 after 的 1505/9906 与 main1865/13248 因随后目标中性文字澄清失效，仅保留为历史；最终重新捕获，没有只按文本长度推算。

## 交接与限制

下一实施入口为[05 联合验收](../issues/05-acceptance.md)：按最终跨包范围执行完整 npm run check，核实 macOS/Linux 新接口组合、真实模型与拥有者体验。旧 03 双平台证据可作为机制依据，不能冒称最终 04 新接口在 Linux 已验。真实 IM/MCP/个人业务平台也未执行，不把适配器替身或 mock 模型计为外部通过。

schema 45 拒绝旧档案，旧接口必须显式升级；保留原文件供匹配版本查阅，不清库。03 既有 APFS 大小写预检拒绝及未显式只读挂载的全局 native 保护范围限制继续见 [03 记录](03-implementation.md)，本单未扩大其保证。独立审查原始包及摘要回读结果见[归档清单](04-archives-verified.json)；原始失败均保留。
