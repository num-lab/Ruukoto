# ruukoto-code Scheduled

Status: ready-for-human

## 目标与边界

用户于 2026-10-25 要求先制定方案：完成 ruukoto-code 的 Scheduled，设置 title、schedule（repeat、time）、Instructions、workspace、permission、model 和 effort。后续回答已确认：一次性、每天、每周指定日期；直接在选定工作区执行，复用目录占用保护；schema 升级后使用新档案。2026-10-26 拥有者确认按工单方案实施，走重流程，因为涉及新增行为、权限来源、持久化与跨模块接口；后续明确授权本地提交，不含推送、部署或发布。

当前实现：Scheduled 已替换占位，支持配置、编辑、暂停、恢复、取消与历史；Code 产品显式装配独立协调器，旧个人 scheduler 仍关闭。Code 使用固定工作区、模型、权限和档位，每轮建立独立开发会话；schema 为 53，控制协议为 41。

关键契约、理由和备选见[决策笔记](../../../.agents/notes/implemented/feature/2026-10-25-code-scheduled.md)。首版提供桌面创建、编辑、暂停、恢复、取消和历史；复用现有权限、模型及 Coding 执行能力。运行使用独立会话，时间计算复用现有 helper，Code 计划独立于个人调度。

拥有者已确认按本工单整体方案实施，包括每次独立会话、固定创建时区、停机最多补最近一次、暂停只影响未来与取消包含当前整项运行。档案策略已定：开发、验收与正式启用均使用独立新档案，不实现增量迁移或自动复制旧会话、设置和授权；现有档案不移动、不清空、不覆盖。

非目标：小时／每月／cron、系统唤醒、云端调度、自动 worktree、立即运行、IM 推送、模型创建计划工具、TUI 专用计划管理页与通用迁移框架。正常 Coding 工具能力不因定时来源被无意移除。

## 方案

### 1. 持久记录与可信来源

在 `packages/core/src/db.ts`、`types.ts`、`store.ts` 及专属 Code 调度存储模块定义计划、运行、写入回执与任务运行归属；按布局提高 schema，保持 Task 状态为执行权威。新档案沿当前初始化入口建立；旧版本和较新版本档案继续在写入前拒绝，不增加迁移或旧字段回填。新建／修改回执按稳定请求键与摘要去重；更新带预期版本，事件与状态同事务。运行固定配置快照，保存原定时间、合并区间和 session/task 反链。

集中、具名的 Code 调度来源核实入口证明计划授权、运行快照与任务归属。`owner-questions.ts`、`background-processes.ts` 的持久 source.kind 区分 coding-owner 与带计划、运行及版本的 coding-schedule；创建、解析和回答续接同步核实。原来源格式保留可读，不伪造 owner 输入。

### 2. 调度与普通 Coding 任务接线

在 `packages/runtime/src/` 增加 Code 调度协调器，并在 `runtime.ts` 的启动、事件推进与停止阶段接线；产品装配显式区分 Code 调度和旧个人 scheduler，`apps/ruukoto-code/src/product.ts` 不直接把旧 scheduler 改为 true。复用 `@ruukoto/channels/scheduler/time.ts`、工作区目录核实、模型解析门闩、任务队列、审批、占用与停止能力，不增加依赖。

到期事务同时登记运行、独立 dev 会话、排队任务与归属，并推进下次时间；提交后才 kick 队列。时间与去重以数据库为准，timer 只唤醒。暂停、恢复、编辑、取消与重启遵守提案中的规则。

逐个核对调用方：`runtime.workflowSource`、`runtime.browserAllowed`、`packages/agent/src/subagent-tools.ts`、`packages/core/src/owner-questions.ts`、`background-processes.ts`、`agent-wait.ts`、`workflow.ts`、`packages/runtime/src/parent-delivery.ts`、`subagents.ts` 及相关报告与工作流运行模块。提问回答、继续中断任务、工作流报告和后代任务创建都要带原运行归属；取消后迟到结果不得派生新任务。来源快照与 wire 投影同步新增来源；实例导入发现 Code 调度或其来源记录时明确拒绝，不丢弃归属或激活计划。目录冲突沿用 queued 与释放后 kickAll，页面投影等待原因，不新增 blocked 任务状态。

运行会话使用 dev 能力但在未关闭期间按宿主绑定守卫：`submit`、`setSessionModel`、`setSessionDefaultMode`、`switchTaskMode` 拒绝普通输入及配置修改，`answerOwnerQuestion`、`continueTask` 拒绝客户端模型／权限覆盖并按本轮快照续接。已关闭后的新手工对话不纳入旧运行。未知效果恢复先核实活动与占用已停止，再在 Scheduled 的恢复操作中由拥有者显式确认保留未知、只允许未来周期；确认绑定运行和版本并落回执，不重试旧操作。

整项收尾等待所有活动任务、问题、报告、后台进程及停止核实；闲置子 Agent 身份不阻塞。运行历史复用现有会话与任务详情，不建设新任务状态机或强制模型汇总流程。

### 3. 控制面与桌面桥

在 `packages/control/src/ops.ts`、`server.ts` 增加 Code 专属、有类型且经拥有者认证的计划读写与请求核实操作，并提高控制协议版本；旧 schedule_* 查询仍指向旧账本。查询分页有界，未知字段拒绝。内部运行与权限来源不能由客户端指定，错误以 code 传递。所有既有提交／修改入口也核实运行绑定，不能只在新 API 加守卫。

更新 `apps/desktop/src/main/ipc.ts` 的 DESKTOP_OPS，沿现有 Code request bridge 同时覆盖 Electron/MyGo；按需同步 shared bridge 与 view 的浏览器可用类型，不新增 preload 特权 API。客户端保留稳定请求键、草稿与实例绑定，丢答先查原回执，冲突要求重新核对当前配置。

### 4. Scheduled 页面

替换 `app.tsx` 占位为独立主画布页面，新增局部页面与状态文件；页面自身不计时触发任务。表单按 Title → Schedule → Instructions → Workspace → Permission → Model/Effort 排列，时间附本机保存时区，一次性显示日期、每周显示星期选择。

复用 `composer.tsx` 的 ModeSelector、ModelSelector、EffortSlider、selectionForModel；Permission 仅提供三个 AccessMode。复用 `new-chat.tsx` 的工作区菜单，必要时只抽出这块控件；Scheduled 只选择已登记工作区，新增工作区仍走现有入口，不因选目录产生多余会话。

列表和详情展示下次执行、最近运行和可处理等待状态；运行记录打开既有 Code 会话，复用历史、工具轨迹、审批与提问卡，未关闭期间禁普通输入与配置修改。取消必须表达包含当前整项运行；暂停只影响未来。确认会话列表、存档、搜索及恢复导航仍能找到历史。通知复用现有 main/notifications.ts，但定时完成／失败以整项事件为准，抑制首次 Task 的提前完成通知；桌面退出后不承诺实时推送。

### 5. 文档与收尾

实施时同步 `docs/modules/core.md`、`runtime.md`、`scheduler.md`、`control.md`、`desktop.md`、`products.md` 与 `docs/usage.md`；来源范围有变则同步 `agent-tools.md`、`workflows.md`，术语在 `CONTEXT.md` 区分 Code 运行来源与既有个人独立定时会话。架构模块不新增，更新现有模块职责与 Coding 调度流程即可。

没有新增产品运行命令或启动服务；desktop 显式声明根已有的 Temporal 0.5.1，不新增包。新增真实模型验收文件与环境门闩，README、开发说明和 pre-push-checks 已同步。决定已转 implemented，产品分工、提问和后台笔记的来源适用范围同步更新。

## 进展与交接

- 当前角色与阶段：实施、文档与独立实现审查已完成；离线、Linux、双壳构建及真实模型证据分别归档。并行实现使用独立工作副本，主工作区由汇总者独占写入。
- 下一角色与动作：拥有者／真实外壳验收者在新档案中验 Electron 和 WKWebView 的完整操作、系统通知、关闭窗口后后台继续及重连历史，并完成主观体验验收；通过后才转 resolved。
- 当前内容：分支 `develop`，接手基点 `493b91c4`，初始工作区干净；本轮已获本地提交授权，未推送、部署或发布。原方案调查基点为 `fe25207fad651f8b653efd9de3f2db27618726af`，后续配置在线更新、实例级 Web Search 与桌面设置整理未取代本方案；schema 从接手时 52 升到 53，协议从 40 升到 41。最终被审代码摘要见[审查证据](../evidence/implementation-review.md)。
- 阻塞与恢复条件：没有剩余实现或方案阻断；真实外壳及产品验收证据仍缺，不能以浏览器夹具替代。旧档案保持原样，启用新 schema 使用新档案。

## 验收与证据

### 方案验证

方案阶段的证据为方案者、两个只读调研者和独立方案审查者读取真实源码及既有决定；当时没有运行模型、桌面或行为测试。方案者在本机执行 `npm run check:static` 通过，覆盖 lint、全部 workspace/foundation 类型检查、笔记及文档门禁；最后补充的契约文本另复跑笔记与文档检查。实现阶段的行为证据见下节。

独立方案审查：2026-10-25，审查角色 `plan_review`。首审要求补齐活动运行会话的人工操作守卫与未知效果恢复入口，并建议整项通知不沿首次 Task 提前发送；修订后复审通过，无剩余实施契约阻断。审查者直接核对来源、提交、问答、继续、模式修改、目录占用、schema 和通知源码；只做方案审查，未执行行为测试。被审未提交提案 SHA-256 为 `660023e79695330c6f5b0d76c57567502030da34d10d049185bcd737efd041dc`，工单为 `f8f018589644ec61151f84c9260374896c1269211b899f6ba2e144c6eecf8ea2`；本条记录及交接状态随后更新，方案和验收内容未变。两篇 implemented 的提案链接一并纳入审查。

### 工程验收计划

| 要求 | 最窄证据 |
| --- | --- |
| 七项配置实际生效 | 新建后回读；由受控时钟触发真实 runtime，断言任务输入、真实 cwd、permission、provider/model/effort；默认设置变化后值仍固定 |
| 周期与时区 | 一次性／每日／指定星期的表单映射、未来日期校验、固定时区；复用已有 DST 回归，不复制时间算法 |
| 幂等与原子性 | 重复扫描、同键重发、异参冲突、编辑版本竞争、丢答核实、接纳落盘失败与取消竞争，失败时模型调用计数为零 |
| 恢复与不重叠 | 多周期停机只补最近一次；暂停期间不补；在途运行合并；重启保留原键且不自动重做中断；未知或停止未核实阻止新执行 |
| 人工恢复闭环 | 未核实占用禁止恢复；已停止且未知时显式确认仅开放未来周期，回执保留旧未知事实；取消或版本过期的迟到确认不能重启 |
| 真正的 Coding 来源 | SubAgent、workflow、ask_user、process_*、browser 各一条链；回答和报告保持归属，伪造来源与取消后迟到回答均拒绝 |
| 固定配置与人工输入 | 活动运行的普通 submit、模式／模型切换被控制面拒绝；回答和安全继续不得覆盖快照；关闭后的手工对话不改变旧结果 |
| 整项生命周期 | 根任务完成但子工作／问题／后台未结束时仍活动；停止核实后只关闭一次；取消保留成果、历史与未核实占用 |
| 失效配置 | 模型／档位不可用、目录消失或身份被替换时不调用错误模型、不写替代目录；显示原因并暂停 |
| 桌面完整链路 | 字段校验、effort 切换、重复点击、草稿保留、冲突、换实例不重放、状态刷新、运行历史及审批卡可到达；首次任务结束不提前通知整项成功 |
| 产品和数据边界 | Code 不启用个人调度；普通聊天和个人入口回归；全新档案建库成功，旧版本及较新版本档案在写入前拒绝，原数据库、JSONL 与历史不改写；无自动复制旧设置或授权 |

新增离线用例为 `test/code-scheduler-core.test.ts`、`test/code-scheduler.test.ts`、`test/code-scheduled-sources.test.ts`、`test/desktop-scheduled.test.ts`；真实模型入口为 `test/code-scheduler-model-acceptance.test.ts`，默认离线跳过。以下保留按改动面选择的验证要求，实际执行与通过范围以本轮验收记录为准。

实施完成跑 `npm run check:static` 及新增定向用例；按实际触及选择 `test/37-scheduler-outbox.test.ts`、`test/71-product-entry.test.ts`、`test/66-control-seam.test.ts`、`test/subagent-source-capabilities.test.ts`、`test/113-workflow-source-capabilities.test.ts`、owner-questions、background-processes 与 agent-wait 对应文件。桌面加 `test/desktop-composer.test.ts`、`test/40-desktop-creation.test.ts`、`test/desktop-session-settings.test.ts`、`test/38-desktop-main.test.ts` 和双壳构建；测试命令列实际文件，不用通配编号。不机械运行全量 `npm run check`。

真实 macOS 桌面以隔离档案验创建、到期、审批／回答、结果导航、关闭窗口后后台继续、重连历史，覆盖明暗、窄窗和键盘。Linux 调度及停止恢复在 `ssh tx` 用隔离目录验；真实模型使用 `RUN_MODEL_CHECK=1` 和明确测试工作区，所有写入限验收资料。缺模型或真实平台证据则保留待验，不以离线替身冒充。

### 实现与验收记录

| 内容 | 实际结果与证据 |
| --- | --- |
| 最终调度回归 | macOS 24.15.0 下 `npx tsx --test --test-concurrency=1 test/code-scheduler-core.test.ts test/code-scheduler.test.ts test/code-scheduled-sources.test.ts`，31 条通过、零跳过；覆盖实际工作区写入、Git 宿主任务、原子回滚、漏期、人工守卫、问答、重启、来源失效及未知恢复 |
| 跨链路回归批次 | 124 条通过：新增四文件及 `test/66-control-seam.test.ts`、`test/37-scheduler-outbox.test.ts`、`test/71-product-entry.test.ts`、`test/subagent-source-capabilities.test.ts`、`test/113-workflow-source-capabilities.test.ts`、`test/owner-questions.test.ts`、`test/background-processes.test.ts`、`test/background-processes-recovery.test.ts`；其中调度收尾部分随后由最终 31 条复核 |
| 桌面和宿主回归批次 | 152 条通过：调度四文件及 `test/desktop-composer.test.ts`、`test/desktop-session-settings.test.ts`、`test/38-desktop-main.test.ts`、`test/106-workflow-host.test.ts`；之后新增的来源失效、子工作取消和真实 Git 宿主归属由最终 31 条覆盖，不冒充这批原有用例 |
| 独立实现审查 | 新上下文 `implementation_review` 直接读取需求和实现，复现宿主反链、队列投影、目录失败类型、未知报告恢复及不可送达结果死等；返工后复审通过、无剩余阻断，亲跑新增四文件 38 条及冻结 runtime/source 16 条；[完整审查](../evidence/implementation-review.md) |
| Linux | `ssh tx` 的全新临时源码与档案，冻结调度三文件 31 条通过，平台／后台／产品六文件 63 条通过；真实 Scheduled HTTP 后台在根 Task 完成后仍活动，取消后 stopVerified、占用为零、服务不可达且成果保留；[环境、源码摘要和日志](../evidence/linux-2026-10-26/README.md)。Node 24.21.0 不替代 CI 的 24.15.0 矩阵 |
| 双壳与视觉 | 两种正式构建与各自严格签名校验通过；真实 Chromium 的正式 renderer 在离线 bridge 夹具下完成明暗、640px、键盘、字段、草稿及取消确认；[截图和断言](../evidence/desktop-2026-10-26/README.md)。不算真实 Electron/WKWebView 业务验收 |
| 真实模型 | 使用拥有者明确提供的 models.json，复制这一份到新临时 agentDir；DeepSeek Flash、off、confirm，两轮各 4 请求通过提问→回答→唯一精确文件审批→写入→整项 completed，原配置哈希不变且凭据副本清除；[脱敏证据](../evidence/model-2026-10-26/README.md)。默认离线模式的验收用例明确跳过，不记通过 |
| 构建与静态 | `npm run build` 和 `npm run check:static` 通过；没有运行全量 `npm run check`。文档、决定与新模型验收入口同步，最终记录另跑相关文档／行尾门禁 |

工程验收：上述实现、独立审查和适用定向检查通过；真实桌面外壳、系统通知及完整关闭重连链仍待验，保留 ready-for-human。产品验收：待拥有者验收字段和周期选择、运行等待状态的发现、取消含义及历史导航；截图与浏览器操作不能代替拥有者结论。没有部署、发布、迁移旧档案或自动复制旧设置／授权。

## Comments

2026-10-26：拥有者明确要求“提交”，授权提交本工单实现、文档和验收证据；状态仍为 ready-for-human，不据此声称真实外壳或主观产品验收通过。无关未跟踪文件不纳入提交。

2026-10-26：实施、独立审查及返工完成。拥有者明确提供 `/Users/eitrous/.ruukoto-code/agent/models.json` 用于真实模型验收；仅按这次授权复制此文件到临时新档案，两轮实际调用通过，源文件不变且临时凭据清除。真实外壳和主观体验保留待验，不标 resolved。

2026-10-26：拥有者接手确认时明确回复“按工单方案实施”；本轮开始实施，整体产品规则及原已确认字段、档案策略一并有效。接手只读复核未发现后续决定推翻方案，schema 和协议调查数值刷新到当前检出。

2026-10-25：拥有者在本次会话确认 repeat 为一次性、每天、每周指定日期，执行直接使用所选工作区。其余语义由本方案提出，未记为拥有者批准。

2026-10-25：拥有者明确回复“使用新档案”。正文与提案已固定该选项，删除增量迁移待决项；这次只更新方案，没有创建档案、迁移资料或实施功能。原独立审查的档案待决表述被本次确认取代，其余方案契约未变。
