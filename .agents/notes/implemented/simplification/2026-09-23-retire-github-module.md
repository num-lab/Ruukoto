# Agent Note: 退役专用 GitHub 模块，GitHub 作为普通 MCP 工具

Status: implemented

原编号：ADR 0007

## 问题

personal-agent issue 06 交付了一个专用 GitHub 模块：经 REST 采集 PR 与 CI 资料，维护草稿与发布状态机，自带仓库绑定、`github_*` 控制接口和 CLI/TUI 入口。通用 MCP 客户端（见[MCP 客户端](../architecture/2026-09-23-mcp-client.md)）接入后，GitHub 也能作为一个普通 MCP 服务使用。两者并存时，同一项 GitHub 能力有 REST 与 MCP 两套实现，运行时要按 GitHub 服务名保留专属业务分支，授权、审批与结果展示也各走一套。拥有者要求 GitHub 与其他 MCP 服务一样，只是普通工具。

退役专用模块会留下历史数据与在途状态：三张旧表里的仓库绑定、草稿和发布操作，旧的 `github_publish` 审批，带使用范围限制的旧凭据，以及历史事件。升级时直接删掉它们，历史就不可读；把未决的发布操作或旧批准沿用到新路径，可能把已经发出、结果不明的评论再发一次，或者在拥有者不知情时扩大授权。

## 决定

- **GitHub 经通用 MCP 客户端接入，不保留专用模块。** personal-agent issue 06 交付的专用 GitHub 模块（REST 采集、草稿与发布状态机、专用控制接口与 CLI/TUI 入口）由 personal-agent issue 17 退役：`src/agent/github/`（client、collect、store、tools、publish）及其在 Runtime、Driver、控制协议、CLI、TUI 中的专用接线已删除。GitHub 经通用 MCP 客户端接入（[MCP 客户端](../architecture/2026-09-23-mcp-client.md)），与其他 MCP 服务共用同一套配置、发现、调用、审批、结果保存与展示流程。运行时不保留 GitHub 专属业务分支，也不存在 REST 与 MCP 两套实现并行承担同一功能；GitHub 专属内容只出现在服务配置示例与使用文档（[docs/runtime.md](../../../../docs/runtime.md)「MCP 服务」节）中。
- **退役以只读接入为前提，不等待写入能力。** 首版 GitHub MCP 只读：写工具不注册、不执行。通用 MCP 写工具（具体操作范围、审批桥单次消费与未知结果恢复）由 personal-agent issue 18 单独验收，见[MCP 写工具统一审批](../feature/2026-09-23-mcp-write-tools-approval.md)；写入能力不恢复旧模块的草稿或发布意图入口。
- **旧模块的专用工作流保证不逐项复刻。** 固定 PR/CI 修订复核、草稿状态机、发布意图只能由拥有者建立，这些保证随模块一起退役。需要这些步骤时，由 Agent 在普通任务中组合工具完成；不能宣称普通 MCP 调用自动提供同等保证。MCP 覆盖不了的缺口如实记录，不以 REST 回退隐藏。
- **历史资料只读保留，不删除。** 旧库的三张表 `github_repo_bindings`、`github_drafts`、`github_publish_ops` 不 DROP，原样保留为只读归档；全新数据库不再创建这三张表。升级后首次启动执行一次性、可重复执行的退役迁移（步骤见下文「退役迁移」）：
  - 旧 `github_publish` 审批中 `pending` 与 `approved` 未消费的一律失效；
  - 未决发布操作按证据定终态：批准已消费或无审批记录 → `effect_unknown`，绝不重发；审批未消费 → `canceled`；
  - 草稿各版本正文、证据引用与发布记录导出为原任务产物；
  - 仓库绑定仅导出无秘密配置；
  - 导出清单落盘为 `github-archive-manifest.json`。
- **旧授权不延续到新路径。** 旧凭据的 host、scope 与秘密值不被迁移改变；`CredentialStore.getForUse()` 对遗留 scope（操作类别 `github_read`、`github_publish`）继续拒绝不匹配的用途，同名轮换保留 scope。旧仓库绑定不自动转为 MCP 授权；旧批准不得转换为新授权，也不转换为 MCP 调用。新的访问范围以通用服务配置、工具允许列表和远端凭据权限为准。
- **旧入口封闭，历史只读展示。** 旧控制接口 `github_*` 移除，控制协议版本递增（退役时由 v7 升到 v8），旧客户端因版本不匹配被拒绝；新版本客户端调用已移除的接口得到 `unknown_op`。旧命令只保留静态迁移提示：CLI `ruukoto github` 不发网络请求、不映射为任何发布，只打印改用 `ruukoto mcp configure` 与归档清单位置的提示并以 1 退出，不列入帮助。TUI 不再提供 `/github`，输入按未知命令处理。历史 `github.*` 事件（`github.binding_changed`、`github.draft_saved`、`github.draft_stale`、`github.publish_requested`、`github.publish_settled`）与 `github_publish` 审批范围在类型中保留，只用于归档展示；除退役迁移为终结旧发布操作写下的 `github.publish_settled` 外，不产生新实例。
- **公共边界不变。** 通用控制面身份、访问模式与单次授权仍遵守[显式访问模式](../feature/2026-09-19-explicit-access-modes.md)与[工具工作进程与按任务容器](../architecture/2026-09-20-tool-worker-per-task-container.md)。自动审查的确定性策略不变（[自动审查模式](../feature/2026-09-22-auto-review-mode.md)）：`github_publish` 范围随模块退役不再产生，历史记录仍按转人工展示。
- **GitHub 入站事件另有边界。** 运行时允许校验、登记与编排 GitHub PR webhook 事件（`src/github/`），规则见[GitHub 事件审查](../feature/2026-09-24-github-event-review.md)；它不恢复 REST 采集、专用草稿或发布状态机，也不提供 REST 回退，GitHub 资料仍经普通 MCP 读取。

## 退役迁移

迁移由 [src/runtime/github-retirement.ts](../../../../src/runtime/github-retirement.ts) 的 `retireGitHubModule` 在 Runtime 启动时执行。

- **触发。** 库里没有 `github_%` 表（全新数据库），或 `meta` 已有 `github_retirement_done`，直接返回。schema 由 v8 升到 v9 时不改表结构，只移除三张表的建表 SQL，旧库的表原样保留；迁移按表存在性判断，不依赖建表 SQL。
- **审批失效与发布操作定终态（单事务）。** `confirmations` 中 `scope.kind = 'github_publish'`、状态为 `pending` 或 `approved` 且 `consumed_at` 为空的记录改为 `stale`。批准已消费的记录原样保留，它是「可能已发送」的证据。`github_publish_ops` 中状态为 `pending` 的操作按关联审批定终态：
  - 存在已消费的批准 → `effect_unknown`；
  - 没有任何审批记录 → `effect_unknown`。完全访问模式下的旧发布可能本来就没有审批，不能用「无审批记录」推断未发送；
  - 有审批但未消费 → `canceled`，可证明未发送。

  已在终态的操作不改写。每个被终结的操作在 `error_message` 写下原状态与核对依据，并在原草稿的任务与会话上落一条 `github.publish_settled` 事件。审批记录没有 reason 列，退役原因记录在发布操作的 `error_message`、逐操作事件与清单的 `retiredConfirmations` 计数里。迁移只改终态，不发送任何请求，也不把任何旧操作转换为 MCP 调用。
- **草稿归档导出。** 每个草稿版本导出为原任务与会话下的产物 `github-draft-archive-<草稿 id>-v<版本>`，内容包括来源 ID 与版本、仓库绑定、正文及其 sha256、分析修订、证据产物引用和本版本的发布记录。导出复用 `ArtifactStore` 与原有权限归属，可经 `read_artifact` 读取；原历史消息、事件、工具结果与产物 ID 保持可读。已有完整产物的版本跳过；上次中断留下的 partial 产物不改写，重跑另建完整导出。单个版本导出失败记入清单的 `errors`。
- **导出清单。** 写入 `<dataDir>/github-archive-manifest.json`，字段为 `retiredAt`、`reason`、`drafts`、`bindings`、`publishOps`、`retiredConfirmations`、`errors`。`bindings` 只含无秘密配置，凭据只以绑定名出现。清单从最终库状态生成，重跑内容一致。
- **完成标记。** 只有全部导出成功才写 `meta.github_retirement_done`；有失败时不标记完成，下次启动继续，已完成的版本不重复产物。原表在任何情况下都不删除。
- **不触碰凭据。** 迁移不读写 `CredentialStore`，旧凭据的 host、scope 与秘密值原样保留。

## 备选方案

- **长期保留 REST 采集与发布，MCP 只补读取** — 旧 REST 模块已经交付并经过测试，承担 PR/CI 采集与经审批的评论发布，MCP 首版只读，保留 REST 就不会出现写入空档。不选，是因为拥有者明确要求 GitHub 作为普通工具；保留 REST 意味着同一能力两套实现并行，运行时保留 GitHub 专属分支，也违背「不长期双实现」。（见 [personal-agent issue 16](../../../../.scratch/personal-agent/issues/16-mcp-github.md) Comments「补充实施计划」与正文开头的方向更新；[personal-agent issue 17](../../../../.scratch/personal-agent/issues/17-replace-github-module-with-mcp.md)「已确认的方向」）
- **在 MCP 之上保留 GitHub 专用适配层** — 复用 `GitHubStore`、增加 GitHub 参数适配层与 `github_mcp_read` 专用操作类别，可以沿用旧模块的仓库绑定与单仓库校验。不选，是因为这等于把旧模块改名后作为 MCP 包装层继续保留，运行时仍按 GitHub 服务名分支；若与退役一起实施，还会先写出随后又删除的适配层。仓库范围改由远端凭据权限约束。（见 personal-agent issue 17 实施计划第 1 步、第 3 步）
- **先完成通用 MCP 写入与审批保障，再退役旧发布流程** — 这样 GitHub 写入能力不中断，旧发布路径在新写入路径就绪后才下线。不选，是因为拥有者确认只读替换即可退役旧模块，接受写功能暂缺；通用写工具单列为 personal-agent issue 18，不作为删除旧模块的前置条件。（见 personal-agent issue 17 Comments「补充实施计划」与「访谈确认」；[personal-agent spec](../../../../.scratch/personal-agent/spec.md)「2026-09-22 访谈确认后的实施边界」）
- **MCP 覆盖不了的能力回退到 REST** — 旧模块的部分能力未必都有对应的 MCP 工具，回退可以补齐。不选，是因为回退会把差异藏起来，并重新引入 REST 与 MCP 两套实现；缺口如实记录，不偷偷回退。（见 personal-agent issue 17「已确认决策」）
- **退役时删除旧表与历史** — 删表后 schema 不再带遗留表，也不需要只读兼容代码。不选，是因为历史草稿、发布记录与结果不明的操作需要保持可查，旧表还是判断「可能已发送」的证据；拥有者确认原表与历史只读归档、不默认删除，草稿原文各版本可导出。（见 personal-agent issue 17「已确认决策」与实施计划第 4 步）
- **把旧未决发布操作一律标为已取消** — 最简单，且同样保证不会重发。不选，是因为批准已消费或走完全访问路径的操作可能已经发出，一律记为「已取消、未执行」会歪曲事实；只有能证明未发送的才标为取消，其余保留 `effect_unknown`。（见 personal-agent issue 17「已确认决策」与实施计划第 4 步）
- **把旧仓库绑定与旧批准转换为 MCP 授权** — 拥有者升级后不必重新配置或重新批准。不选，是因为旧批准绑定的是旧发布操作与草稿，旧绑定限定的单仓库令牌也不能被静默换成宽权限令牌；转换会在拥有者不知情时改变授权。新的 MCP 配置采用新的明确授权。（见 personal-agent issue 17「已确认决策」与实施计划第 3 步）

## 后果

- **收益**：GitHub 与其他 MCP 服务只有一条工具路径，配置、发现、调用、审批与展示的规则对所有服务一致，删除了约 2100 行专用实现。升级后旧待发布操作不会自动发送，结果不明的操作保留 `effect_unknown`；历史草稿与发布记录以普通产物形式可读；旧凭据的用途没有被隐式扩大。
- **代价：保证变弱。** 固定 PR/CI 修订复核、草稿状态机和「发布意图只能由拥有者建立」不再由运行时强制。需要这些保证的工作要由 Agent 在任务里自行组合工具核对，普通 MCP 调用本身不提供它们。
- **代价：仓库隔离变粗。** 旧仓库绑定按 repository ID 做的单仓库校验不再存在；GitHub MCP 可访问的仓库由远端凭据权限决定，通用客户端没有参数级仓库限制。
- **代价：写入空档与重新配置。** 退役后 GitHub 写操作只能经通用 MCP 写工具与统一审批完成；拥有者要为 GitHub MCP 另建凭据与工具允许列表，旧绑定和旧批准都不能沿用。
- **已知上限**：旧库的三张表永久保留，类型、TUI 与自动审查里保留 `github.*` 事件和 `github_publish` 范围的只读兼容分支；全新数据库的 schema 与升级库不完全一致。退役迁移只在后台启动时运行；有导出失败时不写完成标记，之后每次启动都重试，直到全部成功。

## 验证

- `test/17-github-retirement.test.ts` 用冻结在测试里的 v8 旧库样本（多版本草稿、`pending`/`approved`/已消费审批、各类发布结果、历史事件、带 scope 的旧凭据）走真实 Runtime 启动，覆盖：全新数据库不建旧表；升级后审批失效、发布操作按证据定终态、旧表保留；草稿各版本导出为可经 `read_artifact` 读取的原任务产物，清单无秘密，重跑不重复；旧控制接口返回 `unknown_op`，旧凭据不被改变，历史事件可重放；上次导出中断留下 partial 产物时重跑补齐且不改写中断记录。
- `test/08-approvals.test.ts`「带 scope 的凭据不得被通用 http_request 借用；同名轮换保留 scope」承接旧模块测试里仍适用的凭据边界。
- `test/13-tui-state.test.ts` 断言 `github.*` 历史事件按归档记录展示，且不再提示 `/github`。
- `test/24-mcp.test.ts` 经进程内模拟 Streamable HTTP 服务覆盖通用 MCP 路径，不依赖旧 GitHub 模块。真实 GitHub MCP 只读连通需要拥有者配置独立只读凭据，配置与核实步骤见 [docs/runtime.md](../../../../docs/runtime.md)「MCP 服务」节。
