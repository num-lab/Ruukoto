# 第一批测试精简实现独立审查

当前复核状态（主工作区增量）：R1/R2/R3均已关闭；当前已审代码与覆盖无未解决阻断。5个独立受控回归均使目标断言失败，恢复后均通过；另外保留1次未触发失败的探索性变异，未计为有效红灯。整单平台/性能/全量验收仍未完成。首批隔离副本的原记录及哈希保留为历史审查对象。

审查对象：/tmp/ruukoto-reduction-edit-28c033f7，相对28c033f7的第一批代码/测试diff。审查者：audit_remaining。按development-workflow与ponytail-review读取需求、实际diff、相关生产调用和保留用例。主工作区未修改；仅生成本报告。该副本编辑已停止，主工作区后续变化不在本结论内。

本批删除退役运行和重复覆盖，压缩Coding联合验收输入，合并integrate/foundation正例，复用关闭后的命令损坏基线，并以受控时钟验证SSH期限/退避。阶段三其他降层仍在评估，文档尚待收尾，不作为本次遗漏。

## 结论

先修复R1再进行对应SSH定向验证。其余重点变更静态审查未发现丢失工单要求的独有断言，但尚未执行实际用例，因此不判工程验收通过或性能达标。R1是源码可达事件顺序反例，不冒称已在实际SSH测试复现。

## R1：受控退避在计时器登记前推进，可能把正确实现测成超时

级别：P2，第一批应修；位置test/38-desktop-personal.test.ts:330–334及345–351。

变更以kill(pid,0)观察原进程消失，随后马上tick到500/1000/2000ms的退避边界。生产PersonalController.startForward（apps/desktop/src/main/personal-controller.ts:90附近）要等SshProcess.done的then才登记retry；SshProcess.done又要等ChildProcess的close事件，PID消失并不证明stderr关闭及close回调已处理。

具体反例：原PID已被回收，waitForIo返回；close及done.then尚未处理。测试tick(499)，随后ioDelay(10)让真实IO推进，这时done.then才在虚拟499ms登记500ms的retry。测试再tick(1)只到500ms，下一转发需到999ms才会启动；后面的waitForIo只等待真实时间、不会再推进虚拟时钟，因此5秒失败。首段i=1同理。负载下事件处理顺序发生此变化不代表生产退避有问题。

最小修复：推进退避前等待原forward的close已经被controller处理、retry已实际登记，再检查delay-1及最后1ms。可以读取测试中已有controller状态或用测试侧明确阶段通知，不新增生产配置。恢复段350的固定tick(1000)也应与当前控制连接重试阶段对齐，不能把新子进程写出PID日志当成重连计时器已经登记。修复后有界运行该用例，并在测试侧延迟close/重连登记的顺序下证明不会虚假超时。

不修复的影响：原本为缩短等待引入新的CI夹具竞态，违反本工单“不把重试通过当成消除竞态”的要求。

## 重点逐项核实

| 对象 | 静态结果 | 核实依据/仍需执行的证据 |
| --- | --- | --- |
| 122-workflow-code-acceptance | 覆盖保留 | 放行前同时要求held=3、change_1/2/3逐键running、change_4 queued，另核实3个running execution和1个queued step。失败改为3，实际成功1/2/4，各自写入/冻结/独立验证/汇入；7次尝试、失败依赖零尝试、验证目录不污染修改与来源、唯一最终回报/无普通wake、全部stopVerified/零占用都保留。check.mjs仍实际核对所有4份字节。需实际运行及原write_result_missing独立归因；规模缩小不是归因。 |
| 84-subagent-integrate | 合并完整 | already和事件数=1并入多副本成功路径；只读integrate拒绝加await；empty状态和无integrated事件保留；旧coding角色拒绝派发且零work/agent也迁入。冲突/目标复用/停止矩阵未删除。当前合并仍新增一个空副本，不以测试数下降声称所有准备已消失。 |
| personal-command-work十种损坏 | 未见串改档案身份或丢分支 | restricted六种admission/permission/claim/worker/mounts/stop-task；full_access三种env/mounts/node；unproved-stop一种。三个真实基线均close完成后再复制personal.sqlite，每个子例先恢复该副本到原路径、正常open，再独立变造、close、冷恢复拒绝。没有改workspace/执行身份或共享打开的可变SQLite。Pi的NodeSqliteAdapter.close实有wal_checkpoint(TRUNCATE)并close，正常关闭后复制主库可包含全部提交。每子例检查provider请求不增和launches保持1。尚需跑10子例及一个撤校验负例，证明拒绝确实来自目标校验。 |
| command模式删除 | 按计划 | 三模式正常启动/权限141保留；后续未知、暂停、报告流程各保留full_access一份；restricted与full_access损坏仍分别有有效基线。 |
| 38-desktop-personal分类 | 覆盖保留 | 全部网络文本和退出码仍直接tokenFailure；一条真实SshProcess核实退出255、stderr原字节、空stdout、LC_ALL=C。网络断线循环只删同分支两文案，zero与signal仍保留。 |
| SSH期限与停止 | 独有平台路径仍在，但退避须修R1 | 新期限例14999ms不停止、15000ms触发，真实PID退出。该例不再ignoreTerm；仍保留“读取中替换目标”独立真实ignoreTerm进程，controller.close沿SshProcess.stop的真实2秒SIGKILL升级回收。不能把受控timer结果当作OS停止证据；保留的真实例须实际跑。 |
| foundation03→05 | 断言完整迁移 | defineTool及Type.Object移到05；输入hello-host与真实call id只执行一次、assistant toolCall和toolResult关联、第二模型请求收到该结果均保留；原插件阻断/lifecycle/custom条目非模型上下文也保留。03仍实际运行builtin bash。 |
| foundation06删除 | 符合已定裁剪 | 仅未采用pi CLI RPC探索入口；正式SDK接入不依赖该路径。其余SDK契约保留。 |
| MCP路由合并 | 覆盖保留 | backend含全部CODE_MCP_OPS、personal拒绝code=op_not_allowed及零转发；通用凭据列表是原两处并集add/upsert/save/remove。 |
| MCP分页降层 | 未见独有映射丢失 | 新两页fixture核实offset按实际取得数推进、limit50、workspace绑定、顺序/名称/服务数。原无会话与映射选择由desktop-settings:51已有断言承接，真实workspace/组织映射/无会话来源由desktop-settings-mcp-backend:57承接。 |
| Pi版本合并 | 原独有版本断言保留 | personal-entry同时核实apps/ruukoto、packages/agent、apps/ruukoto-code的解析与模块隔离，加回根pi-durable/pi-coding-agent两包版本；实际入口导入图仍保留。 |
| 83及Demo无效/重复片段 | 删除成立 | 83仅去掉没有行为检验的assert.ok(true)尾段和写后即读无副本断言；真实LaunchSpec/停止矩阵都在。Git只删Demo算法自身两例，正式大规模与独立参考比较保留；URL仅去掉Demo副本。 |

命令基线复用降低真实命令执行准备数量，但每子例仍先正常打开干净档案再失败恢复；这不是把所有恢复成本删除。只有完整文件墙钟能证明净收益。

## 删除覆盖核对

- 112、118、125-agent-wait、subagent-role-driver/source-capabilities/workspace-snapshot、workflow-role-integration仅删旧产品循环分支，Coding相同真实执行断言保留。
- 114旧IM语法、115旧IM/调度分支、116/119/121旧个人工作流、51旧scheduler、work-copy-host-runtime及workspace-snapshot-runtime-boundaries旧调度场景都实际属于已退役运行入口；普通Coding、真实快照/权限/停止和当前Personal durable集合未删。
- 38-telegram-owner保留恢复与配置拒绝；40-qq-private保留配置代次、停用启动恢复、登记/发送恢复；77-im-approvals保留重启失效旧批准、遗留控制事件不派发和sending不重发；84-im-final-delivery保留非IM不外发与待发恢复。
- 37-scheduler-outbox保留时间/DST、outbox幂等/未知发送与真实崩溃恢复，删旧计划正常运行。71产品关断及数据归属仍在；85旧导入、退役群聊/coding的兼容文件未改。76旧API删除和71进程入口去重的承接由该批对应审查者补充核实，不能仅凭本重点审查替代完整跨范围证据。
- 118回执检查改为同步findWorkflowReceipt前后序号不变，再独立核实网络返回，避免把同期最终回报事件误算为查询副作用；返回契约与原回答状态仍断言。
- 40-desktop-creation拒绝夹具改用确定缺失目录，保留“明确拒绝不恢复unknown/不重放”的客户端分支，未改生产路径授权。
- packages/tui/src/tui/demo-session新增MCP示例事件属于demo夹具恢复；未改Runtime/权限/存储生产逻辑。其原失败红绿证据由实施者持有，本审查未复跑。

## 已执行的轻量检查与缺口

已执行git diff --check 28c033f7，通过。对37个仍存在的变更TS文件用TypeScript.createSourceFile解析，parseDiagnostics为空。单独30ms Node探针确认当前Node下先导入的node:timers/promises.setTimeout命名绑定不被mock.timers.enable({apis:[setTimeout]})替换，因此waitForIo确实可用真实IO等待；此探针不证明SSH整条通过，也不覆盖另一Node矩阵。

未执行应用测试、foundation完整套件、真实命令子例、负例突变、平台停止或基线。本次没有完成阶段三其他降层、文档/笔记同步、最终四格等要求的验收；这些是明确尚未提交的工作，不作为当前diff的缺陷列项。

## 代码快照

代码diff SHA-256：a8b255d357d148d106a77687fa60a76b18e8f30223bf937f424d12fdf75ab642

哈希命令范围：git diff 28c033f7 -- packages test verification/foundation/test。以下42个文件是本批代码快照范围，文档/工单后续变化另审。

- `packages/tui/src/tui/demo-session.ts`
- `test/112-workflow-real-steps.test.ts`
- `test/114-workflow-owner-input.test.ts`
- `test/115-workflow-final-delivery.test.ts`
- `test/116-workflow-notification-recovery.test.ts`
- `test/118-workflow-entries.test.ts`
- `test/119-workflow-im-controls.test.ts`
- `test/121-workflow-personal-acceptance.test.ts`
- `test/122-workflow-code-acceptance.test.ts`
- `test/123-workflow-model-acceptance.test.ts`
- `test/125-agent-wait-model.test.ts`
- `test/125-agent-wait.test.ts`
- `test/33-config-tui.test.ts`
- `test/37-scheduler-outbox.test.ts`
- `test/38-desktop-personal.test.ts`
- `test/38-telegram-owner.test.ts`
- `test/40-desktop-creation.test.ts`
- `test/40-qq-private.test.ts`
- `test/51-generic-scheduler.test.ts`
- `test/71-product-entry.test.ts`
- `test/74-workspace-sessions.test.ts`
- `test/76-legacy-workspace-data.test.ts`
- `test/77-im-approvals.test.ts`
- `test/83-subagent-worktrees.test.ts`
- `test/84-im-final-delivery.test.ts`
- `test/84-subagent-integrate.test.ts`
- `test/desktop-browser-documents.test.ts`
- `test/desktop-git-layout.test.ts`
- `test/desktop-settings-mcp-backend.test.ts`
- `test/desktop-settings-mcp.test.ts`
- `test/personal-command-work.test.ts`
- `test/personal-durable.test.ts`
- `test/personal-entry.test.ts`
- `test/subagent-role-driver.test.ts`
- `test/subagent-source-capabilities.test.ts`
- `test/subagent-workspace-snapshot.test.ts`
- `test/work-copy-host-runtime.test.ts`
- `test/workflow-role-integration.test.ts`
- `test/workspace-snapshot-runtime-boundaries.test.ts`
- `verification/foundation/test/03-tools.test.ts`
- `verification/foundation/test/05-plugin.test.ts`
- `verification/foundation/test/06-rpc.test.ts`

Verdict: fix R1 first。最终验收待定向运行、必要负例及后续完整证据。


## 主工作区增量复核：SSH、122与模型设置9条降层

本节对象为主工作区当时的三个变更文件，独立于上文已保留的隔离副本。父任务同时执行settings三文件和command损坏组，本审查未并发重测这些文件。

### R1已解决

主工作区38-desktop-personal受控退避的两处推进前均增加controller[retry]非null条件。retry只在原SshProcess.close→done.then处理后登记，消除了上文PID已消失但计时器未登记的具体反例。已读取实施者/tmp/ruukoto-reduction-ssh.log（5/5，包括真实ignoreTerm停止约2.2秒），并由审查者独立执行：npx tsx --test --test-name-pattern='转发连续失败按指数退避' test/38-desktop-personal.test.ts。结果1/1、零失败/跳过，总2445.7185ms，用例1129.941916ms。此结论仅覆盖当前本机；未重复全文件或其他Node/OS。

### 122诊断补充成立

失败信息改从listWorkflowExecutions取每个execution.taskId，并保存实际子Task与对应工具账本，解决旧日志仅看父session的问题。意外paused在waitFor谓词内直接assert.notEqual；helpers/testkit.waitFor不捕获谓词异常，因此会及时进入诊断catch并失败。原四输入的排队、失败、真实验证和集成断言未削减。未重跑122，也不将诊断改进视为历史write_result_missing已经归因。

### R2：仅替换Key不改目录的真实断言没有承接

级别P2，覆盖缺口；原desktop-settings-models:166，当前190附近。原用例保存前捕获h.read()，set_model_api_key之后deepEqual整个models.json；降层后仅检查前端发送set_model_api_key/get_model_config及api_key参数。

这只证明renderer没有发送save_model_catalog，无法发现后端set_model_api_key误改models.json中的高级字段或秘密。现存真实凭据移除用例315是在保存Key之后才捕获bytes，只保护remove操作；31-model-config:393验证auth.json/权限/重启，随后读取当前目录并主动移除内联Key，亦没有保存Key前后完整目录相等断言。具体回归是set_model_api_key同时丢掉modelOverrides或某个不影响默认请求的高级字段：新的窄测固定返回成功，保留真实用例也未比较此前字节。

最小修复：在已有315凭据集成夹具中，set key前捕获models.json字节，保存后立即比较；无需增加Runtime或新用例。前端190窄测继续保留请求顺序。

### R3：无name且无凭据的新提供方不再经过真实后端接纳

级别P2，覆盖缺口；原desktop-settings-models:175，当前199附近。原例同时省略模型name与存储/内联凭据，经真实目录保存成功并读取落盘ID；新例只捕获save_model_catalog参数并返回canned success。

现存137真实CRUD例明确写third-key和name，171目录+存储Key例最终也提供凭据。31-model-config有无name但带apiKey的正例；无apiKey的元数据/坏配置读取不等于save_model_catalog能接纳这组输入。因此后端未来误把apiKey或模型name改为保存必填时，新renderer用例仍会通过，原真实用例本会失败。

最小修复：复用137真实CRUD夹具，新建项采用addModel()后只editModel(id)，省略name和凭据，并继续核实真实保存与落盘；其他真实用例仍持有带凭据目录和名称编辑行为。也可在同一现有夹具补一个无name/无凭据目录保存，不增加Runtime准备。

### 9条降层对照

| 原位置 | 当前承接及结论 |
| --- | --- |
| 166仅替换存储Key | 前端顺序/参数保留；R2要求补真实models.json不变。 |
| 175无模型名称/凭据 | 前端构造与零set key保留；R3要求补后台接纳。 |
| 184目录丢答不提交Key | 保留unknown、秘密清空、关闭弹窗仍关联原pending、读回只读且零set key；真实目录保存/丢答由当前114和274集成承担。 |
| 201目录成功而Key丢答 | 保留部分成功提示、目录状态、秘密清空、Key只发一次、核实不重发；真实两步目录→读修订→Key由171集成承担。 |
| 214提交中关闭弹窗 | 保留真实未解决Promise阶段、关闭后的草稿/pending/零Key，以及提交目录参数；真实保存由114/171承担。 |
| 356离线/换实例/迟到读取 | 所有原前端拒绝与草稿保留断言还在，原例无独有磁盘断言。 |
| 389秘密输入/请求头草稿 | 保留空输入还原占位、导航保护、保存后清秘密、字段错误、__proto__/constructor等对象自有属性处理；真实秘密位置保存与清除由114/335承担。canned view只负责后端脱敏应答，不替代这些真实保存用例。 |
| 421默认/摘要读回 | 保留未提交unknown与已提交unknown两条不同恢复结论、dirty/selection；真实set_default_model/set_summary_model持久与后续会话效应由154承担，真实事件由400/492附近承担。 |
| 441冲突/保存后读回失败 | 保留冲突当前读取失败不能虚称读回、明确成功但读回失败仍pending、保存不重发、后续核实清理。真实跨客户端修订冲突由257、真实成功丢答由274、真实保存回滚由365承担。 |

rendererFixture使用已有DesktopBridge/handleRequest，记录请求深拷贝，before/after分别保留发起前与应答后的故障窗口；get_model_config返回预先设置的视图，不实现另一套后端。此方式能覆盖前端状态，但R2/R3的原磁盘契约必须另由真实用例接住。

轻量检查：主工作区git diff --check通过。未重跑正在由实施者运行的settings或command；负例窗口尚未开放，后续应至少撤去一个renderer阶段守门并确认窄用例失败，恢复后通过。当前结论：R1已关闭，先补R2/R3；未判整个工单验收通过。

增量文件SHA-256：

- `test/38-desktop-personal.test.ts`：`bb207a278ed6af731447400e4639382120f005307de8068c4616d1a3544698fe`
- `test/122-workflow-code-acceptance.test.ts`：`f2658dab2a208d48a7255fdd1a4e939bafd473d0e5bd20d4742992625b2c4dd8`
- `test/desktop-settings-models.test.ts`：`da765a8ac089cefa43bd52bb67c32dac6df82126c1b04718e2bcefa40474b072`


## 后续修复与personal-tools损坏基线复核

R2已补回：保留的真实“移除存储凭据”集成在set key之前保存originalCatalog，set key成功后立即逐字相等；随后原remove不改目录断言也保留。R3已补回：真实提供方CRUD首次third创建使用空addModel后只写id，不写name或apiKey；实际models.json分别核实id、name缺失、apiKey缺失，并核实真实get_model_config中credentials.third缺失。两处均复用现有Runtime，没有恢复被裁剪的重复启动。当前静态结论无未解决覆盖阻断；这些新增真实断言的运行由实施者后续检查记录持有。

personal-tools审查证据原missing/payload两条改为一个完整approve→工具执行→证据落盘基线。保存payloadEntry后先await p.close，再复制personal.sqlite；两个子例每次从原基线恢复到原路径。missing分支先正常打开、删原operation.review.payloadEntry、关闭；payload分支直接用真实SQLite json_remove删除同一个原payloadEntry的data.payload，并要求changes=1，防止负例无效。二者都要求open以tool_record_invalid拒绝且provider calls保持基线值。此处保留的是恢复验证契约；原payload用例虽在写入commit钩子中删字段，也未要求在线立刻拒绝，原本同样等待关闭后验证恢复失败。新实现没有丢失原来的断言。

基线保持原档案、workspace、产物与entry身份；没有把不同档案的身份拼接。关闭时Node SQLite已checkpoint/TRUNCATE再关闭，复用的是一致主库。失败恢复由openPersonalHarness既有catch关闭storage/instance并释放锁；下一子例不会共享打开的库。六种approve/reject/invalid/failure/length/error模型→独立无工具审查→结果/证据链路全部保留，未将它们用预制结果代替。

另有本机审批HTTP超时的夹具修复：调用移到独立Node进程，用execFile参数传入原目录/operation，固定工具调用字符串，无shell拼接或凭据输出；保留真实认证API。该诊断由另一审查者负责，本节仅静态确认新增客户端没有改产品协议或自动重试。

待独立负例窗口：renderer关闭弹窗后不得继续Key、MCP按实际页数推进、command完整访问准备的node固定、review实际payload存在等新夹具至少各取一个会使断言失败的受控回归。尚未运行这些负例，不用正常通过代替。

本轮增量文件SHA-256：

- `test/desktop-settings-models.test.ts`：`da765a8ac089cefa43bd52bb67c32dac6df82126c1b04718e2bcefa40474b072`
- `test/personal-tools.test.ts`：`27f85854c3fd1a339d29a9ce2eed7d2be40aad783af1c35f60c10c25f73e452e`


## MCP剩余降层与会话初始设置增量复核

MCP原200/240/262/285/306/325六条改用局部rendererFixture。真实backend在“编辑核实实际保留凭据”中补host/其他来源/用途/头/repo scope等拒绝，同时对同输入尝试新建invalid-new并核实服务总数仍为1；missing凭据的新建也拒绝，承接原“不能退回匿名、零新建”后端事实。前端拒绝例仍核实发送了所选credential，不把失败改成匿名；其他6条的原来源pending、读回失败、启停与凭据分别核实、迟到响应失效、清空秘密、发现checking重置均保留。真实配置持久化、版本冲突、凭据来源/秘密、事件原子性仍由保留用例证明。未发现新的覆盖缺口。

session-settings的16格只降低renderer层：每格检查恰好一次创建、对应op、cwd、mode、完整model_selection。两种真实控制op的原幂等用例各循环四模式，在真实不同目录创建、核实实际返回/落盘设置与零任务，然后修改该会话并用原键+失效模型重放，仍检查首次成果和零事件。openWorkspace新旧项目路径共用同一store.createSession(settings)段，原existing-workspace前端入口仍在16格中核对。归档改为同一真实夹具true→false，分别检查列表、archivedAt、其他会话和零任务，补强了此前false分支实际上没有先归档的问题。未发现新的覆盖缺口。

## 独立负例及恢复验证（Node v24.15.0）

所有变异只发生在/tmp/ruukoto-neg-y53r145s；主工作区未被修改。副本复制当时主源码，node_modules及构建worker只读复用既有安装；变异目标均是副本apps下的源文件。每次只改一个目标条件，执行一个test-name-pattern，恢复原字节后重跑相同pattern。日志保留具体断言，不以导入失败、复制错误或其他启动异常计为负例成功。

| 负例 | 唯一变异 | 变异结果与失效断言 | 恢复结果 |
| --- | --- | --- | --- |
| renderer-close | 去掉CodeModelsState.save的providerId !== provider关闭守门 | 退出1；“提交中点叉号…”在断言保存结果应false处得到true，test/desktop-settings-models:250 | 退出0，1/1 |
| mcp-pagination | sourceOffset首次取数改为固定50 | 退出1；第二页offset实际50、预期1，test/desktop-settings-mcp:111 | 退出0，1/1 |
| command-stop | 无observation分支删去op.stopped条件，保留returned条件 | 退出1；unproved-stop子例Missing expected rejection，test/personal-command-work:299 | 退出0，父/子2/2 |
| review-payload | 去掉payload.data.payload === undefined的恢复拒绝 | 退出1；payload子例Missing expected rejection，test/personal-tools:404；missing子例仍通过 | 退出0，父/子3/3 |
| session-mode（新增内存夹具额外负例） | CodeState.create来源mode错误固定confirm | 退出1；full_access/new-session发出confirm，test/desktop-session-settings:78 | 退出0，1/1 |

另尝试command-node：仅去掉full_access固定nodePath校验，变异与恢复都4/4退出0，未计有效红灯。临时诊断确认full-node仍被“原未知命令失去工作占用”拒绝，env/mounts仍由原准备校验拒绝；这不是导入/复制错误，但不能证明该单条node guard的回归检出。保留该尝试的原日志和诊断，随后选同一新基线夹具的unproved-stop取得上述有效失败。

每项执行命令、变异前后文本、源码/测试SHA-256、退出码、耗时及日志路径在同名JSON；执行器为/tmp/ruukoto-reduction-negative-runner.py，副本元数据在/tmp/ruukoto-reduction-negative-meta.json。下面是可查产物：

- `/tmp/ruukoto-reduction-negative-renderer-close.json`：mutated exit=1，1.446s，/tmp/ruukoto-reduction-negative-renderer-close-mutated.log, restored exit=0，0.899s，/tmp/ruukoto-reduction-negative-renderer-close-restored.log
- `/tmp/ruukoto-reduction-negative-mcp-pagination.json`：mutated exit=1，0.991s，/tmp/ruukoto-reduction-negative-mcp-pagination-mutated.log, restored exit=0，1.037s，/tmp/ruukoto-reduction-negative-mcp-pagination-restored.log
- `/tmp/ruukoto-reduction-negative-command-stop.json`：mutated exit=1，2.297s，/tmp/ruukoto-reduction-negative-command-stop-mutated.log, restored exit=0，1.752s，/tmp/ruukoto-reduction-negative-command-stop-restored.log
- `/tmp/ruukoto-reduction-negative-review-payload.json`：mutated exit=1，2.077s，/tmp/ruukoto-reduction-negative-review-payload-mutated.log, restored exit=0，3.557s，/tmp/ruukoto-reduction-negative-review-payload-restored.log
- `/tmp/ruukoto-reduction-negative-session-mode.json`：mutated exit=1，1.498s，/tmp/ruukoto-reduction-negative-session-mode-mutated.log, restored exit=0，0.917s，/tmp/ruukoto-reduction-negative-session-mode-restored.log
- `/tmp/ruukoto-reduction-negative-command-node.json`：mutated exit=0，2.782s，/tmp/ruukoto-reduction-negative-command-node-mutated.log, restored exit=0，1.967s，/tmp/ruukoto-reduction-negative-command-node-restored.log
- 未计成功的node变异实际拒绝点：`/tmp/ruukoto-reduction-negative-command-node-diagnosis.log`。

完成后五个变异源文件逐字恢复，并与主工作区原源文件核对相等。独立审查当前无未解决阻断；完整本机回归、Linux/四格CI、性能对比和尚未提交的其他批次不在该结论内。

## 收尾增量：迁移夹具、Desktop 场景文件、Cua 与文档

本节直接读取主工作区相对 28c033f7 的实际 diff、连接源码及两份独立诊断报告。被审代码范围为 `git diff 28c033f7 -- packages apps test verification/foundation/test`，SHA-256 为 `d89f9ba032f840865428371ad4b15a4ad6be1c043cd148e3d36e547b8b79b910`，与证据入口记载一致。实施者正在执行完整 check，本轮不运行测试，不重做已取得的五项变异；主工作区只读。

### 76 两条迁移降层与重复查询删除

新 migrationFixture 每例创建独立真实 Db/Store 和临时目录，以 realpath/stat 取得 cwd/dev/ino；创建原项目及三个目录中的原会话，instanceId 直接取该数据库。没有 mock SQLite、迁移算法、事务或目录身份，也不复用前一例可变库。Runtime.applyWorkspaceMigration 只检查 stopping 并将同样的 store/instanceId 转发到原函数，控制面的 plan/revision/键转换保留在现有真实集成中。

回滚仍在第二个 mapSessionToWorkspace 调用抛错，此时两个目标项目和第一条映射已经真实执行；随后仍核实项目数、第一条映射、零事件和零成功回执，恢复原方法后用同键及原修订成功。t.mock.method 代替 any 赋值，没有改变故障窗口。回退仍真实核实当前映射被改后拒绝、恢复后仅回退映射、保留新工作区、同键重放、claim_source 不可回退及原回执缺失。原先额外 open_workspace 只是准备另一个有根项目，新夹具直接创建同样的真实带根项目。

跨层覆盖仍存在于本文件的安全认领（422）、多目录 map/修订（520）、资料与执行权限（850）、配置来源（919）、JSONL/产物字节（997）、真实控制面 revert 保留新任务/配置/撤销（1065）以及回执跨进程（1138）。被删的“ruukoto 产品界面与旧 API 语义保留”只有原项目查询断言，759 的真实查询用例在映射后仍要求 project_id 返回原 s1/s2，workspace_id 返回映射会话及目标原会话，承接该行为且更完整。未发现独有行为丢失。

### Desktop Personal 夹具修复

已对照 `/tmp/ruukoto-linux-fixture-diagnosis-28c033f7/diagnosis.md` 和当前 harness 的全部 h.write/子 write(s) 调用。父/子用自身 PID 的同目录临时文件同步写后 rename，消除读到 O_TRUNC 半写 JSON 的窗口；inspect 不再无条件回写旧 s，消除 gate 已释放后被旧快照覆盖；首例 finally 中释放 gate 失败仍进入 h.close。原行为断言、管理互斥、迟到页失效、一次共享查询和全部 SSH 子进程已回收断言保留。

原子替换本身不提供多写者字段合并。本文件唯一在子操作尚未完成时由父写入的是 inspect-wait 释放，而 inspect 已变成只读；其余 h.write 均在前一 controller 操作完成/拒绝后执行，stop/start/save 仍通过 Controller 串行路径。因此当前无需为夹具另加锁。诊断中的原版失败、仅原子替换仍失败、完整修复通过与实际改动相符；本轮只核对其证据，没有冒称独立重跑。

### Cua 大帧预算

唯一变化是移除四张上限图片用例的 callTimeoutMs:10_000，实际 connectMcpStdio 仍从 MCP_LIMITS 取已有 60_000，产品 48MiB 上限未改。fixture 仍真实写四张各 8MiB 的图片，随后发 48MiB+1 超限；四图可解码、两次发送、超限请求事实保留及没有 response 的断言全部保留。此测试证明尺寸边界，原十秒是额外夹具假设，撤去它与工单不提高产品执行预算的约束一致。现有记录明确 macOS 定向结果不能替代 Linux；Linux 实际结果待最终证据。

### 退役 IM parser 与文档引用

额外核实 119 的完整删除包含原 parseImWorkflowCommand 纯解析用例。该解析器只被 ImWorkflows.handleCommand 消费，调用来自旧 Runtime 的 registerImInbound；Coding 产品声明 im:false，个人正式入口已由 durable 持有，不再采用该 Runtime IM 控制入口。因此此项按正式入口退役删除成立，不是将共享 parseWorkflowControl 的现行校验一并删除；后者仍用于 Coding 控制面及 CLI，相关测试保留。

新 implemented 笔记保留原提案的必要覆盖、真实边界、四输入/三名额、原并发/矩阵、备选与性能风险，并增加实际夹具取舍。旧 implemented 笔记只更新当前验收定位或补部分取代链接，旧工作流决定正文和历史结果未重写；没有修改 archived 目录。README、开发说明、pre-push 与 foundation 当前导航已同步；历史六输入与 RPC 用 git show 28c033f7 定位。旧工单与原始日志中的历史命令仍可保留，不当作当前执行入口。

只读脚本核实：原 294 个应用测试文件名全部出现在 legacy/remaining/personal-desktop 三份模块审查报告中，当前 290 个应用文件；变更 Markdown（含新 implemented 笔记）的本地相对链接无缺失。此检查只证明清单完整和链接存在，不代替逐断言审查。

当前证据入口没有把完整本机/远端结果提前写成通过，明确原 macOS 有 4 失败、Linux 诊断有回收，不能作为完整绿色基线或严格加速分母。仍待实施者同步最终 full-check 计数/退出码/墙钟及文件进程记录，更新 linux-diagnosis.md 的进行中状态，并把受控诊断中引用的关键脚本与红绿日志保存为可持久复核的交接材料，或明确可访问的来源路径。本节未审尚未生成的最终证据，不将实现无新阻断等同于工单验收完成。

本轮结论：代码和已同步常驻文档没有新的阻断发现；R1/R2/R3 的关闭结论保持。必要工程验收缺口仍为当前完整运行的最终结果，以及同一候选提交的原四格 GitHub CI。未运行任何新增测试、真实模型或 IM。

## 关联产品修复：TUI 退出后的迟到应答

随后 Linux 有界诊断确认32的产品竞态，实施者按原范围另立03局部修复。已独立审查 tickTiming 的 exiting guard、32原断言保留及新增两阶段回归，详见 `/tmp/ruukoto-tui-exit-review.md`。macOS Node24.15 的隔离负例只撤该guard，明确得到80ms引用计时器而失败退出1；恢复后1/1退出0且后台任务独立完成，墙钟6.928/6.215秒，无监护超时。代码无阻断；Linux记录中的7.38/9.2秒为单例完整进程，03已修正“完整文件”措辞并读回确认。此产品改动使此前代码diff哈希不再代表最终候选，后续完整证据须按新候选记录。

## SSH Node22 增量：真实监听与重连 timer 同步

38的新forward日志不代表listen已经发生；Node22补验暴露重连timer登记晚于mock tick的第二处夹具竞态。实现以真实listen回调发布READY=pid，并在计时推进前等待online或reconnectTimer登记。独立静态审查又指出首次连接和deadline恢复存在同样窗口，实施者已统一通过forwardOnline覆盖首次、超时恢复及三次重启，原499/1、999/1、1999/1及14999/1断言和真实IPC/TERM→KILL均保留。当前文件SHA-256为`5a7f861183767b8d295562bd2ebc35043a76422445a368e271774904c1169ddc`，静态无未解决阻断；详细范围见`/tmp/ruukoto-ssh-stage-review.md`。本轮未运行测试，Node22/24全部forward受控晚listen的红绿由Linux执行者补，不能用原仅扰动重启的绿灯覆盖首次窗口。

## macOS 原生夹具增量：就绪发布与早退清理

已独立审查native-macos-identity的唯一新增源码差异，文件SHA-256为`1c4ba2ce310c2d3b8827554f84aa04bab0eb55fd1ef07a9c88e5ffd944bea8f6`。PID临时文件写完关闭后rename发布；fork后3/4/5/8早退均保留失败码并释放本夹具等待者。正常停止和orphan存活证据仍先生成、再发布release，JS继续核对这两份清理前记录，全部五场景断言未改；cleanup只写私有release并waitpid本次正worker_pid，无新增宽范围信号。读取五正常场景6/6、17注入错误码/close及原子发布红绿材料，未运行任何native用例；静态无阻断。详细审查见`/tmp/ruukoto-macos-identity-fixture-review.md`，原挂住完整轮仍属于失败诊断，最终全套结果待独立记录。
