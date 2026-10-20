# 运行中任务收尾协议的实施证据

对应[工单](issues/17-task-ending-protocol.md)与[决定](../../.agents/notes/implemented/architecture/2026-10-16-task-ending-protocol.md)。实施基线为 develop `9928103`，实现与材料在同一提交中保存。下列结论只覆盖本次实现，不代表真实模型或外部渠道验收。

## 实现范围

`packages/agent/src/task-ending.ts` 统一取消意图、首次快照、停止核实、事务内结算与条件终态、归属写入及释放后的唤醒。Driver、宿主操作、工作流与 Runtime 兜底共享任务上下文，仍由原执行归属停止自身。未新增归属登记表、数据迁移或持久字段。

Driver 模式切换与让出目录在停止前公开候选快照；成功且无人采用时撤回，中止采用后不因内层停止入口尚未到达而丢失。宿主自然停止期间首次中止先保存快照再复用原停止 Promise。两处由独立审查发现，以先失败后修复的回归补齐。

## 工程检查

macOS 27.0.1、Node 24.15.0，使用真实 SQLite、Store、ToolOpLedger、默认工作流适配器与可控停止回调。模型流量为本地模拟 provider，真实 Git/worker 的用例仍执行实际本机操作。

- `npx tsx --test test/100-worker-stop.test.ts` 独占执行：33/33，无跳过，含真实 local 进程组与后代停止。
- 最终扩展回归：332/332，通过、无跳过，约 400 秒；命令如下。
- `npm run check:static` 通过（lint、根与全部 workspace／foundation 类型、笔记和文档检查）；`git diff --check`、源码笔记锚点报告及变更文本末尾单换行核实完成。
- 新函数与主要接线先补失败用例：统一入口不存在时测试拒绝加载；接线前已复现 Agent／宿主的有输出写结果缺失、未消费审批的自然结算、已取得 Driver 的异常释放及浏览器停止失败组合。

扩展回归发现真实工作流超时，默认并发与串行批次均中止，不作为通过证据。采样后用真实 Coordinator 的并发重复中止用例缩小：旧实现写取消意图两次，单元停止一次，证明只复用了 halt，重复收尾事件又唤醒暂停调度。修复以作业内 `job.abort` 缓存整次中止，保留 `job.stop` 的单元停止职责；新增回归先失败后通过，独立审查亲跑复核。最终扩展批次在修复后重新执行。

最终扩展命令：

```sh
npx tsx --test --test-concurrency=4 test/01-concurrency.test.ts test/07-real-tools.test.ts test/08-approvals.test.ts test/10-access-modes.test.ts test/58-plan-mode.test.ts test/63-approval-gate.test.ts test/64-tool-op-ledger.test.ts test/66-control-seam.test.ts test/82-subagent-cancel-work.test.ts test/91-release-acceptance.test.ts test/92-subagent-lifecycle.test.ts test/94-task-ending.test.ts test/105-workflow-runtime.test.ts test/106-workflow-host.test.ts test/107-workflow-runtime-wiring.test.ts test/108-workflow-import.test.ts test/109-workflow-cold-recovery.test.ts test/110-workflow-workcopy.test.ts test/111-workflow-capabilities.test.ts test/112-workflow-real-steps.test.ts test/113-workflow-source-capabilities.test.ts test/workflow-role-integration.test.ts test/work-copy-host-runtime.test.ts test/125-agent-wait.test.ts test/125-agent-wait-resource.test.ts
```

本机日志为 `/tmp/ruukoto-17-regression-final.log`、`/tmp/ruukoto-17-worker-stop.log` 和 `/tmp/ruukoto-17-static-final.log`。

## 隔离撤修负例

在独立 worktree 中复制最终源码与回归，复用相同依赖并建立指向该副本 workspace 的包链接；未改原工作区。基线选定的 19 条协议、共享快照及队列回归全部通过。随后每组只撤掉一个保护，再恢复最终文件；以下 16 组全部按预期返回非零，分别命中指定断言或等待条件，没有以缺模块作为这些负例的失败依据。

| 撤去的保护 | 实际失败用例 |
| --- | --- |
| 自然收尾不结算 | `94` 统一自然收尾，结果被不当补记 |
| halt 后重读共享快照 | `94` natural 先进入停止的竞争，遗漏后到中止 |
| 保留首次快照而非重取 | `94` nested 迟到结果，遗漏原写操作 |
| 结算与终态同事务 | `94` 事务回滚，已知只读结果未一起回滚 |
| 仅条件终态成功才标未知 | `94` canceled／interrupted 竞争失败后仍追加未知 |
| 仅实际释放才唤醒 | `94` 两类共享竞争出现重复唤醒 |
| 中止采用候选后换引用 | `94` 成功交接撤掉外层已采用快照 |
| 宿主复用停止前处理首次中止 | `106` 自然停止后首次取消未保存意图与快照 |
| 工作流复用停止前处理首次中止 | `105` 自然停止后首次中止未到达 |
| 与最终输出无关的写结果检查 | `105` Agent／宿主缺写结果仍推进依赖 |
| 默认适配器传递同一上下文 | `112` 默认工作流共享上下文断言失败 |
| Runtime 兜底保守停止协议 | `94` 恢复原 Runtime 后，取得 Driver 异常与浏览器回滚组合失败 |
| 工作副本父停止兜底复用上下文并处理拒绝 | 工作副本两条父停止失败回归失败 |
| 宿主竞争失败补已知结果且不重复唤醒 | `106` 恢复原 HostExecution 后竞争断言失败 |
| 已提交终态的宿主重复停止直接复用 | `106` 撤掉终态 guard 后改写取消意图并补只读结果 |
| 工作流缓存整次中止协议 | `105` 撤掉 `job.abort` 去重后重复写取消意图 |

负例明细为本机会话临时文件 `/tmp/ruukoto-17-negative-results.json`，宿主重复中止的补充负例为 `/tmp/ruukoto-17-negative-host-repeat-results.json`，工作流重复中止的补充负例为 `/tmp/ruukoto-17-negative-repeat-job-results.json`，每组日志以 `/tmp/ruukoto-17-negative-` 开头；这些临时文件不是持续回归入口，仓库测试才是。

## Linux 证据

通过 `ssh tx` 在独立临时副本验证，未修改远端已有工作仓库。环境为 Linux 6.8.0-117-generic、Node 24.21.0、npm 11.19.0、非 root。同步源码逐文件核对 SHA-256；最终 Driver 为 `984280391d5a4fa95739438d958309e6c839798f9329fd3cee6f159025ddb295`。

- `npm run build:worker`、`npm run build:script` 通过。
- `RUN_MODEL_CHECK=0 node_modules/.bin/tsx --test test/94-task-ending.test.ts test/work-copy-host-runtime.test.ts test/106-workflow-host.test.ts`：60/60，无跳过。
- 最终 Driver 再跑 `94`：42/42；随后同机独占 `100`：33/33，无跳过。
- Host 已终态重复停止 guard 最后单独同步，运行 `--test-name-pattern='宿主自然停止已开始|自然完成后的重复中止' test/106-workflow-host.test.ts`：2/2，无跳过；日志为 `/tmp/ruukoto-17-linux-106-guard.log`，其余不受 guard 影响的用例沿用上述证据。
- 工作流整次中止去重最后单独同步，运行 `--test-name-pattern='并发重复中止复用整次收尾|自然停止单元已开始后首次中止' test/105-workflow-runtime.test.ts`：2/2，无跳过；日志为 `/tmp/ruukoto-17-linux-105-abort.log`。

完整 setup 因 `ENOSPC` 未完成；已清理本次半成品，复用远端既有依赖并补齐同版本的三个 QuickJS JS/WASM 包。日志保存在远端 `/tmp/ruukoto-17-linux-final-tests.log`、`/tmp/ruukoto-17-linux-94-final.log`、`/tmp/ruukoto-17-linux-100-final.log`。真实 OS 项使用 local launcher，不据此声称 native cgroup／bwrap 外部验收通过。

## 独立审查与验收边界

独立执行上下文直接读取工单、决定、实际 diff、调用方及回归，亲跑 14 项统一／共享／默认接线、11 项工作流后到中止／队列／工作副本、7 项最终交接／候选采用／宿主后到取消／既有终态保护，以及最后 10 项纯 Store 协议回归；均通过。发现的两个阻断已修复并亲跑复核关闭。Driver 边界在全部资源已核实、后续模式准备失败时沿原行为释放占用的最终微调亦经代码复核；最后新增的已终态宿主重复中止 guard 由审查者亲跑两条回归通过，结论仍通过。工作流整次中止去重的最终修复另经独立复审，亲跑并发重复中止、自然停止后首次中止和默认接线 3/3。

三篇模块文档与旧工作流职责笔记已同步，新决定转 implemented。无主观体验或新增交互，产品验收不适用。未执行全量 `npm run check`、真实模型、IM、真实浏览器或 native cgroup／bwrap 外部验收；浏览器 false 是可控停止替身。已取得 Driver 后异常会保守保留占用，可能需要拥有者核实后恢复；这是已确认的安全代价。
