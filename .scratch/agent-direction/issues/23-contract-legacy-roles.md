Status: resolved

# 23 — 清理固定角色和迁移期兼容写入口

**What to build:** 两个产品日常运行完全使用新的工作区、主 Agent 和通用 SubAgent 路径，旧形态只保留必要的历史读取兼容。

**Blocked by:** [06 — 在工作区管理配置与资料授权](06-workspace-settings.md)；[17 — 汇总并验证并行改动，保留冲突成果](17-integrate-worktree-results.md)；[21 — 把旧开发资料迁入 Coding Agent](21-migrate-coding-instance.md)；[22 — 把旧主会话和服务状态迁入 Personal Agent](22-migrate-personal-instance.md)

依据：[已确认规格](../spec.md) 与 [ADR 0017](../../../.agents/notes/implemented/architecture/2026-10-02-two-agent-products.md)。

## 验收标准

- [ ] 普通委派和 PR 评审全部走通用 SubAgent，核心不再引导或接受固定 coding/chat 新任务。
- [ ] 用户入口、配置和界面不再提供旧角色或旧项目写入路径，产品定位与实际运行一致。
- [ ] 清理前核实所有旧写调用方已迁移；每批变更保持检查通过，不靠一次全局破坏式改名完成。
- [ ] 保留读取旧历史、资料来源和群权限边界所必需的标识与兼容读取，不为删除旧类型而删除数据。
- [ ] 完成相关端到端检查、类型检查及仓库要求的验证；同步本次行为涉及的运行说明和图解，验证记录区分模拟结果与真实环境结果。

## Comments

### 2026-10-04：issue 20 留下的具体清理面

issue 20（核心群聊退役）实施时按“旧类型、工具类别和角色行的收缩留给 23”保留了以下项，执行本单时逐批核对：

- `AgentRoleId` 中的 `chat`、tasks/agent_roles/inbound_events 的 CHECK 约束、`qq_group` 会话类别（schema 收缩）；
- chat 工具类别（tool-availability）、`session-factory.ts` 的 chat 群聊提示、Driver 与上下文装配的 `qq_group` 分支及 `qqRecalledFilter` 参数、`qq/adapter.ts` 的 `filterRecalledQqMessages`（已无注入方）；
- `QqStartGateResult` 只剩 gatePrivate 一个用户；`QqStore` 的群写方法（`registerInbox`/`linkInboxTask`/`bindInboxSession`/`createPendingOutbox`/`insertGroupSession`/`listUnlinkedInbox` 等，生产无调用方，播种测试在用）与 `qq_config` 的 `max_reply_chars`/`queue_ttl_ms` 字段（退役后无消费者）；
- 旧安装的 `agent_roles` chat 行与 `qq-*` 项目/会话行（读取兼容是否仍需，按 21/22 迁移结论定）。

### 2026-10-05：实施计划

基于 HEAD `1aba2f1`（核心库 v30、控制协议 v15）。

#### 现状核实

- 旧写调用方：`coding_delegate`（draft 走 `Orchestrator.delegateCoding`，analyze 已转通用 SubAgent）是固定 coding 唯一的新任务来源；`Orchestrator.delegate` 只服务它与 analyze 自动重试。GitHub 评审自 19 起直接登记 SubAgent，只剩「升级前在途旧 coding 子任务」接管分支。main 的修改委派 17 已开放，普通分析与修改都有通用路径。
- chat：20 已停止引导、拒绝提交；遗留 chat 工具类别/提示、Driver 与上下文装配的 qq_group 分支、`filterRecalledQqMessages`、只剩一个用户的 `QqStartGateResult`、仅播种测试在用的 QqStore 群写方法、无消费者的 `queue_ttl_ms`。**更正 20 的登记**：`max_reply_chars` 仍是私聊回复上限（runtime 回复截断），不删。
- 存储：tasks/agent_roles/inbound_events 的 CHECK、`qq_group` 会话类别与 `AgentRoleId` 中的 coding/chat 都对应旧行实值；收缩 CHECK 就得改写或删除历史，与「不为删除旧类型而删除数据」冲突，**schema 不动**。`AccessScope` 的群项目判定与受限身份是群权限边界，保留。

#### 方案

1. **coding 退役**：只引导 main（旧 coding 行保留为归档标识）；删除 `coding_delegate`、`delegateCoding`/`delegate`/自动重试与委派正文协议；保留 `coding_result` 只读读取旧子任务（结构化旧结果照常展示）。提交入口把 coding 角色会话与 chat/qq_group 并列为只读归档；启动收尾（并入 20 的退役收尾）把排队的 coding 任务定 canceled，运行中的照旧由恢复定 interrupted，结果与唤醒由编排器巡检补记一次，不重放。GitHub 评审删除旧 coding 分支；工具类别删 coding/chat 两类；main 提示删掉 coding_delegate。账本保留 `coding_delegate` 族核实（升级窗口内在途操作的恢复核实要读旧参数），注明只读兼容。
2. **群聊残留**：按 20 登记清单删除；QqStore 群写方法挪进测试 helper（只是播种旧归档）。
3. **用户入口**：ruukoto-code 的 TUI `/new-project`、CLI `create-project`/`create-session` 与在旧项目（无根目录）新建会话改为提示工作区入口；控制面 op 保留（旧数据兼容与测试播种）。
4. 文档：runtime.md、CONTEXT.md、ADR 0017 实施记录、图解页按 visual-docs skill 同步。

#### 不做（待拥有者决定）

- **ruukoto 产品中普通开发会话的写入口**（21 留言）：`npm run dev` 开发实例跑的就是 ruukoto 产品并以普通开发会话开发本项目，另有约 37 个测试文件以默认 ruukoto 产品建 dev 会话。后台按产品拒绝会直接打断开发实例；改开发实例为 ruukoto-code 会因数据目录产品归属而拒绝启动现有档案。需要拥有者选择：(a) 开发实例改用 ruukoto-code 并迁移档案；(b) 保留 ruukoto 的开发会话。本单不改。
- ruukoto-code 也引导 main 角色（隐藏、无 IM/调度）：属于 main 的产品归属问题，不是 coding/chat 退役，不在本单。
- 06 留下的配置写入「省略版本兼容」：不属于角色退役，保持。

### 2026-10-05：实施记录（核心库 v30 不变，控制协议 v15 不变）

**改动**

- **coding 退役**：编排器只引导 main（`ROLE_DEFINITIONS`），入站登记只接受目标 main；删除 `coding_delegate`、`Orchestrator.delegate/delegateCoding`、委派正文头与结构化结果协议、analyze 自动重试门、`Store.countDelegations`；`DELEGATION_LIMITS` 收为编排器内部的 `REVIEW_DEADLINE_MS`。`coding_result` 保留为只读窄口（旧 coding 子任务 + 本会话 SubAgent 执行任务），收尾补记的旧子任务按「退役收尾补记」展示结局与原因。账本保留 `coding_delegate` 规则只供升级窗口内在途操作的恢复核实。
- **退役归档会话统一**：`retiredSessionReason`（qq_group、chat/coding 角色会话）供提交入口与队列兜底共用；启动收尾 `retireGroupChat` → `retireLegacyRoles`，同一事务内另把 coding 角色会话的排队任务定 canceled（`coding_role_retired:…`）；运行中的由恢复定 interrupted；编排器巡检各补记一次结果（`result_ref` 带 `outcome`）并唤醒 main 一次，不重放。
- **GitHub**：删除旧 coding 评审接管分支与 events.ts 的 coding 分支；main 评审唤醒放行 `subagent_result` 与只读 `coding_result`（查阅升级时在途的旧评审）。在途旧评审只补记结果，不保存 review-draft、不发通知；崩溃窗口里已建旧子任务、事件仍 registered 的情形重启后建新 SubAgent 评审（旧子任务已取消；新评审只读，不属于重放结果未知的操作）。
- **群聊残留**：删除 chat/coding 工具类别（`sessionToolClass` 对归档会话返回 null，Driver 拒绝运行）、chat/coding 系统提示、Driver/上下文装配的 qq_group 分支与 `qqRecalledFilter`、`filterRecalledQqMessages`、`QqStartGateResult`、`recalledTagsForSession`/`qqMessageTag`、QqStore 群写方法（挪入 `test/helpers/legacy-group-archive.ts` 作播种）、`QqConfig.queueTtlMs`（列保留）。`AccessScope` 的 qq_group/role_restricted 身份与群项目判定作为群权限边界保留（已无会话以它们运行）。
- **用户入口**：ruukoto-code 的 TUI `/new-project`、在无根目录旧项目里 `/new`/`/new-session`、CLI `create-project`/`create-session` 只提示工作区入口（`LEGACY_PROJECT_WRITE_HINT`）；控制面 op 不变。

**保留不收缩（读取兼容）**：tasks/agent_roles/inbound_events 的 CHECK、`AgentRoleId` 的 coding/chat、`qq_group` 会话类别、旧角色行与 `agent-coding` 项目、coding 项目上的旧 MCP 配置（不再有任务在该项目运行，拥有者可 `mcp remove`）、`listRoleTasksPendingWake` 的 `:retry` 过滤（旧数据中被重试接替的首次任务不补唤醒）。

**评审（/code-review 两轴）处置**：Spec 轴——旧评审唤醒读不到 `coding_result`（已放行）、收尾补记结果丢结构化字段（已写 outcome 并改展示，补测试）、崩溃窗口重建评审（判定不改，见上）、CLI `create-session` 在 ruukoto-code 整条拒绝（有意：工作区会话经 `ruukoto-code <目录>`）。Standards 轴——残留空行、过时注释、test/65 假数据 `queueTtlMs`、名不副实的 `DELEGATION_LIMITS`、CLI/TUI 提示重复已修；判断项保留：`ROLE_DEFINITIONS` 单元素数组、`retiredSessionReason` 返回原因字符串、`sessionToolClass` 与 `retiredSessionReason` 两处退役判定（前者无 store 依赖，合并需引入依赖）、`allowTaskTool` 的 mcpEffect 参数（test/44 仍用）、AccessScope 中无生产者的两种受限身份（群边界保留）。

**验证（模拟与真实分列）**

- 离线（真实 Runtime/SQLite/文件，模型打桩）：新增 test/87（升级收尾三态各一次结果与唤醒、不重放、角色会话拒绝、重启幂等；`coding_result` 读旧结构化结果、收尾补记与产物分页）；test/27/28/40/44/45/46/49/56/57/58/59/62/65/74/76/77/80/84/85×2/86 随行为调整（删除已不存在功能的用例：coding 委派/重试/IM 子任务链审批/升级接管/coding analyze 转接）。`npm run typecheck` 通过；全量 `npm test` 889 项 886 通过、1 跳过、2 失败——test/08 DNS 60s 超时（stash 改动后 HEAD 同样失败，既有环境问题）、test/86 协作消息负载型偶发（单独连跑 3 次 8/8）。test/67 4/4。
- 产品级冒烟 `.scratch/agent-direction/smoke-23-retire-coding-role.mts`（**真实**：旧代码 1aba2f1 与当前代码两份 bin/ruukoto.mjs 后台进程、SIGKILL + 正常停止 + 再启动、控制面 socket/令牌、SQLite、ruukoto-code CLI 进程；**模拟**：MockModelServer）：macOS（darwin arm64）5/5、tx（Linux x64）5/5。tx 首轮因脚本在 main 父任务未收尾时杀进程（重启后 main 队列按占用未核实暂停，属预期安全行为）超时，加等待后通过；远端临时目录已清理。未涉及真实 QQ/Telegram/GitHub。
- 文档：runtime.md（新「固定 coding 角色退役」节替换原 main 委派 coding 节，及工具可用性、系统提示、技能、工作清单、计划模式、GitHub、QQ 群聊、恢复、ruukoto-code 差别各处）、CONTEXT.md、ADR 0013/0017/0020；docs/visual 十页（orchestrator 改动最大：`#delegate` 换为 `#legacy-coding`、删重试门与对照表；outbox 启动顺序原写反已按代码更正；context-pipeline 重复行删除），test/67 通过，改动图经 shoot.sh 渲染核对。

**待拥有者决定（验收第 2 条的剩余部分）**：ruukoto 产品中普通开发会话/旧项目的写入口未移除——开发实例 `npm run dev` 跑的就是 ruukoto 产品并靠普通开发会话开发本项目。选项：(a) 开发实例改用 ruukoto-code（需迁移现有开发档案：数据目录产品归属会拒绝直接切换），随后 ruukoto 后台拒绝 dev 会话的创建与提交；(b) 保留现状。本单保持 `ready-for-agent`，待决定后补做或关闭。

### 2026-10-05：拥有者决定（验收第 2 条剩余部分）

选 (b)：ruukoto 产品**不拒绝**普通开发会话的创建与提交，开发实例 `npm run dev` 继续以 ruukoto 产品、普通开发会话开发本项目；旧项目写入口按 ruukoto-code 已有的提示处理，不再扩展到 ruukoto。本单无剩余实施项，关闭。（决定于架构工单 08 访谈中作出：会话身份模块因此不需要产品维度。）
