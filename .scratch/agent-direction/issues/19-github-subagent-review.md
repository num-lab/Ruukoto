Status: resolved

# 19 — 把现有 GitHub 评审迁移到通用 SubAgent

**What to build:** 现有 PR 事件通过通用 SubAgent 完成只读评审，main 仍向固定拥有者汇报，逐步退出固定 coding 路径。

**Blocked by:** [11 — 主 Agent 委派通用 SubAgent 并收到结果](11-subagent-delegation.md)

依据：[已确认规格](../spec.md) 与 [ADR 0017](../../../.agents/notes/implemented/architecture/2026-10-02-two-agent-products.md)。

## 验收标准

- [x] 同一 PR webhook 从登记、去重、通用子任务评审到原有固定通知完整可用，不再新建固定 coding 评审任务。
- [x] 保持只读工具与资料限制，不执行 PR 代码，不因此取得评论、合并或任意发布权限。
- [x] 旧报告、原始修订、失效状态和来源仍可查看，重复事件及重启不产生重复评审副作用。
- [x] 沿用已有 PR 通知授权，不等待 GitHub comment 对话能力，也不重复实现已经退役的旧 GitHub REST 模块。
- [x] 完成相关端到端检查、类型检查及仓库要求的验证；同步本次行为涉及的运行说明和图解，验证记录区分模拟结果与真实环境结果。

## Comments

### 2026-10-03：实施计划

基于 HEAD `e542261` 制定。核心库 v24、控制协议 v11；12 的计划尚未实施，实施时核实版本号。本单不改 schema，也不改控制协议。

现状核实：

- **入口与去重已具备，不用动。** `src/github/webhook.ts` 负责验签、字段校验、仓库允许列表与 1 MiB 上限；`GitHubEvents.register`（`src/github/events.ts:87`）在一个事务内登记入站事件、按 `(github, delivery ID)` 去重、把旧修订的 `result_ref.review.staleReason` 标为过期，并取消待发通知。
- **固定 coding 路径集中在编排器一个分支。** `orchestrator.ts:495` 起：先建 main 父任务 `evt:<eventId>:main`（无工具，只确认接收），再用 `delegateChecked` 在 coding 角色会话建子任务 `deleg:<parent>:review`（confirm，`sourceEventId` 指向事件，截止为 `receivedAt` + 60 分钟），然后 `markInboundQueued(event, child)`。
- **按 `agentId === "coding"` 识别子任务的有三处：**
  - `GitHubEvents.allowTool`（`events.ts:136`）：coding 子任务只开 `read`、`read_artifact` 与 `effect=read` 的 MCP；main 唤醒只开 `coding_result`；
  - `resultData`（`events.ts:154`）：把最终回答分页完整存为 `review-draft:<eventId>` 产物，并写入 `review` 字段（失败保留 partial 与 `captureError`）；
  - `terminal`（`events.ts:189`）：只对“该事件 coding 子任务的 main 摘要”登记一次 `inbound_event` 通知。
- **复用现成的接线：**
  - 队列循环对带 `sourceEventId` 的任务在出队时走 `inboundGate`（`runtime.ts:2529` 起），修订已过期就取消；
  - `wakeParent`（`orchestrator.ts:876`）对评审子任务沿用事件来源与截止时间，并附 `notice` 修订说明；
  - 重启巡检的补记结果、补发唤醒都已覆盖 `sub_agent_id`。
- **SubAgent 侧（11）：**
  - `SubAgentManager.delegate` 本身不检查父任务是否由拥有者发起（检查在 `subagent-tools.ts` 的工具层），宿主可以直接调用，不必放宽给模型；
  - 子会话沿用父会话项目（`subagents.ts:257`）；
  - 任务输入的首行与边界说明是固定的只读文案（`subagents.ts:428`）；
  - 同一父会话的活动任务上限 3 个（`subagents.ts:150`，`store.ts:1021` 计数）。
- **`handleSubAgentTerminal`（`orchestrator.ts:711`）缺两件事：** 不调用 `resultData`（评审正文不会存成产物），也不回写入站终态、不调用 `onInboundTerminal`。
- **MCP 按会话项目规划与核对凭据。** `driver.ts:763`：`planMcp` 用 `session.projectId`，`subagent` 类别不含 mcp，直接返回空计划。`mcpConfigure` 会把凭据 `scope.projectId` 收紧到所配项目（`runtime.ts:2352` 起），调用时按任务所在项目核对。现行文档要求把 GitHub MCP 配到 coding 角色的项目（`docs/runtime.md:1546`）。
- **旧结果读取已有窄口。** `coding_result` 能读旧 coding 子任务和 SubAgent 任务（`delegation-tools.ts:194` 起）。`src/agent/review.ts` 是审批自动审查，与 PR 评审无关，不动。

实际缺口：

1. 编排器仍新建 coding 评审子任务。
2. SubAgent 拿不到只读 MCP，而评审资料只能经 MCP 读取（ADR 0007 不恢复 REST）。
3. SubAgent 终态不保存评审产物，不回写入站事件，`terminal` 也不认 SubAgent 子任务，因此不会产生固定通知。
4. 宿主评审没有自己的任务输入文案，并且会占用 main 的委派上限。
5. 升级时已经建出父任务和旧 coding 子任务的事件（崩溃窗口）会被重复评审。

#### 默认取舍（推荐即规格，有异议再改）

- **宿主直接调用 `SubAgentManager.delegate`，不经模型工具。** 父任务仍是 `evt:<eventId>:main`。管理器入参新增 `hostReview: { sourceEventId, body }`，只有编排器会传，工具层构造入参时没有这个字段，拥有者来源检查保持原样。评审任务：
  - 不占 main 的委派上限：计数 SQL 增加 `AND t.source_event_id IS NULL`，owner 委派的 SubAgent 任务不带来源事件；
  - 首行写为 `[SubAgent 委派 · GitHub PR 评审]`，正文沿用 `GitHubEvents.request`；
  - 带 `sourceEventId`，以复用出队门、过期标记与通知链路。
- **每个入站事件（每个修订）一项新工作、一个新 SubAgent，不跨修订复用。**
  - 新修订用全新上下文，避免旧 diff 和旧报告混进对新 head 的核对；也不依赖 12 的“忙碌拒绝”规则。
  - 幂等键 `ghreview-<eventId>`，参数摘要只含 `{kind, eventId}`，升级前后提示文案变化不会误报冲突。
  - 评审 SubAgent 空闲后保留，不自动关闭（遵守规格）。宿主不复用它，也不允许主 Agent 用 12 的 `sub_agent_id` 把它挪去做其他工作，因为上下文含不可信的 PR 资料；主 Agent 或拥有者可以关闭它。
- **只读 MCP 按任务开放，只给评审任务。**
  - Driver 新增宿主依赖 `taskMcp(task)`，返回 `GitHubEvents.isReviewTask(task)`，即 `subAgentId` 非空且来源事件是 github。
  - subagent 类会话只在该依赖为真时规划 MCP。收窄规则改为“静态只读白名单 ∪（`effect === "read"` 且评审任务）”，装配、发送前检查、调用门三处用同一结论。
  - owner 委派的 SubAgent、main 自身（类别不含 mcp）、开发会话 SubAgent 都拿不到 MCP。
  - `subagent` 系统提示补一句：宿主为个别任务另开的只读 MCP 以实际工具为准，仍然不能写入。
- **GitHub MCP 改配到 main 角色的项目。**
  - 评审 SubAgent 的会话在 main 项目下，而凭据范围按项目核对，coding 项目的配置用不到。
  - 不自动迁移配置：改写凭据范围属于授权变更。拥有者按文档登记一份 scope 为 main 项目的只读凭据，再执行 `mcp configure --project <main 项目>`；coding 项目的旧配置留到 23 清理。
  - 未配置时，评审如实写明无法取得资料（现有行为）。
  - 这与 ADR 0013 及 `docs/runtime.md` 的“配到 coding 项目”冲突，在 ADR 0013 中追加修订段说明。
- **结果与通知授权不变。** 通知槽仍是 `sourceKind = inbound_event`、逻辑键为事件 ID，目标在登记时固定，发送前复核修订与目标。main 唤醒开放 `subagent_result`；`coding_result` 在迁移期继续开放，给升级前未完成的旧唤醒用。不使用 18 的工作最终汇报机制。
- **评审并行运行，不设并发上限。** 原来所有评审排在 coding 单一队列里串行执行；现在每个修订各用一个会话。已被新修订取代但仍在运行的评审会跑完，结果标为过期、不发通知。代码中用 `ponytail:` 注释写明上限及升级方向：模型成本成为问题时，增加宿主评审并发名额。

#### 实施步骤

1. **管理器**（`src/runtime/subagents.ts`）。
   - `SubAgentDelegateInput` 增加可选 `hostReview`。有该字段时：
     - 跳过限额检查；
     - 不要求资料或路径，读范围为空；
     - `taskInput` 走评审分支：宿主首行 + 工作与来源事件行 + `body`，仍受 8192 字符上限约束；
     - `insertQueuedTask` 带上 `sourceEventId`。
   - `store.countActiveSubAgentTasks` 增加 `source_event_id IS NULL` 条件。

2. **编排器**（`src/runtime/orchestrator.ts`）。
   - `OrchestratorDeps` 增加 `subagents?: Pick<SubAgentManager, "delegate">`，在 runtime 中接线。管理器在 `runtime.ts:625` 先于编排器构造。
   - review 分支：父任务逻辑不变，先 `findChildTask(parent.id, "deleg:<parent>:review")`：
     - 已有旧 coding 子任务（升级前的崩溃窗口）就接管它，不新建 SubAgent；
     - 否则 `subagents.delegate({ parentTaskId, key: "ghreview-<eventId>", request: review, paramsDigest, hostReview })`，取返回的 task 继续 `markInboundQueued`。
   - 管理器准备失败时（缺执行入口、模型门闩未就绪）沿用现有 catch：事件保持 registered，下次派发重试，不降级到 coding。
   - `handleSubAgentTerminal` 补两处：
     - 先调用 `this.deps.resultData?.(task, outcome)`，把结果并入 `resultRef`；`artifactIds` 在其后计算，才能包含刚定稿的评审产物；
     - 结果事务内，与 `handleTerminal` 一样回写 `event.taskId === task.id` 的入站终态，并调用 `onInboundTerminal`。这两段抽成一个小函数，两条路径共用。

3. **GitHubEvents**（`src/github/events.ts`）。
   - 新增 `isReviewTask(task)`。
   - `resultData` 与 `terminal` 的子任务判定改为“coding 或 SubAgent 评审任务”，旧分支留给升级前的在途任务，23 再删。
   - `allowTool` 中 main 唤醒增加 `subagent_result`。
   - 产物头的指引从 `coding_result` 改为 `subagent_result`。

4. **Driver 与提示词。**
   - `driver.ts`：`DriverDeps` 增加 `taskMcp?`；`planMcp(task)` 在 subagent 类且 `taskMcp(task)` 为真时规划 MCP；`narrow` 按上述规则调整。
   - `session-factory.ts`：subagent 提示补一句只读 MCP 说明。
   - `subagent-tools.ts`：`subagent_result` 增加可选 `resultNotice`，评审任务前置修订说明，与 `coding_result` 一致。
   - `runtime.ts`：接线 `taskMcp`、`resultNotice` 与编排器的 `subagents`。
   - `tool-availability.ts`：subagent 仍为空清单，只更新注释。

5. **与相邻工单的边界。**
   - 12：若 12 已落地，在其可用性检查中拒绝复用“工作源自入站事件”的 SubAgent；12 尚未落地时，由 12 实施时补上。
   - 14：取消评审工作后是否唤醒 main、发通知，按 14 的“迟到结果不唤醒”规则执行，本单不另加分支。
   - 18：工作最终汇报只适用于源自 telegram/qq_private 拥有者入站的工作，评审工作排除；后落地的一方补排除用例。

不做：
- 删除 coding 角色及旧分支（23）；
- 跨修订复用评审 SubAgent 或自动关闭它；
- 评审并发名额；
- GitHub comment 对话；
- 恢复 REST 补抓；
- 自动迁移 MCP 配置或凭据范围；
- 改动 webhook 入口与去重。

#### 验证与验收

不新建测试文件。改写 test/45、46（这条链路的既有验收），并追加用例；fixture 的 MCP 改配到 main 项目。按五项验收对应：

- **1 完整链路，不新建 coding 评审：**
  - 签名请求首次返回 202、重复返回 200，HTTP 不等待模型；
  - 生成一项工作、一个 SubAgent 和一条执行任务（`subAgentId`、`workId`、`sourceEventId` 均正确），coding 会话零新任务；
  - 子任务工具 = `read`、`read_artifact` + MCP 读取工具，MCP 调用为前后两次 `get_pr` 加 `get_diff`；
  - 跨页评审正文完整存为产物，`review` 字段与原断言一致；
  - main 唤醒可用 `subagent_result`（并兼容 `coding_result`），只产生一条 `inbound_event` 通知且发送成功；
  - `work list` 能看到该工作。
- **2 只读与权限：**
  - 伪造的 write/unknown MCP 调用、bash、`subagent_delegate` 在发送前和调用门两处被拒；
  - PR 正文里的注入指令不改变工具、目标或权限；
  - 任务固定 confirm，没有任何审批记录；
  - MCP 配在 main 项目时，main 自身任务和拥有者委派的 SubAgent 均不出现 MCP 工具；
  - 评审 SubAgent 不能把工作改派给主 Agent；
  - 不出现 `github_drafts` 等旧表。
- **3 旧记录可查，重复事件与重启不重复：**
  - 预置旧 coding 评审子任务及其 `result_ref.review` 与产物，`coding_result` 和 `read-artifact` 仍能读取；新修订事件同时把旧 coding 结果和新 SubAgent 结果标为过期；
  - 升级接管：父任务和旧 coding 子任务已存在的事件，再次派发时接管旧子任务，零新 SubAgent；
  - test/46 的恢复窗口逐一改走 SubAgent，结果都复用原工作、原任务、原产物与原通知键，模型评审调用恰为一次：
    - 父任务已建、子任务未建；
    - 子任务已提交但回执丢失；
    - 默认模型变化；
    - 报告已定稿但结果事务未提交；
    - 摘要已终态但 outbox 未登记。
  - head/base 变化、同时间戳不同 SHA、关闭事件沿用原断言；
  - 出队时修订已过期的评审被取消，不发通知。
- **4 通知授权沿用，不依赖 comment，不重写 REST：**
  - 换 owner 目标、停用 webhook 都取消待发通知，不改发；
  - `effect_unknown` 不重发，重复 delivery 和重启不重发；
  - 评审工作不产生 18 的最终汇报（18 已落地时）。
- **5 检查：**
  - 类型检查；
  - test/80 的限额用例增加“评审任务不占 main 名额”；
  - test/59、62 随提示词与注释核对。

```bash
npx tsx --test test/45-github-events.test.ts test/46-github-recovery.test.ts test/42-github-webhook.test.ts test/43-inbound-notification-store.test.ts test/44-task-tool-policy.test.ts test/80-subagent-delegation.test.ts
npx tsx --test test/27-orchestration.test.ts test/39-coding-delegation.test.ts test/39-coding-results.test.ts test/24-mcp.test.ts test/25-mcp-write.test.ts test/37-scheduler-outbox.test.ts test/59-system-prompt.test.ts test/62-tool-availability.test.ts test/64-tool-op-ledger.test.ts test/66-control-seam.test.ts
npm run typecheck
npx tsx --test test/67-visual-docs.test.ts
npm test   # nohup + 退出码文件，跑时不改 src/test
```

新增 `.scratch/agent-direction/smoke-19-github-subagent-review.mts`，沿用 smoke-11 的结构，用 `--remote` 在 `ssh tx` 上运行。真实部分：Runtime、控制面、SQLite、独立 JSONL、Docker 受限 worker，以及回环地址上真实监听的 webhook HTTP 入口（签名 POST）。模拟部分：MCP（本地 mock，配在 main 项目）、模型、通知渠道。检查项：

- 202/200 去重；
- 生成 SubAgent 工作，coding 零任务；
- 子任务工具清单正确，伪造写调用被拒；
- 产物完整；
- `subagent_result` 唤醒；
- 一条通知；
- 第二个新 head 的 delivery 让旧结果过期并取消待发通知；
- 重启后不重复评审、不重复发送；
- 空闲期间无残余容器。

模型、MCP 与消息平台为模拟，分别记录。真实 GitHub 投递、真实 GitHub MCP 与真实 Telegram/QQ 没有演练入口，记为未实测。

### 2026-10-04：实施完成，验收证据（基于 HEAD `03510b3`，12/14/16/18 已落地）

**默认取舍按计划执行的两处计划调整**：plan 的 `hostReview: { sourceEventId, body }` 实际只需 `{ sourceEventId }`（正文即 `request`，不重复携带）；「旧 coding 结果与新 SubAgent 结果同时标过期」的断言放进 test/45 修订用例（预置旧 coding 评审种子），「评审任务不占名额、复用拒绝」放 test/80 新用例。

**实施中发现的恢复漏洞（已修）**：评审 SubAgent 登记提交后、首次 kick 生效前崩溃，或崩溃窗口把排队子会话按 `backend_restart` 暂停时，恢复重提命中首次登记（管理器不再 kick）会让评审任务永远排队。编排器派发现在补一次幂等 kick，子会话被恢复事务按 `backend_restart` 暂停时按角色会话同口径恢复（`occupancy_unverified` 不解除，仍等拥有者核实）。

**五项验收证据**

1. **完整链路，不新建 coding 评审**（离线逻辑测试 + 真实执行边界）：
   - test/45 主流程：202/200 去重、HTTP 不等待模型；生成一项工作、一个 SubAgent、一条执行任务（`subAgentId`/`workId`/`sourceEventId` 正），coding 会话零新任务；子任务工具 = `read`/`read_artifact` + 两次 `get_pr` 加 `get_diff` 只读 MCP；跨页正文完整存为 `review-draft:<事件>` 产物、`review` 字段与原断言一致；main 唤醒用 `subagent_result`（迁移期兼容 `coding_result`），恰一条 `inbound_event` 通知且发送成功；`work list` 可见该工作。
   - smoke-19（真实 Runtime/控制面/SQLite/JSONL/Docker 受限 worker/回环真实监听的签名 webhook 入口；模型、MCP、消息平台模拟）：本机 darwin arm64 8/8，远端 tx（Linux x64、镜像内 uid 1003）8/8。
2. **只读与权限**：test/45 伪造 write/unknown MCP、bash、`subagent_delegate` 在发送前与调用门两处被拒（MCP 服务记录只有读取命中）；PR 正文注入指令不改变工具/目标/权限（任务固定 confirm、零审批记录、不采纳 `full_access`）；MCP 配在 main 项目时 main 自身任务与拥有者委派的 SubAgent 均无 MCP 工具（test/45 新用例）；评审 SubAgent 无委派工具，不能把评审改派主 Agent；无 `github_drafts` 表；签名秘密不进入模型上下文、不开放通用 HTTP。
3. **旧记录可查，重复事件与重启不重复**：test/45 新修订把旧 coding 结果（预置）与新 SubAgent 结果同时标过期、取消待发通知，旧草稿完整保留；升级接管用例（父任务与旧 coding 子任务已存在）零新 SubAgent、沿原任务收尾；test/46 五个恢复窗口（父任务已建子任务未建、子任务已提交回执丢失、默认模型变化、报告定稿结果未提交、摘要终态 outbox 未登记）逐一复用原工作/任务/产物/通知键，模型评审恰一次；head/base 变化、同时间戳不同 SHA、关闭事件沿用原断言；新增「出队时修订已过期的评审被取消」用例：零模型调用、不登记通知。smoke-19 C/D 段在真实进程重启下复验（不新建记录、不重复发送）。
4. **通知授权沿用**：test/45 换 owner 目标、停用 webhook 都取消待发通知不改发；`effect_unknown` 不重发，重复 delivery 与重启不重发；ops 全部为 `inbound_event`（评审工作不产生 issue 18 的 owner_reply 最终汇报，`workOriginEvent` 本就只认 telegram/qq_private，新断言固化）。
5. **检查**：`npm run typecheck` 通过；test/80 新用例「不占名额 + 复用/续派拒绝」；test/59、62 通过；图示页同步后 test/67 通过。相关文件集：`npx tsx --test test/42 43 44 45 46 27 39×2 24 25 37 59 62 64 66 67 80` 全绿。

**验证层级**：离线逻辑测试见上；真实后台与执行边界 = smoke-19 本机（macOS + Docker `ruukoto-worker`）与远端 `ssh tx`（Linux + Docker，`uid/gid 1003`）各 8/8；模拟 = MockModelServer 模型、本地 mock MCP（配在 main 项目）、进程内通知渠道；未实测 = 真实 GitHub 投递、真实 GitHub MCP 与真实 Telegram/QQ（无演练入口）。

**文档同步**：runtime.md 新增「宿主固定评审（issue 19）」节、PR webhook 配置改 main 项目并写升级步骤、「评审、修订与通知边界」两条改写为 SubAgent 链路、删去「19 再迁移」说法；ADR 0013 追加 issue 19 修订段；ADR 0017 实施记录加行；CONTEXT.md「SubAgent」与「GitHub 评审入口」条目更新。图解页（visual-docs skill 核实）：orchestrator.html（角色表、请求键表、#github 节整节改写为 SubAgent 链路、结构化结果段、SubAgent 工具行）、inbound-events.html（派发图 aria 与三处评审请求键/任务表述）、tool-call-path.html（SubAgent 装配与收窄两条）、context-pipeline.html（SubAgent 工具定义行）、once-only.html（派发幂等行）、task-lifecycle.html（backend_restart 恢复两行补宿主评审例外）；时序图经 shoot.sh 渲染逐张核对，test/67 全绿。未发现文档与代码的新不一致。

**顺手修复**：test/81「登记失败清理」的目录断言用 `f.includes("c3"/"c5")`，随机 workId 含该子串时误命中旧快照（本单全量运行中首次触发）；改为按 `-c3.txt`/`-c5.txt` 后缀匹配。

**全量**：`npm test` 末轮 917 项，915 通过、0 失败、1 项真实模型测试按默认开关跳过；唯一失败为 test/32-dev「档案路径」在 worktree（目录名 `calm-winding-harbor` 而非 `ruukoto`）下的预置断言，与本单无关（不触及档案路径代码），主检出路径下通过。

文档同步：

- `docs/runtime.md`：
  - 「PR webhook 配置」改为 MCP 配到 main 项目，并写升级步骤：另建 scope 为 main 项目的只读凭据，再 `mcp configure --project`；旧 coding 项目配置不再被新评审使用；
  - 「评审、修订与通知边界」中“宿主固定委派”与“结果归属”两条改写为 SubAgent 链路；
  - SubAgent 章节补宿主评审入口、不占名额、按任务开放只读 MCP；
  - 删去第 1410、1497 行“沿用旧 coding 路径（19 再迁移）”的说法。
- ADR 0013 追加“agent-direction issue 19 修订”段：SubAgent 取代 coding 子任务、MCP 配置项目、唤醒工具、每个修订一个 SubAgent 且不复用。ADR 0017 实施记录加一行。
- `CONTEXT.md` 的 SubAgent 条目补“GitHub 评审经宿主固定 SubAgent”。
- 对每个改动的 `src/` 文件执行 `grep -l <路径> docs/visual/*.html`。预计命中 orchestrator（父子任务表、请求键表 `deleg:<父任务>:review`、github 节、`coding_result` 说明）、inbound-events、outbox、tool-call-path、task-lifecycle、once-only、context-pipeline、storage-layout。同步后运行 test/67。

完成时逐条登记五项验收证据，区分离线逻辑测试、真实后台与执行边界、模拟模型/MCP/平台和真实平台。本次只保存计划，工单状态与验收勾选保持不变。
