# 当前工作区快照工程记录

本单按已确认规格实施，保留接手前 02 未提交内容，不提交或推送。基点 `d12eb6329da9fd9128989ef0725ce1243627068d`，分支 `Eitrous/subagent-roles`；03 独立范围以接手前文件副本与当前 SHA 对照，后续接线由 04 持有。

[生产/测试子清单](03-production-inputs.sha256)固定 03 实际改动的 38 项，SHA-256 为 `4d4080f7821db32e9f2217a0394603932167599bef2afe53e1c404a195e56ed7`。[03 独立补丁](03-production-docs.patch)及[接手前原文归档](03-baseline-originals.tar.gz)包含 54 个源码/测试/文档/笔记对象；在独立临时目录实际套用后 54 项逐一匹配，[复核日志](03-baseline-patch-check.log)。因此本单范围不等同于整个未提交 diff，02 的原有成果未被算作 03 新实现。

## 当前成果

Git target 现在捕获稳定的实际工作区原始字节，含 staged/unstaged、删除、非忽略新文件和二进制，捕获零写入与后续 worktree 登记分开核实。来源对象只读核实 HEAD 和复制 staged blob，关闭 promisor 自动下载及来源 remote/config 继承；全部新对象写入独立私有 Git，持久树与索引对象不依赖源对象库或 alternates。登记用 no-checkout 加原始物化，不执行过滤器；普通宿主准备操作有独立 Task/账本。角色独立于 target，受保护 reviewer 使用 native，仅在副本写检查产物，来源、共享 Git、私有基线及附加来源只读，文件工具和批准后的宿主入口同样受限。

冻结/验证/汇入固定同一快照摘要并只算子增量。完整受影响文件后来改变即冲突，即使 patch 可套用也不覆盖；全部已等于子成果则幂等，无关文件不阻塞。缺失/损坏基线拒绝受影响队列、消息、模型请求、等待、结果与送达；真实终态、历史、副本和旧结果保留，其他任务继续。普通非 Git direct 与 agent_wait 串行不变，保护目标在副作用前拒绝非 Git。

## 验证对象与进度

工程验收完成，[独立实现审查](../03-implementation-review.md)无剩余阻断。验证使用实际 Git、SQLite、worker/native 和离线 mock 模型。下表按执行批次记录，重叠用例不相加；失败日志保留。工程状态见[工单](../issues/03-workspace-snapshots.md)，对象由[内容清单](03-implementation-inputs.sha256)固定。

| 检查 | 结果与证据 |
| --- | --- |
| core/schema 与文件工具、审批、模式、操作账本定向集 | 81/81，[日志](03-core-tool-tests.log) |
| 普通委派/复用/恢复及发布验收 | 25/25，[日志](03-delegation-import-tests.log)；源命令中的未找到文件不计覆盖，实际导入另见后续组 |
| 宿主 Task、坏基线队列/消息/终态、定时与父送达、agent_wait | 111/111，[日志](03-host-recovery-wait-tests.log)；随后补实际私有对象送达门禁，77/77，[最终日志](03-private-delivery-complete.log)，含无报告的 dev 消息注入/main 唤醒及冷恢复 3 个实际 Runtime 负例 |
| 普通汇入、临时 patch、归属与 host Task | 最终 83/84/95 共 42/42，[日志](03-integrate-final-tests.log)；工作流 106 原 Task 结束后的宿主操作也在[对应重验](03-integration-fixture-recheck.log)中通过 |
| 当前快照、native 保护、冻结/验证/汇入与工作流实际步骤 | 最终 53 项首次 52 通过、1 个 macOS reviewer 终态等待超时，[原日志](03-snapshot-final-tests.log)；原用例未改、未放宽超时，安静环境单独重跑 1/1，[日志](03-macos-reviewer-isolated.log)。其余 52 项已含 split-index/staged blob、promisor/模板、路径形态、symlink 与 snapshotDigest 负例 |
| 文件 bind 与真实 native 来源保护 | [原始证据包](03-file-bind-evidence.tar.gz)保留 Linux 修复前真实源写旁路、修复后拒绝及停止；宿主文件检查同样覆盖保护树子对象别名。全局旧缺口另见下文 |
| 打包 | 最终 `npm run build` 通过，[日志](03-build-final.log) |
| 静态 | 最终生产代码 `npm run check:static` 通过，[日志](03-static-final.log)；后续仅交付文档更新，`check:docs`、`verify-notes` 和 note anchors 均通过，[文档](03-docs-handoff-final.log)、[笔记](03-notes-handoff-final.log)、[锚点](03-anchors-handoff-final.log)；`git diff --check` 通过 |

旧 HEAD-only/捕获 fixture 断言及工作流宿主操作次数断言均按新行为修正并重验；旧失败日志保留。初轮静态因尚未创建决定笔记断链，后续最终通过；冷恢复测试临时目录前缀过长导致 socket EINVAL，缩短测试前缀后 77 项通过，没有改生产重试。macOS 最后一次并发等待超时的根因未证明，单次重跑通过不改写首次结论。

| 要求 | 工程验收依据 |
| --- | --- |
| R5 权限收紧及来源保护 | 两产品实际 full_access 父级 → confirm reviewer/native，副本可写；source、原/共享 index、config、私有基线、附加资料的绝对路径/别名/符号链接/硬链接/file bind 与结构化/批准后宿主写均拒绝；缺 native 或非 Git 保护目标在副作用前失败 |
| R9 角色与 target 独立 | 普通工具不按角色决定目标，有 target 捕获当前基线，无 target 沿独立目录/资料；模型目录及任务输入实际记录，旧 mode 替换交 04 |
| R10 当前内容及子增量 | staged/unstaged/新文件/删除/二进制/CRLF/执行位按实际字节捕获；split-index 及阶段对象可追溯，捕获来源零写入与登记元数据分别核实；冻结/验证/汇入固定 snapshotDigest，后续同文件不同 hunk 改动也冲突，无关文件不阻塞，已完整应用幂等 |
| R11 非 Git 与等待 | 普通 direct target、目录占用与 agent_wait 实际串行继续；保护副本/工作流写入在准备与模型前拒绝非 Git；停止未核实保留双方 Task 占用及现场 |
| R14 追溯、恢复及故障归属 | WorkspaceSnapshot 与独立 host Task/账本关联；缺失/损坏私有对象、摘要或 Git 身份在队列、模型、消息、等待、结果与父送达拒绝；保留真实终态与旧成果、消息失败事件只写一次，其他任务可运行；schema 44 与两方向导入严格校验 |

## 机制与真实环境证据

[完整归档](03-mechanism-native.tar.gz)和[逐项摘要](03-mechanism-native-manifest.json)保留机制、独立复核、macOS/Linux native、失败尝试及终态修复的原始脚本/日志/报告；解包后 manifest 的 path 相对归档根，original 是运行时路径。归档包含 source-before/source-after 原始摘要。最初私有 index 配来源 alternates 的实验刷新了 399 个源 loose object mtime，因此弃用；最终完全独立对象库的 Git 实验 43 项与 Node 原始物化 1374 文件均通过，另一上下文重新执行得到同样结果。捕获与登记分开核实：捕获源所有已存在状态不变，登记仅专属分支与 worktree 元数据新增。

macOS 与 ssh tx Linux 实际 native 探针确认 copy 产物可写而来源、原 index、共享 worktree index、config 和附加资料拒绝写入；绝对路径、System/Volumes/Data 与大小写别名、符号链接/硬链接、批准后的宿主文件操作均不能旁路。已有真实停止未核实及非 Git/agent_wait 生命周期探针 macOS 7/7、Linux 6/6；原生 scope Linux 3/3。Linux 首次依赖准备 ENOSPC 和 QuickJS 缺失失败保留，后续使用独立已有依赖副本，未将缺环境尝试记通过。最终合并对象两平台生产检查另固定，不继承机制探针的代码范围。

最终 Linux Node24.21/Git2.43/kernel6.8 将 394 输入（其中 179 packages/apps）及 03 生产子清单 38/38 与主仓逐一 SHA 核实，运行后仍一致；重新 build 实际 worker 后，[五文件首轮](03-linux-final.md)为 42/43，分别 workspace snapshot 22/22、受保护 SubAgent 3/4、native scope 3/3、等待资源 9/9、agent_wait 5/5。唯一 child 离线 mock Connection error 的原文件独立顺序重跑 4/4，额外窄诊断 1/1 捕获 8 请求/7 child HTTP200；只有父 prompt 在 test_end 主动中止，未复现或证明首次原因，没有生产 retry 或放宽 timeout。首次 SDK cause 随标准 shutdown 无法恢复，报告明确该证据缺口。

最终正式 native worker 的来源/shared Git/private/materials 拒写、产物可写、file bind/active hardlink 检查及 stopVerified 均有实际文件证明；真实 scope detached 后代停止和 heartbeat 不再增长通过，快速退出/入口前失败保持 stop=false。等待资源中注入 stop=false 只证明调用方保留规则，不能冒称 OS 整链停止失败；非 Git 与实际 worker 让出由原用例字节核实。Git2.43 缺 promisor blob 捕获拒绝且整个 source/.git46项 bytes/mode/mtimeNs/size不变。原始脚本、编译输出与首次/重跑/诊断归档于[最终 Linux 包](03-linux-final.tar.gz)，两份[非作者审查](03-contract-review.md)与[送达/宿主审查](03-snapshot-review.md)直接持有交叉覆盖；所有归档回读核实见[清单](03-archives-verified.json)。

## 模型输入审计

[量化脚本](03-metrics-probe.mts)使用真实 SDK 请求和选择记录 estimates，两产品各取父 full_access 和目标 reviewer/confirm 的完整工具定义、system 与任务输入。before 是接手 03 前副本（HEAD 加 02 工作区文件），依赖包名解析指向该副本；after 是当前主检出。native 配置前提明确指定，不把 mock 模型记作真实模型。

| 两产品相同身份 | systemPrompt 前 → 后 | toolSchemas 前 → 后 |
| --- | --- | --- |
| 父任务 | 1512 → 1512 | 9921 → 9999 |
| reviewer | 920 → 920 | 551 → 551 |

[before](03-metrics-baseline-final.log)、[after](03-metrics-current-text-final.log)保存完整输入。父工具要求修改/审查显式 target、与材料互斥；子输入说明当前内容、子增量、未复制依赖与可执行的补环境下一步。最后目标中性文字已重取 after，不设 token 上限。

## 未验与下一步

真实模型、IM 和组合产品体验由 05 验收；04 的工作流 role/target/verify 与旧 mode 拒绝尚未实施。本单不运行全仓 check、不自动搬移/清理私有基线、不承诺源文件和 SQLite 的原子性。schema 44 按严格策略拒绝旧档案，需保留原档案并使用匹配代码查阅。

APFS 默认大小写不敏感时，子副本仅大小写重命名可产生非空增量，但 Git 套用预检以 EEXIST 安全拒绝；来源/index/副本不改写，成果与实际原因保留。Linux 大小写敏感目录可套用，没有为此添加自定义源回写器。捕获对非 SHA-1、非 UTF-8 名字、嵌套 Git/gitlink、非常规文件或祖先链接明确拒绝，不回落 HEAD-only。

宿主文件保护为避免缓存旧别名按保护树遍历；本仓 62,985 文件/6,370 目录实测每次约 278–280ms。来源/共享 Git/私有基线/附加资料的显式只读 native 挂载通过真实 file bind 反例修复与复核；没有作为显式只读挂载的全局保护根仍有外部特权预存子文件 bind 的既有缺口，宿主文件入口已拒绝同一对象。真实反例保存在[文件 bind 证据包](03-file-bind-evidence.tar.gz)，该全局范围留后续原生保护审计，本单不宣称已修复或通过。
