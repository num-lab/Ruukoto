# 工单 10 独立实现审查

对象：[工单 10](../issues/10-agent-wait.md)、[计划第二节](../experience-plan.md#二等待工具与调度)，基点 `40dcee7` 的未提交实现及新增文件。审查者从独立执行上下文直接读取要求、开发流程、架构、错误处理、实际源码和测试；作者消息只用作导航，未修改根工作区。快照见本记录配套 SHA-256 清单；后续实质改变应复核相应结论。

## 结论

在本次已审实现范围内没有未解决源码阻断。共享等待、安全让出及恢复、默认拒绝业务工具的内部对话、同来源唯一认领/消费/报告、可信隐藏分类、导入归档和 SQLite/JSONL 恢复均有相应实现与离线证据。工程验收仍由实施者结合最终完整检查及平台证据判断；真实模型、真实 IM 和拥有者体验不能从本地替身推断通过。

## 本次发现及闭合

1. 定时汇报只重核工作流和 schedule.sourceRefs，遗漏普通子任务已消费结果的资料依赖。真实 TelegramAdapter + 本地 FakeBotAPI 负例出现 `sent` 而非 `canceled`。Runtime 现按原 schedule_run 重核 AgentReport 目标、依赖闭包和原钉版目标，正例在实际适配器发送前取消且 API 请求为零。
2. 任务/工作流的产物引用无上限。等待引擎现最多返回 100 条 artifactIds，并以 artifactCount 保留总数；原产物不删除。窄用例构造各 101 条引用并验证两类目标。
3. 导入核实遗漏依赖历史内 memory_read 及 app_data 实例。纯 helper 反例实际被接受。现沿已有导入集合核实记忆，Coding 明确拒绝未导入应用库引用，Personal 核实实际保留实例；不扩大资料导入范围，不抹去原引用。两方向正反用例通过。
4. 取消工作后，agent-final 分组后备仍被旧键解析放行；未开始后备取消终态又因仅接受 running 抛 report_owned。真实 Db/Store + ParentDelivery 反例先出现 admitted=true 和 report_owned。现由持久报告绑定核实取消，自动补报的准入、模型/最终登记和适用实际发送均拒绝已取消工作；正常等待父轮仍可消费取消事实。已经真实终态的未开始后备允许按 undelivered 收尾，原任务/键和整组停车身份保留。

## 亲自核实的证据

- 根最终回归 `npx tsx --test test/125-agent-wait-core.test.ts test/125-agent-wait-import.test.ts`：28/28，通过。独立日志原路径 `/tmp/ruukoto-agent-wait-final-review-core-import-final.log`。
- 根回归 `npx tsx --test test/125-agent-wait-report.test.ts test/125-agent-wait-recovery.test.ts`：15/15，通过；该快照 recovery 为 6 例。独立日志原路径 `/tmp/ruukoto-agent-wait-final-review-report-recovery.log`。
- 直接复核 recovery 后续第 7 例及作者实测 7/7 日志，并亲跑最终根快照 `npx tsx --test --test-name-pattern=request-revoked test/125-agent-wait-recovery.test.ts`：1/1，通过。真实 main 已消费两结果后，在 history_search 提交事件撤销记忆，下一 provider 请求被阻断，调用数保持 2、任务 interrupted、报告 undelivered、没有 owner_reply 或 API 发送。独立日志原路径 `/tmp/ruukoto-agent-wait-final-review-next-request.log`。
- 恢复用例使用真实 SQLite、SDK SessionManager/JSONL 和 Runtime 冷启动：父轮/后备 completed 标记已落盘而数据库仍 running 时补原结果关联；只有 assistant 正文而无完成标记时保留原 entry 证明、记未送达，均为零模型调用。复用 SDK call ID 的前轮结果不会被当前父轮误取；撤掉任务范围后负例实际出现 pending 而非 reported。
- main 真实宿主入站和 Driver 两结果共用一份 owner_reply 和发送请求；限流后撤销依赖不再发送。定时负例同样走真实 scheduler.tick/idle 和 TelegramAdapter。FakeBotAPI 是本地替身，不能记为实际 IM 验收。
- 阅读 control/TUI 的查询与事件字段、渲染和真实 view 用例：等待目标标签/状态、资源阶段和新输入中断原因来自持久事实；补报与停车别名从真实绑定分类，普通同名输入不取得该身份；工具资格对 SubAgent、工作流步骤及无工具汇总关闭。

## 未覆盖与后续责任

本审查没有重新运行原生 worker、全量检查、Linux 矩阵或真实模型，以免与实施者同 UID 的停止验证竞争；由实施者把最终源码和实际结果绑定到工单。真实 IM 未授权、拥有者体验未验收，保持待验及恢复条件。schema 40 / 协议 24 沿既有严格版本规则，旧档案不得原地启动或迁移，资料与 JSONL 不改写。交付状态不授权提交、推送、部署或发布。
