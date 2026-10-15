# 05 最终独立审查 v2 补充

独立补充审查通过：新旧三处测试夹具均保持真实来源与权限合同，未改变生产授权、运行前/发送前/响应后复核或唯一报告规则。本版固定62项输入、27个修复文件；27个修复文件与独立私有包解析副本逐项相同，其余已审输入与主区摘要匹配。Linux 原完整 runner 仍沿其冻结对象执行，本审查不把最窄通过拼成完整 check 通过。

原 `05-final-independent-review.md`、60项清单及原归档保持原字节。原60项仅 `test/84-im-final-delivery.test.ts` 一行由本版取代：旧摘要3191c29a8925970f647a30bfd2a7e11edb099679f78435f5bf00dd6bfa45c33c → 新摘要8e370c8a71ca76238b91b8431cfe70eea878f73408bdef6373fb58cc40b09a76；其余59项未变。另增10-access-modes与125-agent-wait-resource两项，unique修复数从25到27。原R1–R14、两项实现阻断及GitHub固定入口结论继续沿未变来源适用，下面补充R8/R14及测试层次核查。

## 保护根夹具

原10使用宿主真实 `/var/lib/ruukoto`，root保存的三目标原探针均在遍历其service-ops目录时报EACCES。production approved-ops.ts:66–126的身份核实与失败传播未变。新测试以自有canonical临时根创建真实protected/work目录，保留文件系统根祖先拒绝、直接祖先拒绝、兄弟允许三项语义，清理仅限自有目录，不mock、不吞权限错误。独立最窄1/1、0跳过、exit0、1343.216667ms；完整说明见 `05-protected-root-independent-review.md`。

## Driver父级注入夹具

原125两例已mock注入候选与消费，但遗漏新增真实Runtime recheck；伪造无work普通Task按安全合同本应拒绝。补丁只在同一Driver测试接缝补recheck，逐次核会话、结果列表及消息列表且至少一次，继续核成功消费1次/失败0次；新增两分支模型请求确含已记录子结果且恰发送一次，排除提前拒绝假绿。真实来源资格仍由8个Runtime/Driver边界例验证，不改生产。独立反向应用旧夹具1通过1失败、exit1，再恢复候选核hash；候选最窄2/2、0跳过、exit0、1773.260916ms。完整说明见 `05-parent-injection-independent-review.md`。

## 来源停用后的IM结果唤醒

独立读取84作者原红栈和活实例诊断：子Task completed并保留SUB-RESULT，QQ停用后wake已canceled，errorMessage=subagent_source_invalid、wake选择记录0；旧测试等待completed而超时，原ACCEPTED是唯一已发送notification。代码链为 verifyWorkflowSource(runtime.ts:1108)拒失效入口 → verifySubAgentSource拒来源 → ParentDelivery.wakeUnavailable → queueLoop按原因取消，符合R8/R14消费前撤销要求。

新84仅更新A分支：要求精确canceled原因、无新增模型请求/编排器汇总请求/wake选择记录、零汇报op与skip、仅原受理外发，同时保留completed child结果、work未取消和原wake键。B的已pending汇报在改配置后取消、零新目标发送的原断言字节不变。该同步强化来源撤销断言，不能为抵达旧channel skip而放宽生产来源门。

在独立副本应用固定patch c78057e4ae405f361b81edda58614433e973ee8cbe2f5646f08c62e84171d245，亲自执行 `npx tsx --test --test-name-pattern='^目标变化不改发：' test/84-im-final-delivery.test.ts`：1/1、0跳过、exit0、1831.639542ms，实际包含A/B两分支。channel层旧skip保障未删，独立执行 `npx tsx --test --test-name-pattern='^owner 回复与工作汇报：' test/89-im-entries.test.ts`：1/1、0跳过、exit0、149.726792ms，仍精确断言work_report:target_changed、零新op、旧null目标及外部来源拒绝。

本补充不执行真实模型/native，也不冒称Linux最终全量或外部平台已通过。原基线49项失败、Linux原完整检查及新夹具后续验证分别保留；最终模型报告、137prompt字节独立核查和macOS24/24后续证据由汇总单列，不与本次测试相加。拥有者主观体验和未检查的外部MCP/IM配置/平台仍不自授通过。

精确输入见 `05-final-independent-inputs-v2.json` / `.sha256`；本版只补充实现审查范围，不改变工单产品状态。
