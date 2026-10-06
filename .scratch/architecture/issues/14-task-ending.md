Status: resolved

# 任务收尾一处完成

## 目标

store 提供「以某个终态结束任务（附原因）」的入口：一个事务内做条件更新与全部配对效果（审批置 stale、清待定模式切换、`task.*` 事件、释放占用），返回是否发生了变化；「保留占用待核实」是显式选项。来源：2026-10-05 架构审查的候选 07。

## 背景

2026-10-05 核对（develop d109dbe），11 处手工配对 `transitionTask`：

| 运行中任务收尾 | 条件更新 | 审批置 stale | 清模式切换 | `task.*` 事件 | 释放占用 |
|---|---|---|---|---|---|
| `driver.ts:1105` 收尾 | ✓ | ✓（中断/取消） | ✓ | ✓ | ✓ |
| `runtime.ts:2869` 驱动异常 | 不看结果 | ✗ | ✗ | 无条件追加 | ✓ |
| `runtime.ts:1334` 重启恢复 | ✓ | ✓ | ✗ | ✓ | 留待核实（有意） |
| `runtime.ts:4327` 后台停止 | ✓ | ✓ | ✗ | ✓ | 留待核实（有意） |

- 另有 6 处 queued → 终态（`runtime.ts` 1362、1494、2795、2822、3029，`subagents.ts:675`）各抄一段「条件更新 + 事件」；`runtime.ts:2392`（模式切换失败 → interrupted）发 `task.mode_switch_failed`。
- `runtime.ts:2869` 不看条件更新是否成功就追加 `task.failed` 并释放占用：若 `driver.run` 收尾后再抛错，已完成任务会多一条矛盾的终态事件。目前没有触发路径（MCP close 吞掉错误）。
- 先例：`transitionTask` 已在内部关闭未结束的 thinking 事件（`store.ts:812–822`）。

## 实施取舍

- 重启恢复与后台停止同样清除待生效模式。模式只在活动任务的工具边界应用；终态后的残留不再具有执行意义，也不会继承到 continue 的新任务。
- 模式切换未核实继续使用 `task.mode_switch_failed`，不额外发 `task.interrupted`；收尾入口只接收目标模式与原因，任务及会话标识由 Store 读取。
- 任意终态都使 pending 与 approved 未消费的审批失效，已消费与已拒绝的审批保留。
- 沿用调用方的同步 `withTx`，不嵌套事务；保留既有工具操作账本，并只在条件更新成功后于终态事件前补记效果未知。
- 非终态状态转换与离线实例导入保留原入口，通用队列与提交后唤醒仍归 Runtime。

## 相关 ADR

- ADR 0002 / 0010：重启后占用待核实、不重放——不变。

## Comments

### 2026-10-07：实现交付

第 7 条在分支 `task-ending` 实施，基线 develop `10edea5`：

- `Store.endTask` 统一终态条件更新、待生效模式清理、未消费审批失效、`task.*` 事件和按任务 ID 释放占用；`keepOccupancy` 显式保留待核实占用，驱动器账本可在终态事件前补记效果未知。
- Runtime、Driver、SubAgentManager 的在线终态路径均改用该入口；调度循环驱动器异常在原收尾已经成功时不再追加矛盾的 `task.failed` 或删除该任务保留待核实的占用；模式切换未核实继续保留 `task.mode_switch_failed`。
- 新增 `test/94-task-ending.test.ts` 11 项：四种终态的审批清理与已消费/已拒绝记录保留，思考阶段关闭、重复终态和新任务占用保护，末步占用释放故障导致整笔回滚（含账本与广播）、重试后提交，三种保留占用路径，实际 Runtime 的收尾后抛错、无驱动器停止及重启恢复。
- Runtime 的异常竞争用可控驱动器替身触发，验证真实队列 catch 与 finally，不声称当前 SDK 存在可自然触发的收尾后异常。重启与缺失驱动器停止用真实 SQLite 播种启动/崩溃形态；模型为本地替身，未做 Linux、真实模型或 IM 验收。
- 图解定位与同步：task-lifecycle#states、#stop、#restart；tool-call-path#approval 中审批状态的图、aria-label、说明及转换表。原文「completed / failed 不走审批 stale」已不符合统一收尾，修正为所有终态；原文调度 catch 无条件追加失败的例外随实现删除。状态、审批、模式、占用与事件的事务边界由 Store.endTask / withTx 核实，账本回调由 Driver.finalize 核实，保留占用由 Runtime.recover / doStop 及 SubAgentManager.recoverQueuedTasks 核实。
- 渲染逐张核实 task-lifecycle 8 张、tool-call-path 15 张切片，无文字重叠、截断或箭头错位，文件在 `/tmp/vis-<页面名>-<序号>.png`。
- 类型检查、94 号 11/11、图解测试 4/4 与 `git diff --check` 通过；既有生命周期、账本、SubAgent 和 IM 审批定向回归 77/77 通过。完整测试结果在最终记录中补充。

### 2026-10-07：最终验证

- 最终完整 `npm test`：974 项，972 通过、1 跳过、1 失败（退出码 1）。唯一失败为 `test/08-approvals.test.ts` 的 `.invalid` DNS 解析等待 60 秒超时；该环境问题此前已在工单 12 的干净基线验证中复现。本单不改 DNS 路径，不声称完整测试全绿。完整日志 `/tmp/ruukoto-task-ending-full.log`。
- 五项变异均在独立临时源码副本中被 94 号捕获：忽略条件更新结果、删除审批清理、删除模式清理、删除保留占用分支，以及恢复 Runtime 无条件追加失败事件/释放占用。源码副本每次还原，实施工作区未注入变异；证据在 `/tmp/ruukoto-task-ending-mutations-j6se219t/results.json` 与同目录日志。
- 最终 `npm run typecheck`、图解检查 4/4 与 `git diff --check` 通过。运行文档和两张图解页已同步；本单标记 resolved，候选清单同步，交付在 `task-ending` 分支本地提交。
