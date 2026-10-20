# 39 最终验收进行记录

本轮从 `b1e975437f4cd3ca8084a8b07e451f19ba80ba17` 的干净工作区接手。2026-10-19 晚拥有者按披露性残余风险处置 A1 后，39 置 resolved 并提交本地候选；本页保留各轮事实与未验边界，其中 A1 三项历史未归因失败仍为披露性残余风险，不表示已归因或全矩阵通过。最终标准仍由[规格](../../spec.md)与[39](../../issues/39-final-acceptance.md)持有。本目录分开保存离线、真实 OS、真实模型、真实 IM 与诊断失败；不累计旧测试数作为当前候选通过。

## 2026-10-19 接手更新

本页v3结论只对原v3快照有效；接手时实际6份服务事实晚改动使清单643/649匹配，远端正式后台仍运行v3。QQ委托792的取消及同身份复用已发生，但第二项未申请重启、最终878字符正文仍错误要求核实；service824实际未消费且已知未执行。NapCat首错已由本人启动日志确定为Library Validation/Team ID拒绝，旧“底层原因待查”失效。拥有者已选Linux/Docker；隔离候选native已加载、仅回环且未接个人后台，扫码仍待完成。源码补验、原失败事实与当前后续由[本次接手记录](handoff-2026-10-19/README.md)持有，不累计旧日志作为当前全矩阵通过。

## 2026-10-19 晚：新入口与真实 QQ 复验

本人扫码后新 Linux/Docker NapCat 4.18.38 已登录同一测试账号；本轮用仓库真实引导向导按新代次重新配对 QQ 入口（新边界消息 id 698476783、旧回环目标无监听、未双收发），以当前候选源码启动隔离验收后台，并完成真实 QQ 组合：新独立委托复用原身份 → 服务重启待批 → 本人在原入口 `/审批` 并「批准本次」一次 → 测试服务计数 3→4（唯一新增启动行、MainPID 更换）→ 委托唯一报告 delivery=sent、557 字符与宿主事实逐句一致、无二次重启与其它业务。真实 QQ 新图已产物化（11464 字节 PNG）并实际入模，模型读出图内文字，根 Agent 独立读图一致；Linux 两 Node 子服务族 32/32 补齐。独立终审无阻断，[A1 失败账本](handoff-2026-10-19/a1-failure-ledger.md)保留三项未归因失败、不关闭门槛。全部新事实、记录修正与未验边界见[本轮记录](handoff-2026-10-19/round3/README.md)；发布候选绑定见[candidate-bindings.json](handoff-2026-10-19/round3/candidate-bindings.json)。

## 源码与环境

[candidate-source.json](candidate-source.json) 固定接手时647份运行、测试、构建及基础验证文件，[source-archives.json](source-archives.json) 固定完整/最小源码导出与旧代码导出的 SHA。远端导出分别新建隔离 Git snapshot 供 setup 使用，没有复制原 Git 历史；原始 commit 身份由清单记录。`current` 与 `old` 分别安装依赖，不共用 node_modules。原生探针首轮覆盖远端两份 results 文件，该变化已单列，不声称整个导出树不变。

macOS 为27.0.1/arm64，Node24.15.0；额外独立下载校验Node22.19.0。Linux目标为拥有者指定的 oracle-4c24g，Ubuntu24.04.4/aarch64、实际ubuntu账户。安装了固定Node24.15.0/22.19.0、bubblewrap、编译工具和仓库按路径AppArmor前置，保留整机userns限制。原生探针首轮因沙箱中没有node返回2，补齐正式路径的Node后54项通过，见[真实报告](linux/native-probes.json)及[两轮原始日志](linux/oracle-native-retry.log.gz)。该报告是OS边界探针，不替代产品恢复或真实模型/IM。

## 已完成的限定证据

| 范围 | 本轮事实 | 证据与限制 |
| --- | --- | --- |
| A1／原36/38 | macOS 100/101-helper独占44项通过；112/118单文件24项通过；125/22/45/83单文件分别通过；snapshot重复扫描缺陷已修，原15秒并行负载反例先红后绿 | [独占日志](macos/macos-exclusive.log.gz)、[112/118摘要](macos/coding-audit-summary.json)、[四组原日志指纹](macos/coding-group-archive-manifest.json)、[原生修复交付](native-protection/author-delivery.json)。原17停止失败与native101身份查询仍独立，不用新超时归因覆盖它们 |
| A1/A9/A11／Node | macOS Node22入口/基础49项通过；Linux Node24入口/原生/CLI等94项中93过、1项不适用；Linux Node22首轮108项中107过、1项模型流强杀等待失败 | [macOS22](macos/macos-node22-entry.log.gz)、[Linux24](linux/oracle-node24-tests.log.gz)、[Linux22](linux/oracle-node22-tests.log.gz)。两平台不是完整CI矩阵；Node22原失败不因后续派生窄通过而注销 |
| A2/A10／真实文字 | 本人完成QQ和TG实际配对；两平台真实文字进入同一主会话1，QQ回答“QQ已记住”，TG从上下文回答“蓝莓39-1018” | [消息与收件引用](cross-platform.json)、[QQ绑定](qq-binding.json)、[TG绑定](telegram-binding.json)。尚不证明图片、后台组合或全部唯一发送窗口 |
| A8/A9 | 当前基础/记忆/技能/历史/媒体五文件69项通过；上一轮658份被验源码与接手源码完全一致，可沿用原模型/CLI叶证据 | [当前69项](macos/map-a8-a9-summary.json)、[旧证据逐字节对照](macos/map-manifest-comparison.json)。源码匹配只允许复用原范围 |
| A12 | Linux真实旧服务自动重启、停用/mask、独立scope停止、双归档指纹、旧四类积压不执行与第三空白档案代码回退通过 | [演练报告](a12/report.md)、[两轮权威原始包](a12/evidence.tar.gz)。第一轮脚本验据失败保留；模型/平台为回环替身，生产切换仍归40 |
| A7／浏览器 | Linux实际 owned 浏览器 ready，独立目录/端口身份可核实，本地页面和截图成功，namespace/PID/network/seccomp/TSYNC sandbox均启用，关闭后自有进程退出 | [真实报告](browser/browser-report.md)、[原始包](browser/browser-evidence.tar.gz)。首轮 No usable sandbox 保留；补精确路径AppArmor后成功，没有关闭全机限制或使用 no-sandbox |

## 原生启动重复扫描修复

原 Code 场景双进程并行时，两份原15秒等待均失败；采样表明运行依赖逐项核对反复同步遍历同一保护树，单进程超过300万次lstat。改为每个保护根一次批量核对，保留逐保护根的代码资产只读例外、身份与祖先关系、子文件bind/硬链接拒绝，不保留跨调用缓存。目录退出时拒绝已观察的身份/修订变化，候选/祖先/保护根返回前复核；不是文件系统原子快照。

[独立审查](native-protection/native-batch-review.md)无阻断；原15秒双进程在最终源码下均通过，新增8项边界有撤修复反例。作者86项回归中有最后stat守卫变化，按[交付清单](native-protection/author-delivery.json)保留时间范围，不拼成最终全绿。根工作区整合后构建worker、静态及38项调用方检查通过；Linux真实mount namespace的nlink=1文件bind别名被拒绝，卸载后同名安全文件放行，见[真实探针](linux/native-file-bind.json)。Linux Node24/22各45项中44过、1项macOS专用跳过，见[24日志](linux/final-native24.log.gz)、[22日志](linux/final-native22.log.gz)。

目录时间测试在Linux可能因同时间片不变而假阴性，已将夹具显式推进mtime，验证“观察到变化则拒绝”；[32轮现场](native-protection/dir-clock-linux.json)中29轮即时创建没有可见mtime/ctime/size变化，不据此承诺目录变化都能被时间戳发现。原17/36和native101旧停止原因仍缺首故障分支/PID/errno，[归因交接](native-protection/stop-unattributed-analysis.md)及mock C不变式探针不冒称真实OS重现。

## 报告发送状态修复

真实模型探针复现报告正文仍写“delivery=waiting”，而宿主已沿原入口唯一发送并记sent。真实请求中的progress结果包含自身report.waiting/running，随后被抄入最终正文；无历史、无重启的最小替身链可重复，delegations和生成中的report_result也各有同类红反例。

模型progress/delegations移除报告阶段和发送状态；报告生成中的report_result只引导查询成员业务，普通拥有者轮次、宿主/CLI/IM仍查询完整真实发送状态。三条最窄回归先红后绿，相关三文件66项通过，静态门禁通过；[独立审查](reports/real-report-independent-review.md)无本次修复阻断，普通拥有者查询仍保留原文及local/completed。实际补测共22次真实模型请求、平台为回环TG替身，验证复用、截断标注、固定入口唯一发送及重开不重发；不计真实IM。

[原始请求/SQLite/错例包](reports/raw-evidence.tar.gz)与[敏感扫描](reports/real-report-sensitive-scan.json)保留修复前后。后续报告另有offset=1读取自身切片后误称原片段首字被切掉，原offset0完整，已单列未解决的全文准确性缺口；发送状态修复不能冒充全文准确或A1–A12通过。

针对上述切片误述，工作/报告文本页另补offset和保存总长totalChars，参数明确文本位置/条目位置及nextOffset、partial的不同含义；保留合法任意offset。三文件60项红绿检查与静态通过，原失败日志及新日志见[红](macos/result-page-red.log.gz)、[绿](macos/result-page-green.log.gz)。[独立实现和真实长答复核](reports/offset-final-review.md)、[原始包](reports/offset-evidence.tar.gz)确认5990字符原文和具体遗漏匹配，9次真实请求均有输入/实际payload双份记录，固定原消息发送一次、重开不重发。系统提示估算107→107、工具定义3338→3364；模型仍多读一次offset8192空页，但没有误述原文，不将单次正确扩大为模型永不误述。

## Node22模型流诊断

原stock用例在Linux Node22两次未等到partial标记；派生诊断最初改坏eval导入，且异常处理假设数据库已存在，属于诊断脚本错误，不解释原失败。修正后保留原5秒预算的stock-relative探针两次在4892ms/4959ms才拿到标记；分阶段主要为约4501ms静态导入、84ms开库、5ms提交和369ms到partial；Node24原stock窄例通过。见[诊断](linux/node-stream-diagnosis.md)。支持启动等待余量过小，原失败时刻现场不足，仍保留未归因。

测试现先等待子进程完成静态导入的IPC ready（10秒），再开始原5秒已持久partial等待；整例15秒、真实锁/流/强杀/重开及唯一用户/非空aborted断言保持。独立反例发现整体超时后可能先删夹具后关闭子进程，最终补注册在夹具前的等待关闭清理及abort启动守卫；最终Linux Node22/24各27/27，见[原日志及范围](linux/final-ranges/summary.json)、[最终清理补丁与作者证据](linux/ready-final-cleanup/ruukoto39-personal-durable-ready-cleanup-delivery.json)。这是测试等待起点改变，不宣称产品冷启动5秒保证或追认原失败唯一原因。另六个个人文件的两版各114/114发生在浏览器汇总筛选后续修复前，范围分开记录。

## 实际连接与当前待验

NapCat在拥有者本机127.0.0.1:3001，凭据只留本轮私有0600文件。匿名WS握手后关闭，实际鉴权get_login_info成功，见[只读探针](napcat-preflight.json)。远端通过仅回环SSH隧道连接，不公开监听。TG直连getMe失败；使用本机固定上游api.telegram.org、无重试的回环代理及SSH隧道后实际配对与聊天通过。代理支持原Bot API及图片下载，认证值不入日志或仓库。两份配置中的apiBase/endpoint反映本轮环境，不作为生产配置。

当前真实档案在远端 `~/.local/ruukoto39/live-profile`；已保留文字阶段一致备份，拥有者更新模型input包含image后，Agent停机核实、按原配置入口启用imageInput、命令及资料/网络能力，再启动。图片、后台/调度、真实权限/服务/MCP/HTTP/浏览器与外部效果恢复组合仍在推进。工具链及业务准备由Agent承担，只有本人账号输入/图片/原入口决定沿31集中完成。未提交、推送或接管生产。

拥有者随后已实际发送两平台图片。TG图片进入主会话entry54，具有image part及持久图片产物，模型entry60正确读出独立校验码IMG39-B9M2及蓝色三角形；QQ图片接收/下载仍在核查，不能用TG成功替代。

QQ首图记录download_unavailable并明确回复下载失败，没有降级成文字请求。当前NapCat官方固定源码使用multimedia.nt.qq.com.cn，原白名单缺少该精确主机，已补并通过[独立审查](native-protection/qq-host-review.md)；HTTPS、userinfo拒绝、精确hostname、redirect:error和不携连接token保持。原首图实际URL未取得，不能断言其失败唯一根因；本人已重发两图，仍在下载阶段拒绝，详见下方新输入取证。两条隧道曾暂态断开，已在不改变sshd/共享会话下重新建立，不能把连接关闭归因成已证实限流。

## 真实业务组合

专用HTTPS MCP使用本轮CA和私有Bearer，未关TLS验证；无CA失败、无/错token401、正确认证发现/单行SQLite写入成立。原字节service helper及仅ruukoto39-test.service/restart的策略已在新隔离路径安装，无sudoers改动，初始计数1；[准备记录](business/preparation.md)、[原始包](business/preparation-evidence.tar.gz)不等于模型组合通过。

实际DeepSeek本机拥有者轮次完成memory/skill、应用数据同事务两行、MCP marker单行、真实Tavily、文件/HTTP及浏览器工具调用。到截图后轮次unanswered，原错误为image_reference_invalid、仅记input无payload，不能称provider HTTP失败；原业务写入没有重试。当前SDK将Responses工具图片放在function_call_output.output，旧快照漏读该位置；真实adapter双来源图片检查先红，补精确位置后媒体/browser两文件28项通过，两版macOS通过，独立实读SQLite/adapter复核无阻断。另一次只读真实请求正确识别原TG图片与截图，没有重复业务，见[独立审查](reports/responses-image-final-review.md)。

随后独立拥有者轮次正常命令一次、测试服务重启一次，文件以独占创建写入marker，服务计数1→2。原最终报告在发模型请求前被浏览器能力筛选误按pi.user核实而失败；筛选现仅对精确宿主报告kind移除浏览器资格，其余未知/缺失来源仍拒绝，原报告门禁独立核实，见[独立审查](reports/browser-report-final-review.md)。后续只读复核探针因人工12次HTTP预算在13次后取消，只证明结果读取/筛选，不计最终回报成功；没有重复命令、服务或上轮业务。完整原材料见[组合包](business/combo-evidence.tar.gz)与[凭据扫描](business/combo-sensitive-scan.json)。

独立A6故障档案在原字节helper完成唯一restart后、结果提交前强杀：服务计数2→3，恢复为effect_unknown且原来源暂停，没有再次重启；另一真实模型聊天完成，原效果核实及真实停止重核后释放原占用，见[报告](business/a6-service/README.md)、[原始包](business/a6-service/evidence.tar.gz)与[四份凭据72种变体扫描](linux/final-ranges/a6-four-credential-scan.json)。该轮是可信宿主API故障窗口，不计真实IM原菜单决定；测试服务当前计数3，未增加后续重启。

## 当前输入身份与本人复验

本人QQ后台45秒要求已经作为独立pi.user进入主会话，模型却只查询旧331/346并误称新要求附在宿主汇总参考末尾，没有创建新后台工作；TG同时要求的聊天正常回答。实际规范输入和Responses payload中旧参考与新要求是两条分离user消息，没有平台字符串拼接或SDK合并，见[边界摘要](reports/qq-current-input-boundary-summary.json)、[原始证据](reports/qq-current-input-boundary-evidence.tar.gz)和[凭据扫描](reports/qq-boundary-sensitive-scan.json)。该场景为失败，不能据TG回答记双平台后台通过。

主会话正常请求现从唯一活动Submission的持久entry kind追加当前来源说明；候选还只在原pi.user与实际当前user逐字段一致时，为该轮正文投影添加首尾边界。技能先匹配原文再展开，图片parts保持顺序，原用户entry不改写；压缩/子/定时/未知kind不冒充拥有者。真实模型对照A/B/C仍误判或停留旧查询，D在明确预算内转向新delegate意图，仅为模型意图，不计IM执行。候选独立检查包含实际Responses图片、技能、合成user、并发压缩及撤修复反例，见[独立审查](reports/owner-boundary-independent/review.md)。原广组787项为784通过、2个旧分页期望失败、1个macOS不适用；修正两处既有offset/totalChars期望后，命令与模型夹具40项全部通过，不把范围不同的日志改称一次广组全绿。本人复验B已受理且完成唯一命令，实际当时仍为来源句版本，不能将其归因于尚未部署的正文边界。

## 本人新输入与登记修复

QQ复验B在原委托593创建工作602，并以命令616执行唯一sleep45；TG同时收到“跨平台聊天39-1018B”。模型原调用620已经请求登记593的最终报告，但宿主把正常started占位也判为来源暂停而返回work_source_paused。命令随后以exit0、stopped=true结束，成员回答“QQ后台39-1018B完成”；当时没有报告登记，不能计最终回报通过。

登记现只核实原输入、原入口有效和未取消；生成及发送仍由原报告Task等待全部成员停止与效果核实，其他操作的来源暂停不放宽。running、unknown、restored三条新增用例原码均红，修复后两种核实先后均保持未齐备零汇总、零新派，齐备后唯一报告和原命令计数1。作者126项及静态通过，[独立终审](reports/report-registration-independent/review.md)亲跑三条无阻断；这是命令worker与替身systemd，不计真人QQ完成。[实现和红绿包](reports/report-registration-evidence.tar.gz)、[原593诊断包](reports/report593-diagnostic-evidence.tar.gz)分开保存。经空闲停机、一致备份及同源配置单写者维护，原620意图已兑现为reportTask762；实际3次模型HTTP、1次固定原QQ发送，poll与Harness正常关闭，再恢复正式后台tasks0/inputs0。该维护只接续原报告，没有新工作或命令执行。首轮维护误用/usr/local/bin/node，被旧full_access命令371的原Node路径校验拒绝，registered/model/HTTP/send均0；改用原正式Node路径后成功，未放宽验证器。另一次后台启动因调用工作目录错误找不到tsx，已按原cwd修正后确认在线，不归产品缺陷。

本人QQ重发880487927、940475107两图均记录download_unavailable、产物0、无模型Submission；后续纯文字让模型复述旧TG图片，不是QQ图片成功。捕获的一份原URL形态为白名单内HTTPS gchat.qpic.cn；后续Oracle同URL单次GET为HTTP400/空体，无跳转，与当前下载拒绝一致，不追认原时刻状态。本机GET已发起但编排错误未留metadata，缺证据不补称成功。原URL/query凭据不入库；[安全审查](reports/qq-schedule-audit/review.md)、[小包](reports/qq-schedule-safe-evidence.tar.gz)保留范围，原始事件仅在私有临时文件。

本人TG消息550实际创建一次性过去时刻计划；独立会话688派生子分析，正确算出44693。报告结果753经发送任务754确认sent，真实平台消息552固定回复原550。原正文562字符仍把计划内无效report动作列为失败，并评价本次发送状态；原文 `reports/qq-schedule-audit/schedule-answer-original.txt`（原文无末尾换行，为满足仓库“文本以恰好一个换行结尾”的提交门禁未纳入本次提交；其 sha256 `747b0d817cb4a5c72eb34d8138e2ee64efda9fbdbc3e30294b1492cc9b5ea75c` 已记在同目录 `schedule-fact-chain.json` 的 `textSha256`）与[事实链](reports/qq-schedule-audit/schedule-fact-chain.json)保留，不重写计划/原结果或重跑业务。schedule_create说明已明确目标四动作及宿主自动封组，汇总输入只交付业务正文；真实SDK及持久请求反例、两Node调度整文件检查已通过，文本改动不能追认原正文准确。

QQ原最终报告业务事实和唯一原入口送达成立，但552字符正文仍称“我也未发送”，并要求拥有者再次指示report。原文及真实发送事实均保留，未改写或重发593；该正文准确性缺陷继续由39持有。报告参考末尾原先直接拼原拥有者“安排最终回报”要求，当前v3已增加引用边界，结果和有限模型对照见下文，不因已有开头说明就把原模型偏差记通过。

QQ补充诊断只调用一次真实get_image，24ms返回ok；其新URL仅fileid改变，Oracle单次下载仍HTTP400/空体。本机返回文件受OS隐私限制不可读，没有绕过；没有图片内容入模、没有重投原收件。官方固定源码的online_rkey是运行时状态，不是可开配置，当时安装版本与配置尚不可读，因此没有增加上游签名特判或猜测设置。[安全结论](reports/qq-media-diagnostic-review.md)、[诊断包](reports/qq-media-diagnostic-safe-evidence.tar.gz)及[四凭据和资源字段扫描](reports/qq-media-diagnostic-scan.json)保留准确边界；拥有者随后已提供可读安装副本；后续原生诊断和维护准备见下文，当前无需再次发图。

原593报告的[完整证据包](reports/report593-final-evidence.tar.gz)保留唯一admission/Task、三轮input与实际payload、原552字符全文及真实QQ回执676103229；[四凭据扫描](reports/report593-final-four-credential-scan.json)覆盖42个解压文件且零命中。当前新模板将原目标编码成单行JSON引用，再在引用后明确正在生成已登记报告的业务正文；新增实际请求反例原码红，完整reports37项及静态通过。硬只读/原入口/发送门禁不变，不改或重发593，[独立审查与只读模型对照](reports/report-stage-independent/review.md)完成：仅3/4HTTP、零重试，原历史/两图片/系统/工具逐字节保留，只替换本次报告参考；不再要求再次report，但仍有投递状态说明，只记有限样本改善。[完整包](reports/report-stage-final-evidence.tar.gz)与[四凭据扫描](reports/report-stage-four-credential-scan.json)保留，不计原593正文已修或新的真实IM通过。system235→235、toolSchemas4716→4716、参考输入102→119，均为共享估算而非供应商usage。

## 新增 OS 与恢复范围

A5在Oracle实际产品入口分别以confirm和auto-review运行一次受限命令，使用真实worker/native/bwrap，无权限/进程替身。外部读写/网络均受限、凭据不继承、原接纳/权限/回执可核对，命令退出且scope和临时目录清理；[证据包](business/a5-restricted-evidence.tar.gz)与[独立审查](business/a5-independent-review.md)不把Mock模型记为真实模型。

[单次真实固定检查异常链](business/inspection-abnormal/review.md)亦已补：原helper在show完成、stdout结果前冻结，SIGKILL后台后原占用保持，stop-inspect两次false；宿主仅结束本次冻结helper后，正式原stop-inspect确认true、工作中止并释放身份，重开无新检查。初次过早重核的active拒绝原样保留；[根独立SQL/字节核证](business/inspection-abnormal/root-independent-review.md)无该范围阻断。没有服务restart或live写入，不能推广到所有迟到窗口。两次正常固定服务检查均有原stop-inspect、同boot/machine、原进程组消失和root私有claim，当前未留检查占用；[审查](business/service-inspections/review.md)只关闭正常收尾，不替代中断和迟到窗口。A11新增[在途CLI协议检查](cli-inflight/review.md)验证client退出时真实请求已在途、同键后台完成、重连读取且无第二次模型请求；不是补写真人当时未捕获窗口。

原A1身份停止故障仍未重现。独立macOS诊断原窄例成功而无首故障，语义mock不作OS归因；Linux首诊断副本因外部绝对依赖链接在原沙箱不可见而失败，保留原未知占用及两份一致备份，不改记产品回归。修正独立副本依赖实体布局、证明真实原沙箱可导入后，原122窄例一次通过且全部stopVerified、无残占用；[完整证据](native-protection/a1-first-fault-evidence.tar.gz)不证明原17/native101历史原因或宽批次全通过。

## NapCat 原生状态与维护准备

拥有者提供的可读副本与一次真实get_version_info均为NapCat4.18.30；一次nc_get_packet_status明确返回unsupported_qq_version_arch，当前QQ6.9.96-49738/arm64没有原生offset，packetStatus=false。此状态和当前资源HTTP400共同限定上游环境缺口，但不能据此唯一解释此前每次下载失败。实际程序与账号目录仍受macOS TCC拒绝，本轮没有绕过或修改它们。

官方v4.18.38包含该QQ版本/架构offset。已准备并核GitHub digest的Shell发行包，SHA256为735f2e633247df3ffd6e8ee8b84d7039c315b2655f5807e5f0029f93d2c30016；ready仅按官方Mac安装器把package.version从0.0.1设成4.18.38，685成员逐项固定。实际zip与候选保留在拥有者Developer/Temp，仓库只留[维护说明](business/napcat-maintenance/维护说明.md)、[诊断安全包](business/napcat-maintenance/diagnostic-safe-evidence.tar.gz)、[最终独立审查](business/napcat-maintenance/independent-review.md)及小型清单，不入库账号配置或完整第三方包。

维护脚本要求QQ正常退出、显式实际workdir、原loader/程序/QQ版本吻合；完整私有备份后暂存替换程序，保留当前账号数据、config/cache/logs/plugins/data。回滚校完整旧程序但仍保留当前状态，不自动覆盖旧数据。每次复制校目标hash，合成文件系统6/6自检覆盖成员漂移、目录碰撞、切换/metadata失败恢复及当前状态保留；最终Python6fea248c51a103f1eea13cf72c29cadde6e53be9d0488d391acbe0290ff0fbd5与Shell39f96e088e6f643e5c51a1eccba75f1b5a354516fd42d24020492001067b4305前后不变。独立审查没有在真实目录执行升级/回滚，不能保证恢复自身遇I/O故障也必定成功。本人执行时在读取原loader的前置检查即遇Errno1/Operation not permitted，未进入程序替换；随后本人改用NapCat Installer更新。一次真实版本查询已确认4.18.38，但两次纯packet状态查询均1400，第二次为补取首条未分类错误，脱敏原因为NativePacketClient不可用。当前定位到napi2native加载层，尚未证明缺文件或dlopen的具体原因，没有请求新图或重投旧失败收件；[实际查询](business/napcat-maintenance/after-installer-result.json)与安全响应均保存，原响应仅私有保留。

## 最终矩阵收束

[独立矩阵v3](final-matrix-review-v3.md)与[A1逐项核对](a1-closure-plan.md)已把原38各组关联到实际叶日志、晚共享原生变化和当前源码。四组原日志已补归档，分别125为5/5、22为17/17、45为7/7、83为24/24；没有新增执行，也不合成最终宽批次全绿。三个Coding生成worker与原112/118环境和v3制品逐字节一致；共享native变化另由安全负例、调用方和原15秒并发红绿证明。独立核对未发现必须新增执行而全无覆盖的当前场景，历史事件数63≠61、预算/宽批次时序和首次停止归因仍保留，A1最终验收门槛及发布commit没有据此自动关闭。

QQ真实审批/取消的[最小方案](qq-minimal-owner-plan-v3.md)已只读核代码；保留auto-review、现有服务长期授权0，第一阶段只取消未封组单项，停止核实后再同委托复用身份，第二阶段只批准一次测试服务重启并生成原入口报告。首次[在线预检](qq-human-preflight-before-reconnect.md)确认后台空闲、服务计数3、helper/单元策略和QQ原绑定均匹配，但远端QQ离线，不能请本人发委托；本轮本机隧道/代理进程已退出；已按原固定上游和回环目标恢复，新的远端QQ查询确认enabled/receiving/online均true、tasks0/inputs0，随后才请求本人第一条新委托。重连前两次SSH在服务端banner之前关闭，后续同目标以本进程IPQoS=none成功，不唯一归因，也未改全局sshd/SSH配置。详见[连接记录](connection-restoration.json)，没有改默认权限或重复旧业务。

## 当前制品范围

[当前源码清单](candidate-current-source.json)固定649个运行/测试/构建文件，含相对接手基线50个变化文件；[macOS v3制品](macos/final-v3-artifacts.json)与[Linux v3制品](linux/final-v3-artifacts.json)分别逐字节匹配649份源码及个人包75/Coding包6成员。当前仍是未提交工作区，没有可发布commit；两平台均完成构建，隔离后台已按原Node和cwd更新为v3并确认tasks0/inputs0。v2清单保存在[candidate-current-source-v2.json](candidate-current-source-v2.json)，此前648份来源句版本保存在[candidate-current-source-v1.json](candidate-current-source-v1.json)。

该段是 v3 时点记录。2026-10-19 晚的最终候选改为绑定 [source-manifest.json](handoff-2026-10-19/source-manifest.json)（649 文件，b2fa5776…）与[candidate-bindings.json](handoff-2026-10-19/round3/candidate-bindings.json)，Linux 制品记录已从远端临时目录归档为[linux-artifacts.json](handoff-2026-10-19/round3/linux-artifacts.json)，实现补丁见[round3/candidate-diff.patch](handoff-2026-10-19/round3/candidate-diff.patch)；旧 `changes.patch`/`implementation-diff.json` 保持原样不改写。

v2晚变化的macOS Node22拥有者/报告/夹具14项与scheduler整文件12项、Node24命令/夹具40项与scheduler整文件12项、Linux Node22/24组合各24项通过；随后v3报告参考独立改动，macOS Node24 reports整文件37项及静态通过，macOS Node22和Linux两Node各2条精确引用/只读门禁通过。未变的原生、Coding、媒体、权限及调度语义按已核变化范围复用叶证据，不把这些范围合成一次全量CI矩阵。实现差异见[完整补丁](changes.patch)及[指纹](implementation-diff.json)。QQ图片、较强QQ审批/取消及必要真人窗口仍待对应证据；未安排生产接管。
