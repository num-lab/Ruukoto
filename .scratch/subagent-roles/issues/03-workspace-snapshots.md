# 当前工作区快照、受限审查与增量汇总

Status: planning

## 目标与边界

实现[规格 R5、R9–R11、R14](../spec.md)，Git 目标包含当前未提交内容，审查保护原工作区，普通汇总只应用子代理新增改动。拥有者已确认 Q4、Q8、Q13、Q14。依赖 01、02 的固定权限和来源接口；不实现非 Git 隔离副本/回写，不改变 full_access 的账户信任语义。

## 方案

1. 先执行[计划第三节](../implementation-plan.md#三目标快照占用与增量)列出的机制实验：不写源 index/对象地捕获 staged/unstaged/untracked binary；基线与子增量分离；所有写回源路径的旁路被拒绝。保留失败日志，失败退回方案，不退成 HEAD-only。
2. target 独立于角色；无 target 使用已有独立子目录与获准资料并开放来源允许的 shell。Git target 捕获当前稳定内容，记录基线与目录身份；源变化拒绝，捕获阶段不修改源文件或仓库状态。捕获零写入与后续宿主 worktree 登记分别记录；只有后者可产生已登记的副本管理元数据/专属分支，原工作树、原 index、HEAD、当前分支、hooks/config 保持不变，子代理不取得这项宿主资格。
3. 受保护副本用真实 native 隔离，来源目录、共享 Git 与附加来源只读；文件工具、批准后的宿主文件路径和绝对路径同样受约束。缺环境拒绝，测试依赖只在获准位置准备。
4. 冻结/普通汇总使用相对捕获基线的增量，冲突不覆盖原改动。源和副本占用、worker 停止、已提交引用、保留成果沿既有机制；非 Git direct 普通执行与 agent_wait 串行，保护要求或工作流写入在非 Git 上先拒绝。
5. 同步 execution/runtime/core 和工作副本使用文档，更新既有 HEAD-only 断言与相关 fixtures；工作流新基线接线交 04。

调用面：runtime/work-copy.ts、runtime/subagents.ts、core/worktree.ts、agent/tool-router.ts、agent/execution/native.ts、agent/approved-ops.ts、worker 文件与命令入口、普通 integrate 及实际源目录占用入口。源 snapshot 与 SQLite 的引用不能宣称跨文件系统原子。

## 进展与交接

独立方案审查已通过，无未解决阻断；实现前置 01、02 尚未完成，当前不标可实施。规划基点和当前 HEAD 为 `ec45979fc94f9828cd902620752c059867b4de15`，分支 `Eitrous/agent-workflow`；本单为未提交规划文件，内容由[审查输入清单](../evidence/plan-inputs.sha256)固定，方案结论见[独立审查](../plan-review.md)。下一角色核实前置后转 ready-for-agent，先完成机制实验和独立核查，再接生产入口。现有 freeze 会 git add -N，不能直接用于原工作区；原有工作副本只含 HEAD，旧测试通过不能证明本单。

## 验收与证据

工程待验证，产品待验收。真实临时仓库含暂存/未暂存改动、删除、非忽略新文件、二进制、忽略文件及嵌套目录；快照前后核实源源码、index/refs/config 与对象状态。子增量汇入保留原改动；原工作区后续变化触发冲突；完整验证不改待审字节；通过绝对路径、路径别名、符号链接及宿主文件工具尝试写原目录必须失败。

运行 npm run check:static 及 test/83-subagent-worktrees.test.ts、test/110-workflow-workcopy.test.ts、test/125-agent-wait.test.ts，按执行/停止改动加入真实 native 与 tool-op 用例。macOS 和 ssh tx Linux 分别验证受限写拒绝、停止未核实保留及非 Git 目录竞争。模拟工具结果不能代替实际文件检查；已有全量或旧 smoke 不证明新基线。

实现须独立审查；05 验证审查当前改动、运行检查及保留成果的产品体验。

## Comments

2026-10-14：包含未提交内容同时要求捕获零写入与增量汇入，三者共同验收，不只验证副本中出现文件。
