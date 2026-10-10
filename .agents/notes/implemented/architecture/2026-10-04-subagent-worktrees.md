# Agent Note: SubAgent 修改委派每项工作使用独立 worktree

Status: implemented

原编号：ADR 0021

## 问题

[两个产品](2026-10-02-two-agent-products.md) 确认并行编码使用独立 Git worktree、非 Git 目录写任务串行，且目录占用机制需按此调整。实施前 SubAgent 只有只读分析（[工作委托与 SubAgent](2026-10-03-work-delegation-subagent-task.md)）：没有修改模式与写工具，宿主不能创建 worktree，执行目录与占用键固定为会话 cwd，目录占用只比对同一目录（`/ws` 与 `/ws/sub` 互不阻塞）。

## 决定

1. **一项工作一个写入目标，首次委派钉定。** `work_delegations.write_target`（schema v27 补列，可空）：Git 目标记 `{kind:"worktree", repoRoot, commonGitDir, gitdir, path, dev, ino, branch, baseCommit}`，非 Git 目标记 `{kind:"direct", path, dev, ino}`；空 = 只读分析工作，不能升级为写入。继续委派（`work_id`）沿用并逐项复核（目录身份、`.git` 指向的 gitdir），复核发现目录被替换、删除或 `.git` 指向改变时明确失败，不自动重建；复用（`sub_agent_id`）承接新工作时另建副本。普通开发会话与 main 均能发起修改委派（main 开放见[改动汇总](../feature/2026-10-05-integrate-worktree-results.md)，计划模式、SubAgent 和固定 coding/chat 归档身份拒绝）；子任务固定 confirm 在容器中运行，工具只有 read/edit/write/bash/read_artifact，不继承 full_access。
2. **Git 目标每项工作一个宿主生成的 worktree。** 位置 `<dataDir>/../agent-work/worktrees/<workId>`（保护根与父工作区之外），分支 `ruukoto/work-<workId>`，基线为委派时仓库 HEAD——父工作区未提交改动不进副本。子任务不 add/commit/推送，改动留在工作树由主 Agent 按[汇总规则](../feature/2026-10-05-integrate-worktree-results.md)套用；副本一律保留，不提供删除入口，创建失败保留现场并把路径与分支写进错误。单一写入者由目录占用保证：占用冲突判定升级为 dev/ino 相等、realpath 相等或按分隔符边界互为前缀（祖先/子孙），对所有任务生效——非 Git 子任务与父会话串行，已有的嵌套 cwd 会话从此也串行；释放统一按 `taskId`。父任务没有阻塞等待子任务的接口，不会持锁空等。
3. **worktree 在受限容器内创建，宿主永不执行 git。** 创建复用 `ToolWorkerHost.start(launcherFor("confirm"))`：workspace 为仓库根（与父任务自身 confirm 任务权限相同），副本目录读写挂载，执行宿主固定的一条 bash（`git -c core.fsmonitor=false rev-parse --verify HEAD` + `git -c core.fsmonitor=false -c core.hooksPath=/dev/null worktree add`，基线提交按 40 位十六进制从输出提取）。理由是仓库的 `.git/config` 可以被父任务的 confirm 容器写入，宿主以后台账户运行 git 会执行其中植入的 fsmonitor 或 filter，以后台账户身份逃出边界；容器内以 `/dev/null` 跳过 hooks、显式关 `core.fsmonitor`。宿主在容器启动前预建空副本目录（0700）——挂载源不存在时 Docker 会以 root 自动创建，容器内 uid 写 `.git` 被拒；非空目录 = 失败残留，不自动认领或覆盖。git 会把副本路径字串写进共享 Git 目录的 `worktrees/<name>/gitdir` 并据此回核，macOS TMPDIR 的 `/var → /private/var` 符号链接会让字串与 realpath 不一致（实测报 "not a git repository"）：命令、挂载与 `write_target.path` 一律用 `copyDirReal = fs.realpathSync(copyDir)`。这一步不取父会话占用（父任务正持有占用，取则自锁），并发由 git 自身的锁处理。
4. **共享 Git 目录对子任务只读。** LaunchSpec 把 worktree 作为工作区（读写），共享 Git 目录作为 `readRoots` 只读挂载：子任务能 status/diff/log，不能写 refs、hooks、config——共享目录可写时子任务能改 hooks 或 `core.fsmonitor`，之后会在拥有者自己的 git 中执行。容器环境注入 `GIT_CONFIG_COUNT/KEY_0/VALUE_0=safe.directory=*`，允许容器 uid 在挂载的宿主路径下运行 git。覆盖 `agent-work/worktrees` 或其下位置的读写授予被 `validateGrantedPaths` 拒绝（只读仍允许），副本不能经授予路径旁路写入。worker init 的 readRoots/dev/ino 与 workspaceIdentity 只在 Linux 下发：Linux 原生 bind mount 按宿主原样呈现目录身份；macOS Docker Desktop 经 VM 重新编号 inode（实测容器侧 dev/ino 与宿主恒不一致），macOS 不下发数值身份，worker init 只按路径钉定，目录身份复核由宿主队列回路在任务启动前按 `taskWorkspaceFor` 承担。同理，执行身份的可读/可写预检（`executionCanRead`/`executionCanWrite`）在 macOS 按后台账户 `accessSync` 核实——Docker Desktop 的 VM 以宿主身份执行容器内文件访问，容器 uid 的 POSIX 位判定在 macOS 恒假；Linux 原生容器按容器 uid 的权限位判定。

## 与相关决定的关系

2026-10-08 的[工单 26](../../../../.scratch/agent-direction/issues/26-native-sandbox.md) 要求将 Coding Agent 的所有受限调用统一替换为原生边界，包括本决策的 worktree 创建、子任务只读共享 Git 目录与改动汇总。两平台第一阶段尚未通过，当前实现仍使用上述容器路径；“宿主永不执行不可信仓库中的 Git 命令”、目录身份复核、成果保留与无法核实停止时保留占用的要求继续有效。原生接入时必须重新核实宿主 UID 与 dev/ino，不能延用 Docker Desktop 的 VM 权限和 inode 例外。

- [两个产品](2026-10-02-two-agent-products.md)：落实「并行编码用独立 worktree、非 Git 串行、占用按此调整」；[改动汇总与冲突处理](../feature/2026-10-05-integrate-worktree-results.md)同样在容器内执行 git，提交仍由主 Agent 自行决定。
- [工作委托与 SubAgent](2026-10-03-work-delegation-subagent-task.md)：首版只读限制由本决定扩展为 analyze/modify 两种模式；登记事务、幂等与查看口径不变，只加可选字段（协议版本不变）。
- [显式访问模式](../feature/2026-09-19-explicit-access-modes.md)：SubAgent 任务仍一律 confirm，写入目标是容器边界内的收窄而非授权扩大；不继承长期授权。
- [工具工作进程](2026-09-20-tool-worker-per-task-container.md)：容器边界是唯一的写入约束；宿主新增能力（容器内创建 worktree）不引入执行账户的新权限。

## 备选方案

宿主直接运行 git 可以省去创建容器与挂载准备；但父任务能改 .git/config，git 会执行植入的 fsmonitor/filter，使后台账户越过执行边界，因此必须在受限容器执行宿主固定命令并禁用 hooks 与 fsmonitor。子任务共享 Git 目录读写可沿用常规 worktree 工作流；但能修改 hooks/config，后续会在拥有者自己的 git 中执行，因此共享目录只读、子任务不提交不推送。上述取舍见[工单 16](../../../../.scratch/agent-direction/issues/16-parallel-worktrees.md)与原决定的执行边界分析。

## 后果

Git 修改工作可并行保留独立成果，父工作区未提交内容不进入副本；非 Git 工作与父会话按目录占用串行。代价是副本和失败现场一律保留，不能自动清理或认领，目录及 Git 指针变化必须拒绝；祖先/子孙占用规则对所有任务生效，旧嵌套 cwd 会话也会串行。Docker Desktop 的 VM UID/inode 例外不能带入未来原生边界，原生接入须重新核实宿主 UID 与 dev/ino。worker 代码在镜像构建时打包，修改 tool-worker 后必须重建镜像。

## 验证

[工单 16](../../../../.scratch/agent-direction/issues/16-parallel-worktrees.md)与 smoke-16-parallel-worktrees.mts 记录：test/83 13/13，npm test 904 项中 903 通过、0 失败、1 跳过，typecheck 通过；macOS Docker Desktop 和 ssh tx Linux 原生 Docker（uid/gid 1003）各 9/9。模型模拟，Runtime、文件和受限容器真实；覆盖并行 worktree、非 Git 串行、safe.directory、git commit 与 hooks/config 写入拒绝、宿主不执行植入及零残余容器。
