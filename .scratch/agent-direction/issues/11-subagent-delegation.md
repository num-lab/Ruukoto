Status: resolved

# 11 — 主 Agent 委派通用 SubAgent 并收到结果

**What to build:** 在已有开发会话和 main 中走通通用委派：登记工作委托，创建独立 SubAgent，执行有界任务、返回结果并保持空闲。

**Blocked by:** 无，可立即开始

依据：[已确认规格](../spec.md) 与 [ADR 0017](../../../docs/adr/0017-two-agent-products.md)。

## 验收标准

- [x] 主 Agent 可创建 SubAgent 并执行一个受控读取或分析任务，拥有者可查工作委托、子任务状态和结果。
- [x] SubAgent 完成后保留身份与上下文、进入空闲，不自动关闭；主会话在等待结果期间仍能处理新消息。
- [x] 工作委托与一次执行任务明确区分，跨主 Agent 对话轮次仍能关联原工作；重复委派不会重复创建同一次执行。
- [x] 工具和资料由宿主限定；SubAgent 不能再创建下级、直接向拥有者发送或取得拥有者控制面身份。
- [x] 新增通用身份与旧固定角色兼容共存，复用已有任务、历史、结果和幂等机制；本单不删除旧 coding 调用路径。
- [x] 现有 main 的分析委派接入通用只读路径，保留旧修改委派兼容，避免最后清理时才补分析职责迁移。
- [x] 完成相关端到端检查、类型检查及仓库要求的验证；同步本次行为涉及的运行说明和图解，验证记录区分模拟结果与真实环境结果。

## Comments

### 2026-10-03：实施计划

基于 HEAD `24f1ac3` 制定。10 已交付限定服务长期授权，核心库 v23、控制协议 v10，全量检查 862 项中 861 通过、1 跳过，真实 Linux 服务冒烟 14/14；真实 QQ/Telegram 平台仍未实测。11 从现有开发会话与 main 的委派入口推进，不让 SubAgent 继承服务授权或拥有者身份。

首版完成同一条有界分析链路：主 Agent 登记工作委托，创建独立 SubAgent 和执行任务，立即取得关联 ID 并继续处理拥有者消息；子任务只读取指定资料并分析，结果回到原父会话，拥有者可以查状态、正文与产物。任务结束后保留 SubAgent 身份、会话及历史并进入空闲，空闲不继续运行模型或工具进程。

现有代码只把 main 的委派送入共享 coding 会话，幂等键以父任务为范围；固定角色与一次任务没有分离出通用 SubAgent 身份。普通开发会话还没有委派工具。另一个实际约束是所有任务均按 cwd 的路径和 dev/ino 排他占用，直接让子会话使用父 cwd 会阻塞主会话。本单新增必要的持久身份和独立工作目录，复用现有 Runtime 队列、Driver、执行边界、任务账本、JSONL、结果及产物，不另造调度框架。

#### 实施步骤

1. **分开记录工作委托、SubAgent 身份和每次执行。**

   新增 `work_delegations` 与 `sub_agents` 两表，任务增加可空 `work_id`、`sub_agent_id` 及本次限定资料范围，核心库从 v23 迁移到 v24（实施时核实版本）。工作委托保存所属父用户会话、原资料身份、发起任务、请求键及必要说明；SubAgent 保存独立 ID、所属父用户会话、独立 Session、当前工作和运行/空闲状态；Task 继续保存本次执行、直接父任务、截止时间、权限、结果及历史引用，并保存用于复核的读路径/身份、资料 SourceRef 与授权版本。创建工作与某次任务完成分别表达，不能把子任务结束当作工作关闭或 Agent 关闭。

   保留 `AgentRoleId`、`agent_roles` 和 `tasks.agent_id` 的 main/coding/chat 固定角色语义，动态 ID 放入新关联列，不能塞进旧角色 CHECK。新子会话可以沿用所属项目的资料身份，但由 `getSubAgentBySession` 等宿主绑定识别为独立的子身份，绝不能因没有固定角色而落入默认 dev 工具类别。新会话的组织归属也不作为权限依据。

   首版每次新委派创建一个新 SubAgent 和独立 Session，后续主对话轮次可沿原 workId 查询结果或向同项工作增加新的分析执行；同一个 Agent 的继续委派、跨工作复用和显式关闭由 12 实现。工作 ID 不等于 taskId，直接父任务也不必是工作最初的发起任务，二者均保留，以便跨轮次关联而不改写旧执行。

   为首次委派的父任务/请求键及工作内的 `(work_id, key)` 建立唯一约束。同 key 同规范参数返回原 work/Agent/Task，异参冲突；即使从后来一轮父对话重复调用，同一工作内也不能重复创建执行。工作内的参数摘要不包含本次调用的 parentTaskId，重放保留首次记录的直接父任务和快照；不能直接套用现有 Runtime.submit 中包含 parentTaskId 的摘要造成跨轮次误冲突。迁移只加必要对象和关联列，旧任务默认关联为空，不把旧 coding 身份或历史任务自动改造成新 Agent。

   主要落点：`src/core/types.ts`、`src/core/db.ts`、`src/core/store.ts`。用短 ADR 记录这三个领域对象与固定角色兼容的决定，衔接 ADR 0017；不提前增加同级消息、worktree、完整工作取消或恢复状态机。

2. **增加非阻塞委派与结果工具，原子登记后再调度。**

   增加集中通用委派模块（例如 `src/runtime/subagents.ts`）与 `src/agent/subagent-tools.ts`，对普通开发会话和 main 开放 `subagent_delegate`、`subagent_result`。委派参数只包含正文、幂等键、可选的既有 workId、选定资料及待读取路径；首版分析能力固定，不提供模型自选角色、执行账户、访问模式、父会话、任意 cwd 或自由工具列表。第一次省略 workId 时同事务建立工作，返回 workId、subAgentId、taskId 和截止时间。

   委派只接受拥有者发起的当前主任务，或同一父用户会话内明确继续原工作的拥有者新任务。宿主核实普通 dev/main 绑定、活动任务、工作归属及来源，拒绝群、固定 coding/chat、动态子身份、定时唤醒和内部结果唤醒借资料内容创建下一层。现有 `coding_delegate.ownerOriginated` 以 `agentId===null` 识别直接提交，新动态任务也可能为空，必须同时检查 subAgentId、父任务及宿主身份，避免被误判为拥有者。

   先按固定请求键查重，重复调用不重新解析可能已经变化的资料。新的请求先异步准备模型与受限执行入口、宿主生成的独立目录、路径身份及有界资料快照；再在一个同步 `Store.withTx` 内重核父绑定、权限版本、工作归属及限额，并按保存的来源引用调用 `SourceResolver.verify` 核实资料授权、重核父当前有效读范围，防止准备后、提交前撤销的资料进入新的子上下文。核实后登记工作（如需）、Session、SubAgent、queued Task、请求摘要及审计。提交后才 kick 子会话。复用 `Store.createSession`、`insertQueuedTask` 与现有提交校验，不串行调用两个各自提交的 `Runtime.createSession()+submit()` 留下半成品，不在核心事务中等待文件或模型操作。

   文件准备与 SQLite 没有跨系统事务；准备失败或落库失败时不启动模型/worker，只清理本次新建且没有已提交引用的临时目录，不能删除竞争请求已经使用的目录。同键竞争、模型配置门闩或提交应答丢失时先按原键核实已提交事实，不换键新建。通用委派工具的账本核实同时检查工作、Agent、Session、Task 的关联，复用既有 delegation 族的已提交/未提交语义。

   工具在子任务已入队后立即返回，不 await 子模型结束，也不循环轮询阻塞父任务。复用现有每 Session 独立的队列循环；父模型收到登记结果后可以结束当前轮次，让后续拥有者消息继续执行。沿用现有委派的小时级截止时间与有界并发理念，首版同一父用户会话最多三个 queued/running/awaiting_confirmation 的通用子任务；查重先于限额检查，空闲身份不占活动限额，新分析任务不自动重试。

   `subagent_result` 按所属父用户会话和 workId 核实，跨对话轮次可读取原工作的状态、有界摘要、最终回答及交付产物，沿用现有 UTF-8/字节分页。不能只依赖当前父 taskId，也不能接受另一个用户会话、工作或项目的 Agent/Task/产物 ID 打开资料。

3. **把只读工具、资料与执行身份限定在宿主能力内。**

   新增独立的 SubAgent 工具类别与系统提示，首版只开放 `read` 和 `read_artifact`。装配、模型发送前与实际调用门都使用相同静态白名单，伪造调用和以后新增的未知工具默认拒绝。不开放 bash、edit/write、request_file_access、HTTP、MCP、Web Search、host_data、skills、记忆/应用数据写入、服务管理、调度/通知或委派工具；现有 `/plan` 包含 bash 等能力，只作普通开发计划任务的规则，不能当作这里的只读约束。

   子任务固定 confirm，不继承父 full_access、会话默认模式、grantedPaths 的写权限、单次批准或长期服务授权。每个 SubAgent 使用保护根之外的独立宿主目录，保留既有目录排他占用，首版不改造共享读写锁。目录内只放明确传入的资料快照，代码路径和目录不能由模型任意指定；准备时核实实际 worker 身份能读这些资料，不能用后台 UID 读通代替执行身份验证。

   普通开发会话的待读路径由宿主限定在父工作区及父任务当前已授予范围内，取交集后只给 read 能力。保存规范路径和必要身份，拒绝路径穿越、符号链接越界、保护根及包含保护根的目录，启动和调用时重核身份及仍有效的授权，范围变化明确失败。原批准记录不能当成可复制的路径授权。读取复用已有工具 worker 和只读 GrantedPath 挂载/平台受限后端，不回退到后台身份读任意文件，也不打开写工具让模型自行承诺不写。

   只读挂载只限制写入，现有 worker 的 `readOperations` 仍直接调用 fs.readFile，不能据此宣称仅能读取指定资料。新增宿主钉定的读范围，经固定 launch/init 传入 worker，只允许私有快照目录与核实的只读路径；模型的 read 参数不能提供或替换该范围。在实际 ReadOperations 打开文件时复核路径、范围及身份，复用不跟随符号链接的解析与 O_NOFOLLOW/fstat 等既有方式，路径解析留在执行边界内。绝对系统路径及容器内部的范围外文件也拒绝。最小改动落到 `src/agent/tool-worker/protocol.ts`、host/worker 与路由器接线，旧编码任务未启用此限定时沿用原语义。

   main 默认没有可泛读的开发工作区。它通过现有 SourceResolver 在自己的有效资料权限内解析 text/task_result/artifact/app_data 等选定材料，生成有界、可追溯的快照交给子任务；保存原始来源引用，在子任务启动及每次向模型发送上下文前重新 verify，撤销后阻止后续注入，已保存快照正文不重新解析或改写。不能复制完整会话历史，也不能借仓库 URL、资料中的路径或父身份推导任意本机/网络访问。没有实际可读资料时说明能力范围或请求补充资料，不能暗中恢复 bash/clone 或改派到拥有修改能力的通用分析任务。保留原材料种类及访问限制，未接收群资料等不能借新工具扩散。

   Driver 的上下文装配也须识别动态子身份：只包含固定任务说明、选定快照及自己的 JSONL，首版不自动注入父项目指令、个人共享记忆、技能目录、父完整历史或继续来源。当前 `dataScopeRestricted` 只识别 chat，`artifactAccess` 又默认同项目可读，均需为子身份接入明确分支。`read_artifact` 只读本次自产，资料快照经宿主选定后落到其自己的范围；拒绝其他任务产物与 `prompt-snapshot:`，父 Agent 读取子结果则走上一步的关系窄口。

   同时封住普通控制面 submit/continue/switch-mode、会话默认、工作区入口及迁移流程对动态子 Session 的误用：拥有者可以只读查看，不能把该 Session 当成普通用户对话提交任意模式或工具。无需扩建资料 Accessor 总体系；以后确需让 SubAgent 查询历史/记忆时，再增加相应任务范围。本单不向子进程提供控制面令牌、后台凭据、Docker socket 或服务 helper 权限，缺执行边界时明确失败。

4. **持久回传结果、进入空闲，并迁移 main 的分析委派。**

   通用任务终态沿现有结果提取、`setTaskResult` 条件更新及事件机制收尾。现有 `Orchestrator.onRuntimeEvents` 与待补结果查询只处理非空 agent_id，需覆盖 sub_agent_id；复用结果正文按该任务历史条目读取、完整产物与分页，不从子会话最新回复或模型自报推断任务成功。结果中明确 workId、subAgentId、taskId、原直接父任务、所属父会话、状态、摘要及结果引用。

   结果与子身份空闲状态在同一事务登记，重复终态通知或补记只产生一份逻辑结果。正常退出且 worker/占用已核实回收才展示 idle；任务已终态但执行单元尚未确认退出时展示待核实，不能虚称空闲并释放资源。结果落库失败后按已有巡检/原请求键补记，不重新执行分析。后台异常仍沿用现有任务 interrupted、队列暂停和旧占用保留，不能因有动态身份而自动重跑；15 再增加完整恢复能力。

   普通开发会话收到指向原父用户会话的持久完成通知和结果入口，TUI 可直接看到归属；下一次父模型调用也注入有界的宿主结果资料/引用，完整结果用 `subagent_result` 查询。该通知不能伪装为拥有者新请求或授予委派权限。main 继续使用稳定 `wake:<childTaskId>` 回报键，附工作与动态身份，固定 confirm、不复制原 IM sourceEventId；委托工作关联保留原入口事实供 18 使用，本单不以内部回报取得自动 IM 最终外发授权。

   空闲保存身份、Session、JSONL 与产物；任务终态、TUI 退出和空闲时间不关闭 Agent。`Runtime.drivers` 会缓存 SDK，任务收尾及结果提交、执行退出已确认后复用 `Driver.dispose()` 释放动态会话的运行对象，不能把释放 SDK 视为删除身份。释放在队列循环的 driver.run 收尾之后进行，避免终态监听与运行 finally 竞争。

   main 新的 `coding_delegate(mode=analyze)` 转入通用只读链路，兼容入口返回新的工作/Agent/Task 关联，`coding_result` 能识别并经相同窄口读取这些新分析结果。当前修改参数实际名为 `draft`，保留其旧 coding 路径、旧任务及结果；不引入不存在的 modify 参数。旧持久 analyze 结果与宿主 GitHub review 的既有 coding 路径也继续可读/可运行，19 再迁移评审职责。更新 main/dev 提示，引导普通分析使用通用工具，不能只改工具名称而保留新 analyze 的写能力或旧自动重试。

   新增薄的已认证工作/Agent list/get 控制面与 CLI 查询，状态、历史、任务事件和产物复用现有接口。TUI 以简单的归属、运行/空闲状态及结果入口展示，普通工作区会话列表排除动态内部 Session，保留只读详情。新增动态身份、结果事件与快照视图随控制协议版本提升（当前 v10），旧客户端明确提示升级，持久旧事件仍能展示；不建设复杂新面板。

#### 验证与验收

新增 `test/80-subagent-delegation.test.ts`（实施时核实编号），复用 test/27、39 的模型桩、委派幂等/结果故障注入，现有 Runtime/Store、worker、历史与产物助手。必须覆盖：

- 普通开发会话和 main 各自完成工作登记 → 独立子身份/会话/任务 → 真实受控读取或材料分析 → 结果回传 → 父读取完整结果与产物 → 子空闲。子模型保持挂起时，父当前轮次可以结束，拥有者第二条消息能得到回复，不被子 cwd 占用阻塞。
- 后一轮父任务按同一 workId 查询及增加新的分析执行，工作、Agent 与每次 Task 的 ID 和关系分别核实；同 key 同参（含跨轮次及并发）返回同一组记录，异参冲突、限额拒绝、快照不重新解析；准备及事务中途故障不会启动半成品。
- 子工具发送与调用两处拒绝 bash/edit/write、任意 HTTP/MCP、记忆/应用数据写入、服务、通知及下级委派。测试读取后原文件字节/指纹未变，恶意资料中的指令也不能打开写能力。父 full_access、服务长期授权、默认模式及 `/plan` 不扩大子权限。
- 指定读范围之外、绝对系统路径/容器内部范围外文件、路径穿越、符号链接/目录替换、保护根、其他任务产物及 prompt-snapshot 拒绝；伪造 read 参数不能覆盖 worker init 范围。子模型请求不包含父原始历史、个人记忆、技能/项目指令和凭据。快照准备后、提交前撤销来源授权或改变父读范围时零子执行，main 的跨项目引用失败及未接收群资料边界保持。
- 群、旧 coding/chat、动态子任务、调度与回报唤醒不能创建通用孩子；普通控制面、工作区入口与模式切换不能把子 Session 改作用户会话。其他父用户会话/工作无法读结果，组织归属不改变资料身份。
- main analyze 硬只读迁移、draft 修改兼容、新旧 coding_result 读取、旧历史和 GitHub review 路径回归。原 analyze 测试中允许写入的行为不能继续作为新路径的成功断言。
- 完成/失败/超时/中断的结果如实保存，重复终态及结果写入失败只补记一次；普通 dev 的持久通知与下一轮上下文资料、main 的稳定唤醒均不伪造拥有者来源。不自动分析重试、不自动 IM 最终外发。
- 身份在完成、TUI 退出与等待后仍存在，空闲期间零额外模型/worker；未核实退出保留占用与待核实状态。重启不自动运行旧子任务，记录及旧 JSONL 可查；继续/复用/关闭及整项取消的后续功能不在本单宣称完成。
- v23 → v24 的旧角色、会话、任务、审批、长期授权、历史及产物保持，旧关联列为空；拥有者实际通过 CLI/TUI 查询新工作和子任务，未认证控制面拒绝，协议版本不符明确提示。

实施后的检查顺序：

```bash
npx tsx --test test/80-subagent-delegation.test.ts test/27-orchestration.test.ts test/39-coding-delegation.test.ts test/39-coding-results.test.ts test/62-tool-availability.test.ts test/64-tool-op-ledger.test.ts
npx tsx --test test/09-artifacts.test.ts test/11-history-read.test.ts test/44-task-tool-policy.test.ts test/58-plan-mode.test.ts test/59-system-prompt.test.ts test/61-context-compaction.test.ts test/66-control-seam.test.ts test/71-product-entry.test.ts test/77-im-approvals.test.ts test/79-standing-permissions.test.ts
npx tsx --test test/13-tui-state.test.ts test/14-tui-app.test.ts test/29-cli-entry.test.ts
npm run typecheck
npx tsx --test test/67-visual-docs.test.ts
npm test
```

新增 `.scratch/agent-direction/smoke-11-subagent-delegation.mts`，用真实产品后台、隔离 profile/socket、SQLite、独立 JSONL、实际受限 worker 与可控文件验证 ruukoto-code 开发会话及 ruukoto main。模型及消息平台可以打桩，必须分别记录；本机 macOS 使用 04 已验证的受限后端，Linux `ssh tx` 使用现有受限执行环境，不能以本地无隔离替身替代执行边界证据。保存父/子 sessionId、workId、Agent/Task、实际读取内容、原文件未变、第二条父消息先得到回复、结果/通知幂等、空闲无进程及身份仍保留的证据。真实 QQ/Telegram 演练没有入口时仍记未实测，不能继承 10 的模拟平台结果作为真实平台验收。

同步 `CONTEXT.md`、`docs/runtime.md` 的工作委托/Task/SubAgent 分离、只读能力、异步回报、空闲及兼容范围，更新 ADR 0017 的实施说明并记录必要的新 ADR；当前阶段的复用、通信、取消、恢复及异步 IM 汇报分别链接 12–15、18。对每个实际修改的 `src/`、`deploy/` 文件按仓库约定执行 `grep -l <文件路径> docs/visual/*.html`，同步命中的图、表和正文，重点核查编排器、工具调用、任务生命周期、存储、上下文、控制协议及部署页面，并运行 test/67。

完成时逐条登记七项验收证据，区分离线逻辑测试、真实后台与执行边界、模拟模型/消息平台和真实平台。本次只保存计划，工单状态及验收勾选保留。

### 2026-10-03：实施与验证记录

按四步计划交付。核心库 v23 → v24：`work_delegations`（父会话/发起任务/键/参数摘要，UNIQUE(父会话,键)）、`sub_agents`（独立 ID/父会话/独立 Session/宿主目录/当前工作与 running-idle-unverified 状态）、tasks 补 `work_id`/`sub_agent_id`/`read_scope`/`result_delivered_at` 四列（旧行恒空，旧 CHECK 与角色不动）；新 `src/runtime/subagents.ts`（查重先→异步准备→单事务登记→提交后 kick）与 `src/agent/subagent-tools.ts`（`subagent_delegate`/`subagent_result`，dev 用 read_paths、main 用 materials）；Driver 新 subagent 会话类别（read/read_artifact 静态白名单，装配/发送前/调用门同一结论，受限资料范围不注入父指令/记忆/技能）、`work_delegation.created` 与 `subagent_task.*` 事件、结果与空闲同事务登记、main 走 `wake:<childId>`/dev 走 `[SubAgent 结果]` 注入；worker init 钉定根读范围（根目录逐段禁符号链接+O_NOFOLLOW，容器根只读挂载）；控制协议 v11（快照带三件 + `work_list`/`work_get`，CLI `ruukoto work`），submit/continue/switch-mode/会话默认/工作区迁移入口拒绝子会话；`coding_delegate(mode=analyze)` 转通用硬只读（不自动重试），`coding_result` 兼容读取，draft 与 GitHub 评审保留旧路径。文档：ADR 0020 新记录 + ADR 0017 实施记录、CONTEXT.md、docs/runtime.md（新章节）、docs/visual 八个页面（test/67 通过）。code-review 两轴复核后修复：登记事务内按保存引用重核资料授权、工作区迁移排除子会话、执行身份权限位预检（容器按 uid/gid）、材料 ≤8 上限、死导出/注释失实清理；剩余为 judgement call（宿主工具文件的 okText/intParam 沿用仓内同款重复惯例）。

**离线逻辑测试（模型打桩 + 真实 Runtime/SQLite/本地 worker）**：test/80 共 11 例——dev/main 各自全链路（登记→独立身份/会话/任务→真实受控读取（worker 内正文）→原文件字节未变→dev 下轮上下文注入结果块、main wake+`coding_result`/控制面可查+空闲 idle）、子挂起时父第二条消息先完成、跨轮次同键同参返回原记录/异参冲突/限额拒绝/同工作新键复用同一 Agent、受限读取范围外/保护根/符号链接拒绝、伪造写调用两处被拒（装配收窄+调用门）、伪造 read 越 worker init 范围被拒、materials 中注入指令不打开写能力、coding/chat 无委派工具与零建、submit/switch-mode/会话默认拒子会话、subagent_result 跨会话/未知工作拒绝、登记事务故障注入零半成品+目录清理+同键恢复、占用未回收记 unverified、v23→v24 旧任务保留+新列为空。联检 39/39-results/27/62/64/66 全过，40/57/77 委派用例改走保留语义（draft 旧链或编排器直建 analyze）全过，09/11/44/58/59/61/63/71/13/14/29/34/36/62/66/69/07/77/79/19/21/22/75/76 与 67 全过；`npm run typecheck` 通过。全量 `npm test` 873 项 872 通过 0 失败 1 跳过（干净基线安静复跑；此前两次负载型失败——test/33 60s 等待与 test/26 状态核对——经同文件单独及安静环境复跑确认与本单无关）。

**模拟模型 + 真实后台与受限执行边界（smoke-11，macOS 本机 + ssh tx Linux，真实 Runtime/SQLite/独立 JSONL/Docker 容器 worker/真实文件）**：两轮 9/9——真实容器读取范围内文件（正文进子上下文）、范围外/钉定外读取实际拒绝、原文件未变、子模型挂起期间父第二条消息先完成、幂等返回与异参冲突、空闲无残余容器、work list/show 控制面、重启身份保留且旧子任务不自动运行、main 快照落 `materials-<key>.txt`+wake 回报+coding_result 读取。

**未实测**：真实 QQ/Telegram 平台（无绑定拥有者演练入口，平台语义未验收，不继承 10 的模拟平台结论）；容器内非默认 uid 的资料可读位以权限位预检 + worker 调用如实失败两级覆盖，未做 ACL 级演练。
