# Cua 正式入口验收

日期：2026-10-23。代码基点：`d048c7254b174c50a62bf882ebb2cf5e450658bc`，本轮在此基点上追加R6恢复应答存证修复，精确补丁哈希见下。范围沿[工单05](../issues/05-acceptance.md)与[规格R8](../spec.md#r8-验收与结束标准)，复用02–04已通过的离线证据。双端工程、正式视觉／恢复、本人管理体验及专用环境收尾均经独审，无未解决阻断；02–05已结案。原失败、未知与停止核实限制保留。

## 原始材料

本机保护目录：`/Users/eitrous/Developer/ruukoto-backups/cua-acceptance-20261023-d048c725`，目录0700，证据文件0600。正式Code使用独立数据、模型、控制与工作目录，浏览器使用独立profile；日常产品档案未改。拥有者选择`magpie/workbuddy-ai/step-5-preview`，仅所选凭据进入验收后台环境，模型配置保存环境变量引用。实际调用经已配置的Magpie提供方，未独立验证其网关上游。

| 相对保护目录的入口 | SHA-256 | 证明范围 |
| --- | --- | --- |
| `preflight.json` | `c222d54264c30b3a8cd1612f7bfd033894961a2195c40e361c3f535135a7e9e3` | 当前UID／console501、Driver0.38.0固定制品与只读权限预检；Linux最初缺前提 |
| `evidence/code-success/manifest.json` | `77e9ba330d3836e53743b2fbe11191308454f37387e693ffcc15ada0e35e732b` | 正式Code成功流程的38份原件、图片和历史索引 |
| `evidence/code-loss-held.json` | `334f58b3151a0ede5c23a744d578edbd31a34a32be6a210c2b9fc802aeffaeea` | 第一轮真实提交后、原应答赋值前的调试屏障 |
| `evidence/code-crash-injection.json` | `d8ab57bacd093835fdc25bd190524c124395f2a78f58e952a2655a27932d6dea` | 原宿主身份、SIGKILL及当时独立计数2 |
| `evidence/code-loss-stop-first-failure.json` | `9736c984f76ea0e99f2f1504874692cfe87bdb93124566398f11eea0d192a471` | 正式停止核实失败；CLI异常输出转存，非原wire帧 |
| `code-retry/evidence/code-recovery/manifest.json` | `3e7cb975fb8fdaa0b96be4117505af21d69b0d2c5815de65c29ce9ff08eb9448` | 修正外层会话后的真实丢答、冷冻结、停止及本人恢复事实 |
| `code-retry/evidence/code-new-work/manifest.json` | `c73de88d71bcd353346f8dd3b119d62f1d7de1c07b96bec848ac8b3c282df52b` | 本人接受后的一次新工作及新截图确认 |
| `evidence/code-cleanup/manifest.json` | `5b2111de7bd39a9adfa6fdce2e7fa4fde5a64d1be88de695e2152234c31250db` | 专用进程收尾、一次新停止核实失败及禁用／冻结状态；39份原件 |
| `code-retry/evidence/owner-management-acceptance.json` | `600a2129e69056049113129c49fb3b41d59ee2d9e4cbbeb673aa8808abe505c6` | Code本人正常管理入口、暂停／继续及提示确认 |
| `evidence/linux-preparation/index.json` | `bb71f861b429dee9270788a8d52c2d11b8b58ff63c361301b02f123af6a6a482` | Linux正式制品、既有沙箱、凭据换代与发现前提；本机JSON只读副本 |
| `evidence/linux-personal-8f622690/success5-final/manifest.json` | `8eb358aef73574e78aecf3b1b7cfd3a8ef875b5c677350ee125772abded558b5` | Personal正式成功及先前失败的57份原件，含实际请求、图片、历史及guest账本 |
| `evidence/linux-personal-8f622690/loss1/manifest-through-stop.json` | `6ae40dc7c23364badcccdbb2b933a861c0aa79aec85561a423012e06722f0762` | Personal真实丢答、冷冻结不重发、本人停止选择及原运行代停止的74份原件 |
| `evidence/linux-personal-8f622690/loss1/manifest-through-readonly-diagnosis.json` | `5c3c69234616ccfda52c8e8f17affd380f91bf468dc5dafdaa510d0b1f9a1286` | 加上本人begin、首次观察失败、原回执内存取证及新端点就绪的115份原件 |
| `evidence/r6-response-fix/manifest.json` | `cd354e8c67064dd389776598c872314eab6e4a384617d7047b2a133c152d1f5c` | R6修复补丁、作者红／绿回归记录和55项定向检查日志 |
| `evidence/r6-response-fix/root-validation.json` | `448485be1d80f1ae0a3db5f4e1b7a629ff04f07b605073be603de683fe8871a7` | 根集成check:static、Personal Cua20项及独审结论 |
| `evidence/linux-personal-8f622690/r6-observed/manifest.json` | `ebfa29f25a5897febee06480fadf351ebf6290fbdf938721442fe92e0bda356e` | 补丁接入、旧档案冷载、正式新观察及应答事件的45份原件 |
| `evidence/linux-personal-8f622690/post-recovery1/before-owner-menu/manifest.json` | `cf2a2d6fd3a365ac548d06fb813e5e7975baea5cc86354ecbd960bea019a952b` | 唯一新任务结束、本人菜单体验前的一致SQLite、747条历史和guest账本备份 |
| `evidence/linux-personal-8f622690/post-recovery1/manifest.json` | `ca57f2fcab0e0d06c8ccdb41abcb23a44a37f8f9738552d008698b4ec82e1c28` | 保留的初版新工作索引；后发现误含已消失的SQLite临时文件，稳定入口见下一行 |
| `evidence/linux-personal-8f622690/post-recovery1/manifest-stable.json` | `70e9ac57d56813b6f6fa36f07e58cb75ff030f6f9c2704fa1a4b33b0264520b9` | 正式接受867、唯一新任务2→3、真实请求／原图、原unknown不变及两项索引纠正，83份稳定原件 |
| `evidence/independent-review-engineering-20261023.json` | `977b0aa4afb3db3272847eb80ec9da3829765d0553652c40bdac3cb8669119df` | 双端工程结论、新恢复／新工作链条终审、具体限制与当时人工待办 |
| `evidence/linux-personal-8f622690/owner-experience-readback/manifest.json` | `697e5afab0aaaf23b33f990655f469b6cdf233e65ce4d60182d6a120957c7c1d` | 保留的初版索引，误含已消失的SQLite临时文件；由下一行纠正 |
| `evidence/linux-personal-8f622690/owner-experience-readback/manifest-stable.json` | `f9520d0ab192cc9225babca207f12f9b960b9aade1123b037f0c0a4cf7d089d1` | 28份稳定原件及索引纠正说明；暂停／正常退出、缺继续事件与保护不变量 |
| `evidence/independent-review-readback-20261023.json` | `b35ae9fbfe6e88906a6b90c3c9c4b0b14893bef14022da3d53f8978f621d4a03` | 管理增量、两处稳定索引纠正、正常退出与继续缺证的独审 |
| `evidence/linux-personal-8f622690/owner-resume-step/ready-manifest.json` | `3e794d7518c036c6a06d258f09d5da74a80fe516ff11d7a66d6b911fe0a17212` | 本人澄清、同档案暂停后台上线、旧unknown／计数不变及1057冷载事实，8件原件 |
| `evidence/linux-personal-8f622690/owner-resume-final-readback/manifest.json` | `58484eb2d5c30bb2c8847bcd55bbdf5cf47030216c01b19133f095c249533ff5` | 本人补继续1058、正常停止及档案释放、保护不变量的27份稳定原件 |
| `evidence/linux-personal-8f622690/scoped-cleanup-final/manifest.json` | `2058f79b6b5c7fbb5f86c34f3c39ea531ee3b54db6a08d8beac759ccda7f1b39` | 专用进程精确退出、无活跃后代／10条Z记录、保留不变量及最后关隧道的14份稳定原件 |
| `evidence/independent-review-closure-20261023.json` | `c5dc811a4c548ec731b08f62a55454aad64cae10e232c25047490906a021f3af` | 最后管理与收尾独审通过，支持04／05结案，原工程与readback报告不覆盖 |

## Code／Mac

正式`apps/ruukoto-code/bin/ruukoto-code.mjs server`启动，使用正常控制面打开工作区、保存Cua配置、检查权限并提交confirm任务；审批由验收代理经正式拥有者控制面执行，不记为本人操作体验。固定Driver哈希与归档一致，实际目标仅为专用Chrome测试窗口。

成功流程通过：模型先从画布截图读出新随机码，填写后以最新AX元素提交，独立fsync账本只新增一条且文字一致；模型再读新截图，正确报告提交次数1。完整导出6张PNG、14份模型规范快照和原JSONL，图片与原MCP应答、历史引用及哈希一致；第一份请求及首次带图请求没有随机码明文。Code快照采于提供方发送函数之前，不等同于适配器转换后的HTTP请求体。

原失败保留：最初浏览器随启动命令退出，首任务只读查询后中断、零写入；修正浏览器启动后，成功任务一次像素点击误落输入框，随后一次因缺新画面的调用在发送前拒绝，模型重新观察后才实际提交一次。正常停用、原生停止和重新启用已通过实际控制面执行。

第一轮丢答确实使应用计数1→2：调试器在stdio原应答赋值前暂停，SQLite已保存原request且无response，再终止原宿主；同档案正式冷启动保留原unknown与冻结，无重发。其停止核实返回`cua_stop_unverified`，原监督器无可信回执，所以该档案继续冻结，未开始或接受恢复。

已用不操作GUI的最窄对照定位到验收启动器：外层exec会话随宿主退出而结束时，同组监督器在留回执前消失；保留外层会话则可取得`reaped:true`、双EOF及`stop.exited=true`。具体清理信号未直接观测，首次保留会话对照的`identity_unavailable`也保留为失败。索引见保护目录`evidence/stdio-session-diagnosis-index.json`，原始对照位于`/tmp/ruukoto-cua-stop-fix.jRxGUK`。未修改产品停止判据；仅修正外部启动器，在新`code-retry/`档案重验受影响的丢答与恢复，原失败不改判。

新档案重验已完成：应用计数2→3时暂停原应答赋值，终止单独宿主并保留外层会话；监督器留下`reason=verified`、`reaped=true`、双EOF及`outputComplete=true`的可信回执。同档案正式冷启动保持冻结与unknown，正式停止入口核实成功、未重发。拥有者实际查看业务图后明确选择开始只读恢复，再查看正式Cua新截图并接受这次观察、授权一次新测试；两次本人选择绑定原操作和图哈希，原图经正式产物入口完整导出。新任务只用最新窗口观察与AXPress，计数3→4且新图一致；旧任务仍interrupted/effectUnknown、原response仍缺，恢复事实另存。新工作一次增量观察返回上游`internal typed output mismatch`，模型只重读完整画面，没有重发点击。恢复全桌面图仅供本人查看，其产物引用未进入新任务的5份模型规范快照。

正常管理体验后新建的闲置连接在收尾时停止核实失败：监督器虽已退出且有双EOF，回执仍为`reaped=false / identity_unavailable`，不能记为可信停止。正式状态查询及落盘均保持冻结，服务停用为v2，没有运行／排队任务，该运行代的写调用均有完整应答。独审判定这是R6规定的安全失败，不推翻前述已完成的可信恢复，但停止身份采样仍是可用性限制，不能声称所有停止均通过。仅结束本次专用宿主、外层会话、Chrome及夹具；原unknown、失败和已完成恢复记录逐字段／哈希保持不变，档案未删除。指定进程及四个工具会话均已结束。

## Personal／Linux

拥有者已授权在`oracle-4c24g`准备独立验收环境和ubuntu的Docker访问。副本位于`/home/ubuntu/ruukoto-cua-05-20261023-22cc20e4`，使用当前提交归档；归档SHA-256为`071ca1d229d862a0222b44b1f626c83eb2907e2ddda0292bb5257fbdaadd0dd6`。setup、worker/script构建、正式bin的PTY菜单退出，以及user systemd/cgroup前提通过。

固定CLI0.7.0已从正常发现位置链接，既有沙箱按实际Docker名称登记为`local:ruukoto-cua-01-owned-94hehxsy`。保存原1字节撤权文件后，以全新凭据原子换代，未恢复旧token或controller；认证GET为405、匿名401，正式发现及目标核实通过。准备阶段原完整容器ID为`6ddef499ea8ecae413cdf4c5f389af70bb9830e6b6bd86c0f49d401a04c9d399`，StartedAt为`2026-10-23T02:01:52.909749585Z`、PID2211601、restart=no，该阶段未停止或重启。保护目录的`evidence/linux-preparation/`只读副本持有制品、来源、认证和发现索引，不含凭据正文。

SSH多次在握手关闭，失败材料保留；连接恢复后一次完成准备。真实模型最初访问宿主bridge测试页被既有防火墙阻断，随后改为guest内localhost独立夹具，未改防火墙。页面已从真实截图读到随机码；一次模型输出预算耗尽、两轮像素定位失准均保留，各轮结束时计数0，未把正常返回的误点击改称unknown或重复提交。原截图、产物及实际provider图片字节一致，PNG均1200×675；官方工具仅以图片及描述约定坐标，未发现宿主丢弃尺寸字段。

经正式设置加入辅助功能查询／元素动作后成功：模型从画布图片读码，树中没有画布短码，只用元素定位控件。第一次元素动作取得明确的过期拒绝，随后新查询、聚焦、输入、提交均有完整应答，独立guest账本只追加一条且match=true、计数0→1；正式新截图及AX文字共同确认结果，模型正常结束并给出正确回答。成功包含482条历史、78份实际payload和9张核验图片，根已亲看原图；中文标签因guest缺字形，不能仅从图片声称读到“短码一致”。这份独审只覆盖正常成功，丢答与恢复由下述增量证明。

真实丢答已使独立账本1→2：AX press操作837在原应答赋值前暂停，仅终止已核身份的正式宿主2589191，保留监督器与外层会话。同档案正式冷启动后，原操作为effect_unknown／interrupted、remoteEnded=false且绑定冻结；间隔5秒的两次采样均为原请求一份、新请求零份、账本两条且哈希不变。原受管CLI scope及cgroup自然结束，不能据此声称guest停止；沙箱仍为原StartedAt运行代。独立framebuffer业务图SHA-256为`b81ee859f1af7892841039ba7dd92b203396049c824d12c1490d329fcc0122ea`，只供本人检查，不作为正式恢复观察或模型输入。拥有者已获知丢失内存和未保存应用状态、保留磁盘的后果，并明确选择“停止这个验收沙箱，继续核实”；这次选择只授权停止核实，开始恢复另由后续本人选择。

正式停止入口已保存原操作的停止核实事实entry856：原容器同ID与StartedAt，Running=false／Status=exited／PID0，FinishedAt为`2026-10-23T08:50:38.769734718Z`、ExitCode0；原CLI及原容器运行代分别核实结束。停止状态下通过docker cp只读账本仍两条且全match，SHA-256为`85c9dcd4255b9a9ae2bce0ebb8e0a7e2763f03c64e2d3fb76fefb333a7b7f3e2`，磁盘保留。原effect_unknown与remoteEnded=false未改判。本人检查后明确选择开始只读恢复，正式begin保存为entry857。

首次正式observe已重启同一沙箱，但返回`cua_observation_failed`、没有可交付图片，入口继续暂停。虽然官方登记仍为旧api_port，Docker端口32779／32780已变为32781／32782，只读内存取得的原callEvidence精确关联请求860，证实实际连接新端口32781、错误为`spacesd_not_available / connection reset`并提示可能仍在启动；原回执SHA-256为`7dd30b3751c5b16da2fc058d16433dabba8e449ab646442465ec552415fb5627`。这推翻旧登记导致拨号失败的早先推断，未改登记、端口或启动方式；临时断点已移除且宿主已继续。候选源码与已装CLI制品的对应尚未证实，不作为固定制品源码证据。另发现R6记录缺口：完整错误应答在保存恢复观察前被抛错丢弃，只有pending请求；下述补丁修复后续应答保存，不回填旧事件或改变原unknown。隔离夹具按授权从原盘恢复，当时账本字节与计数2保持，尚无新图接受或新提交。

09:07 UTC只读健康检查新端点，匿名GET为401、正常登记凭据认证GET为405；spacesd／Xvfb／xfce／专用Firefox均存活，隔离测试页与原账本就绪。没有发新GUI工具调用，没有变更登记、端口或凭据，未见持续端点或认证故障。

R6最窄修复已通过方案与实现独审并集成：恢复进度钩子先在同一事务保存observe-response原应答事件与EntryId引用，再判断工具报错、图片校验或保存；owner原详情可分页重读，模型includeHost=false仍不暴露。新旧事件双向关联核原请求／执行／JSON-RPC id与顺序，旧无responses档案兼容；失败观察不可接受，旧unknown／remoteEnded和接受条件不变。补丁SHA-256为`35abad11bdbc5de00c668b37fce86870d06335ac85c45d2ee06774bb493a3d03`，五个源／测试／文档文件；原始失败事件不回填成新实现已存证。作者5条新反例先红后绿、四个定向文件55/55通过，独审亲跑7/7，根集成check:static及Personal Cua20/20通过。修复理由见[决策](../../../.agents/notes/implemented/bug-fix/2026-10-23-personal-cua-recovery-response.md)。

远端五文件补丁后哈希与根工作区完全一致。旧闲置宿主及只读CLI正常结束，沙箱未停启；新正式宿主2842171同档案冷载无responses旧记录成功，原837仍unknown／interrupted／remoteEnded=false，账本2条且原哈希不变。随后唯一一次正式observe成功：request864→response865→observation866，原应答事件已落盘并进入原调用详情；PNG51949字节，SHA-256为`e6b80d67cb6a0625d6f2563f8b79bd284af7ee0c17112edccdc058352719b871`，与原回执图片逐字节相同。沙箱仍是08:54:53这代，没有再次重启。拥有者完整查看唯一新图后明确选择“接受此新图，并执行一次新测试”，绑定观察866与该图；正式接受保存为entry867，授权一次新测试2→3。

## 独立审查与剩余项

独立上下文`evidence_review`亲自核对38份成功原件哈希、6张图片、JSONL的6个媒体引用及14份快照中的40个图片引用，成功流程通过；同时直接核SQLite丢答前备份、冷启动冻结与停止失败，未把PID消失算作停止证明。新档案又核15份恢复原件、18份新工作原件及其哈希、11处快照图片引用与6处JSONL引用，亲读原native claim/supervisor/stopped关联与两次本人选择，Code R5／R6／R8工程流程通过。该轮未运行新的GUI／模型／SSH或旧矩阵，Linux后续增量另述。

拥有者已在Mac终端通过`/tmp/cua05-code`进入这份隔离档案的正式`ruukoto-code mcp cua`，实际操作后回复“已操作，配置和提示清楚”。Code正常配置、暂停／继续、批准节奏及恢复提示的产品确认通过，记录在`code-retry/evidence/owner-management-acceptance.json`；Personal的后续本人确认及管理记录另述。

Linux成功流程独审已核57份原件哈希、482条历史与库中原记录、9张原图及78份实际payload中的464次图片引用，均可精确重建。树中无画布短码；过期拒绝有完整应答且remoteEnded=true，新观察后的聚焦／输入／单次提交与截图确认对应同一条独立账本。该结论只覆盖正常成功，丢答恢复另按增量审查。

Linux至停止阶段独审已核74份原件、冻结／停止后的598／599条历史、11图及94份实际payload的636次图片引用，原记录只新增停止事实856；原837仍unknown／interrupted／remoteEnded=false且没有原response。原请求只有一份，冻结后无新发送，停止状态的磁盘账本与停前完全一致。该段只证明停止，首次observe失败仍保留，存证修复及后续恢复另作增量审查。

修复后新观察独审已核45份原件哈希，沿已审599条历史的不变前缀核609条库记录及10条增量；旧860仍request-only，新864／865／866的原JSONL逐条等库记录，新应答与原图逐字节一致。旧837、原请求单次、计数2及账本哈希均不变，94份实际模型请求也完全未变，本人恢复图未进入模型。该段只证明新观察，接受及新工作另审。

本人新图接受已正式保存为entry867，绑定观察866，实时连接核实通过；无需额外继续。旧837仍unknown／interrupted／remoteEnded=false且无原response。唯一新任务requestId为`8eddec01-c645-4ed3-9093-55d04ba5578f`，挑战轮换不改计数或旧账本。新聚焦964、全选983、输入1002及提交1021均有完整应答；提交后独立guest账本恰3条，末条count3、match=true，SHA-256为`5bea7201568d9869b2b486ca7ee96427e7a3421f71a2adc7084102df13076e4c`。其后交互写全部冻结，正式新截图1040已进入实际model-request1054，模型正常结束并给出非截断答复、stopReason=stop。根亲看原图，画布短码与输入均为736FE7A4、计数3；PNG哈希为`57015b7f5a95639231dbfbd58ee7b7aeb906fa34fb412f3f9dbcce4fa8244715`。最终83份原件包含747条历史、113份实际payload和15个核验图片产物，本段增量独审见下。

host只读镜像在原沙箱停止时随relay失败退出，停留计数2；恢复没有重建镜像，不能把它视为当前计数。原relay错误及诊断已保留，未改写guest账本。新提交前后的守卫及结果以guest权威文件直接采样，前三条中的前两条与原账本逐字节相同。

新工作终审已亲核83份原件哈希，旧609条历史前缀不变，138条新增记录逐条等于SQLite；旧94份实际payload不变，新19份实际payload的243处图片引用与原字节一致。867接受绑定866，唯一新输入只产生9个均完整返回的工具调用、一次提交1021，1040原图逐字节匹配；1055最终正文正确报告新短码及计数3，stop且无截断。新AX树不含画布短码，guest账本只追加第三条match，owner恢复图未进入provider。独审以只读delta.apply重建原837，确认unknown／interrupted／remoteEnded=false、无原response及停止856／begin857／接受867均保留，无重放。双端工程无未解决阻断，02／03据此结案。

拥有者按`/tmp/cua05-personal`正常菜单体验题操作后明确回复“已操作，配置和提示清楚”，主观反馈保留。随后只读核记录：1055最终答复后只有1056 `ruukoto.mcp-cua-pause {paused:true}`，总748条，没有paused:false；正式host2842171于10:16:31.605Z正常code0退出，CLI已结束、scope inactive、socket移除、档案无持锁者。只能证实暂停、正常停止及释放，不能记继续成功。04曾按反馈提前结案，核对后恢复ready-for-human并向本人澄清。该次核对时后台与沙箱均未重启、专用进程／隧道收尾暂缓，旧记录和计数不改。没有重跑旧探针矩阵或全量`npm run check`，没有提交或推送。

本人反馈后的28份原件已封存：旧747条历史及所有task／submission行不变，只新增cuaPause=true／entry1056的文档修订；无新用户输入、模型请求或MCP调用。MCP配置与固定9工具语义不变，guest账本仍为3条、哈希`5bea7201568d9869b2b486ca7ee96427e7a3421f71a2adc7084102df13076e4c`，当前沙箱StartedAt／PID2823043／birth450826143均不变。入口没有录制本人终端输出，后台日志只含inspector提示，不能据此构造继续成功或错误原因。

本人反馈后的初版索引误收入本地核库产生的32768字节SHM与零字节WAL，连接关闭后两者消失；独审发现后保留原索引，另以manifest-stable索引稳定原件并保存纠正说明，不重造临时文件。SQLite本体仍为远端backup API生成的独立一致快照，SHA-256为`e7569cc979cba2e199626be089d63fb183a0e148d8a279de1c09740b48802110`，immutable只读核748条且integrity_check=ok；没有丢失持久WAL或改写运行档案。窄核前一post-recovery1索引也误含同类两项，原索引与工程报告均保留，另加稳定索引；其SQLite本体哈希`1c0e034d2e4438c3cfca360e339d5ec0b22c5c9a17c637bd090598210a09e894`不变，immutable完整性通过，747条逐条等于原历史JSON且该历史哈希不变。此纠正只处理索引，复用已审真实请求／图片与恢复链条，不重跑模型或旧批。

管理增量独审已核稳定索引28项及一致SQLite，证实旧747条与全部task／submission不变，唯一新增暂停1056、唯一文档修订为cuaPause=true；没有继续事件。正常host退出、CLI／scope结束和档案释放可证，配置、guest计数及运行代未变。新工作稳定索引另窄核删除恰两项临时文件、新增恰原索引与纠正说明，其余81项元数据全等，SQLite与历史原件哈希不变；工程结论继续有效。该次审查结束时04／05待本人澄清，专用fixture、Firefox、监督器和反向隧道暂留，未执行收尾或重启。

本人随后澄清“只暂停后就停止了后台”，与缺继续事件一致；不将未执行的步骤归因为产品错误。保留配置查看、主观清楚反馈与暂停／正常停止结果，仅启动同一隔离后台并保留原暂停，供本人补继续及正常停止；沙箱未重启，没有追加模型／GUI任务。

补继续前正式后台2881130上线，控制面为online／available=true、paused=true、busy=false、operations=[]，原837仍effect_unknown／interrupted／remoteEnded=false，观察866与恢复accepted保留。冷载只追加1057 launch-stopped，对应原837的launch863；该事实与原结果未知分开记录，没有代做继续。ready索引8件已独审核size／SHA和控制面状态，随后本人通过`/tmp/cua05-personal`完成继续→正常停止后台→退出。

本人补步后明确回复“看到继续成功，并已停止后台退出”。最终readback封存27份稳定原件，无SQLite临时sidecar：ready的749条前缀精确不变，只新增1058 `ruukoto.mcp-cua-pause {paused:false}`；正式host2881130于10:43:45.266Z正常code0退出、档案锁释放。全部task／submission行及配置字节不变，无新输入、模型请求或MCP调用，旧837仍unknown／interrupted／remoteEnded=false且原response缺失、恢复accepted保留；guest账本仍3条同哈希，当前沙箱运行代未变。本段与随后收尾均已独审通过，没有待本人操作。

收尾以UID、出生标记、可执行程序及完整argv核身份，使用pidfd向guest Node457、专用Firefox500与host fixture2425147发送SIGTERM，三个主进程均已退出。5个保留监督器仅写各自release marker后正常退出；Firefox没有活跃后代，但10条已退出、ppid1、状态Z的记录仍待PID1回收，不能声称所有PID均消失。未为回收这些记录停止或重启沙箱。证据拷出并校哈希后，最后关闭本次SSH master51052与反向隧道，本地PID及专用socket已消失，原Magpie3425监听未改。

最后独审亲核ready8件、readback27件与cleanup14件哈希；750条库除1057／1058外旧记录原文完全不变，217任务、7提交及83份文档元数据原行相同，文档修订仅补CLI停止与暂停false。837物化只新增launch863.stopped=1057，原unknown／interrupted／remoteEnded=false、responses865／observation866／accepted867完整保留。清理前后全部durable表、配置、登记、固定CLI及guest账本不变，沙箱仍为08:54:53.746Z／PID2823043／birth450826143运行代，磁盘和历史保留，已授权的ubuntu Docker访问未撤销。最后远端状态取自关闭隧道前的只读采集，关闭后未再连接远端。

工程与适用的本人产品验收全部通过，首版验收结束。Code停止未核实的隔离档案保持冻结；Linux仅余已退出待回收的10条Z记录，无活跃专用执行进程。未重跑旧探针矩阵或全量`npm run check`；拥有者随后要求提交，本次收录修复与验收记录，未推送或生产部署。
