Status: resolved

# 16 — SubAgent 在独立 worktree 中并行修改

**What to build:** 同一工作区中的编码子任务分别在独立 Git worktree 修改，主工作区得到保护，非 Git 写任务串行。

**Blocked by:** [05 — 按工作区创建和切换开发会话](05-workspace-sessions.md)；[11 — 主 Agent 委派通用 SubAgent 并收到结果](11-subagent-delegation.md)

依据：[已确认规格](../spec.md) 与 [ADR 0017](../../../.agents/notes/implemented/architecture/2026-10-02-two-agent-products.md)。

## 验收标准

- [x] 两个子任务能在同一所属工作区的独立 worktree 并行产生改动，拥有者可定位各自改动和工作归属。
- [x] 主工作区和其他 Agent 的副本不被直接覆盖；共享 Git 元数据及其他授权路径的写入也需遵守边界。
- [x] 非 Git 目录对同一份工作文件保持单一写入者，不以不同当前目录假定没有写冲突。
- [x] 主任务等待子任务时不会持有阻止子任务执行的同一独占锁。
- [x] 创建失败、单个执行任务取消或执行退出时保留已有改动和可核查状态，不自动删除未汇总成果。
- [x] 完成相关端到端检查、类型检查及仓库要求的验证；同步本次行为涉及的运行说明和图解，验证记录区分模拟结果与真实环境结果。

## Comments

### 2026-10-03：实施计划

基于 HEAD `e542261` 制定（核心库 v24、控制协议 v11）。12 的计划尚未实施，落地后会带来 v25 与协议 v12，本单的版本号在实施时核实（预计 v25→v26）。

现状核实：

- **目录占用只比对同一目录。** `store.ts:2085` 的 `tryAcquireOccupancy` 按 dev/ino 或 cwd_real 相等判定冲突；`/ws` 与 `/ws/sub` 互不阻塞。占用键固定是会话 cwd：取得在 `runtime.ts:2597`，释放在 `runtime.ts:2635` 和 `driver.ts:1097`（都用 `session.cwdReal`），`resumeQueue` 在 `runtime.ts:2847` 按行释放。
- **执行边界只认会话 cwd。** `tool-router.ts:216` 把 `session.cwdReal` 作为 LaunchSpec 的 workspace；容器在 `launchers.ts:184` 以读写方式挂载它，授予路径按 access 挂载，`readRoots` 以只读挂载（`launchers.ts:193`）。confirm 模式下 edit/write/bash 在容器内执行、不逐次审批（`tool-router.ts:280`），越界读写和 HTTP 才走审批。
- **worktree 只有检测，没有创建。** `core/worktree.ts` 能识别 worktree 的 `.git` 文件并找到共享 Git 目录；`runtime.ts:1925` 只在授予路径覆盖共享目录时加注说明。宿主任何地方都不执行 git，镜像内有 git（`deploy/worker-image/Dockerfile`）。
- **SubAgent 只读。** `subagents.ts` 为每个 Agent 建宿主目录 `agent-work/sub-agents/<agentId>`，会话 cwd 就是它；`tool-availability.ts:37` 的白名单只有 read/read_artifact，任务固定 confirm，`runtime.ts:2129` 禁止切换模式。
- **子任务不会被父任务的锁卡住。** 委派不阻塞，子任务 cwd 是独立宿主目录，与父会话占用不同键（11 已验证）。
- **相邻目录互不嵌套。** 角色会话 `agent-work/<role>`、群会话 `qq-work/<x>` 与子身份目录是兄弟目录；保护根是 dataDir、agentDir、controlDir 与 CODE_ROOT（`runtime.ts:453`）。

实际缺口：

1. 没有可写 SubAgent：没有修改模式、写工具白名单和对应提示。
2. 宿主不能创建 worktree，也没有保存“工作 → 副本”的关系，拥有者无法定位各自改动。
3. 执行目录与占用键都固定为会话 cwd，无法按任务指向 worktree 或非 Git 写入根。
4. 占用不识别祖先或子孙目录，不同 cwd 会被当作没有写冲突。
5. 容器里的 git 在 worktree 中不可用：共享 Git 目录不在挂载范围，`.git` 指向的路径不存在；macOS 上容器 uid 与文件属主不一致，还可能触发 git 的 dubious ownership 检查（需冒烟核实）。
6. 宿主管理的副本可能被其他任务经授予路径写入覆盖。

#### 默认取舍（推荐即规格，有异议再改）

- **写 SubAgent 固定 confirm、在容器中运行，不继承父任务的 full_access。** 沿用 ADR 0003“其他任务不继承临时授权”和 11 的固定 confirm。工具只有 read、edit、write、bash、read_artifact：不给 request_file_access、http_request、MCP，没有网络，不能委派下级。工作目录内的修改由容器边界约束，不逐次审批。拥有者需要更大权限时自己在主会话操作。
- **只有普通开发会话能发起修改委派。** main 没有开发工作区，传修改模式直接拒绝，main 的修改委派由 17 迁移。计划模式下不能发起修改委派。
- **一项工作一个写入目标，首次委派时确定，继续委派沿用。** 已经存在的只读工作不能改成写入；复用到新工作（12）时另建副本。
- **Git 目标：每项工作一个宿主生成的 worktree。**
  - 位置：`<dataDir>/../agent-work/worktrees/<workId>`，在保护根和父工作区之外。
  - 分支：`ruukoto/work-<workId>`。
  - 基线：委派时仓库 HEAD 指向的提交；父工作区未提交的改动不进副本，工具结果会明说这一点。
  - 仓库根：从目标路径向上找 `.git`，纯文件系统查找，不运行 git，范围不超过父工作区。
  - 共享 Git 目录必须位于父工作区内或父任务的只读授予范围内，否则拒绝。
  - 容器只读挂载共享 Git 目录（作为 readRoot），子任务能 status、diff、log，但不能 add、commit，也不能写 refs、hooks、config。改动留在工作树，由 17 汇总。理由：共享目录可写时，子任务能改 hooks 或 `core.fsmonitor`，之后会在拥有者自己的 git 中执行，等于逃出边界。
- **worktree 在受限容器内创建，宿主不运行 git。**
  - 做法：复用 `ToolWorkerHost.start(launcherFor("confirm"))`。workspace 用父会话 cwd，这与父任务自身 confirm 任务的权限相同；授予目标副本目录读写，执行一条宿主固定的 bash 命令：`git rev-parse --verify HEAD` 加 `git -c core.hooksPath=/dev/null worktree add -q -b <branch> <path> <base>`。
  - 理由：仓库里的 `.git/config` 可以被父任务的 confirm 容器写入，宿主以后台账户运行 git 会执行其中植入的 fsmonitor 或 filter，并以后台账户身份逃出边界。
  - 这一步不取父会话占用：父任务正是在持有占用时调用委派，取占用会自锁；并发由 git 自身的锁处理。
  - 局限：容器内没有全局配置，LFS 文件会以指针形式检出。
- **非 Git 目标：直接写入并串行。** 写入根为父工作区内的目标目录（不建副本）。子任务的执行目录和占用都是这个目录。
- **占用改为识别祖先与子孙目录，对所有任务生效。** 判定为 dev/ino 相等、或 realpath 相等、或互为前缀（按分隔符边界）。ADR 0017 明确要求按此调整现有占用机制。效果：
  - 非 Git 子任务与父会话串行：父任务本轮结束才释放占用；父任务没有阻塞等待子任务的接口，不会持锁空等。
  - 已有的嵌套 cwd 会话从此也串行，这是行为变化，会写进运行文档。
  - 局限：挂载别名的祖先关系识别不出，用 `ponytail:` 注释标明上限。
- **占用键改为任务的有效写入根。** worktree 任务占用 worktree，非 Git 任务占用目标目录，其他任务照旧占用会话 cwd。一个任务只持有一行占用，释放统一改为 `releaseOccupancy(taskId)`。
- **改动一律保留。**
  - 创建失败：不删除宿主已建的目录和 git 记录；错误信息写明路径与分支，随工具结果写入历史，`git worktree list` 也能查到。与 11 的规则一致：准备失败不落库。
  - 单次任务取消、退出或中断：worktree 与写入目标都保留。退出未核实时占用保留，Agent 记为待核实（11 已有逻辑，改为按新占用键生效）。
  - 本单不提供任何删除副本的入口；12 的关闭和 14 的取消也不删除。
  - `ponytail:` 失败残留不自动清理或认领；需要时再改为按键确定路径并认领。
- **副本不能经授予路径被写。** `validateGrantedPaths` 拒绝覆盖 `agent-work/worktrees` 或位于其下的读写授予；只读授予仍允许。
- **ADR：新开一份短 ADR**（编号实施时核实），记录上述 worktree、单一写入者与容器内创建 git 的决定，衔接 ADR 0017 与 0020。ADR 0020 第 5 条“首版只读”由它扩展，不与 ADR 冲突。

#### 实施步骤

1. **存储与占用**（`src/core/db.ts`、`src/core/types.ts`、`src/core/store.ts`）。
   - `work_delegations` 经 `ensureColumns` 增加 `write_target TEXT`，可为空，表示只读工作。内容为 JSON：
     - worktree：`{kind:"worktree", repoRoot, commonGitDir, gitdir, path, dev, ino, branch, baseCommit}`；
     - 非 Git：`{kind:"direct", path, dev, ino}`。
   - `WorkDelegation` 增加 `writeTarget`；迁移注释按惯例追加。
   - `tryAcquireOccupancy` 增加前缀判定；`releaseOccupancy` 改为只按 taskId，调用方共 3 处一并改：`runtime.ts:2635`、`runtime.ts:2847`、`driver.ts:1097`。
   - 新增一个纯函数 `taskWorkspace(task, session, work)`（放在 `src/core/worktree.ts`）：有 writeTarget 时返回它的 path、dev、ino，否则返回会话目录身份。
2. **队列与执行目录**（`src/runtime/runtime.ts`、`src/agent/tool-router.ts`）。
   - 队列启动前对 `taskWorkspace` 复核目录身份；被替换或消失时任务失败，不自动重建。
   - 占用改按 `taskWorkspace` 取得。
   - `ensureWorker` 的 workspace 改为 `taskWorkspace`；worktree 任务把共享 Git 目录加入 readRoots。
   - 容器环境变量补 `GIT_CONFIG_COUNT/KEY_0/VALUE_0=safe.directory=*`，只在需要时加；能否生效以冒烟为准，不生效就改由 worker 在 `/tmp` 写全局配置并设置 `GIT_CONFIG_GLOBAL`。
3. **委派**（`src/runtime/subagents.ts`、`src/agent/subagent-tools.ts`）。
   - **工具参数**：`subagent_delegate` 增加 `mode: "analyze" | "modify"`（默认 analyze）与 `target`（modify 必填，父工作区内的路径）。
     - 只在 modify 时把这两个字段纳入参数摘要，11 的重放摘要不变；
     - 继续委派（`work_id`）不接受 `mode`，沿用工作原有模式。
   - **准备阶段**（事务外）：解析目标，判定 worktree 还是非 Git；核对保护根、父工作区范围与共享 Git 目录位置；预检执行身份能写入（复用 `executionCanRead` 的权限位思路，检查写位）。worktree 模式按上面的取舍在容器内创建副本，记录基线提交、gitdir 与 dev/ino。
   - **事务内**：重核后与工作一起写入 `write_target`。
   - **继续委派**：核对 worktree 的 dev/ino 和 `.git` 文件仍指向记录的 gitdir，不一致就明确失败。与 12 的可用性检查（空闲、未关闭）并列。
   - **任务输入**：宿主首行写明“修改模式 · 工作目录 <path> · 分支 <branch>（基线 <commit>）· 不要 git add/commit，改动留在工作树由主 Agent 汇总”；非 Git 模式写明“直接写入，与主会话串行”。
4. **工具与提示**（`src/agent/tool-availability.ts`、`src/agent/driver.ts`、`src/agent/session-factory.ts`）。
   - 新增 `SUBAGENT_WRITE_TOOL_NAMES`。子会话每个任务都会重建 Driver（11 已有），所以装配、发送前和调用门都按当前任务所属工作是否有写入目标选择白名单，三处结论相同。
   - subagent 系统提示不再写死只读，具体能力以任务首行为准。dev 提示补一句修改委派的用法。
5. **查看**：`subagent_result` 遇到排队中的非 Git 任务、且占用由本会话持有时，提示“等待本会话释放目录，请结束本轮”。`work list/show` 与快照自然带上 `writeTarget`；`state.ts` 的 `worksSummaryForSession` 补“分支 X”或“直接写入”。只加可选字段，不新增事件或操作，协议版本不变；实施中若需要新增事件，按惯例升级。
6. **授予路径**：`runtime.ts` 的 `validateGrantedPaths` 拒绝覆盖副本根的读写授予。

不做：改动汇总、提交、合并与冲突处理（17；17 也需在容器内执行 git，并核对 `.git` 指向与 in-tree hooks）；同级通信（13）；整项取消（14）；中断后恢复（15）；main 的修改委派（17）；删除或清理副本；读写分离的占用；自定义基线或包含未提交改动。

与 12、14 的交界：12 的继续和复用沿用本单的写入目标规则——继续沿用同一副本，复用建新副本，因此旧工作的改动不会进入新工作。12 的关闭、14 的取消都只停止任务，不触碰副本和写入目标。

#### 验证与验收

新增 `test/<NN>-subagent-worktrees.test.ts`（编号实施时核实，不与 12 的 test/81 冲突）。测试用 `git init` 建临时仓库，复用 test/80 的 testkit、模型桩与 `realTools()`，按六项验收覆盖：

- **并行与定位**：两项 modify 工作指向同一仓库，模型桩各自 edit 不同文件并让子任务挂起，确认两个子任务同时为 running。各自 worktree 的改动只出现在自己目录；分支、基线、路径和工作的对应关系可经 `work show` 和 TUI 摘要查看。
- **保护主工作区与其他副本**：
  - 主工作区文件与未提交改动的字节不变；
  - LaunchSpec 只以读写挂载自己的 worktree，共享 Git 目录在 readRoots，grantedPaths 为空；
  - 子任务执行 `git commit` 或写 `.git/hooks`、`.git/config` 失败（容器部分在冒烟验证，离线断言挂载方式）；
  - 在父仓库 `.git/config` 植入 `core.fsmonitor` 与 hook 后委派，宿主进程不执行它们（离线检查标记文件不存在）；
  - 覆盖副本根的读写授予被拒；
  - 共享 Git 目录不在父工作区内时拒绝委派。
- **非 Git 单一写入者**：
  - 父会话占用 `/ws` 时，写 `/ws/sub` 的子任务保持 queued；父任务本轮结束后子任务启动；子任务运行期间拥有者的新消息排队；
  - 占用单元测试覆盖相等、祖先、子孙、兄弟目录与 dev/ino 别名，以及释放后唤醒；
  - 已有嵌套 cwd 用例的变化在回归中逐一核实。
- **不持同一独占锁**：worktree 模式下父任务持锁期间子任务立即运行；非 Git 模式下父任务在同一轮内调用 `subagent_result` 时如实返回“排队等待本会话释放目录”，不挂起。
- **失败、取消与退出保留**：
  - 创建失败（目标分支已存在、目录不可写）时工作未登记，错误包含路径与分支，残留目录不被删除；
  - 单次任务取消后已写的文件仍在 worktree 中，写入目标不变；
  - 退出未核实时占用按 worktree 键保留、Agent 为待核实；
  - worktree 被删除后继续委派明确失败，不会悄悄重建。
- **其他**：迁移时旧工作的 `write_target` 为空；main 传修改模式被拒；继续委派不能切换模式；修改模式不带入 11 的重放摘要。

test/80 的只读断言保留，作为 11 行为的回归。

```bash
npx tsx --test test/<NN>-subagent-worktrees.test.ts test/80-subagent-delegation.test.ts test/07-real-tools.test.ts test/27-orchestration.test.ts test/62-tool-availability.test.ts test/64-tool-op-ledger.test.ts test/66-control-seam.test.ts test/73-desktop-execution.test.ts test/74-workspace-sessions.test.ts
npx tsx --test test/13-tui-state.test.ts test/14-tui-app.test.ts test/29-cli-entry.test.ts test/58-plan-mode.test.ts test/59-system-prompt.test.ts
npm run typecheck
npx tsx --test test/67-visual-docs.test.ts
npm test   # nohup + 退出码文件，跑时不改 src/test
```

新增 `.scratch/agent-direction/smoke-16-parallel-worktrees.mts`，沿用 smoke-11 的结构与 `--remote` 方式，在真实 Runtime、SQLite 与 Docker 受限 worker 上运行，macOS 本机与 `ssh tx` 各跑一轮。检查内容：

- 容器内创建 worktree，两个子任务并行改动同一仓库；
- 容器内 `git status/diff` 可用（顺带验证 safe.directory 的做法）；
- `git commit` 和写 hooks、config 实际失败；
- 主工作区字节不变；
- 非 Git 目录与父会话串行；
- 取消后改动保留，空闲时没有残余容器；
- 宿主不执行植入的 fsmonitor 与 hook。

模型为模拟，单独记录。macOS 完全访问账户与真实平台不涉及。

文档同步：

- `CONTEXT.md` 的 SubAgent 与工作区条目更新当前实现说明。
- `docs/runtime.md` 的 SubAgent 章节补修改模式、副本位置与分支、不提交、非 Git 串行；占用相关段落补祖先与子孙判定，以及嵌套会话串行的行为变化。
- 新 ADR 一份，ADR 0017 的实施记录加一行。
- 对每个改动的 `src/` 文件执行 `grep -l <路径> docs/visual/*.html`，预计命中 orchestrator、tool-call-path、task-lifecycle、storage-layout、deployment、context-pipeline、index，同步后跑 test/67。

完成时逐条登记六项验收证据，区分离线逻辑测试、真实后台与执行边界、模拟模型和未实测项。本次只保存计划，工单状态与验收勾选保持不变。

### 2026-10-04：实施完成与验证记录

按计划落地（版本号以实施时为准）：核心库 `SCHEMA_VERSION 26→27`（`work_delegations.write_target` 可空列，ensureColumns + 迁移注释链）；控制协议 v13 不变（`work_list`/`work_get`/快照只加可选 `writeTarget`）。新测试 `test/83-subagent-worktrees.test.ts`（13 用例），新 ADR `docs/adr/0021-subagent-worktrees.md`，冒烟 `.scratch/agent-direction/smoke-16-parallel-worktrees.mts`。

**冒烟结果（真实 Runtime + SQLite + Docker 受限容器 + 真实 git，模型为确定性桩、消息平台不启用）**

| 环境 | 结果 |
| --- | --- |
| macOS 本机 Docker Desktop 29.8.0（容器 uid 1000） | 9/9（修复批次后复跑同结果） |
| Linux 远端 tx（原生 docker，uid/gid 1003，经 `--remote` 自包含全程） | 9/9（修复批次后复跑同结果） |

**逐项验收证据**

1. **两项子任务独立 worktree 并行改动，可定位**：离线 test/83 两项 modify 同时 running、改动只落各自副本、`work show`/`work_get` 与 TUI 摘要带「worktree 分支 X」；真实环境副本 A `a.txt=alpha-A`、副本 B `b.txt=beta-B` 字节级核实，分支 `ruukoto/work-<workId>`、基线为委派时 HEAD（两平台）。
2. **主工作区与其他副本不被覆盖**：离线 LaunchSpec 钉定（workspace=副本、共享 Git 目录为只读 readRoot、grantedPaths 为空、env 仅 safe.directory）、覆盖副本根的读写授予被拒（只读放行）、共享 Git 越出父工作区拒绝、植入 fsmonitor/hook 后宿主无标记；真实环境主工作区字节与未提交改动不变，容器内 `git commit`/写 hooks/写 config 真实失败（只读 readRoot），植入 fsmonitor 只在容器内被只读挡住（两平台）。
3. **非 Git 单一写入者**：占用升级为祖先/子孙前缀判定（dev/ino 相等、realpath 相等或分隔符前缀），释放统一按 taskId；离线占用单测覆盖相等/祖先/子孙/兄弟别名与释放唤醒；真实环境父持锁期间子任务保持 queued、本轮结束后自然启动并覆盖 `notes.md`（两平台）。行为变化：既有嵌套 cwd 会话从此串行，已写入 runtime.md；挂载别名祖先关系识别不出的上限以 `ponytail:` 标注。
4. **不持同一独占锁**：worktree 模式下父持锁子任务立即 running（离线）；非 Git 模式下父任务同轮 `subagent_result` 如实提示「等待本会话释放目录，请结束本轮」，不挂起。
5. **失败/取消/退出保留**：离线覆盖创建失败保留现场（错误含路径与分支、工作未登记）、单任务取消后文件仍在、退出未核实按 worktree 键保占用并记待核实、worktree 被删/被替换后继续委派明确报 `worktree_gone` 不自动重建；真实环境取消后副本字节保留、副本创建与任务容器零残余（两平台）。本单不提供删除副本入口（12 的关闭、14 的取消同样不触碰副本）。
6. **验证与文档**：`npm test` 904 项 903 过 0 失败（1 项 skipped）；`npm run typecheck` 0 错误；`test/67` 4/4；v26→v27 迁移用例（旧工作 `write_target` 为空）。CONTEXT.md、docs/runtime.md、ADR 0017 实施记录、新 ADR 0021、图解七页（orchestrator/storage-layout/task-lifecycle/tool-call-path/control-protocol/deployment/context-pipeline/index）已同步。

**模拟与未实测**：模型为模拟桩；消息平台不启用（与本单边界无关）。macOS 完全访问账户未涉及。

**实施中实测修正（对计划的补充，已写入 ADR 0021 与 runtime.md）**

- worker init 的 dev/ino 数值复核（workspaceIdentity 与 readRoots）只在 Linux 下发：macOS Docker Desktop 经 VM 重新编号 inode，容器侧与宿主恒不一致（实测），macOS 由宿主队列回路按 `taskWorkspaceFor` 复核兜底。
- 副本目录由宿主在容器启动前预建空目录：挂载源不存在时 Docker 以 root 自动创建，容器内写 `.git` 被拒（实测）。
- worktree 命令、挂载与 `write_target.path` 统一用 `copyDirReal = fs.realpathSync(copyDir)`：git 把副本路径字串写进 `worktrees/<name>/gitdir` 并据此回核，TMPDIR 的 `/var→/private/var` 符号链接会报 "not a git repository"（实测）。
- 固定命令加 `-c core.fsmonitor=false`（植入的 fsmonitor 不参与执行也不污染基线输出）；基线提交按 40 位十六进制从容器输出提取。
- `executionCanRead`/`executionCanWrite` 在 macOS 按后台账户 `accessSync` 核实（Docker Desktop VM 以宿主身份执行容器内文件访问，按容器 uid 权限位恒假）；Linux 原生容器按容器 uid 权限位。
- 流程教训：worker 代码打进镜像（`deploy/worker-image` 打包 `src/agent/tool-worker` 与 `src/core`），改 tool-worker 必须重建镜像才进容器。

**code review（双轴）处置**：删死代码 `inputDigestSha256`、删空调参 `createWorktreeInContainer.baseCommit`、`planModeBlocksModifyDelegation` 包装内联为 `runsInPlanMode`、工具结果补「副本基于提交 X（父工作区未提交改动不在副本内）」明说、共享 Git 目录补执行身份写预检、`resolveCommonGitDir` worktree 分支复用 core/worktree 解析、`GIT_CONFIG safe.directory` 环境收敛为 `GIT_SAFE_DIRECTORY_ENV` 单一事实源；「继续委派复核分类有误」与「Driver 非逐任务重建」两条经核实不成立（实现已正确：复核按 cwd+writeTarget 双层，SubAgent 子会话 run 收尾即释放 Driver）；占用兜底缺口为 issue 15 既有口径，不在本单。
