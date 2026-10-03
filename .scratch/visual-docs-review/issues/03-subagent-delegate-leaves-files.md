Status: resolved

# 03 — SubAgent 委派被拒后留下工作目录或资料快照文件

**What to fix:** `SubAgentManager.delegate` 在准备阶段写过的目录与文件，只要委派最终没有登记成功，都要清理干净。

## 现状与证据

`src/runtime/subagents.ts` 的 `delegate` 分三段执行：准备（建目录、写资料快照）→ 拼任务正文（`taskInput`）→ 登记事务。清理只发生在两段 `try/catch` 里，并且只在 `createdNewDir` 为真时删除目录。

1. **正文超长时新建目录残留。** `taskInput` 在正文（含宿主模板）超过 `INPUT_TEXT_CAP`（8192 字符）时抛 `invalid_params`。这个调用位于准备段的 `try/catch` 之后、登记事务的 `try/catch` 之前，所以首次委派新建的 `agent-work/sub-agents/<id>/` 及其中的 `materials-<key>.txt` 会留在磁盘上，库里没有任何记录指向它们。
2. **沿原工作再委派失败时快照文件残留。** 带 `workId` 的委派不新建目录（`createdNewDir` 为假），但会把 `materials-<key>.txt` 写进原工作目录。之后无论是正文超长、登记事务失败还是参数冲突，这个文件都不会删除。
3. **ADR 0020、runtime.md 与 `subagents.ts` 头注释**都写着「失败只清理本次新建目录」，没有提到这两处缺口。

来源：2026-10-03 可视化文档核查（orchestrator.html）；主代理按代码复核。

## 验收标准

- [x] 委派因任何原因未登记成功时（准备失败、正文超长、登记事务失败或冲突），本次新建的目录和本次写入的快照文件都不留在磁盘上。复用原工作目录时只删本次写入的文件，不碰已有内容。
- [x] 正文长度检查挪到任何磁盘写入之前，或者纳入统一的清理范围。
- [x] 测试覆盖：首次委派正文超长、沿原工作委派正文超长、沿原工作委派登记冲突，分别断言目录与快照文件的结局。
- [x] 与 agent-direction 工单 12 协调：12 会改快照文件命名并改造同一函数的准备阶段，两张工单先合入的一方负责让清理规则覆盖新的命名。
- [x] 同步 ADR 0020 / runtime.md / 代码注释里「失败清理」的说法，以及 `docs/visual/orchestrator.html` 登记失败表里「留下什么」一列。

## Comments

### 2026-10-04：随 agent-direction 工单 12 一并修复

按验收标准第三条口径修：`delegate` 的 `taskInput`（含 `INPUT_TEXT_CAP` 检查）纳入准备段的 `try/catch`，准备与登记两段失败统一走 `cleanup()`——本次新建目录整删；沿用目录（继续/复用）只删本次写入的快照文件（新命名 `materials-<workId>-<key>.txt` 由本工单覆盖）。测试在 `test/81-subagent-reuse-close.test.ts`「登记失败清理（visual-docs-review 工单 03）」：首次委派正文超长、沿原工作正文超长（目录与既有内容保留）、沿原工作登记冲突（故障注入）三种结局分别断言，9/9 通过。说法同步：`subagents.ts` 头注释、runtime.md 登记事务条目、ADR 0020 补充段第 3 条、`docs/visual/orchestrator.html` 登记失败表（「本次新建目录，或本次写入的快照文件」）。随工单 12 同批提交。

