# 07 独立工程审查

> 本文部分原始证据已移出 Git；原路径保留用于查找原件，见[归档说明](../../git-history-cleanup/archive.md)。

本审查只读共享工作区，根实现者负责落盘。起点和当前 HEAD 为 `84f0d4d78ced04b76f6c8be9ba299c66091e2e74`；审查同时覆盖 07 的未提交追加实现、验收用例与原始证据。A1–A12在下述工程覆盖范围内没有剩余实现阻断；最新macOS22及Linux两版本的停止事实/应用入口增量已闭合。07不能据此声称全部产品验收通过，真实IM和拥有者体验仍待验。本记录不授予提交、合并或发布。

## 逐项判断

| 要求 | 源码与证据 | 判断及边界 |
| --- | --- | --- |
| A1 | 121/122 六输入真实 Runtime、Driver、SQLite、工具账本与 Git；各有一个故意失败，第五成功成果及独立验证对应；平台矩阵；真实 123 | 工程覆盖并发、逐项验证、五成功一失败、partial 与唯一完整覆盖清单。联网与 IM 是本地替身；真实模型样例不是六输入实平台样例。 |
| A2 | runtime 的双产品装配和来源 product 绑定；112 双产品 Driver；118 双入口；121/122/123 | 共享编排、专属能力与入口均已核对，没有跨产品能力混用。真实绑定 IM 与拥有者 TUI 体验待验。 |
| A3 | script-worker 的 host/interpreter/protocol/validate；104 四格真实构建脚本/WASM与隔离检查 | 串行、并发、分支、循环与有界协议覆盖；脚本不能直接使用 Node、文件、命令、网络、凭据、时钟与随机数。具体工作仍通过实际步骤工具守门。 |
| A4 | runtime.workflowSource/verifyWorkflowSource；107/115/118；121/122/123 | 来源任务结束后仍沿固定授权执行，日常聊天与后台工作并存，唯一最终汇总与独立记录覆盖。实际 IM 最终发送及拥有者体验待验。 |
| A5 | workflow-steps 的 resolve/verify/result-source；Driver模型发送与工具实际调用门；tool-availability；111–114 与四格112/113 | 来源能力、当前配置/引用、单步收窄、来源失效与 MCP 单次批准边界覆盖；普通受限技能仍归一为 null，只有持久执行绑定的步骤保留技能。 |
| A6 | runtime.workflowSource/startWorkflowTask/startWorkflowOwner；118/119；123 | 显式及模型工具启动经过同一宿主来源与资源核实；无来源内部任务、引用指令、外部入口与嵌套步骤不能伪造拥有者权能。123明确指示模型启动指定定义，不证明模型自行选择编排策略。 |
| A7 | workflows 的 pump/invoke/flush/runAgent/retry/unsafeReason/control；105–109；独立 Promise.race 与双运行组合；115 新事实负例；真实 final-report | 独立分支继续、失败依赖跳过、固定顺序恢复、已完成缓存、未知写入暂停、取消与恢复仲裁覆盖。真实摘要引用启动旧停止 null 的缺口已修，最终本批编码正文明确脚本与6/6执行停止已核实。历史失败和未知记录不改。 |
| A8 | core.workflow 的共享名额与事务领取；105/107/122 | 固定三个来源共享名额、并发抢位、重试计尝试、缓存不计、纯人工停计、超限保留与拥有者调整后恢复覆盖。拥有者已澄清仅可调 attempts/time。 |
| A9 | workflow-library；117/118/120 | 定义与参数固定、修改新版本、原键重放、恢复原版本、文件/编码/语法/路径拒绝覆盖；不回退另一版本。 |
| A10 | core问题/答复事务；workflows.ask/answer；114–116/119；121/123 | 问答持久化、精确运行/步骤/版本/来源、重复去重、过期/跨源/取消拒绝、与工具批准独立、等待中继续聊天覆盖。真实 IM 回答发送未验收。 |
| A11 | work-copy 的 freeze/createValidationCopy/applyFrozen；workflow-steps.integrate；110/112/122/123 | 实际独立 Git 副本、不可变字节/摘要/基线、独立验证上下文、副本内验证写入隔离、拒绝旧结论/伪造通过、冲突零套用、此前成功保留、组合检查失败可见覆盖。123最新编码单例1/1进一步记录不同验证task的实际bash/grep调用、宿主验证/集成账本、最终字节与全部停止。该命令末尾echo使工具isError=false不单独证明grep退出0；实际调用、独立结论/成果绑定与直接汇总后检查各有自己的证据。 |
| A12 | work-copy/steps 的非Git预检；110/112/121 | 非 Git 修改在副本、worker、模型或写入前拒绝；非 Git 分析及已授权业务工具仍可用。 |

## 已复核的返工

脚本停止的两处信号成功短路已移除，仍在原预算中查询原组退出；TERM/KILL 的 EPERM 或查询未知本身不表示退出。独立 Node22 100/104 集合 70/70、104两项三十轮无失败；精确撤修负例红。原同 PID/PGID51189 的 Z/UID501现场支持该脚本竞态，不能套用到原生身份失败。

原生身份失败的最小修正仅对同 PID 内核查询有限重查三次，每次间隔请求1ms；仅完整身份或明确ESRCH接受，持续错误、部分响应与坏字段仍未知。七类 fixture 包含实际 C 函数，独立通过且精确旧 C 撤修在瞬时EPERM后明确ESRCH正例红。采样中断、新孤儿、PID/unique身份与权限规则未放宽。真实仪器曾捕获 PID278/count0/EPERM，之后该 PID 为 ESRCH；原调用的具体身份、退出或权限原因仍未证实，不能从清零结构中的 UID0推断 root 身份。候选实际五轮原生smoke通过，没有捕获同一 PID 的 EPERM→重查ESRCH转移，不能声称这一原现场原因已被证明。

应用查询把无响应结算从 exit 移到 close，使 exit 后到达的 stdout 结果仍可被接收；原两秒预算、SIGKILL 与退出等待保留。独立真实查询/超时及退出时序窄例通过，精确旧 ESM Runner 撤修使正例以 child_exited 红，无结果负例仍拒绝。首轮临时 CJS/路径夹具错误不是产品证据。

默认全量并行与同 UID 新孤儿采样存在已证夹具冲突：保留100失父后代的1.5s窗口，与101正常回收并行时，101记录的 unknown_new_orphan 正是100的 Node后代PID24148；相同 fixture与断言顺序运行2/2。原全量 PID49426 的来源未证实。新入口只在 macOS 独占顺序跑100与101-helper，随后并行其余文件；Linux保留全并行，不改变C的安全判定，也不跳过测试。独立124实际CLI9/9，实际138个文件Darwin为2+136、Linux138，全部只分配一次；失败码、信号、缺失文件、启动异常与未知退出均不报成功，真实模型固定关闭。

最终报告原只包含停止未核实负事实，源会话的 workflow_start 历史仍是 scriptStopVerified=null；实际模型因此与当前true账本矛盾。修正增补当前脚本三态、已启动执行的核实数量与排队未启动数量，声明终态事实取代旧状态；保留所有效果未知和停止未核实警告。独立115正例和五种三态组合2/2，精确旧 ParentDelivery撤修首正例红；追加效果未知且停止已核实的负例1/1。真实双产品final-report2/2，当前编码正文正确反映脚本及6/6执行停止核实，原坏正文保留。

## 原始证据核对

末轮 `check-runner-final.log` 退出0，包含 build、lint、全部workspace/foundation类型检查、notes与docs门禁；独占批38/38零skip，其余1313项1310pass/3真实模型skip，应用合计1348/1351、零fail；基础9/10、仅真实模型skip1。138文件分批未少执行断言。旧 `check-delivery.log` 的unknown_new_orphan失败和更早文档预算/夹具失败保留，不拿文件名推断通过。

macOS最终原始 matrix-delivery：Node22为64/64（额外5项101-native-execution，包含实际C身份fixture，再加原59），Node24为59/59；两个 native-delivery 各10个真实OS单元PASS，末尾execution=native/models=mock。最终 macOS manifest列准确22.19.0/24.15.0、系统27.0.1、HEAD与23个source/worker摘要，读取时与当前全部一致。

Linux最终两版本均 build退出0、matrix59/59、query2/2、native10/10；命令和版本原始记录完整。331个Linux source摘要与本机当时仅Mac专用C及100/101追加不同，所列Linux运行链路一致。npm ci因ENOSPC未通过；锁版本核对的第三方运行依赖物理复制满足真实原生挂载，省略类型/sourcemap，不能宣称新鲜setup或Linux完整lint/typecheck已验收。

最终停止事实与runner的Mac22及Linux两版本增量均19/19、零失败/跳过；Linux原始commands分别为准确22.19.0/24.15.0、exit0，四个追加source摘要与当前本机完全一致。本审查范围给出工程实现无阻断结论。末轮完整check后的123追加只影响显式真实模型分支，最新验证操作单例1/1另行留证，不据此复跑全仓；随后完整static-handoff-final的lint/全workspace及foundation类型/notes/docs通过，最后只改断言诊断字面及core一条已实施决定Note锚点，未变行为。最终manifest的postCheckDelta明确这些增量，23份source/worker摘要与当前全部匹配。工单与证据入口终稿仍需同步当前计数和状态，并运行最窄文档门禁。独立检查原始日志不简单相加，避免把重叠集合充作覆盖数；source快照保存在 `independent-review-source-hashes.json`。

## 未覆盖与产品待验

实际绑定 QQ/Telegram 的六输入、等待聊天、版本绑定回答、唯一发送及换代/未知发送未验收；恢复条件是实际绑定实例和平台。拥有者 TUI 进度、问题、代码汇总、组合检查与失败报告体验未验收。普通应用测试和原生smoke使用模型替身；真实123有明确启动指示，未证明自主选用策略，也不能代替真实IM。首轮真实编码以write_result_missing暂停后档案被清理，原始输出缺失，不能反推格式根因或将该失败记通过。当前有限原生身份修正的回归与末轮成功，不会抹去旧停止未知历史或证明PID278原失败的具体原因。
