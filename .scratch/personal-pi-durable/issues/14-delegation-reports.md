# 个人 durable 委托汇总与原入口最终回报

Status: resolved

## 结单结论

2026-10-18，按拥有者最新指令取消本单重复人工走查门槛，沿用已有工程交付、独立审查及实际证据，记为resolved。尚未执行的真实环境或最终候选组合由[39](39-final-acceptance.md)统一持有，不新增测试通过结论，不再单独要求拥有者操作。

具体承接与唯一人工事项见[本轮工单收敛](../evidence/owner-acceptance-2026-10-18/issue-closure.md)。下列实施记录保留当时的失败、跳过与证据范围，原逐单体验等待不再作为当前结单门槛。

## 目标与边界

接续[总工单](01-migration-plan.md)、[规格](../spec.md)及[分析委托](13-analysis-delegations.md)。已确认总方案与本次接手授权覆盖实施。主 Agent 显式结束分析安排，宿主等待全部成员停止，唤醒主会话汇总并向固定原入口汇报一次；本机可分页查完整报告。只覆盖空工具分析，不改变正式入口、部署、Coding 或独立服务操作归属。

## 方案

- `background_work` 增加 report，须当前唯一拥有者输入且属于原委托入口；同事务登记不可改写接纳证据、唯一原生报告 Task。报告引用即封组事实，阻止共用 delegate/append 的所有入口；重复请求返回原报告，不另造任务。
- 报告 Task 以原生 allSettled 等待成员，核实停止、取消、固定入口与整组未知效果。失败但停止已核实的成员如实汇总；停止未核实不调用模型。未知效果由原报告 Task 观察既有操作 document 等待，效果与停止都核实后继续；等待不占主会话。
- 以稳定键和自定义 entry 向 root admission，内容及来源先固定持久化，再重接同一 Submission。主会话报告只可查询原结果，没有拥有者变更授权。provider 的两处持久记录边界核实报告归属及暂停/取消；不用普通 hook 异常作拦截。结果只读本报告 Submission.answer。
- admission 后若 provider 门禁发现未知效果，同 commit 留下该报告尝试的不可改写暂停证据，再在真实请求前拒绝。原 Submission unanswered 后，报告 Task 等待核实，再以同逻辑报告下递增且持久的尝试键重做只读模型汇总；每次尝试内始终原键恢复，唯一外发键仍是原报告 Task。普通模型失败没有暂停证据则可查终止，不循环重试；不能在 provider 门禁里等待从而占住主聊天。
- Telegram 最终发送使用单独报告身份，固定原 bot/owner/代次及原消息，沿现有 pending→sending→verify 的未知不重发语义。取消或换代先提交则不发送；已领取发送后保留真实 sent/effect_unknown。持久状态和完整回答由 CLI/Telegram 可查。
- 取消先落盘，报告 admission 后再检查并撤回尚未放入上下文的该条 Submission；不 abort 整个 main。新增扩展阻止旧程序恢复新档案；启动双向核对报告任务、封组接纳、固定输入、Submission 与发送关系。
- 影响面：personal-report、delegation、work、work-tools、harness、work-controls、control、CLI、测试和 fixtures；同步个人模块/products/usage、测试导航、pre-push 检查及决定笔记。无依赖或共享包变化。

## 进展与交接

- 实施交付时角色：工程交接；基点 `0c6f60c`，分支 `Eitrous/migrate-to-pi-durable`，接手工作区干净；本次提交承载实现、测试、文档与证据，以相对基点 diff 和[内容快照](../evidence/14-delegation-reports.sha256)核对。快照不包含工单与证据，避免自指。setup 在 macOS 完成。
- 两个独立只读调查核实公开 SDK admission/等待原语和方案窗口；独立方案审查发现并修正未知暂停后的 admission 恢复缺口，复审无阻断，亲跑 notes/docs/diff 通过。无拥有者待决产品取舍。
- 原实施交接：拥有者体验 CLI/Telegram 的完整报告、封组后追加拒绝、取消及固定最终回报；实施者继续外部工具归属与权限。工程完成且独立审查无阻断，真实模型/平台与完整 A1–A12 仍由总工单持有。

## 验收与证据

- 2026-10-18，37 在 `63a52f46` 补做真实模型本机子集：`deepseek/deepseek-flash` 实际委派、复用原身份、report 封组并用 progress/result/report_result 查询，唯一报告最终为 `local/completed`，实际主/子/汇总请求已归档并经[独立审查](../evidence/37-current-live-flow/review.md)。仅同进程持久重开，不是故障恢复或真实 IM。模型报告引用生成期间的 waiting 中间状态，拥有者体验及外发唯一性仍待验；不据此关闭本单。
- 多成员、追加说明与失败结果完整归属，主聊天继续；report 后拒绝续派/追加，登记竞争按事务顺序仲裁。
- 汇总与最终发送各只登记一次；重启重接原 Submission，其他主聊天回答不能串线；原入口换代不改发。
- 取消覆盖成员、报告等待/admission/生成/发送前窗口；已开始外发如实保留效果。未知服务效果与停止未核实零汇总请求；取消不误撤无关聊天。
- 未知效果暂停后重启，仅核实效果仍零请求，核实停止后原报告继续；admission 后门禁暂停只增加有证据的模型尝试，固定外发最多一次。
- 汇总输入不能取得拥有者变更授权；坏关系、缺扩展/版本/接纳证据恢复前拒绝。请求证据包含实际工具和提示，记录文本估算前后值。
- macOS/Linux personal 窄测试、静态及构建；CLI 真 PTY、离线 Telegram 故障、真实进程重启。真实模型/平台和拥有者体验缺前提时待验，不替代为通过。
- macOS 27.0.1 / Node 24.15.0 / npm 11.12.1：12 文件完整基线 285/285，最终报告文件 28/28（比基线增加 3 项），累计覆盖 288 个唯一用例，零失败/跳过；不是一次完整 288 项运行。check:static、build 通过，最终测试文件另经 lint/根 tsc，说明同步后 notes/docs/diff 通过。Coding 包 shasum 保持 `5af04e561c9fbf84bf29f8237e3655e563ea5ed9`。日志、命令、环境与统计见[本机汇总](../evidence/14-macos/summary.json)。
- Ubuntu 24.04.4 / Node 24.21.0 / npm 11.19.0：专属隔离副本 setup、12 文件基线 281/281、报告/服务增量 69/69、最终报告增量 28/28，两次 build 通过；累计覆盖 288 个唯一用例，实际执行 378 次，不累计重复执行为唯一数量。34 份最终 personal 源码/测试 SHA 匹配，专属目录与 cwd 残留进程均清理。初次无 Git 元数据的 setup 拒绝和外层 SSH 255 运输异常保留，后续独立连接核实远端实际退出码为零。详见[Linux 证据](../evidence/14-linux/RESULT.md)。
- 独立方案审查 `summary_design` 发现原键 unanswered 无法恢复，补充持久暂停证明及逻辑报告内安全模型尝试后复审无阻断；亲跑 notes/docs/diff。独立实现审查同名上下文直接读规格、源码及 SDK；报告/服务 61/61、报告及调用方 90/90，最终独立探针 10/10；停用 token、取消/admission/发送领取、选择性撤回排队报告与 HTTP 输入逐份深等均通过。源码哈希、日志和探针见[独立审查](../evidence/14-macos/independent-review/REVIEW.md)。
- 新用例包括同轮多成员、追加/封组仲裁、所有追加来源、重复 report 原任务、回报参考无变更授权、HTTP 前/在途取消、native abort 未 admission 不造输入、发送领取两种顺序、原生 Submission.done 后与真实发送成功提交前两个 SIGKILL 窗口、坏接纳/固定输入/回答/reply/暂停/工具关系拒绝、未知效果跨重启等待与 HTTP 前暂停后安全尝试、CLI 实际后台接口及 Telegram 原菜单分页零模型。
- 真实 PTY 选择委托、查看完整本机报告并退出向导；退出后原后台状态仍可查询，随后停止后台/模型替身并删除专属档案。见[PTY 记录](../evidence/14-macos/pty.json)。自动操作者不替代拥有者体验确认。
- 实际 HTTP 输入与 durable payload 8/8 深等，保存主/子/报告完整工具、提示与报告内查询轮次。wire 文本估算主 systemPrompt 70→122、toolSchemas 691→804，子 64/0；见[估算](../evidence/14-macos/text-estimates.json)与[输入快照](../evidence/14-macos/independent-review/model-input.json)。快照限无服务主会话与空工具子会话；服务装配由本轮 personal-services/operations 回归覆盖。
- 工程验收：本片通过。实施交付时产品验收记录：待拥有者体验；真实模型、Telegram/QQ、systemd 与精确 Node 矩阵未执行。未跑全仓 check，没有共享包、依赖、正式入口或部署变化。完整 A3/A6/A10/A11 及 A1–A12 整体继续待验。

## 37 真实流程补证

2026-10-18：实际6组各唯一报告Task/接纳，其中5份TG sent、1份local；原中断报告等待双核实后仅送一份。新更正group825报告唯一回复TG535，但正文末句误述仅留本机，缺陷原样交39，不能称正文完全准确。版本、实际ID、源码候选与清理见[37证据](../evidence/37-current-live-flow/README.md)。这是限定补证，不改变本单未覆盖项或当前状态。

## Comments

2026-10-17：从总工单接手。只读调查确认 SDK 的同键 admission 不核对正文，故由应用固定报告输入并恢复核对；主会话报告采用自定义 entry，不冒充 pi.user。

2026-10-17：独立方案审查先发现未知暂停的原 Submission 无法复用恢复，修订持久安全尝试后通过；独立实现审查发现停用 token 恢复与最后未知检查竞态，均修复复核。精确取消与发送领取、原报告排队选择性撤回已验证；发送领取两种顺序纳入回归。当前工程验收通过，产品与真实环境待验；未提交、推送或部署。

2026-10-17：拥有者指示提交本片；源码与已验内容快照、独立审查结论一致，工程验收沿用。产品和真实环境仍待验；本次未获推送或部署指示。

2026-10-18：拥有者明确要求只保留必须本人执行的事项，其余直接resolved；本单按上方结单结论结束独立跟踪，未验项目与原失败由39承接，不重复要求真人走查，未执行新的运行检查或生产操作。
