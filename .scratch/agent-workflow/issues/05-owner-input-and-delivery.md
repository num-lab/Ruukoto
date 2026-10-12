# 工作流人工等待与最终回报

Status: planning

## 目标与边界

落实[规格 A4、A7、A10](../spec.md)，依[实施计划](../implementation-plan.md)四、五、六节接入可信拥有者回答、工具审批和双产品最终回报；业务回答不得作为工具批准。

## 实施与交付

1. 保存问题与回答、匹配的运行/步骤/入口代次和请求键；在事务中处理回答与取消的竞争、重复回答和过期状态，重启后可查询和继续等待。
2. 工具审批仍使用已有任务/操作/权限版本，问题等待走独立业务状态；到限、回答、批准和取消不得互相替代。
3. 工作流子结果只送协调器；最终结果提交后以稳定键送达。为 dev 新增经来源核实的内部汇总唤醒，main 沿原拥有者 IM 目标回报。
4. 定时来源等待名下完整工作流，取消级联，最终只有调度回报路径；入口换代不改发，发送效果未知不重发。
5. 保留暂停、取消及未核实停止的可查询事实；业务问题的通知失败不能伪装成已回答或自动批准。

主要落点为 runtime 的 parent-delivery/orchestrator/内部提交、control 协议与服务、channels 的 IM 控制解析/审批/调度归属、已有 outbox。

## 验收与交接

依赖 [04](04-step-capabilities.md)。新增回答绑定、恢复与通知去重用例；相关回归为 `test/66-control-seam.test.ts`、`test/77-im-approvals.test.ts`、`test/89-im-entries.test.ts`、`test/93-im-approval-lifecycle.test.ts`、`test/37-scheduler-outbox.test.ts`、`test/51-generic-scheduler.test.ts` 与 `npm run check:static`。

同步 control/channels/scheduler/runtime 说明。离线平台替身与真实 IM 证据分开；真实发送、日常聊天可用和回答体验在 07 验收。本单当前未实施。
