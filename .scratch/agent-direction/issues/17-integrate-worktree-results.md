Status: resolved

# 17 — 汇总并验证并行改动，保留冲突成果

**What to build:** 主 Agent 将子任务改动汇入所属工作区、处理冲突并运行检查，失败时仍可找回每份成果。

**Blocked by:** [12 — 继续委派、跨工作复用并显式关闭 SubAgent](12-subagent-reuse-close.md)；[14 — 取消整项工作而不影响其他委托](14-cancel-work.md)；[16 — SubAgent 在独立 worktree 中并行修改](16-parallel-worktrees.md)

依据：[已确认规格](../spec.md) 与 [ADR 0017](../../../docs/adr/0017-two-agent-products.md)。

## 验收标准

- [x] 从多个执行副本收集修改，按明确来源汇入主工作区并运行相关检查，结果关联原工作委托。
- [x] 冲突或检查失败时保留主工作区原有改动与各子任务成果，向拥有者说明待处理内容，不强制覆盖。
- [x] 取消工作或关闭 SubAgent 不会删除尚未汇总的修改；汇总与关闭竞争时保持可恢复记录。
- [x] 汇总前核实原工作区和副本状态，Agent 身份复用不导致把旧工作改动合入新工作。
- [x] 现有 main 的代码修改委派通过通用 SubAgent 产生、汇总并验证改动，普通分析和修改职责均有替代路径，旧固定入口仅保留迁移期兼容。
- [x] 完成相关端到端检查、类型检查及仓库要求的验证；同步本次行为涉及的运行说明和图解，验证记录区分模拟结果与真实环境结果。

## Comments

### 2026-10-05：实施完成

主 Agent 工具 `subagent_integrate(work_id)`（dev/main 均装配、回报唤醒轮次也允许）把工作 id
钉定副本的完整差异经容器内 git（`add -N → diff --binary/numstat → apply --check → apply`，
fsmonitor 关、hooks 走 /dev/null，宿主永不执行 git）套用到父工作区待提交区：不代提交；
冲突两向预检都失败时零写入、父工作区原改动与副本成果双方保留并点名文件（`integrate_conflict`）；
完整差异已在工作区按幂等返回（already，不重复登记）；空差异/直接写入如实告知；只读工作拒绝。
套用成功登记 `work_delegation.integrated` 事件（分支/基线/父 HEAD/文件清单/统计）关联原工作委托；
账本按事件核实，登记缺失报无法核实。套用前核实 busy/副本身份（与继续委派同一判定）/仓库根归属；
只按工作 id 取首次钉定目标，Agent 复用不把旧工作改动带进新工作；取消/关闭不拦汇总。
main 的修改委派开放（旧 `coding_delegate mode=draft` 仅迁移期兼容，描述引导通用链路）；
协议 v15。「运行相关检查」的口径：宿主预检（apply --check）+ SubAgent 任务输入要求在副本内完成
相关检查并如实报告 + 主 Agent 汇总后用自己的工具验证（dev/main 系统提示已写明），不给
main 增加任意命令通道——详见 [ADR 0021](../../../docs/adr/0021-subagent-worktrees.md) 补充段。

附带修复（同单一事务内的根因修复，均经测试核实）：
- 副本创建在「父仓库本身是 worktree」时补挂共享 Git 目录（prepareWriteTarget 创建容器原本
  无法解析 `.git` 指针，与汇总同一取舍；冒烟发现并复核于两端真实容器）；
- SubAgent 系统提示原本对修改委派自相矛盾（「不能修改任何文件」与 issue 16 的写工具冲突），
  改为只读分析/副本修改两种形态以任务首行为准；
- test/83 两处负载竞争（running 状态先于模型调用到达即拉释放闸）与 test/19 合成演示补齐
  `work_delegation.integrated` 事件。

验证记录（区分模拟与真实）：
- 模拟（local 后端，git 语义为真实 git）：test/84 七项验收用例全过；typecheck 全绿；
  全量 npm test 896 项、892 过、3 失败全部与本单无关且分别在独立环境下复现：
  test/32（worktree 检出名 issue-17 与档案名 ruukoto- 前缀假设的环境性失败）、
  test/08 DNS（本机 DNS 把 .invalid 通配解析到 198.18.0.51，前提不成立）、
  test/14（两次全量中偶发一次的负载抖动，单独运行通过）。
- 真实（macOS Docker Desktop 与 tx Ubuntu 24.04 原生 docker，uid/gid 1003）：
  `.scratch/agent-direction/smoke-issue17.mts` 各 7/7——真实容器创建副本、子任务容器真实
  edit/write、容器内 diff/apply 落入待提交区、幂等、冲突零写入、取消+关闭幂等汇总、
  worktree 父仓库补挂、容器零残余。记录于 [运行文档](../../../docs/runtime.md) 验证状态表
  与 ADR 0021 冒烟节。

图解同步（.agents/skills/visual-docs）：改 orchestrator.html（新增 #subagent-integrate 节、
lede/委派入口/失败表/旧委派节文案、staleness 修正——「首版限制」盘点改为「已知限制」）、
control-protocol.html（事件表与版本表各一行）、tool-call-path.html（工具集合、装配条件、
审批规则、账本核实行）、context-pipeline.html（系统提示与任务输入两行数值如实更新）。
已逐节核对锚点与数值（INTEGRATE_FILE_LIST_CAP 处改挂常量锚点），shoot.sh 渲染切片逐张看过，
无重叠/截断；test/67 全绿。核查中发现的代码问题已当场修复并记录于上，无遗留不一致。
