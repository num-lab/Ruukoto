Status: resolved

# 01 — 删除业务定时分支并实现独立通用任务

规格：[通用定时任务](../spec.md)。决策依据：[调度计划只触发独立的通用任务](../../../.agents/notes/implemented/feature/2026-10-12-generic-scheduled-tasks.md)。本单记录实施顺序、进度与证据，不重复决定的理由。

## 目标与协作分工

删除新闻与定时固定正文两条执行路径；每次到期创建独立的个人任务，具备已有业务工具及委派能力，完整处理审批、整项工作结束、最终回报、重叠、重启和取消。主聊天持续可用，搜索与通用发送能力保留。

关联：[完全访问工单 01](../../full-access/issues/01-full-access-current-account.md)。本单持有 Schedule 的模式与通知绑定字段、调度运行身份及生命周期、news／notify 删除；完全访问单持有共享 launcher、工具免审批、普通任务与委派模式传播。公共授权记录和免审批接线优先落地，本单的删除、存储及独立执行准备可先做；最终联合验证，不能互相等待对方整单 resolved，也不能实现两套模式保存或审批入口。

## 已核实的缺口

| 位置 | 现状与必须补齐的内容 |
| --- | --- |
| `apps/ruukoto/src/scheduler-tools.ts` | action 分为 wake_main／notify／news；通用任务接口需要替代业务参数、审批与展示分支 |
| `packages/channels/src/scheduler/news.ts`、`runtime.ts`、`store.ts` | 新闻有独立采集器、循环、快照和搜索注入；notify 直接登记固定正文；时间与 outbox 是共用能力 |
| `packages/runtime/src/orchestrator.ts` | scheduler 事件进入唯一 main 会话，需转入本次运行的独立执行上下文 |
| `packages/core/src/session-identity.ts`、`db.ts`、`packages/agent/src/driver.ts` | 现有 main 角色绑定唯一会话；业务工具还核实 main 绑定，普通 dev 或 SubAgent 没有等效能力 |
| `packages/channels/src/im-approvals.ts`、`im-entries.ts`、`packages/runtime/src/parent-delivery.ts` | 审批和最终回报只接受原 IM 委托来源；定时来源不能直接复用为一次伪造私聊 |
| `packages/channels/src/scheduler/runtime.ts` | runFinished 只等首次任务终态；cancelSchedule 不停止正在执行／等待审批的任务 |
| `packages/channels/src/personal-import.ts` | 导入调度记录时需同步新字段及支持范围，避免重新启用退役动作 |

## 实施计划

阶段按顺序接通；每阶段更新直接受影响的调用方、夹具和回归。完整行为与验收交付前保持 ready-for-agent，不提前勾选完成项。

### 1. 删除专用动作，确定通用存储与入口

- 在现有 Schedule／ScheduleRun 中保存时间规则、任务说明、创建模式、明确资料来源、固定拥有者目标或无目标、每次执行归属及最终汇报引用。字段和事件由 core／scheduler 现有存储持有，创建键、调度版本、原定时刻及事务内状态／事件继续统一仲裁。
- 删除 schedule_create 的 news、固定 content、action 业务分支，替换为通用任务信息；query 按运行查任务、结果和发送状态，cancel 继续是唯一取消计划入口。保留时间解析与创建幂等校验。
- 删除 `scheduler/news.ts`、采集循环及其启动／取消／恢复钩子、searchNews 注入、专用类型、news_result、schedule.news 和审批 mode=news。移除定时 notify 的直接 outbox 分支；普通 notification 工具和 outbox 不动其独立职责。
- 同步 schema、类型、exports、控制面／CLI／TUI 消费方与个人实例导入支持范围。版本单调递增，较新库仍拒绝启动；旧动作明确不支持，不做转换、回填或隐式降级。导入失败在修改目标状态前可见。

交付检查：新闻专用工具参数与定时固定通知被拒绝；普通搜索、一次外发、owner 回复与审批回执仍可用。计划创建失败不留下孤立运行、任务或发送操作。

### 2. 建立每次运行的独立执行身份

- 到期登记 run 后，由宿主为本次运行创建并持久绑定独立会话／执行身份及任务，重复派发只返回同一执行。绑定包括个人产品、资料项目、计划、运行与任务归属，不由模型参数或消息正文提供。
- 复用现有 Driver、任务队列、模型选择和工具装配，使计划执行具有个人助手已有能力及委派资格。同步 `SessionIdentity`、`executionProfile`、业务工具调用身份核实、资料访问与控制面查询；不能复制 main 角色行或绕过现有校验。
- 每轮上下文仅装配任务所需基础配置、计划说明和明确资料，不自动注入主聊天或前次运行历史。每次重新执行有新的上下文，已完成结果仍按现有历史／产物接口查询。
- 独立会话不进入主聊天 FIFO；使用现有资源与并发约束，不建立第二套后台调度执行器。通过宿主窄接口注入保持 workspace 依赖方向，core 不反向引用 runtime 或 channels。

交付检查：两次运行使用不同上下文，日常主聊天不受长任务和审批阻塞；计划任务能查询应用数据、调用已启用工具并委派，伪造身份或跨运行引用被拒绝。

### 3. 接通固定来源的审批和最终回报

- 创建时保存可信拥有者入口与配置代次或无目标；审批来源解析接受该宿主绑定，保留原平台、账号、拥有者和代次约束。无 IM 的计划仍能运行并从 TUI／控制面审批，不回退到最近一条私聊的收件人。
- 应用计划保存的模式：full-access 走完全访问单提供的共享免审批路径；confirm／auto-review 沿既有审查与批准消费。模型、计划正文和跨平台命令不能提升模式、扩大目标或创建长期授权。
- 向固定入口发送具体待审批，原拥有者可查询、批准或拒绝；目标失效、权限变化、取消与迟到决定均在执行前重核。审批通知失败或无人回应保持可查等待，不自动批准。
- 以 run 为单位登记唯一最终回报。结果或失败说明与终态可靠落盘后再发送，复用 outbox 的固定键、平台离线、限流和未知效果规则。删除或抑制本轮首次回答、各子任务和各汇总回合的重复自动外发。
- 没有目标时保存结果供查询；绑定变化时标明未送达，不改发。计划固有的固定目标最终回报与任务主动 notification 工具外发分别记录，后者仍按任务模式决定审批。

交付检查：定时来源审批可在正确 IM 入口完成，主聊天仍响应；另一入口及非拥有者不能批准。无 IM、目标失效、失败结果和发送应答丢失均有可查状态，不重复回报。

### 4. 让运行覆盖全部工作，并处理重叠和恢复

- 将首次执行、它创建的所有 WorkDelegation、派生任务、协作消息及结果汇总关联到同一 run。ParentDelivery 识别独立计划父级，在其执行上下文汇总，不把结果注入日常主聊天。
- 关闭运行前核实全部派生工作及待投递汇总，首次任务完成不够；登记子任务、消息、汇总与关闭竞争必须有同一存储仲裁，不能靠内存标志或同步调用顺序推断没有待办。
- 同计划已有未完成运行时只记录并合并漏过范围，等待审批也算未完成，不另建任务或补跑队列。离线且无在途运行时只补最近一次，时间／时区算法沿用现有实现。
- 重启恢复已登记未执行的工作时复用原键、模式、目标及上下文归属；已运行且结果不明的操作中断并保留未知效果，不自动重做。派发失败、最终汇报登记失败均保持可恢复事实，不能提前关闭后丢工作。

交付检查：子任务仍执行、消息迟到或最终汇总尚未结束时下一周期不会启动；关闭与委派竞争不漏记。重复扫描、重连及重启不会重复建任务或发送，漏过周期不形成积压爆发。

### 5. 取消覆盖本轮所有任务与汇总

- 取消计划的同步事务登记停止未来触发及本轮取消意图，阻止未派发事件和新的子任务／汇总入队；在事务外用现有取消接口停止排队、执行、等待审批的根任务和全部派生工作。
- 扩大到本轮汇总任务，不能只调用原 WorkDelegation 取消后漏掉已经运行的父级唤醒。取消过程中创建／返回的迟到执行必须读取同一取消状态，不重新激活计划或登记成功汇报。
- 统一保存停止结论与目录占用，保留成果和已知工具结果。请求已发但无法核实效果时标为未知，停止未核实不能报“全部已停”；在途发送沿 outbox 保存真实回执，不承诺撤回。

交付检查：取消与派发、审批消费、子任务完成、汇总、outbox 领取及后台重启交错时均不漏停或重放；记录、成果和占用可查询。

### 6. 清理界面与文档，完成联验

- 同步 scheduler 工具描述、系统提示、TUI／CLI 的计划与运行详情、取消反馈、审批和汇报说明；界面区分计划已取消、执行是否停止、最终消息是否送达，不只显示一个笼统状态。
- 实现后更新 `CONTEXT.md`、`docs/modules/scheduler.md`、`runtime.md`、`core.md`、`agent-tools.md`、`channels.md`、相关控制面与产品文档、`docs/usage.md`；`docs/visual/` 是冻结快照，不再维护，保持原样。新提案转为 implemented 时修引用和代码锚点，旧新闻决定按替代审计处理，不提前把计划写成现状。
- 删除新闻专用测试及无兼容目标下的迁移夹具；普通搜索 topic=news、共用 outbox 和通用来源校验的测试保留。补删除后接口拒绝与共享能力仍可用的回归，不只依赖字符串检索。
- 依下表执行定向检查并与完全访问单联验。证据和已知缺口写入本目录、链接到 Comments；所有验收闭合后才能标记 resolved。

## 验证计划

下列为立项时的验证计划；实际命令与结果见末尾交付记录及[验收报告](../validation.md)。以实际改动面选批次，已通过且代码未变化的检查不重跑；默认离线，不默认执行全量 npm run check。

| 改动面 | 现有落点及新增断言 |
| --- | --- |
| 存储、身份与恢复 | `test/01-concurrency.test.ts`、`03-lifecycle.test.ts`、`04-crash-recovery.test.ts`、`05-overflow-db.test.ts`：run／会话／任务绑定、事务回滚、较新库拒绝及恢复 |
| 调度与发送 | `test/37-scheduler-outbox.test.ts`：通用创建、独立运行、目标快照、单一汇报键、时间合并及取消；`test/51-news.test.ts`、`50-news-migration.test.ts` 的专用断言退役，共享断言移到对应通用用例 |
| 审批与权限 | `test/08-approvals.test.ts`、`10-access-modes.test.ts`、`22-auto-review.test.ts`、`63-approval-gate.test.ts`、`64-tool-op-ledger.test.ts`、`77-im-approvals.test.ts`、`93-im-approval-lifecycle.test.ts`：模式固定、定时来源、跨入口拒绝、取消／撤销竞争、未知效果 |
| 私聊与最终汇报 | `test/38-telegram-owner.test.ts`、`40-qq-private.test.ts`、`84-im-final-delivery.test.ts`、`89-im-entries.test.ts`：主聊天不中断、固定目标、无 IM、目标变更、失败与重复投递 |
| 委派、汇总与停止 | `test/80-subagent-delegation.test.ts`、`82-subagent-cancel-work.test.ts`、`86-subagent-messaging.test.ts`、`86-subagent-recovery.test.ts`、`88-parent-delivery.test.ts`、`92-subagent-lifecycle.test.ts`、`94-task-ending.test.ts`、`100-worker-stop.test.ts`：整项 run 完成、迟到、取消与未核实占用 |
| 业务能力与产品入口 | `test/28-main-data.test.ts`、`71-product-entry.test.ts`、`78-linux-service-management.test.ts`、`86-personal-instance-import.test.ts`、`91-release-acceptance.test.ts`：宿主身份、能力启停、个人产品范围及退役动作不能导入执行 |
| 控制面与界面 | `test/66-control-seam.test.ts`，实际修改后补跑 `13-tui-state.test.ts`、`14-tui-app.test.ts`、`33-config-tui.test.ts`，覆盖计划、运行、停止和送达的区别 |
| 静态与构建 | 实施过程中 `npm run check:static`；改动导出、worker 或产品装配后 `npm run build`；笔记转为 implemented 时核对锚点 |

命令形式为 `npx tsx --test <对应测试文件>`。用可控时间、模型与 IM 替身跑真实 Runtime／SQLite／JSONL／outbox 集成，观察事件和持久状态，不用固定睡眠推断完成；用实际进程覆盖启动取消和停止。只有触及 Linux 专属执行或服务能力时到 `ssh tx` 验证，真实平台推送未测须明确记录。

## 验收标准

- [x] news／定时 notify 专用实现、参数和当前说明退役；普通搜索与通用发送路径保留。
- [x] 每次运行独立上下文，具备个人业务工具及委派资格，不复制私人主历史且不阻塞主聊天。
- [x] 创建模式和目标跨重启保持；受限审批可由原拥有者入口处理，完全访问零操作审批。
- [x] 完成判定覆盖所有子任务、消息和最终汇总，每次只登记一次最终回报。
- [x] 无 IM、目标失效、失败、离线与发送结果未知可见，不改发、不重复发送。
- [x] 同计划不重叠，漏过合并、离线最多补最近一次，未知操作不重做。
- [x] 取消覆盖本轮排队、运行、等待审批、子任务及汇总；成果与未核实占用保留。
- [x] 仅个人产品开放，原时间及时区规则有效，无旧计划转换、参数兼容或回填。
- [x] 定向检查及完全访问联验有证据，文档与实际行为一致。

## Comments

### 2026-10-12：记录已确认方案与实施计划

拥有者已确认统一任务入口、每次独立上下文、仅个人产品、固定目标最终回报、受限任务等待审批、同计划不重叠与漏过合并、取消整项运行。沿用创建时模式及快速迭代期不做兼容过渡的决定。本次只落提案、规格和工单，并同步完全访问单的职责与失效条目；未开始代码实现或功能验收。


### 2026-10-12：通用任务与完全访问联验完成

news 与定时固定 notify 路径、专用参数、搜索注入、事件、审批分支及测试已退役，普通搜索和一次通知保留。计划保存资料项目、创建任务与权限版本、说明、明确资料、模式与固定可选目标；每次运行原子绑定新的 scheduled 会话和根任务，复用个人业务工具与委派能力，使用独立提示和历史，不阻塞主聊天或复制主聊天上下文。

受限审批回到计划保存的原入口，无 IM 时可经控制面处理；完全访问共享免审批授权。父任务链覆盖全部子任务、消息与汇总，关闭与唯一最终 outbox 回报同事务；等待审批和停止未核实均阻止重叠。漏过周期合并，未开始排队工作按原键恢复，已开始的不明操作不重做。取消覆盖根任务、派生任务与汇总；发起任务取消自身计划异步收尾，避免当前工具等待自身中止，未核实占用仍保留。界面和查询分述任务、结果、停止与发送事实。

`npx tsx --test test/51-generic-scheduler.test.ts` 生命周期 9/9；最终 `npm run test:app` 为 1154 通过、1 跳过、0 失败，`npm run test:foundation` 为 9 通过、1 跳过，`npm run check:static`、`npm run build` 与 `git diff --check` 通过。原始日志、固定目标／跨平台／主聊天并行／IM 审批／取消恢复证据见[本单验收](../validation.md)与[联验报告](../../full-access/validation.md)。决策已转 implemented，当前文档、术语和当前格式导入同步；`docs/visual/` 保留冻结快照；状态改为 resolved。

模型、IM 和服务使用离线替身，未验收真实消息平台推送或真实模型；真实 OS 执行由完全访问单的双平台证据持有。没有修改真实数据、账户或部署，不转换旧计划、旧 schema 或回填授权；未知外部效果不重放，主动脱离进程和外部服务不承诺回收。


### 2026-10-12：撤回冻结图解的误改

`README.md` 与 `docs/visual/index.html` 明确该目录是已停止维护的历史快照。本次误把它当作当前文档更新；用户指出后，已撤回全部 11 个 HTML 文件改动，恢复原图、正文及快照标注，目录与任务开始时的版本完全一致。实施计划与交付记录已修正，当前行为只维护模块文档、使用及部署说明，不以旧图解与新代码不一致为由改写冻结资料。该纠正不改变运行代码或原功能验收结论。

`git diff --exit-code -- docs/visual` 与 `git diff --check` 均退出 0；`npm run check:docs` 和 `npm run verify-notes` 均通过，见[纠正文档检查](../../full-access/frozen-visual-doc-checks.log)。仅文档还原与记录纠正，未重跑应用测试。
