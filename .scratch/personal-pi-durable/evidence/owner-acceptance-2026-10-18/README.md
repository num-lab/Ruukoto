# 本轮拥有者验收

2026-10-18，拥有者要求协助完成 personal-pi-durable 中仍为 ready-for-human 的工单。本轮读取23张当前工单、规格、35合并走查及37真实流程证据，按现行源码准备分批验收。该23单清单是本轮开始时的快照；拥有者随后要求仅保留真正必须本人执行的事项，其余resolved，当前状态以[工单收敛](issue-closure.md)为准。未执行的真实环境与工程残项统一由39持有，不改写为通过。

## 候选与已执行检查

- HEAD 为 `12b1a66cfa661f2a8bddaa9405283ab9f22cb20c`，工作区已有未提交改动；[源码指纹](candidate-source.json)保存658份实际源码、测试、部署和构建文件，[初始状态](initial-status.txt)区分原有修改。本轮没有改产品源码。
- macOS Node 24.15.0、Python 3.14.5；`npm run check:static` 实际退出0。原始命令输出保留于本聊天工具记录，未另存完整日志。
- 复用[35的PTY驱动](../35-owner-controls/pty-walkthrough.py)，在内存中把启动目标替换为正式 `apps/ruukoto/bin/ruukoto.mjs`，新日志写入本目录，不覆盖35证据。首次因旧驱动期待“隔离后台已启动”而失败；[原始终端记录](../../../git-history-cleanup/archive.md?path=.scratch%2Fpersonal-pi-durable%2Fevidence%2Fowner-acceptance-2026-10-18%2Fpty.log.gz)实际已显示“个人后台已启动”。finally核实停止、重新取得锁并清理临时档案后，驱动只更新该期待文本再运行。
- [当前正式入口记录](../../../git-history-cleanup/archive.md?path=.scratch%2Fpersonal-pi-durable%2Fevidence%2Fowner-acceptance-2026-10-18%2Fpty-current.log.gz)与[通过摘要](pty-summary-current.json)：真实160×50 PTY完成首次虚构模型配置、启停和状态、完全访问二次选择后切回自动审查、授权空列表、在线配置持锁拒绝、正常退出；真实模型及IM请求均为0，结束重新取得实例锁后清理档案。自动驱动不计拥有者体验通过。
- Linux `ssh tx` 可连接，PATH中有Node、npm、bwrap，未发现chromium/google-chrome命令；`/tmp`所在根分区40G、可用约934MB、使用98%。探测末尾因远端没有rg退出127，不能据此声称已检查服务环境变量。本轮未安装、清理或启停远端资源。
- 开始探测时本机进程未提供验收模型/IM凭据变量，默认 `~/.ruukoto-durable/` 不存在。37专用凭据和资源已清理，不能直接恢复其旧档案继续执行；后续新授权和实际操作见下文。
- 本轮检查结果汇总见[checks.json](checks.json)。已准备独立空白档案和启动器并请求Terminal打开，路径见[本机真人会话](human-session.json)；`open`退出0。界面工具禁止访问 `com.apple.Terminal`，因此未核实屏幕内容、未代操作或记录为真人验收；也未改用其他方式读取界面。
- 独立上下文 `early_acceptance` 核对23单枚举、658份源码字节、两轮PTY/清理事实、7份交接材料的105个文件链接与状态/格式、真人启动器及空白档案，结论无阻断；另亲验37归档123成员大小/哈希及数据库解压哈希相符。没有重复静态/PTY/外部操作，不能将本次材料审查记为真人验收。作者 `git diff --check` 通过。

## 逐单剩余项

下表是状态收敛前的缺口快照，不再逐张要求人工；最新状态及职责见[工单收敛](issue-closure.md)。

下表是本轮走查入口，长期要求仍由各工单与[规格](../../spec.md)持有。37补证只按其实际版本和范围复用；当前组合层已经随31–38变化，不能拼成最终候选全矩阵通过。

| 工单 | 本轮需要补齐的主要结果 |
| --- | --- |
| [03 本机CLI](../../issues/03-local-cli.md) | 当前分组菜单的实际配置、启停、最近记录、退出重连及原键核实体验 |
| [07 TG入口](../../issues/07-telegram-entry.md) | 当前候选的配对、收发诊断及主聊天；37已覆盖真实并发聊天与原入口报告 |
| [08 审批与授权](../../issues/08-telegram-service-approval.md) | 当前模式/审批/授权菜单及明确拒绝；37已覆盖批准、创建/命中长期授权、撤销后待审 |
| [09 服务配置](../../issues/09-service-configuration.md) | Linux专用helper配置说明、固定路径和实际检查；隔离副本不代表生产部署 |
| [10 模型后台工作](../../issues/10-model-background-work.md) | 当前结果查询与空闲身份关闭后历史保留；37已有取消后复用 |
| [11 工作控制](../../issues/11-work-controls.md) | 当前CLI结果分页、关闭身份及可理解的工作选择 |
| [12 追加说明](../../issues/12-work-notes.md) | 当前CLI追加及最后结果；37已证明审批等待期间实际消费补充 |
| [13 委托](../../issues/13-analysis-delegations.md) | 当前多成员进度与取消；补一项委托取消时另一委托继续 |
| [14 汇报](../../issues/14-delegation-reports.md) | 完整报告分页、封组后拒绝追加；37报告末句误述仍由39复验 |
| [19 检查停止](../../issues/19-inspection-stop-controls.md) | 真实固定检查未停时走 `/检查`，登记停止重核后核原执行退出且不另发检查 |
| [20 服务恢复](../../issues/20-service-recovery-controls.md) | 服务效果后/结果提交前中断，经 `/服务核实` 分别证明业务效果和原执行停止、计数不增加 |
| [21 子Agent服务](../../issues/21-subagent-service-operations.md) | 与20合并证明子工作/报告等待与双核实；37已有真实批准/长期授权/撤销 |
| [25 受限命令](../../issues/25-durable-commands.md) | 当前目录配置、双流分页与本机核实；37受限恢复只证明一个崩溃窗口 |
| [26 完全访问命令](../../issues/26-full-access-commands.md) | 当前配置/核实体验与适用恢复；37正常full命令不覆盖全部恢复 |
| [28 MCP](../../issues/28-durable-mcp.md) | 专用真实端点/凭据、发现/允许列表、模型调用、原IM审批、原请求/响应和撤销 |
| [29 通用工具](../../issues/29-tools-access-artifacts.md) | Tavily、HTTP、资料授权/撤销、产物独占导出及未知HTTP双核实；保留38相关超时缺口 |
| [30 浏览器/图片](../../issues/30-browser-media.md) | 真实视觉模型、双平台发图、浏览器/产物菜单及Linux可用Chrome沙箱 |
| [31 QQ](../../issues/31-qq-owner-entry.md) | 专用NapCat与拥有者好友号；与TG交叉上下文、图文、审批/取消及各自原入口唯一报告 |
| [32 调度](../../issues/32-scheduled-work.md) | 双平台真实近期计划、子工作和业务完成后才汇报；聊天并行、取消及固定原入口 |
| [33 记忆/技能/历史](../../issues/33-memory-skills-history.md) | 真模型保存→重启→读取原记忆、显式技能、本机修订/撤销及历史原文 |
| [34 应用数据](../../issues/34-app-data.md) | 真模型建表→单事务两行→重启查询；原IM破坏性操作审批、原回执及定时组合 |
| [35 配置与控制](../../issues/35-owner-configuration-controls.md) | 汇总上述当前菜单可达性与拥有者操作反馈，逐项回写已覆盖原单 |
| [36 Coding回归](../../issues/36-coding-regression.md) | 原17两平台停止失败的精确触发仍缺现场；属于工程取证，不能用体验确认或绿测关闭 |

## 实际走查顺序

以下是拥有者收敛指令前的合并走查安排，已由[工单收敛](issue-closure.md)取代：仅31保留本人账号动作，其余验证由Agent在39安排，不再重复逐张人工走查。

1. 本机正式入口使用新的专用 `RUUKOTO_PERSONAL_DIR`。拥有者操作当前分组菜单，先确认首次配置、启停、状态、模式与授权；真实模型配置确定后再接消息/退出重连/原键核实。空列表可达不能代替已有工作、回执与恢复菜单体验。
2. Linux专用目标补TG工作/服务链，优先验证37未覆盖的明确拒绝、关闭空闲身份、多成员取消、`/检查` 和 `/服务核实`；本轮故障只针对可回收服务与原执行身份，Agent负责效果计数、现场与清理，拥有者操作原菜单并按实际观察核实。
3. 配齐专用QQ、MCP、HTTP/Tavily、视觉模型/浏览器及技能后，完成双平台与各外部能力，再做记忆/应用数据重启链。真实模型窄smoke会在finally删除临时档案，不能把它当作保留完整现场的组合验收。
4. 完成配置与撤销反例并恢复最终配置后，再创建定时计划。技能、MCP、资料等配置变化会使原计划后续执行失效；浏览器只供创建时已有能力的完全访问计划，不开放给子Agent或最终汇总。
5. 每批记录实际候选、拥有者操作与反馈、模型请求/平台菜单/效果/停止证据，独立复核后只关闭确已满足的原单。36/38未归因失败仍阻断39及生产，其他能力可独立预验收。归档原始资料后才清理本轮资源。

## 当前接续点

拥有者选择先做本机CLI，指定后续Linux为 `oracle-4c24g`、NapCat为 `127.0.0.1:3001`、模型为 `/Users/eitrous/.ruukoto/agent/models.json` 的deepseek，并提供只供本轮的临时Telegram凭据。凭据不写入本证据；启动器只读取选定provider并把认证值传入进程环境，不复制旧档案。

本轮选 `deepseek/deepseek-flash`，OpenAI Responses、上下文1000000、输出上限4096、纯文字。拥有者实际完成首次配置、启动及状态查看，并回复“配置保存成功，后台在线”。Agent通过认证本机接口独立核对：[第一步记录](human-step-01.json)显示模型参数匹配、零输入/活动任务、目录0700及配置0600，配置只含凭据环境变量名。03/35增加该步真实拥有者证据，尚不关闭。

并行的独立临时档案执行[真实模型窄检查](model-smoke.json)，退出0、约24.7秒；[原始输出](../../../git-history-cleanup/archive.md?path=.scratch%2Fpersonal-pi-durable%2Fevidence%2Fowner-acceptance-2026-10-18%2Fmodel-smoke.log)记录5次输入、两次正常重启，脚本断言记忆保存/原版本读取、技能加载、应用表单事务两行及重启查询、成对请求证据和凭据不入证据。该脚本按其finally清理临时档案，不保留完整SQLite；因此只补33/34等对应叶测，不算当前真人档案、真实IM或最终组合通过。

实际 `oracle-4c24g` 为Ubuntu 24.04.4/aarch64、ubuntu账户，user manager为running、根分区约91GB可用；PATH未发现node/npm/bwrap，未安装任何依赖。该机3001端口无监听，本机3001返回HTTP426，后续核实NapCat位置与鉴权；初始tx探针不代表本轮目标环境。

拥有者反馈模式切换/切回、长期授权空列表说明及在线配置拒绝“三项都符合预期，说明清楚”。Agent随后核实发现实际默认模式仍为confirm、仅有一次本机confirm/version2变更，尚无切回auto-review记录；授权确为空、模型配置与第一步一致。实际差异保存在[第二步观察](human-step-02-observation.json)。拥有者再次选择后回复“已显示自动审查”；Agent亲核auto-review/version3与原配置不变，[第二步结果](human-step-02.json)保存原变更和复核，现将这三项记为拥有者走查通过，不把先前差异推断为产品缺陷。

拥有者实际完成真实消息、退出重连及最近消息查询，回复“后台在线，原回答包含结束标记”，见[第三步反馈](human-step-03-owner.json)与[只读观察](human-step-03-observer.json)。原后台身份未变、原回答保留，但完成早于原CLI退出约0.8秒；本轮不声称捕获执行中退出。

后续按现有测试范式准备独立本机代理，在真实后台接纳一次输入后直接丢弃客户端回包，实际捕获control_response_lost、原pending保留及原输入placed→done。尚未完成原菜单核实时，拥有者明确要求“不要浪费时间在这上面了，直接跳过”；该场景记[拥有者跳过](human-step-04-loss.json)，不再重复要求操作或记真人通过。Agent按精确代理PID/启动身份、cwd和socket持有者停止观察器，核实释放后删除本轮代理目录；按原键只读核实原输入done后，用现有helper清理自建pending，未重新提交。个人后台保留在线，零活动输入/任务，原历史不删除。

拥有者现已明确取消重复逐单体验门槛；本轮24张切片resolved，31保留本人账号动作，39承接实际未验项目，40持有生产授权与执行。原跳过不改称真人通过。后续QQ前置只读探针发现本机NapCat匿名WS立即关闭，尚未核实有效端点/鉴权；没有发送QQ消息或建立远端隧道。临时TG凭据仅保存于本轮专用0600文件，仓库只记录[只读连通检查](telegram-preflight.json)。本轮只收敛工单，没有提交、推送、部署或接管生产；结束须核实后台停止后再处理其档案。

本轮状态收敛的确切范围、前后状态及职责以[收敛清单](issue-closure.md)和[机器记录](issue-closure.json)为准；本README前段自动/真人步骤保持各自原始证据范围。
