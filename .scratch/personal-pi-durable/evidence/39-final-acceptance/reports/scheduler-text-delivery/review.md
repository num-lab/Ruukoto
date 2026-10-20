# 定时说明与汇总正文交付

根批准的两段文字已原样实现于独立副本，补丁仅含六个文件。产品差异只有 schedule_create.instruction 参数描述和最终汇总参考末段；没有新增动作、权限、计划版本或发送路径，也不修改旧计划及已保存结果。

两个新增回归从实际 personalProvider/openai-completions 发往回环模型的请求取定义与汇总正文，并与持久 ruukoto.model-request.input/payload 核对。创建参数在主拥有者请求中说明目标 delegate/list/result/cancel 与自动封组；独立定时链完成初轮、单子工作、封组、汇总和本机交付，实际 background_work 定义仍恰好四动作。完整工具和系统文本随请求装配，由 payload 等于实际 HTTP JSON 的断言覆盖。

旧文案两例均按目标断言红。新两例与三个相关旧例合计5/5绿；npm run check:static最终完整通过，含lint、全部workspace/foundation类型、notes、links/refs/budgets/wrap。原始失败日志保留：首次绿色尝试的请求计数应为四（初轮工具调用、子工作、初轮续答、汇总），随后schema断言按实际anyOf.const修正；首轮static因副本直接共用node_modules造成根和副本两份私有类类型，已仅调整副本workspace链接后完整通过。产品文字未因这些夹具校正改变。

量化记录使用原真实entry679的完整schema/system，仅替换精确新文案；system237→237、toolSchemas4671→4696、summaryInput273→281，采用共享estimateTokens对role:user字符串的UTF16/4向上取整。after总量是相同真实配置上的反事实估算，不是新增真实模型请求；实际离线装配断言证明最终文字确实进入请求。

未发新真实模型、IM或计划，未重做已完成的TG定时任务。真实原任务552的送达与正文偏差证据保留在/tmp/ruukoto39-qq-schedule-audit；本补丁的离线回归不能虚称已复验真实模型正文。root在整合前git apply --check通过；最终补丁cb0146f8053da77f916dbd9b17058ef09060f389ffc12d735422e21e4912e731已由root整合。

文件摘要与原始日志清单见manifest.json。
