# 委托 918 报告正文与宿主事实逐句核对

对象：真实 QQ 新委托 918 的最终报告（557 字符，`delivery=sent`，来源为原 QQ 入口）。目的：核对正文每项事实，避免重复旧 792/593 报告中“仍要求核实”“误称未发送”一类偏差。核对依据是同一档案的宿主查询与 durable 任务记录，不依赖模型自述。

| 正文主张 | 宿主事实 | 结论 |
| --- | --- | --- |
| 成员 1，completed，stopVerified=true，partial=false 无截断 | 委托 918 `total=1、active=0、state=reported`；成员工作 928 `state=completed、stopVerified=true`；工作结果 `partial=false、totalChars=296` | 一致 |
| 工作 928 复用同一空闲身份 agent 801 | 工作 928 记录 `agentId=801`；该身份来自原“QQ取消审批39”，本轮未新建身份 | 一致 |
| 实际调用 service_restart 恰好 1 次，unit=ruukoto39-test.service | 本轮新服务操作仅 950 一项（另一项 824 为历史未执行、407 为更早轮次）；950 的 unit 为 ruukoto39-test.service | 一致 |
| operation 950，effect=executed，code=command_completed，exitCode=0 | durable 任务 950 `outcome.status=completed`，`result={effect:"executed", code:"command_completed", exitCode:0}` | 一致 |
| mode=auto-review | 档案权限 `default/qq` 均 auto-review；操作记录 mode=auto-review | 一致 |
| approval=拥有者已在原入口批准（consumed=true） | 本人在 QQ 原入口发送 `/审批`（平台消息 815311032）并引用回复「批准本次」（平台消息 1427002127）；操作 950 `consumed=true`、`approval=拥有者已在原入口批准` | 一致 |
| launcherStopped=false，requiresVerification=false | 工作 928 的服务事实字段与之一致 | 一致 |
| 宿主服务事实：重启命令已结束；退出码不证明业务健康 | 宿主投影 `verification` 原文相同；`starts.log` 新增一行、MainPID 由 3463107 变为 4105943，只能证明命令执行 | 一致 |
| 除这一次重启外未执行命令、服务检查、MCP、应用数据、记忆、文件、HTTP、搜索、浏览器或新建委派；未发 IM | 本轮时间窗内新增任务只有广播输入、`pi.generation/pi.tool`、`ruukoto.background-work`、`ruukoto.service-operation`、报告与命中输入；无 command/MCP/浏览器/应用数据类任务；无成员 IM 发送任务 | 一致 |
| 无失败项、无遗漏，目标已完成 | 委托成员全部停止且无 `unverified`；报告任务 941 唯一且 completed | 一致 |
| 无需再次审批或再次 report | 报告任务已封组并 sent；无等待中的审批项 | 一致 |

补充边界：正文没有评价本次发送状态，符合报告模板要求；但这是单次真实样本，不能据此声称模型永不误述，也不替代 A1 或其他真实环境证据。采集与原始记录见 [qq-approval-image-collect.json](qq-approval-image-collect.json) 与 [qq-approval-message-ids.json](qq-approval-message-ids.json)。
