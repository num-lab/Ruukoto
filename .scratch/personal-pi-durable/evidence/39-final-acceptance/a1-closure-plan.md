# A1 原38宽批次：最小收口计划

本次只读结论：当前范围没有必须新增运行的测试。已有窄叶覆盖当前行为；只需根归档四组现存日志、绑定最终候选，并明确保留历史归因风险。没有运行测试/业务、没有修改仓库或碰 NapCat；不把这份计划记作 A1 已通过。

当前候选清单 SHA256 `59c4bcac4716b860185df732b96fb3c6f5ada0b383572f31e72016d62b3d0c34`，649份中本次实读匹配649份，基点 `b1e975437f4cd3ca8084a8b07e451f19ba80ba17`；仍为未提交 v3 工作区。两平台 v3 构建/包及锁/worker已有记录，不能写作一次完整CI矩阵。

| 原待办 | 已有证据及当前复用结论 |
| --- | --- |
| 112 | 14/14整文件和86批次中的修改/冻结/验证路径均绿；晚初始stat守卫由最终边界/18项/根38调用方及原15秒负载红绿补证。86运行中有最后守卫变化，不能称最终单快照86全绿，也不解释原script_cpu_limit及其余超时。无需再为历史现场重跑112。 |
| 118 | 10/10含原重复回答的事件数量断言通过；测试/核心runtime与事件链未变。之后native保护扫描改变不增加事件协议，个人报告/来源文案不等于Coding入口变化；63≠61历史原因未得，不抹除旧失败。 |
| 125/22/45/83 | 四个本轮逐文件均exit0、测试前后SHA不变，当前测试hash仍相同。原生共享delta另用最终安全/调用方叶证明；补现存日志和groups-summary即可，不重跑。 |
| SubAgent snapshot | 最初39首轮仍红已保留；同原Code场景15秒/原夹具双进程在基线红，最终approved-ops/native完整源码下两条均绿。最终单文件调用方同时保留双产品保护边界；不靠扩预算通过。 |
| workflow-role-integration | 最初逐文件计划因snapshot失败未到此文件，但后续86日志明确两个产品普通/工作流reviewer均通过。最后stat guard是独立保守保护检查，最终18/根38和边界负例已补；不得把停止的计划误记role已跑，也不需要再建lost现场诊断。 |
| 32-dev | 本轮75日志包含开发25项及其余个人原失败文件，均pass；38另有25/25。原宽批次逾13分钟后INT无业务断言，不推出新当前缺陷，也不把单文件绿解释成宽批次根因。32测试与开发入口未新增行为delta；共享Mock原类保持原文的独立用例已验证。 |
| personal-tools | 原个人文件组合75/75以及后续个人广组均无personal-tools失败；后续当前来源/分页/报告/媒体按现有窄叶补，而非重跑整个787。原60秒中断保留历史，不能冒称已唯一归因。 |
| personal-command-work | 787的仅两fail是offset/totalChars旧期望，修正后当前命令/夹具40/40；running/unknown/restored三条报告登记先红后绿与作者126/独立3条另证。原文件级INT不是新业务断言；不需要再跑787。 |
| 122/supervisor historical boundary | 122当前正常/停止已有整链与Linux窄叶，原36/17和38 native101身份/停止首次现场仍缺。当前绿色不是历史原因；若未来真实再现再取首故障，不能无限绿跑等待自发重现。 |

最小实际工作是根归档以下五份现存文件；无需重跑。四份逐文件result及精确源/日志hash均在JSON，可备选一起存，但groups-summary已含其内容。

- `/tmp/ruukoto39-coding-audit-groups-summary.json`，SHA256 `efc40fc08ba5c334a1aa7764a25798386bd1d87bb939fdc4ca749facdae63a29`。
- `/tmp/ruukoto39-coding-audit-125.log`，SHA256 `03d71a3041f4d8866a7a93fe9c0e96713ef4dc0526f0c17a2348b00a92c4911a`。
- `/tmp/ruukoto39-coding-audit-22.log`，SHA256 `1c6dfe812d736fbc32c9c18ff7578fa919215a27d4bacaee0061041f1b01cd02`。
- `/tmp/ruukoto39-coding-audit-45.log`，SHA256 `ca48b77f47973a6cdced3fe2f97b4e96be2c0287d010fb56906ac9c18ab41bb0`。
- `/tmp/ruukoto39-coding-audit-83.log`，SHA256 `a69492bc7d775c1b80307c14231760e9def89d64b122bb97628539848c12dbbb`。

当前必须新增测试命令：空。若之后源码再变，只补实际delta；不为无法恢复的旧现场反复跑宽批次或新建同类诊断。

112/118原叶均为macOS/Node24.15，14/14、10/10；其已记录11项源/worker中只有approved-ops与当前不同，native.ts并未列在该11项内。最终native优化SHA见JSON，与作者最后交付完全相同；86批次存在末端stat守卫变化，应连最终18项、根38调用方、8边界和15秒双进程证据一起引用，不能把86全部称作最终同快照。

118的事件数63≠61、112的script_cpu_limit与其他等待、原宽批次竞争/中断仍无唯一历史归因；32-dev的25/25和个人75/75只证明对应正常文件。snapshot确有本轮原预算红绿修复，但不能推广为全部历史故障同因。原17/36/native101停止归因也不由此关闭。

个人787原记录784过/2旧分页期望失败/1不适用跳过保留；当前命令/夹具40/40及报告登记3条独立红绿是修正范围，不能追改787为全绿。晚owner/report/scheduler变动已由v2/v3叶覆盖，不再加一次787。

最终验收应明确处置现有39的历史门槛和残余风险；这份只读核对不擅自取消门槛，也不以有限绿叶证明原失败已修。详细测试/实现/worker完整hash、四组result与日志计数见同名JSON。


采集更正：649源码清单不含生成worker；worker/worker.mjs、worker/workflow-script.mjs、worker/native-macos-supervisor已从实际路径取hash，并与macOS v3制品和原112/118环境三项全部匹配。JSON原三处null来自误查源码清单，现已更正；历史日志未改，复用范围未扩大。
