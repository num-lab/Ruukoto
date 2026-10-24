# 测试精简只读审查：旧个人 44 条与编号 01–79

审查对象：工单 `.scratch/ci/issues/02-reduce-test-suite.md`，检出 HEAD `28c033f7`。角色：独立只读覆盖审查者。只读取仓库，不修改工作区，不运行应用测试、真实模型、平台测试或基线计时。本报告是阶段二与阶段四的覆盖审查输入，不能替代实现验收或性能证据。

已读取开发流程、issue-tracker、领域入口、CONTEXT、架构总览、测试精简提案及个人入口退役决定。完整发现使用 `rg --files test`，用路径数值前缀解析筛选 `0 <= number <= 79` 且以 `.test.ts` 结尾；共 89 文件，没有发现 00 或不补零的 1–9 额外文件。附录列出全部文件，按模块给出保留/删除/合并/降层结论，不复制全部断言。

## 总结

首批旧个人 44 条候选可以按计划处理：8 个产品循环仅去掉旧个人分支，11 个旧工作流/调度运行用例退役，25 个旧 IM 运行接线退役。删除依据分别是同体 Coding 断言完整保留，以及正式个人入口已不加载旧 Runtime。现行 durable 测试用于证明现行产品覆盖仍在，不能声称它们逐条验证旧存储、旧协议或旧恢复语义。

另确认 11 行额外可处理项：9 个普通完整用例、119 中 2 个平台展开分支及 1 个配置 UI 内部分支。它们在下表逐项列出；不以数字作为删除配额。38-desktop-personal 不能整删；GitHub 三组也不能因旧个人标签整删。未确认替代的安全、恢复、原生进程、传输与存储边界保留。

## 正式入口与共享库证据

- `.agents/notes/implemented/simplification/2026-10-18-personal-product-entry.md` 明确个人正式入口唯一 durable，旧共享 CLI/Runtime、调度/服务工具装配退出，旧资料原地归档。
- `apps/ruukoto/bin/ruukoto.mjs` 导入自身 `src/main.ts`；`apps/ruukoto/package.json` 不声明 `@ruukoto/runtime` 或 `@ruukoto/tui`；`docs/modules/products.md` 明确个人不提供旧工作流。
- `test/helpers/legacy-product.ts` 是薄旧资料夹具；不能用它证明现行个人入口仍有该运行行为。它还有旧资料与恢复调用，不能删除 helper。
- `apps/ruukoto-code/src/product.ts` 固定 `im: false`、`scheduler: false`；`packages/runtime/src/runtime.ts:870` 仅在 `product.scheduler` 开启时创建/恢复旧 Scheduler。
- 新个人实际共享库：`apps/ruukoto/src/personal-app-data.ts:8` 至 `:10` 导入 AppData contract/Store/Query；`personal-qq-api.ts:1` 与 `personal-qq-cli.ts:3` 导入 OneBotClient；`personal-scheduler.ts:6`、`personal-schedule-authority.ts:6`、scheduler CLI/controls 导入共享时间库。故 28-main-data、26-qq、37-scheduler-outbox 不能整删。

## 首批 44 条的逐项定位

表中位置均是 HEAD 28c033f7，实施按标题重新定位。保留位置指断言所在地，退役行指前述正式入口依据。

### 产品循环 8 条

| 候选位置 | 原测试标题/分支 | 结论与承接 |
| --- | --- | --- |
| `test/112-workflow-real-steps.test.ts:24` | 真实 ${product?.type ?? "ruukoto"} Driver：原任务结束后修改、冻结、独立验证及汇总，验证写入留在独立副本 | 只删 product=undefined；保留 Coding 同体 :41–56：2 次尝试、真实修改字节、冻结/验证 digest、独立验证副本不污染源、停止与占用释放。 |
| `test/125-agent-wait.test.ts:16` | agent_wait ${product?.type ?? "ruukoto"}：父轮让出真实 worker 与目录，修改、冻结、验证、汇总后继续检查且唯一报告 | 只删 product=undefined；保留 Coding 同体 :58–69：唯一报告、真实字节、验证 digest、所有执行 stopVerified、占用清零及无额外 final 任务。 |
| `test/workflow-role-integration.test.ts:58` | ${product.runtime.type} 的普通与工作流 reviewer 使用同来源、当前内容及固定角色，真实 bash 不能改来源 | 只删 personalProduct；保留 codeProduct 同体 :98–120：角色钉版、普通/工作流同源工具、confirm 来源保护、实际 bash 写副本、来源字节不变。 |
| `test/subagent-workspace-snapshot.test.ts:14` | ${product.runtime.type} 完全访问父级派发 reviewer 审当前内容，真实 native 拒绝源码、Git 与基线写旁路 | 只删 personalProduct；保留 codingProduct 同体 :63–80：真实 native 拒绝源/Git/基线写入，宿主任务归属、工具账本和停止事实。 |
| `test/subagent-role-driver.test.ts:12` | ${product.runtime.type} 的实际模型目录、角色正文、消息及冷恢复可重建 | 只删 personalProduct；保留 codeProduct 同体 :30–70：实际角色目录/正文/JSONL/prompt、旧角色复用与冷恢复、损坏阻断零新增请求。 |
| `test/subagent-source-capabilities.test.ts:43` | ${product.runtime.type} 普通与工作流默认角色具有同源工具并在独立目录实际执行 bash | 只删 personalProduct；保留 codingProduct 同体 :62–83：最小委派、工具集合一致、真实 bash、独立目录和源目录无副作用。 |
| `test/118-workflow-entries.test.ts:159` | (product?.type ?? "ruukoto") + " 空闲会话显式启动、带参复用与多个运行不占聊天，原键拒绝授权字段" | 只删 product=undefined；保留 codingProduct.runtime 同体 :168–215：显式宿主启动零模型、并行运行不占聊天、权限/预算拒绝、幂等回执与 Plan 拒绝。 |
| `test/118-workflow-entries.test.ts:263` | (product?.type ?? "ruukoto") + " 真实 Driver 自主发起工具与说明进入历史；步骤没有嵌套工具" | 只删 product=undefined；保留 codingProduct.runtime 同体 :267–289：步骤无嵌套工作流、说明工具进入历史、来源身份和调用次数。 |

### 旧个人工作流与调度 11 条

| 候选位置 | 原测试标题/分支 | 结论与承接 |
| --- | --- | --- |
| `test/121-workflow-personal-acceptance.test.ts:27` | "旧共享装配六输入命名工作流：实际搜索工具与应用数据、独立检查、单项 JSON 失败、等待聊天及唯一 IM 替身回报" | 整条退役：旧共享六输入工作流、应用数据与 IM 联合运行已无个人正式入口；Coding 联合验收另在 122 保留，现行个人调度/工具由 durable 套件承担。 |
| `test/119-workflow-im-controls.test.ts:95` | "IM 异步启动期间同外部键异参只允许首项提交；回执故障整笔回滚来源事件/任务/运行" | 退役旧 IM 工作流接线：同键异参、sourceEvent/txExtra 回滚是该退役入口契约；不可把此删除记录成通用 Store 事务已由 durable 等价替代。Coding 工作流控制幂等与回执仍在 118:159/220。 |
| `test/119-workflow-im-controls.test.ts:158` | "IM 模型失效与限额内深嵌套脚本有固定失败回执，推进偏移后仍处理聊天，不泄露凭据" | 退役旧 IM 工作流错误回执/偏移链路；当前个人不接纳旧 /workflow-run。Coding 编译/模型预检和请求拒绝继续由其工作流测试持有。 |
| `test/51-generic-scheduler.test.ts:37` | "子任务与协作消息完成后才关闭整项运行；一次最终汇报，模式与上下文独立" | 退役旧整项调度生命周期；现行对应概念见 personal-scheduler-integration:85/101，及 personal-scheduler:64。 |
| `test/51-generic-scheduler.test.ts:88` | "取消整项运行停止子任务与汇总，迟到新委派或消息被拒，成果记录保留" | 退役旧取消运行/子任务/汇总接线；现行 personal-scheduler:88 保留取消及迟到结果不得复活。 |
| `test/51-generic-scheduler.test.ts:120` | "受限运行独立等待审批，主聊天继续响应，计划保存模式跨默认变化与重启不重算" | 退役旧审批恢复运行；现行 personal-scheduler-integration:101 保留主聊天独立与创建模式，旧未消费审批恢复仍留 77:646。 |
| `test/51-generic-scheduler.test.ts:161` | "queued 首次执行与已登记汇总重启沿原任务键、模式、目标和独立上下文继续" | 退役旧 queued 首次任务/汇总继续运行；不把继续旧运行当作资料兼容。现行 personal-scheduler:41、integration:85/166 验证 durable 身份与不重放。 |
| `test/51-generic-scheduler.test.ts:203` | "独立执行绑定失败回滚会话、任务与来源关联，运行记录失败且只回报一次" | 退役旧 Runtime 绑定失败回滚/固定失败回报链路；现行 personal-scheduler:81/98、integration:135 保留失效零模型与失败事实。 |
| `test/51-generic-scheduler.test.ts:224` | "取消尚未执行的 root、子任务及待消息：结果均登记，运行关闭且不调用模型" | 退役旧 root/子任务/待消息取消；现行 durable 取消保留原记录，不需要模拟旧队列继续运行。 |
| `test/51-generic-scheduler.test.ts:250` | "退出未核实占用阻止整项关闭与下轮重叠，核实后保留原结果再收尾" | 退役旧停止未核实阻止下一轮；现行 personal-scheduler-integration:145–162 保留 HTTP 写未知、整项占用、重启不重发。 |
| `test/51-generic-scheduler.test.ts:274` | "宿主取消停止未核实：task中断及占用可见，运行继续开放等待核实" | 退役旧宿主取消停止未核实链路；现行 durable 的停止与未知效果仍留 scheduler/work/service 的原边界测试。 |

### 旧 IM 接线 25 条

| 候选位置 | 原测试标题/分支 | 结论与承接 |
| --- | --- | --- |
| `test/38-telegram-owner.test.ts:80` | "owner 私聊进入同一 main 会话并回复原消息；重复 update 与非 owner 消息不建任务；跟随主会话默认模式；token 不外泄" | 退役旧 Runtime 接纳接线。现行 personal-telegram:97 的 :102–112 保留非 owner 零调用、重复/异参、自己的回答/回复目标与秘密不入历史。 |
| `test/38-telegram-owner.test.ts:131` | "发送明确失败与结果未知不重发；429 退回 pending 按 retry_after 再发一次" | 退役旧发送运行接线。personal-telegram:135–147 保留未知不重发、同请求 429 延后、403 明确失败。 |
| `test/40-qq-private.test.ts:73` | "QQ owner 私聊复用 main、采用会话默认模式、先登记且去重；群与陌生人消息不串入；凭据不外泄" | 退役旧 QQ main 接线。personal-qq:108–133 保留双平台共同历史、乱序/重投、固定 owner 与非法事件零调用。 |
| `test/40-qq-private.test.ts:135` | "QQ owner 身份与控制面授权独立：伪造模型工具不能改权限或批准开发会话操作" | 退役旧 QQ 完整接线；认证/模型不能扩权仍由 10-access-modes:494/527、personal-cli:660（未认证拒绝在663）、personal-qq:136/152 保留。 |
| `test/40-qq-private.test.ts:200` | "QQ 与 Telegram 共享 main；通用计划独立执行并固定回报，其他外部事件不自动外发" | 退役旧共享 main+Scheduler 接线；personal-qq:108 与 personal-scheduler-integration:85/101 分别保留共同主会话、定时独立上下文/模式；非 IM 不外发另保留84:289。 |
| `test/40-qq-private.test.ts:308` | "token 错误和登录账号不符不接任务；连接掉线、账号离线与坏心跳停止接收并可恢复" | 退役旧 QQ 接收接线；personal-qq:124、196、312 的错账号/离线/重连与持久缺口留存，26-qq:28 的真实 OneBot 传输仍留。 |
| `test/40-qq-private.test.ts:361` | "发送明确失败、内部异常、超时、缺少消息 ID 与异步回执按事实收尾，重复入站不重发" | 退役旧发送分类接线；personal-qq:185–204 保留失败/未知/缺消息号/异步、原账号重连、不重发。 |
| `test/77-im-approvals.test.ts:162` | "Telegram：通知 → 列表 → 分页详情 → 批准 → 原操作恰好一次 → 原入口结果；重复决定拒绝" | 退役旧文本审批菜单与命令；personal-telegram-permissions:206–216 保留原菜单批准、重投/异参、单次执行与控制零模型。 |
| `test/77-im-approvals.test.ts:225` | "QQ：批准/拒绝经私聊完成；命令在任务等待审批时直处理不死锁，普通消息继续排队" | 退役旧 QQ 批准/拒绝直处理；personal-qq:152–171/353–369 保留原平台服务/应用数据批准，permissions:206 保留等待时主聊天继续。 |
| `test/77-im-approvals.test.ts:285` | "Telegram：非 owner/群/转发/格式/部分 ID/版本错误/跨平台/无来源一律不能执行，未核实不给详情" | 退役旧文本 ID/版本审批解析；personal-qq:124/136/152、personal-telegram-permissions:189/232/253 保留身份、原菜单、换代及未知菜单不得批准。 |
| `test/77-im-approvals.test.ts:354` | "QQ：temporary/subtype、错误 self_id/sender 与群消息不进入审批路径" | 退役旧 QQ 接纳门；personal-qq:124–133 保留 temporary/subtype、错误账号/owner/群等零模型与零回复。 |
| `test/77-im-approvals.test.ts:388` | "TUI 抢先与平台重投：决定及操作只生效一次；同键异命令拒绝；重投读原回执" | 退役旧 TUI/IM 抢先与命令重投组合；personal-telegram-permissions:206/260 保留原消息与唯一消费，旧 Store 的批准消费仍在08:610、63:126。 |
| `test/77-im-approvals.test.ts:433` | "QQ：owner 变化、停用再启用、凭据 A→B→A、凭据删除——旧批准失效零执行，等待解除，不波及 Telegram" | 退役旧 QQ 代次/凭据接线；personal-qq:207/325 保留换代取消、跨平台不串与新默认；10/63 继续保护权限版本。 |
| `test/77-im-approvals.test.ts:531` | "Telegram：凭据轮换使旧批准失效且旧偏移重置；旧轮询结果与重投不污染新代次；旧 null 目标明确失效" | 退役旧 Telegram offset/null-target 运行接线；personal-telegram:115/158、permissions:232 保留现行 offset/换代。旧资料恢复用77:646，不把新旧水位策略强行等同。 |
| `test/77-im-approvals.test.ts:583` | "通知登记中途故障：审批创建整笔回滚（无审批、无通知、零执行），恢复后可重新申请" | 退役旧审批通知登记失败接线；共享闸门事务钩子仍在63:349，现行原接纳失败零外调见permissions:154–170。 |
| `test/77-im-approvals.test.ts:614` | "决定/控制/回执中途故障全部回滚：审批保持待决，平台重投后成功一次" | 退役旧决定/回执事务接线；63:402 保留通用 txExtra 与决定原子提交，permissions:260–270 保留现行提交后丢答唯一授权/执行。 |
| `test/77-im-approvals.test.ts:734` | "429 只按原通知操作延后重试，不换键；领取与 fetch 之间的配置变化按 target_changed 终止" | 退役旧通知 outbox 重试与领取后换代接线；personal-telegram:143、personal-qq:207、permissions:173 保留现行原意图延后/目标失效；旧发送恢复仍留77:646。 |
| `test/77-im-approvals.test.ts:785` | "旧 token 的迟到错误在账本与事件里均脱敏（凭据轮换期间完成的发送）" | 退役旧 token 迟到错误写旧账本路径；现行 personal-telegram:112/226 与配置凭据负例继续保留，旧 adapter 的配置/脱敏维护不作为整个新产品测试的替代。 |
| `test/77-im-approvals.test.ts:824` | "列表翻页与详情参数分段：/approvals 游标与 /approval 偏移逐段到达全部数据" | 退役旧 /approvals 游标与 /approval 偏移交互；现行菜单分页由 personal-telegram-permissions:86、personal-tools-controls 等持有；无需保留已退役的文本命令格式。 |
| `test/84-im-final-delivery.test.ts:134` | "QQ：先受理、可续聊、收尾后唯一最终汇报引用原消息；重复终态与工具清单回归" | 退役旧 QQ 受理/最终汇报接线；personal-qq:245–265 保留后台报告固定原消息和唯一发送，personal-reports:248/438 保留封组/追加。 |
| `test/84-im-final-delivery.test.ts:191` | "Telegram：受理在前汇报在后，汇报引用原入站消息" | 退役旧 Telegram 最终汇报接线；personal-reports:374/394 保留原回答/原消息、强杀恢复及单次外发。 |
| `test/84-im-final-delivery.test.ts:226` | "目标固定发起入口：QQ 工作在 Telegram 轮次续派，两份汇报都发回 QQ，Telegram 零汇报" | 退役旧跨轮次发起链路；personal-qq:245–265 明确后续 Telegram 聊天不改变原 QQ 平台，Telegram 零最终报告。 |
| `test/84-im-final-delivery.test.ts:342` | "并发与补充收尾：唤醒 1 时仍有未收尾唤醒则不汇报，后终态唤醒只汇报一份；补充再收尾键不同" | 退役旧唤醒1/2收尾规则；personal-reports:248/438 保留现行多成员封组、重复登记和事务先后，不要求新实现复刻旧唤醒任务。 |
| `test/84-im-final-delivery.test.ts:464` | "目标变化不改发：唤醒前来源失效则取消；发送前重新配置则取消且新目标零发送" | 退役旧唤醒/发送前换代接线；personal-qq:207、personal-reports:409 保留原入口换代取消与不得改发。 |
| `test/84-im-final-delivery.test.ts:535` | "发送结果不明记 effect_unknown 不自动重发（含重启）；Telegram 429 同一记录按 not_before 再发" | 退役旧发送未知/429运行组合；personal-reports:394 保留真实强杀后未知不重发，personal-telegram:143 保留429原请求延后。 |

### 不能随 44 条删除的独有边界

- `38-telegram-owner:170`、`40-qq-private:471`、`77-im-approvals:646`、`84-im-final-delivery:413` 保留旧事实恢复；`84:289` 保留非 IM 来源零外发。77:678–689 明确旧 pending/approved-unconsumed 变 stale，consumed 仍 approved 且事实留存、旧控制事件不创建模型任务；现行 permissions:253 则允许重启后的待审批按新菜单决定，语义不同，绝非替代。
- `71-product-entry:219` 保留 Coding IM/调度关断及旧计划读取；`:275` 保留跨产品目录拒绝。85/87 的归档与导入不在本次删除范围。
- `64-tool-op-ledger:256` 双产品循环核对的是旧持久账本族恢复，而非相同现行运行；全留。`125-agent-wait-resource` 的 main/dev 差异也不是本轮重复项。
- `28-main-data` 的真实 SQLite schema、事务、幂等、版本、查询进程、稀疏分页、限额与审计仍被个人 durable 复用，不能按 main 标签整删。`26-qq:28` 真实 OneBot 连接/账号/异步回执仍被复用。

## 阶段四额外候选

| 位置与原标题 | 操作 | 保留/退役依据与限制 |
| --- | --- | --- |
| `71-product-entry:266`「旧格式测试装配：调度器照常启动」 | 删除完整用例 | 唯一断言旧 scheduler 非 null；旧个人正式运行入口退役。71:219 的 Coding 关断和旧计划可读完整保留。 |
| `71-product-entry:320`「进程：apps/ruukoto-code/bin/ruukoto-code.mjs 入口引导 TS，未知名字按工作区处理（非 TTY 退出 1）」 | 删除完整用例 | `29-cli-entry:139` 同样启动这个 bin、参数 bogus，断言退出1与TTY。保留71:326非法环境变量测试，不能连同 runNode helper 删除。 |
| `74-workspace-sessions:563`「ruukoto：选择面板行为不变，角色项目仍列出」 | 删除完整用例 | 仅验证退出的个人旧 TUI。Coding 面板、旧会话映射和归档仍由同文件533/584/634/665持有。 |
| `76-legacy-workspace-data:867`「ruukoto 产品界面与旧 API 语义保留：归属字段不影响原项目查询」 | 删除完整用例 | 同文件809用例的856–861已断言映射后 project_id 仍按原项目返回s1/s2；867仅再次查询其中一个会话，不新增边界。 |
| `33-config-tui:777`「ruukoto-code：项目分区先列工作区（显示根目录）再列旧项目；ruukoto 不标注」内 hStd 分支 | 仅删除旧个人 hStd 启动/断言/清理（805–815） | 保留 hDev Coding 分区、根目录、排序、菜单身份断言及总体Runtime清理。个人配置菜单已是 app 内 durable CLI。 |
| `37-scheduler-outbox:178`「通用计划：独立会话使用创建模式，重复扫描只运行一次并固定最终回报」 | 删除完整用例 | 旧 Runtime Scheduler 运行入口；现行 scheduler:41/64 与 integration:85/101承担实际个人定时身份/隔离，保留同文件时间规则。 |
| `37-scheduler-outbox:387`「通用计划：无IM目标仍独立运行并保留结果，终态与回报失败同事务回滚」 | 删除完整用例 | 旧 Scheduler→Runtime 定时执行/关闭契约退役；durable 独立的事务/结果事实由现行调度套件持有。 |
| `37-scheduler-outbox:427`「独立定时执行：应用数据免审批并审计真实scheduled身份」 | 删除完整用例 | 旧 scheduled 身份及旧 AppData tool 装配退役；共享 AppData Store/Query 测试不删。 |
| `37-scheduler-outbox:463`「发送函数挂起时控制面与普通任务继续推进；stop 中止在途发送并在关库前收尾」 | 删除完整用例 | 旧 Scheduler sender 运行接线，两个正式产品均不以它发送；真实 OS/恢复不重放的独立证据保留在37:512及现行 personal-telegram:186。 |
| `37-scheduler-outbox:496`「旧调度 schema 拒绝启动，不转换或回填执行授权」 | 删除完整用例 | 仅把 schema_version 设12再断言通用 schema_version_unsupported；08-approvals:110覆盖旧/未来版本拒绝且结构/版本不改写。79:221的独立旧库真实批准/发送事实不变仍保留。 |
| `119-workflow-im-controls:26` 的 telegram 与 qq_private 两个展开分支「完整显式启动/查看/暂停/恢复/回答，跨入口及引用不控制，最终只回报一次」 | 删除两个旧平台展开用例 | 与该文件95/158同为旧个人 IM 工作流运行验收；不在原44中，但旧正式入口退役依据相同。16的纯解析安全负例先保留；不顺手整删生产解析器。 |

上表按执行用例计为 11 个完整展开用例加 1 个测试内部 UI 分支，其中119的两个展开分支同属一行；文件的辅助函数/导入仅在最后一个调用消失后清理。表首总结只作导航，实施统计应采用实际运行展开数。

## 38-desktop-personal：整文件删除没有成立的入口证据

结论：保留文件；依原方案仅去掉同分支网络错误副本，分类降到 tokenFailure，时钟部分可用受控时钟。不能因新 PA 设置用了 SSH 机器 CLI 而整删旧 PersonalController 测试。

正式调用链还在：`apps/desktop/src/main/index.ts:28` 创建 DesktopHost，`:138` 在 app.whenReady 后仍调用 `host.reconnectPersonal()`；`host.ts:104–123` 读取旧 personal.json 并创建 PersonalController；`:145` personal 订阅可重连；`:217–232` 仍分发旧 Personal IPC 和保存配置重连。`renderer/personal-connection-state.ts:40/:65` 仍使用旧 config_read/config_save。新设置另走 `PersonalSettingsController`（host:151起、237–247），是并行接入，没有切掉旧链。

必须保留的独有边界：`:29` SSH主机/路径及落盘秘密，`:43` 真实 shell 区分目录/socket/FIFO且注入不执行，`:67` 覆盖用户SSH复用/后台/RemoteCommand配置，`:183` 令牌轮换，`:228` 真实TERM→KILL与取消/迟到无效，`:248` 换目标先等旧进程退出，`:277` 真实控制面拒绝错产品，`:294` 两目标故障隔离，`:337/:353/:375` 快照同步窗口、Personal权限与原请求跨重建核实。重复网络文本在`:138`分类表仍全保留，`:161`只需一个网络文案完整重连、另留正常退出和信号退出。

## GitHub：先保留，发现文档与调用链不一致

`docs/modules/channels.md:80` 称 Coding 不能启用 GitHub 自动评审，但当前 `packages/tui/src/cli.ts:290–292` 仍将 --github-webhook-config 传入 Runtime；`packages/runtime/src/runtime.ts:1015–1023` 仅判断配置是否存在，未按 product.im 关断；`packages/channels/src/github/events.ts:118` 的 gate 只核对配置仓库/修订。因此42-github-webhook、45-github-events、46-github-recovery仍可能保护可达的正式 Coding 路径，不能以“旧个人退役”删除。

本轮未运行真实入口反例，故这里只报告已核实的静态调用链差异；若确认为产品缺陷或文档过期，应另立关联工单，不在纯测试精简里静默改产品。17-github-retirement的旧发布事实归档与上述 webhook 不是同一功能，亦保留。

## 全部 89 文件的模块结论

| 模块 | 结论 | 独有作用与成本判断 |
| --- | --- | --- |
| Runtime 生命周期、并发、重连、崩溃、产物与历史 | 保留 | FIFO/目录身份互斥、单终态、客户端断开不取消、真实进程崩溃后不重放、SQLite失败不应答、UTF-8及部分历史不能由纯状态断言互相替代。01–05、09、11、12等跨的是不同失败窗口。 |
| 文件/HTTP审批、模式、自动审查、MCP与Web Search | 保留 | 08/10/22/23/24/25/44/63覆盖信任边界不同：认证、批准消费、DNS/凭据、模型请求、工具发送、远端失联与存储落盘。63窄闸门不代替08/25真实接线；旧数据测试64也保留。 |
| 上下文、模型配置、记忆、Jev、技能、Plan与清单 | 保留 | 16/18/20/21与52–62分别覆盖保存权威、真实发送视图、钉版、撤权竞态、预算/压缩、SDK输出与输入可重建；纯算法与完整装配作用不同。21的小/大窗口不能因同函数就删掉非默认窗口证据。 |
| TUI、控制连接、CLI、开发入口 | 保留；33局部删旧个人分支，71删两项重复/退役 | 14的假终端交互、15真实PTY、32开发进程管理、33在线/离线配置不同层。14保留多页长正文/翻页阈值、工作流实际控制、草稿/审批/窗口；15保留PTY输入/终端恢复/退出持久结果。73已仅循环Coding，无旧个人副本可删；旧local/container、非法后端多入口测试保护拒绝发生在副作用之前。 |
| Desktop 构建、主进程、SSH、恢复/流式/差异/Demo | 保留；38-personal按工单降层与去重复 | 构建CSP/打包原生引用、桌面IPC/代次、SSH真实进程、流式补读、差异归属不同。43-desktop-demo 的源码一致性承担已确认冻结Demo/组件契约，不能无替代地称为无用实现锁定。 |
| 工作区、设置与旧资料 | 74局部退役删除；76重复删除并按阶段三降层，其余保留 | 74目录dev+ino/认领/幂等，75配置与资料授权来源，76组织映射/权限/字节不变/回滚各不等价；76的纯迁移事务适合真实SQLite+临时文件窄入口，控制接线、配置源、权限、字节仍留集成。 |
| 旧IM、调度、QQ与归档 | 首批44按上述表删除；37再局部删；其余保留 | 26传输、28业务库、37时间仍是现行共享；38/40/77/84旧恢复及非IM零外发保留；41/48/49归档群资料来源隔离、撤回、授权不能被普通开发读取。79保留旧授权行/事件约束和拒绝升级不改事实。 |
| GitHub 入站与退役发布 | 保留，调用链差异交主实现者 | Webhook HMAC/原字节/有界接纳/停止、修订归属、固定只读工具、partial报告以及旧发布归档并非同一行为；正式可达性尚不能证明全部退役。 |
| 真实模型连通性 | 保留显式开关 | 06默认离线，不能把外部验收跳过算通过，也没有值得追求的默认CI耗时收益。 |

本次没有建议为纯删除新增测试。阶段三新夹具/窄入口仍须留下能因回归失败的最窄反例。14/15/33/73等保留的慢文件应以完整进程墙钟进一步判断成本，本文未执行它们，不能承诺减时。

## 完整发现文件列表

- `test/01-concurrency.test.ts`
- `test/02-idempotency-reconnect.test.ts`
- `test/03-lifecycle.test.ts`
- `test/04-crash-recovery.test.ts`
- `test/05-overflow-db.test.ts`
- `test/06-connectivity.test.ts`
- `test/07-read-images.test.ts`
- `test/07-real-tools.test.ts`
- `test/08-approvals.test.ts`
- `test/09-artifacts.test.ts`
- `test/10-access-modes.test.ts`
- `test/11-history-read.test.ts`
- `test/12-reconnect-pending.test.ts`
- `test/13-tui-state.test.ts`
- `test/14-tui-app.test.ts`
- `test/15-tui-pty.test.ts`
- `test/16-context-memory.test.ts`
- `test/17-github-retirement.test.ts`
- `test/18-model-selection-store.test.ts`
- `test/18-model-selection.test.ts`
- `test/19-tui-demo.test.ts`
- `test/20-prompt-inspector.test.ts`
- `test/21-context-breakdown.test.ts`
- `test/22-auto-review.test.ts`
- `test/23-web-search.test.ts`
- `test/24-mcp.test.ts`
- `test/25-mcp-write.test.ts`
- `test/26-qq.test.ts`
- `test/27-orchestration.test.ts`
- `test/28-main-data.test.ts`
- `test/29-cli-entry.test.ts`
- `test/30-workspace-entry.test.ts`
- `test/31-model-config.test.ts`
- `test/32-dev.test.ts`
- `test/33-config-tui.test.ts`
- `test/34-event-flow-view.test.ts`
- `test/34-event-stream-backend.test.ts`
- `test/36-event-flow-state.test.ts`
- `test/37-command-history.test.ts`
- `test/37-scheduler-outbox.test.ts`
- `test/37-view-browser.test.ts`
- `test/38-desktop-build.test.ts`
- `test/38-desktop-main.test.ts`
- `test/38-desktop-personal.test.ts`
- `test/38-telegram-owner.test.ts`
- `test/39-desktop-recovery-guide.test.ts`
- `test/40-desktop-creation.test.ts`
- `test/40-qq-private.test.ts`
- `test/41-desktop-stream.test.ts`
- `test/41-qq-private-scope.test.ts`
- `test/42-desktop-inspector.test.ts`
- `test/42-github-webhook.test.ts`
- `test/43-desktop-demo.test.ts`
- `test/43-inbound-notification-store.test.ts`
- `test/44-task-tool-policy.test.ts`
- `test/45-github-events.test.ts`
- `test/46-github-recovery.test.ts`
- `test/48-chat-results.test.ts`
- `test/49-chat-result-flow.test.ts`
- `test/51-generic-scheduler.test.ts`
- `test/52-jev.test.ts`
- `test/53-jev-config.test.ts`
- `test/54-jev-records.test.ts`
- `test/55-jev-runtime.test.ts`
- `test/56-skills.test.ts`
- `test/57-todo-list.test.ts`
- `test/58-plan-mode.test.ts`
- `test/59-system-prompt.test.ts`
- `test/60-context-prefix.test.ts`
- `test/61-context-compaction.test.ts`
- `test/61-manual-context-compaction.test.ts`
- `test/62-tool-availability.test.ts`
- `test/63-approval-gate.test.ts`
- `test/64-tool-op-ledger.test.ts`
- `test/65-slash-commands.test.ts`
- `test/66-control-seam.test.ts`
- `test/68-context-format.test.ts`
- `test/69-session-list.test.ts`
- `test/69-session-summaries.test.ts`
- `test/70-prompt-format.test.ts`
- `test/71-product-entry.test.ts`
- `test/72-on-demand-backend.test.ts`
- `test/73-desktop-execution.test.ts`
- `test/74-workspace-sessions.test.ts`
- `test/75-workspace-settings.test.ts`
- `test/76-legacy-workspace-data.test.ts`
- `test/77-im-approvals.test.ts`
- `test/78-linux-service-management.test.ts`
- `test/79-standing-permissions.test.ts`

未执行：应用测试、平台/PTY负例、真实模型、Linux与CI；未核实任何性能改善。风险：本报告只证明删除/保留范围的静态依据，实施后需验证候选标题仍对应原断言、保留用例可运行及旧记录安全恢复。
