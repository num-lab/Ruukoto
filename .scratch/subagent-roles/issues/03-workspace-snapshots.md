# 当前工作区快照、受限审查与增量汇总

Status: ready-for-human

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

工程验收与[独立实现审查](../03-implementation-review.md)通过，无未解决阻断；当前基点 `d12eb63`，分支 `Eitrous/subagent-roles`，保留 02 未提交成果且没有提交。本单实现当前内容捕获、独立宿主准备、native 来源保护、子增量及坏基线失败隔离，[工程记录](../evidence/03-implementation.md)固定 38 项生产/测试 SHA、双平台实际入口与原始失败。macOS 最后并发组一次等待超时和 Linux 首轮一次离线 mock 连接错误均单独通过但根因未证明，不改写首次记录。01–03 的工程前置成立，下一实施入口是 [04](04-workflow-integration.md)；人工体验与真实模型联合验收由 05 持有。

## 验收与证据

工程定向验证、最终索引/阶段对象完整性、双平台真实 native 与非作者交叉审查已完成；产品待验收。实际用例覆盖暂存/未暂存、新文件、删除、二进制、split-index、promisor、模板与路径形态，分别核实捕获零写入及登记元数据；子增量保留原改动，同文件后续变化拒绝，独立验证固定原基线。来源绝对/别名/符号链接/硬链接/file bind 与结构化/批准后宿主写均拒绝。APFS 仅大小写重命名可能被 Git 安全拒绝；非显式只读挂载全局根的既有特权 bind 缺口另列，不宣称该全局范围通过。

运行 npm run check:static 及 test/83-subagent-worktrees.test.ts、test/110-workflow-workcopy.test.ts、test/125-agent-wait.test.ts，按执行/停止改动加入真实 native 与 tool-op 用例。macOS 和 ssh tx Linux 分别验证受限写拒绝、停止未核实保留及非 Git 目录竞争。模拟工具结果不能代替实际文件检查；已有全量或旧 smoke 不证明新基线。

实现须独立审查；05 验证审查当前改动、运行检查及保留成果的产品体验。

## Comments

2026-10-14：包含未提交内容同时要求捕获零写入与增量汇入，三者共同验收，不只验证副本中出现文件。

2026-10-15：01、02 工程前置成立，转 ready-for-agent；本单只更新交接，没有提前执行目标捕获或降低验收要求。

2026-10-15：拥有者直接指定本单；01、02 的工程前置仍成立，当前工作区保留 02 未提交成果，按已确认范围进入实施，不提交或推送。

2026-10-15：工程实现与独立审查完成，38项生产/测试内容由主仓及最终Linux逐项核实；转 ready-for-human，04 工程前置成立，05 人工/真实模型体验保留待验。原始失败和重跑均入库，不把工程通过称产品通过。
