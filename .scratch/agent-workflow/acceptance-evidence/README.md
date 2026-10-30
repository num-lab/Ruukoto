# 工作流联合验收证据

> 本文部分原始证据已移出 Git；原路径保留用于查找原件，见[归档说明](../../git-history-cleanup/archive.md)。

验收入口为[07](../issues/07-acceptance.md)，要求见[规格](../spec.md)。起点 `84f0d4d78ced04b76f6c8be9ba299c66091e2e74`，工作区初始干净。证据区分实际宿主/worker、模型、联网/IM 替身与人工体验；真实 IM 和拥有者体验仍待验。历史未知停止和失败日志保留，不从后续成功反推旧现场已停止。

入库日志仅清理空白行的尾随空格及文件末尾多余换行，不改诊断正文。

## 组合与真实模型

| 对象 | 证据与结果 |
| --- | --- |
| 编码六输入 | `git show 28c033f7:test/122-workflow-code-acceptance.test.ts`，`code-batch.log` 1/1。真实 Runtime/Driver/Git，三个实际修改者并发，第六项输出失败、依赖验证跳过；五份冻结补丁与独立验证任务/副本对应，目标实际字节与组合检查一致，终态 partial、唯一汇总 |
| 个人六输入 | `git show 28c033f7:test/121-workflow-personal-acceptance.test.ts`，`personal-batch.log` 1/1。实际联网工具与应用数据，Tavily/Telegram 为本地替身；十一项搜索、六次查询、五项独立检查，等待期间聊天、重复回答，实际五行与唯一回报。`personal-batch-first/second.log` 是夹具路由/ask 返回值诊断，不计通过 |
| 指定真实模型 | [123](../../../test/123-workflow-model-acceptance.test.ts)，[最终日志](../../git-history-cleanup/archive.md?path=.scratch%2Fagent-workflow%2Facceptance-evidence%2Fmodel-workflows-final-report.log) 2/2，零跳过，[实际最终回报](model-reports.md)。用户指定 `/Users/eitrous/.ruukoto-code-dev/ruukoto-2159f2e3/agent/models.json` 的 `magpie/mirasim/deepseek-flash`，low 思考；模型通过工具启动命名定义、等待期间真实聊天、业务回答后实际应用数据/编码与独立验证、唯一汇总。实际查询行和目标字节、所有停止与零占用硬断言通过。没有真实 IM，也不证明模型自行选择编排策略 |
| 模型验证操作 | [编码增量](../../git-history-cleanup/archive.md?path=.scratch%2Fagent-workflow%2Facceptance-evidence%2Fmodel-workflows-verify-op-final.log) 1/1，零跳过；实际独立验证者的 bash/grep 操作、宿主 worktree_verify/integrate 与已核实停止/目标字节记录均留证。只增加显式模型用例断言与脱敏操作事实，不重跑已通过且不受影响的离线全量 |
| 模型诊断 | `model-workflows-initial.log` 0/2：medium 不受该模型配置支持；`model-workflows-low.log` 1/2：编码验证以 write_result_missing 暂停。首轮失败档案当时被测试清理，缺少原始输出，原因未证实；最终样例显式收窄 bash 与 JSON schema 后成功，不能反向声称首轮成功或已恢复。123 已改为失败保留档案 |
| 真实回报返工 | `model-workflows-reports.log` 个人成功、编码发起上游 503；[失败摘要](model-upstream-503.json)与隔离档案保留。`model-workflows-code-report.log` 编码补跑 1/1，但实际模型正文引用启动时的停止 null，与终态账本 true 矛盾；最终回报现明确脚本三态、已启动执行核实数、未启动数，并说明终态取代旧状态。最后同批 2/2 正文与停止事实一致 |
| 连通性 | `model-connectivity*.log` 分别记录思考/保护根夹具失败、agentrouter 503 与其他档案的 DeepSeek 连通；只有上述指定配置的工作流用例计为本次真实模型联合证据 |

## 全量与修正

`check-initial.log`：构建/静态通过，应用 1331 项中 1323 通过、7 失败、1 真实模型跳过；基础验证尚未执行。七项在 `regressions-before.log` 独立复现，修正后 `regressions-after.log` 31/31。demo 补工作流事件，main 工具/提示种类及资料拒绝文本夹具同步；普通受限上下文恢复技能归一，持久工作流技能例外由 `skill-binding.log` 12/12 覆盖；smoke 前提拒绝且未启动后台时清理模型档案，执行失败仍保留。

`static-docs.log`、`check-final.log`、`check-accepted.log`、`static-runner-report.log` 是文档预算触红，均不计通过。重复操作说明归 smoke 文档，预算不变。`check-current.log` 曾完整退出 0：应用 1335/1338、三项真实模型跳过；基础 9/10、一项真实模型跳过，不能覆盖随后修正。查询修正的 28/113/121 集合 `query-close-current.log` 51/51；终态事实修正的 115/116/121/122 集合 `report-stop-fixed.log` 15/15。

最终 [npm run check](../../git-history-cleanup/archive.md?path=.scratch%2Fagent-workflow%2Facceptance-evidence%2Fcheck-runner-final.log) 完整退出 0：应用先独占 38/38、其余 1310/1313（3 项模型跳过），合计 1348/1351；基础 9/10（1 项模型跳过），零失败。构建、lint、全 workspace 类型、notes 与 docs 均通过，Python/PTY 用例实际执行。Node22 的 115/124 增量另为 19/19、零跳过，见 [Mac 增量](../../git-history-cleanup/archive.md?path=.scratch%2Fagent-workflow%2Facceptance-evidence%2Fmacos-node22-report-runner-final.log)。最后 123 只增真实模型验证者实际 bash 调用断言和脱敏证据，不改变离线或产品执行链，单独真实复核；[末轮静态门禁](../../git-history-cleanup/archive.md?path=.scratch%2Fagent-workflow%2Facceptance-evidence%2Fstatic-handoff-final.log)退出 0，后续仅诊断措辞和决定锚点的 prose 改动由[文档门禁](../../git-history-cleanup/archive.md?path=.scratch%2Fagent-workflow%2Facceptance-evidence%2Fdocs-handoff-final.log)及[锚点检查](../../git-history-cleanup/archive.md?path=.scratch%2Fagent-workflow%2Facceptance-evidence%2Fnote-anchors-handoff.log)补证。

Linux 六输入在单文件仍复现查询丢失：子进程 360ms 正常 exit=0，结果随后到 stdout，原 runner 在 exit 先结算 child_exited。修正只把无响应结算移到 close，原两秒预算、SIGKILL 和退出等待不变。`query-close-without-fix.log` 在原错误处红，`query-close-fixed-narrow.log` 2/2；首次 `query-close-before/after.log` 的 namespace mock 不可写问题是夹具失败，不作为产品负例。

`check-delivery.log` 应用 1341 项中 1337 通过、1 失败、3 模型跳过；101-helper 对新失父 Node 保留 unknown_new_orphan。独立受控并行反例记录 100 的后代 PID 24148 正是 101 的拒绝对象，原断言不变、并行 1/2，串行 2/2，控制单例 1/1；原全量 PID 49426 的来源未证明。macOS 默认入口先独占顺序 100/101-helper，再并行其余；Linux 全并行。实际全部 138 文件恰分配一次，124 在两 Node 版本各 9/9，独立 9/9；启动/缺文件/未知退出/信号/失败不吞掉。原生新孤儿安全规则未放宽。

## 独立审查

HEAD 独立审查亲跑 104、105、110–116/118 与两项组合实验，共 136 项通过、零跳过，日志为 `independent-isolation/steps/controls/core/combinations.log`。组合实验跨重启保留 Promise.race 动态后继的持久交付序和四次文件写入，两个运行共用名额且取消不串扰。追加 121/122 独立 2/2、技能/清理与停止独立检查见 `independent-*.log`；不把各集合重叠相加冒充覆盖数。

[最终独立工程审查](independent-review.md)及[源码快照](independent-review-source-hashes.json)核对 A1–A12、当前追加实现、四格原始日志、三格增量、完整检查与真实模型正文，无剩余工程阻断。07 为 ready-for-human；真实绑定 IM 和拥有者体验待验。实际 grep 调用的命令尾部有 echo，不单凭 bash 的 isError=false 推断 grep 退出码；成功结论还依赖不变成果、独立验证绑定、实际目标字节及汇总后检查。

Node22 原脚本停止失败已定位：同一 PID/PGID 51189，TERM/KILL EPERM 后 ps 为 Z/UID501，原两处短路不做退出核实。`stop-failed-pid-ps.log` 保存原始事实；修正只去掉信号成功前提，仍按原预算核实原组。`stop-eperm-without-fix.log` 与 `independent-stop-revert.log` 撤修红；`stop-eperm-after.log` 2/2、`independent-stop-fixed-node22.log` 70/70，`independent-stop-loop.log` 重复三十轮通过。EPERM 与查询失败本身不代表退出，持续未知仍为 false。

最终回报三态的 `report-stop-red-valid.log` 两条在原实现红，`independent-report-stop-revert.log` 原 ParentDelivery 实际 sweep 红，修正独立 2/2。其他 report-stop-before/without-fix/red 是工单中注明的夹具状态/序号/来源绑定诊断，不当作产品反例。true 只计已启动项；false/null 和效果未知继续明示，已登记脚本 null 仍阻止汇总。

## 平台与未核实事实

macOS arm64，准确 Node 22.19.0/24.15.0。[最终环境、源码与实际构建资产摘要](macos-manifest-final.json)与原旧摘要分别保留。当前 C 构建的 `macos-node22-matrix-delivery.log` 64/64（59 平台项与 101-native-execution 的五项，含实际 C 七类身份反例）；`macos-node24-matrix-delivery.log` 59/59。两版本 `macos-node22/24-native-delivery.log` 各 10/10，实际 native worker、模型为替身。终态事实与测试入口的随后增量由末轮全量、115/124 窄例和真实模型补证，旧矩阵不冒称涵盖该增量。

原 macOS identity_unavailable 原生失败保留。`native-identity-eperm.log` 捕获 proc_pidinfo 对 PID 278 返回 count=0/EPERM，稍后 PID 消失；字段已清零不能据 UID=0 推断 root，具体瞬态原因未证明。C 现在对同 PID 查询错误最多三次、间隔 1ms，只有完整身份或明确 ESRCH 能核实，持续错误/部分结构/错误 PID/零 uniqueid 仍未知；身份比对与原子信号不变。实际 C 夹具旧实现撤修 SIGABRT、新实现七类通过，独立亲跑；候选五轮各 10/10 未捕获恢复 trace，不声称已复现原触发机制。历史现场和未核实占用不由本次成功清除。

Linux `ssh tx` 独立 Git 检出，准确 Node 两版本；默认 24.21.0 不计目标版本。[最终摘要](linux/linux-final-summary.json)和[命令/退出码](linux/linux-final-commands.json)：两版本均构建 exit=0、组合 59/59、查询 2/2、native worker 10/10，零跳过。来源稳定且相关八文件与根逐一匹配；macOS 专属 C/夹具不计 Linux 链路。首轮 npm ci 因 ENOSPC 失败，仅删除本任务 partial 依赖；锁版本核对后物理复制现有第三方运行依赖，@ruukoto 用独立源码，复制副本省声明和 sourcemap。安装未记成功，Linux 全量 lint/typecheck/check 未执行；完整静态门禁由本机覆盖。运行/资产/依赖/失败账本保存在 linux/，旧档案不动。

最终回报与分批入口增量在两 Linux Node 版本各 19/19、零跳过，见 [commands](linux/linux-delivery-increment-commands.json)、[源文件摘要](linux/linux-delivery-increment-hashes.json)及 [completion](linux/linux-delivery-increment-completion.json)。这些窄例补证新增路径，旧 59 项仍只证明其被检版本。

## A1–A12 对应

| 要求 | 工程证据 |
| --- | --- |
| A1 批量与独立验证 | 121/122 六输入，两产品均五成功、一失败、依赖跳过、partial 清单；实际字节与应用数据 |
| A2 双产品 | 112/113/118 与 121/122/123；真实 Driver、分产品工具及适用入口，IM 为替身 |
| A3 受限脚本 | 104/105 与四格平台；控制流、真实 WASM/进程、I/O 拒绝、协议/资源与停止 |
| A4 后台与唯一回报 | 107/115/118/121/122/123；来源授权、发起者结束后继续、聊天与唯一汇总 |
| A5 来源权限 | 111–114、四格 112/113；收窄、MCP/审批、资料撤销、绑定与引用 |
| A6 可信发起 | 118/119 模型/显式入口同一宿主核实、外部引用/无来源拒绝；123 实际工具发起 |
| A7 故障与恢复 | 105–109、独立重启/双运行组合、115/116；失败分支、持久交付序、未知写暂停与取消竞争 |
| A8 固定三名额 | 105/107/122；普通委派共用、事务抢位、尝试/时间预算与纯人工停计；拥有者澄清已落盘 |
| A9 版本固定 | 117/118/120；原脚本/参数/请求键、命名历史与不可读/校验失败明确拒绝 |
| A10 人工问题 | 114–116/119；绑定、重启、重复/过期/跨来源/取消与批准分流；123 实际聊天和回答 |
| A11 冻结汇总 | 112/122；五份实际补丁与独立副本/任务、验证版本、冲突保留、组合检查失败可见 |
| A12 Git 范围 | 110/112/121；非 Git 修改在写入/模型前拒绝，分析与业务工具正常 |

真实 IM：本机个人与开发档案均无 QQ/Telegram 绑定，拥有者已选择先完成可运行验收、真实 IM 待验。恢复条件是提供实际绑定实例/平台，再从原入口完成六输入、等待聊天、版本绑定回答、唯一发送及换代/未知发送检查。拥有者产品体验尚未确认，不能以替身、PTY 或模型检查代替。
