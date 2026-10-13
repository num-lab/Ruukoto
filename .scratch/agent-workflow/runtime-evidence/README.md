# 持久工作流验收证据

本目录对应[03 工单](../issues/03-runtime-and-store.md)与[实施决定](../../../.agents/notes/implemented/architecture/2026-10-13-workflow-runtime-and-store.md)。实施基点为 `df34a05dc03f1d56fcda2f9e4988603f94503163`；命令在 2026-10-13 的 macOS 27.0（26A428）、arm64、Node 24.15.0 工作区执行。Agent 与模型服务器使用离线替身；Git、SQLite 多进程事务、脚本/工具 worker、进程组停止和后台 SIGKILL 为本机真实执行。没有将替身结果算成真实模型或 IM 验收。

## 当前有效检查

| 内容 | 命令与结果 | 原始记录 |
| --- | --- | --- |
| 协调器、人工停计、Runtime 接线与真实冷恢复 | `npx tsx --test test/105-workflow-runtime.test.ts test/107-workflow-runtime-wiring.test.ts test/109-workflow-cold-recovery.test.ts`，43/43，零跳过 | [activity-clock-accepted.log](activity-clock-accepted.log) |
| 两方向 preview/apply 拒绝丢弃绑定 | `npx tsx --test test/108-workflow-import.test.ts`，2/2，零跳过 | [import-guard-accepted.log](import-guard-accepted.log) |
| 宿主任务、真实 Git 与停止未核实 | 独立亲跑 106/107/108 共 14/14 中的 `test/106-workflow-host.test.ts` 七项 | [independent-14.log](independent-14.log) |
| 固定脚本构建 | `npm run build:script`，退出 0 | [build-script-final.log](build-script-final.log) |
| 脚本活动与 worker 停止 | `npx tsx --test test/104-workflow-script.test.ts test/100-worker-stop.test.ts`，68/68，零跳过 | [activity-script-accepted.log](activity-script-accepted.log) |
| 操作效果分类 | 104/100/64 联合 77/77 中的 `test/64-tool-op-ledger.test.ts` 九项；分类器此后未改，受影响的脚本部分另行复核 | [execution-accepted.log](execution-accepted.log) |
| 普通核心任务与委派 | 下方完整命令，144/144，零跳过 | [ordinary-accepted.log](ordinary-accepted.log) |
| 原两方向导入与发布组合回归 | `npx tsx --test test/85-legacy-instance-import.test.ts test/86-personal-instance-import.test.ts test/91-release-acceptance.test.ts`，13/13，零跳过；导入新拒绝路径随后由 108 复核，91 亦在普通回归中复核 | [import-regressions.log](import-regressions.log) |
| 静态门禁 | `npm run check:static`，退出 0，覆盖 lint、typecheck、notes 与 docs | [static-final.log](static-final.log) |

```sh
npx tsx --test test/01-concurrency.test.ts test/03-lifecycle.test.ts test/04-crash-recovery.test.ts test/05-overflow-db.test.ts test/66-control-seam.test.ts test/80-subagent-delegation.test.ts test/81-subagent-reuse-close.test.ts test/82-subagent-cancel-work.test.ts test/83-subagent-worktrees.test.ts test/84-subagent-integrate.test.ts test/86-subagent-messaging.test.ts test/86-subagent-recovery.test.ts test/88-parent-delivery.test.ts test/91-release-acceptance.test.ts test/94-task-ending.test.ts
```

新增 105–109 当前共有 52 项：35 项状态/重放与竞争，7 项宿主执行，5 项 Runtime 接线，2 项导入拒绝，3 项后台冷恢复。表中证据有重叠，不把各轮次数相加作为覆盖数量。最终静态门禁与独立工程审查均通过，不用旧的 48 项联合结果冒充新增检查已执行。按已核实基点执行 `npm run change-scope -- --base df34a05dc03f1d56fcda2f9e4988603f94503163`，范围记录见[change-scope.log](change-scope.log)。

## 要求与事实

| 要求 | 可核对事实 |
| --- | --- |
| 固定来源、脚本、模型和完整输入 | 105 直接读取定义/运行/步骤 JSON 与事件；来源任务结束后续步骤仍使用原快照，篡改或缺失引用暂停 |
| 共享名额、尝试和墙钟 | 105 的真实 SQLite 子进程争最后名额、最后尝试、取消/启动和预算/领取；107 的普通 SubAgent 等三个工作流释放，实际峰值为三；人工等待、独立分支和问题旁的脚本同步计算分别计费 |
| 幂等重放与顺序 | 完成值缓存、同键异参/异序拒绝、`Promise.race` 分支顺序固定；重发历史暂停请求不再停止新执行 |
| 不重复写入与原始输出 | 真实操作账本标写入、效果未知、混合审批及宿主族只读分类；缺输出/写后格式失败不重试，超限原始字节保存产物并检查缺失/篡改 |
| 父任务结束后的宿主执行 | 106 真实创建 Git 副本、改文件并汇总目标；不创建模型会话，不计 Agent 尝试；ready/call 两阶段停止 false 保留实际身份及源/副本占用，第二次操作不重入 |
| 真正崩溃后的登记/缓存恢复 | 106 后台 SIGKILL 后沿原键执行 queued 宿主任务；109 SIGKILL 分别落在宿主结果已提交而步骤未收尾、只读 Agent 已开始、汇总 host Task 已排队三处；核实旧进程组与计时/占用后只执行必要的一次工作，实际标记字节不重复 |
| 普通路径保持 | 144 项普通生命周期、SubAgent、工作副本、取消/恢复与父级送达回归；单独导入回归和 108 证明新绑定不会静默丢弃 |

109 的真实只读 Agent 用于启动完成后的崩溃窗口，不证明真实 Driver 启动窗口的取消接线。Agent 适配器必须先登记 starting 句柄、再启动并更新实际身份，stop 等待启动收尾；接口和交接明确此责任，04 接真实步骤时覆盖。106 已覆盖本单的真实宿主操作 starting/ready/call 停止边界。

## 诊断与撤修

[diagnostics](diagnostics/)保留施工轮次：`regressions.log` 为 143/144，新增表未加入导入 TABLE_POLICY 导致 91 失败；两方向显式登记并拒绝有执行绑定的源后，当前普通回归 144/144、导入回归 13/13。`workflows.log` 为 41/42，揭示只读中断输出/占用核实不能重排；修复事实补记、账本判定和恢复后，当前 105/109 均通过。`wiring-import-accepted.log` 名称沿用当时尝试但实际是失败日志：107 夹具经正常 stop 已暂停、108 预建目标缺目录，修正夹具后以表中 final/guard 日志为准。其他诊断日志是被新用例或内容变更取代的早期通过结果，不作为新增行为的最终证据。

独立上下文 `runtime_seams` 在隔离副本撤去 109 对应的三项恢复修复，分别看到同键宿主重复写、只读尝试不能续接及 queued 宿主登记不能恢复的负例，然后恢复改动；记录由该上下文提供。最终独立审查 `store_plan_audit` 亲读规格、计划、实际源码及文档，确认本单无未解决工程阻断；亲跑 `npx tsx --test test/104-workflow-script.test.ts test/105-workflow-runtime.test.ts test/107-workflow-runtime-wiring.test.ts test/109-workflow-cold-recovery.test.ts` 为 80/80、零跳过，见[independent-80.log](independent-80.log)；亲跑 `npx tsx --test test/106-workflow-host.test.ts test/107-workflow-runtime-wiring.test.ts test/108-workflow-import.test.ts` 为 14/14、零跳过，见[independent-14.log](independent-14.log)。审查者还亲跑原计时反例、核对作者原始日志与文档范围，`git diff --check` 通过。

`store_plan_audit` 另以真实 `Date.now`、250 ms 预算和 QuickJS 脚本 `const question=ask("q",{prompt:"wait"}); await progress("tick",{}); let sum=0; for(let i=0;i<10000000;i++)sum+=i; await agent("after",{request:"after compute"}); return await question;` 复现活动误算等待：修前经过 483 ms、启动一次 Agent、只计 39 ms；活动通知修复后独立复测经过 257 ms、启动零次、计 253 ms 并暂停 duration_limit。作者同一反例的[实际记录](activity-clock-repro.log)为经过 253 ms、启动零次、计 254 ms。105 的持久进度交付后推进可信注入时钟用例固定捕获旧错误，不依赖机器启动快慢；其他人工停计回归仍通过。

## 未覆盖与后续

本单没有产品入口和 UI，产品体验不适用；尚未执行真实 Driver 的工作流工具/资料权限、冻结成果与独立验证、认证 IM 回答、调度整体收尾、最终回报及定义管理，分别由 04–07 持有。未跑真实模型/IM、03 的 Linux 或 Node 22 矩阵、全量 `npm run check`；02 已有的四格脚本隔离证据只证明其固定入口，不代替工作流联合验收。拥有者在验收后要求提交；未推送、合并或发布。

schema 36 沿仓库规则拒绝旧存储格式，不迁移旧授权；含工作流执行记录的跨实例源明确拒绝导入，原实例资料保留可查。这些边界已经同步模块说明、导入操作说明与决定。
