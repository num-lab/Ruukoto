# SubAgent 修改委派：每项工作一个宿主生成的 worktree，非 Git 串行

日期：2026-10-04

状态：已接受（agent-direction issue 16 实施记录；衔接 ADR 0017 的「同一份工作文件只允许一个 Agent 写入」，扩展 ADR 0020 第 5 条「首版只读」）。

## 背景

ADR 0017 确认并行编码使用独立 Git worktree、非 Git 目录写任务串行，且目录占用机制需按此调整。实施前 SubAgent 只有只读分析（ADR 0020）：没有修改模式与写工具，宿主不能创建 worktree，执行目录与占用键固定为会话 cwd，目录占用只比对同一目录（`/ws` 与 `/ws/sub` 互不阻塞）。

## 决定

1. **一项工作一个写入目标，首次委派钉定。** `work_delegations.write_target`（schema v27 补列，可空）：Git 目标记 `{kind:"worktree", repoRoot, commonGitDir, gitdir, path, dev, ino, branch, baseCommit}`，非 Git 目标记 `{kind:"direct", path, dev, ino}`；空 = 只读分析工作，不能升级为写入。继续委派（`work_id`）沿用并逐项复核（目录身份、`.git` 指向的 gitdir），不复核即被替换/删除则明确失败，不自动重建；复用（`sub_agent_id`）承接新工作时另建副本。只有普通开发会话能发起修改委派（main 由 17 迁移，计划模式与 SubAgent 自身拒绝）；子任务固定 confirm 在容器中运行，工具只有 read/edit/write/bash/read_artifact，不继承 full_access。
2. **Git 目标每项工作一个宿主生成的 worktree。** 位置 `<dataDir>/../agent-work/worktrees/<workId>`（保护根与父工作区之外），分支 `ruukoto/work-<workId>`，基线为委派时仓库 HEAD——父工作区未提交改动不进副本。子任务不 add/commit/推送，改动留在工作树由主 Agent 汇总（17）；副本一律保留，不提供删除入口，创建失败保留现场并把路径与分支写进错误。单一写入者由目录占用保证：占用冲突判定升级为 dev/ino 相等、realpath 相等或按分隔符边界互为前缀（祖先/子孙），对所有任务生效——非 Git 子任务与父会话串行，已有的嵌套 cwd 会话从此也串行；释放统一按 `taskId`。父任务没有阻塞等待子任务的接口，不会持锁空等。
3. **worktree 在受限容器内创建，宿主永不执行 git。** 创建复用 `ToolWorkerHost.start(launcherFor("confirm"))`：workspace 为仓库根（与父任务自身 confirm 任务权限相同），副本目录读写挂载，执行宿主固定的一条 bash（`git -c core.fsmonitor=false rev-parse --verify HEAD` + `git -c core.fsmonitor=false -c core.hooksPath=/dev/null worktree add`，基线提交按 40 位十六进制从输出提取）。理由是仓库的 `.git/config` 可以被父任务的 confirm 容器写入，宿主以后台账户运行 git 会执行其中植入的 fsmonitor 或 filter，以后台账户身份逃出边界；容器内以 `/dev/null` 跳过 hooks、显式关 `core.fsmonitor`。宿主在容器启动前预建空副本目录（0700）——挂载源不存在时 Docker 会以 root 自动创建，容器内 uid 写 `.git` 被拒；非空目录 = 失败残留，不自动认领或覆盖。git 会把副本路径字串写进共享 Git 目录的 `worktrees/<name>/gitdir` 并据此回核，macOS TMPDIR 的 `/var → /private/var` 符号链接会让字串与 realpath 不一致（实测报 "not a git repository"）：命令、挂载与 `write_target.path` 一律用 `copyDirReal = fs.realpathSync(copyDir)`。这一步不取父会话占用（父任务正持有占用，取则自锁），并发由 git 自身的锁处理。
4. **共享 Git 目录对子任务只读。** LaunchSpec 把 worktree 作为工作区（读写），共享 Git 目录作为 `readRoots` 只读挂载：子任务能 status/diff/log，不能写 refs、hooks、config——共享目录可写时子任务能改 hooks 或 `core.fsmonitor`，之后会在拥有者自己的 git 中执行。容器环境注入 `GIT_CONFIG_COUNT/KEY_0/VALUE_0=safe.directory=*`，允许容器 uid 在挂载的宿主路径下运行 git。覆盖 `agent-work/worktrees` 或其下位置的读写授予被 `validateGrantedPaths` 拒绝（只读仍允许），副本不能经授予路径旁路写入。worker init 的 readRoots/dev/ino 与 workspaceIdentity 只在 Linux 下发：Linux 原生 bind mount 按宿主原样呈现目录身份；macOS Docker Desktop 经 VM 重新编号 inode（实测容器侧 dev/ino 与宿主恒不一致），macOS 不下发数值身份，worker init 只按路径钉定，目录身份复核由宿主队列回路在任务启动前按 `taskWorkspaceFor` 承担。同理，执行身份的可读/可写预检（`executionCanRead`/`executionCanWrite`）在 macOS 按后台账户 `accessSync` 核实——Docker Desktop 的 VM 以宿主身份执行容器内文件访问，容器 uid 的 POSIX 位判定在 macOS 恒假；Linux 原生容器按容器 uid 的权限位判定。

## 补充：改动汇总与 main 修改委派（agent-direction issue 17，2026-10-05）

1. **汇总 = 副本对基线的完整差异，预检通过才写入。** 主 Agent 经 `subagent_integrate(work_id)` 触发（dev 与 main 均装配，回报唤醒轮次也允许；SubAgent、群与固定角色会话经宿主身份重核拒绝），宿主只按工作 id 取首次钉定的写入目标——Agent 复用承接新工作（另建副本）后，汇总旧工作仍只落旧工作的副本。套用复用本决定的宿主容器入口（宿主永不执行 git）：副本内 `git add -N --all` 把未跟踪文件纳入索引 → 对基线取完整二进制 diff 与 numstat → 父仓库 `apply --check` 预检通过才 `apply`（预检失败零写入）；fsmonitor 显式关、hooks 走 /dev/null，父仓库本身是 worktree 时共享 Git 目录按钉定记录补一枚读写挂载。不代提交：差异落在父工作区待提交区，随后由主 Agent 用自己的工具继续验证（SubAgent 的任务输入同样要求其在副本内完成相关检查并报告结果）。
2. **三套结论，冲突零写入。** applied（套用成功并登记事件）/ already（完整差异已在工作区，`apply --check --reverse` 命中：幂等返回，不重复写入、不重复登记）/ conflict（两向预检都失败：父工作区原改动与副本成果都保留，错误点名冲突文件与待处理说明）。套用成功在一个事务内追加 `work_delegation.integrated` 事件（工作/SubAgent/发起汇总的主任务/分支/基线/父 HEAD/文件清单 ≤64 条/numstat/patch 字节数），工具操作账本按事件核实，登记缺失如实报无法核实而非「未生效」（apply 落字节与事件登记是两个步骤，窗口内崩溃的现场由保留的副本与父工作区 git status 核对，不自动重放）。已知上限：汇总后继续委派产生新改动时再次汇总会命中冲突（已套用的 hunks 挡路），不引入增量汇总状态；busy 检查与容器套用之间登记的新执行可能让副本继续变化，副本保留与事件钉定使现场可核对，不加锁。
3. **套用前核实，取消/关闭不拦汇总。** 工作有活动任务拒绝；副本目录身份与 `.git` 指向逐项复核（与继续委派同一判定，被替换/消失明确失败、不自动重建）；仓库根仍在父会话工作区内且 `.git` 可读。整项取消与显式关闭本就不删副本与成果，汇总不按取消/关闭状态拦截——取消后、关闭后的成果仍可按工作找回；汇总与关闭同为「读副本 + 写父工作区待提交区」，竞争保持可恢复记录（副本保留 + 事件钉定）。非 Git 直接写入工作没有副本，调用只如实告知（改动本就就地落盘）；只读分析工作明确拒绝。
4. **main 的修改委派开放，旧入口仅迁移期兼容。** main 会话可按同一规则发起 `mode=modify + target`（接入同一 worktree 容器、占用与汇总链路）；固定 coding/chat 角色会话仍拒绝。`coding_delegate` 的 `mode=analyze` 此前已走通用只读链路，`mode=draft` 保留旧 coding 路径仅作迁移期兼容（无 `work_id`，不纳入汇总），描述引导修改工作走通用链路。协议进 v15（新事件与新工具）。

## 与既有决策的关系

- ADR 0017：落实「并行编码用独立 worktree、非 Git 串行、占用按此调整」；改动汇总、提交与冲突处理由 issue 17 实施（同样需在容器内执行 git）。
- ADR 0020：第 5 条「首版只读」由本决定扩展为 analyze/modify 两种模式；登记事务、幂等与查看口径不变，只加可选字段（协议版本不变）。
- ADR 0003：SubAgent 任务仍一律 confirm，写入目标是容器边界内的收窄而非授权扩大；不继承长期授权。
- ADR 0004：容器边界是唯一的写入约束；宿主新增能力（容器内创建 worktree）不引入执行账户的新权限。

## 冒烟记录（issue 17 改动汇总，2026-10-05；模型为模拟、真实容器边界）

`.scratch/agent-direction/smoke-issue17.mts`：macOS 本机 Docker Desktop
7/7；Linux 远端（tx，Ubuntu 24.04 原生 docker，uid/gid 1003，
`RUUKOTO_CONTAINER_UID/GID=1003`）同日 7/7——宿主容器创建 worktree 副本、
子任务容器真实 edit/write（父工作区字节不变）、汇总容器
add -N→diff→apply --check→apply 落入父工作区待提交区（父 HEAD 不变、
`work_delegation.integrated` 事件登记）、already 幂等、冲突零写入点名文件
双方保留、取消+关闭后汇总不拦、`ruukoto-task-*` 容器零残余。流程教训：副本
创建与汇总在「父仓库本身是 worktree」时必须把共享 Git 目录补挂读写
（prepareWriteTarget 与 integrate 同一取舍），否则容器内 git 无法解析
`.git` 指针（本版已修并覆盖在两端冒烟里）；冒烟夹具与真实流程一样统一用
realpath 建链（macOS TMPDIR 的 /var→/private/var 别名否则撞穿）。

## 冒烟记录（macOS 9/9，2026-10-04；模型为模拟）

macOS 本机 Docker Desktop：两个子任务同一仓库并行 worktree（同时 running、不同分支），副本创建容器与任务容器零残余；容器内 `git status`/`diff` 可用（safe.directory 环境有效），`git commit` 与写 hooks/config 真实失败（共享 Git 只读挂载）；主工作区字节与未提交改动不变；植入的 fsmonitor 只在容器内被只读挡住，宿主不执行。Linux 远端（tx，原生 docker，uid/gid 1003，经 `--remote` 自包含跑完全程）同日 9/9 通过：并行副本同时 running、非 Git 写入与父会话串行、宿主不执行植入、零残余容器。流程教训：worker 代码打进镜像（`deploy/worker-image` 构建阶段复制 `src/agent/tool-worker` 与 `src/core` 后 esbuild 打包），改 tool-worker 必须重建镜像才进容器。
