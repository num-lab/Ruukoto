# Agent Note: 汇总 worktree 完整差异并保留冲突成果

Status: implemented

部分取代：[个人 Agent 原生执行与 Docker worker 退役](../../implemented/architecture/2026-10-12-personal-native-sandbox.md)将个人产品受限汇总接到原生 worker；完整差异、幂等、冲突与成果保留语义仍由本篇持有。

原出处：ADR 0021「补充：改动汇总与 main 修改委派」

## 问题

[独立 worktree](../architecture/2026-10-04-subagent-worktrees.md)让修改工作并行且不动父工作区，但成果需要由主 Agent 汇总、验证，并在冲突时同时保留。main 的修改委派也需进入相同边界，避免依赖旧固定 coding 流程。

## 决定

1. **汇总 = 副本对基线的完整差异，预检通过才写入。** 主 Agent 经 `subagent_integrate(work_id)` 触发（dev 与 main 均装配，回报唤醒轮次也允许；SubAgent、群与固定角色会话经宿主身份重核拒绝），宿主只按工作 id 取首次钉定的写入目标——Agent 复用承接新工作（另建副本）后，汇总旧工作仍只落旧工作的副本。套用复用[worktree 决定](../architecture/2026-10-04-subagent-worktrees.md)的受限 worker 入口（宿主永不执行 git）：副本内 `git add -N --all` 把未跟踪文件纳入索引 → 对基线取完整二进制 diff 与 numstat → 父仓库 `apply --check` 预检通过才 `apply`（预检失败零写入）；fsmonitor 显式关、hooks 走 /dev/null，父仓库本身是 worktree 时共享 Git 目录按钉定记录补一枚读写挂载。不代提交：差异落在父工作区待提交区，随后由主 Agent 用自己的工具继续验证（SubAgent 的任务输入同样要求其在副本内完成相关检查并报告结果）。
2. **三套结论，冲突零写入。** applied（套用成功并登记事件）/ already（完整差异已在工作区，`apply --check --reverse` 命中：幂等返回，不重复写入、不重复登记）/ conflict（两向预检都失败：父工作区原改动与副本成果都保留，错误点名冲突文件与待处理说明）。套用成功在一个事务内追加 `work_delegation.integrated` 事件（工作/SubAgent/发起汇总的主任务/分支/基线/父 HEAD/文件清单 ≤64 条/numstat/patch 字节数），工具操作账本按事件核实，登记缺失如实报无法核实而非「未生效」（apply 落字节与事件登记是两个步骤，窗口内崩溃的现场由保留的副本与父工作区 git status 核对，不自动重放）。已知上限：汇总后继续委派产生新改动时再次汇总会命中冲突（已套用的 hunks 挡路），不引入增量汇总状态；busy 检查与实际套用之间登记的新执行可能让副本继续变化，副本保留与事件钉定使现场可核对，不加锁。
3. **套用前核实，取消/关闭不拦汇总。** 工作有活动任务拒绝；副本目录身份与 `.git` 指向逐项复核（与继续委派同一判定，被替换/消失明确失败、不自动重建）；仓库根仍在父会话工作区内且 `.git` 可读。整项取消与显式关闭本就不删副本与成果，汇总不按取消/关闭状态拦截——取消后、关闭后的成果仍可按工作找回；汇总与关闭同为「读副本 + 写父工作区待提交区」，竞争保持可恢复记录（副本保留 + 事件钉定）。非 Git 直接写入工作没有副本，调用只如实告知（改动本就就地落盘）；只读分析工作明确拒绝。
4. **main 的修改委派开放。** main 会话可按同一规则发起 `mode=modify + target`（接入同一 worktree 受限 worker、占用与汇总链路）；固定 coding/chat 角色会话仍拒绝。新分析与修改统一经 `subagent_delegate`；历史 coding draft 没有 `work_id`，不纳入汇总，旧结果只读保留。协议进 v15（新事件与新工具）。

## 临时资料与原生执行

[原生执行沙箱](../../implemented/architecture/2026-10-10-native-execution-sandbox.md)沿用同一 `Runtime.executeWorkCopy` 入口；patch、numstat 和错误资料改用执行单元专用 `TMPDIR` 下 `mktemp -d` 创建的随机 0700 目录。固定 `/tmp/ruukoto-integrate.*` 在原生环境会与并行任务或宿主已有资料相撞，因此不再使用。资料由执行单元的已核实停止统一回收，不设置 EXIT trap；停止未核实保留临时现场，父工作区与副本成果仍按既有规则保留。`test/95` 用两份真实仓库与 numstat 同步屏障，确保两份 patch 同时存在后分别套用，覆盖跨工作污染。

## 曾经的做法与改动原因

迁移期 coding_delegate(analyze) 转入通用只读，draft 留在旧 coding 路径且没有 work_id。通用修改与汇总完成后，旧委派入口按[工作委派决定](../architecture/2026-10-03-work-delegation-subagent-task.md)删除，coding_result 继续只读查旧结果。

<!-- agent-note-format: alternatives-not-recorded (pre-format Agent Note) -->

## 后果

汇总将完整差异套用到父工作区待提交区，不替主 Agent 提交；冲突零写入，两边成果可找回。代价是完整差异没有增量汇总状态，汇总后继续产生新改动再汇总可能因已套用 hunks 冲突；busy 核实和实际套用间没有额外锁，新执行可能改变副本。apply 落字节与事件登记也无跨系统事务，无法核实即保留副本和父 status 供核对，不自动重放。取消和关闭不阻止找回保留成果，目录占用和活动任务核实继续有效。

## 验证

[工单 17](../../../../.scratch/agent-direction/issues/17-integrate-worktree-results.md)与 smoke-issue17.mts 的历史记录：macOS Docker Desktop 与 ssh tx Linux（Ubuntu 24.04 原生 Docker、uid/gid 1003、RUUKOTO_CONTAINER_UID/GID=1003）各 7/7。模型模拟、容器边界真实；验证副本真实 edit/write、父字节未动、add -N→diff→apply --check→apply、父 HEAD 不变、integrated 事件、already 幂等、冲突零写入且点名文件、取消关闭后汇总与容器零残余。父仓库本身为 worktree 时创建与汇总均需补挂共享 Git 目录读写；夹具和真实路径统一 realpath，避免 macOS /var→/private/var 别名。

## 适用范围

两个产品的受限汇总均经 native 复用 `Runtime.executeWorkCopy`，完全访问按实际发起任务使用启动账户。执行单元的 HOME/TMPDIR 使用宿主临时磁盘，无单任务容量限制；停止未核实时保留临时现场与占用，已核实停止才清理。上述后端与临时资源选择归[个人 Agent 原生执行与 Docker worker 退役](../../implemented/architecture/2026-10-12-personal-native-sandbox.md)；本篇完整差异、幂等、冲突、事件归属及成果保留继续适用，原真实容器报告不改写为 native 结果。

完全访问的账户、环境、免审批及宿主任务授权传播采用[本决定](2026-10-12-full-access-current-account.md)；本篇其他独立规则继续适用。
