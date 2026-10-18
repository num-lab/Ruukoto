# 剩余 app 部分补跑的失败分组

源日志 /tmp/ruukoto38-app-rest.log 已收尾，exit 1；runner 报 2542 项、2480 pass、40 fail、3 cancelled、19 skipped，约 1306 秒。失败详情区共有 43 个 block，包括文件级失败与取消；不能称为 43 个独立已归因缺陷。本批包含自有进程有界 INT 和后续失效测试契约，不代表最终完整覆盖。以下分组按详情/旧源依赖描述，不认定同因。

| 详情分组 | block 数 | 实际表现与局限 |
| --- | --- | --- |
| 旧工具契约涉及的用例 | 15 | 113 四项、115 一项、40 一项、49 四项、51 三项、85 一项、subagent-source-capabilities 一项；分别仍要求 schedule_query/notification_query/notification_enqueue/schedule_cancel。日志含显式缺工具正断言、paused!=succeeded、无结果TypeError和等待超时。该源依赖证据不等于证明每次超时只有这一原因，待修订后窄验。 |
| 112 真实修改验证 | 8 | 个人首项 Assertion 明确 reason=script_cpu_limit，change completed/validate running；Code 及另六项为等待工作流/验证/冻结后等待超时。profile 仅定位其中自有 PID 某一秒的同步保护目录身份扫描，不包办解释各失败。 |
| 118 Code 重复回答 | 1 | 原回答核实不重复推进或发事件，事件数 actual=63/expected=61；独立保留，尚未归因。 |
| 122 Code 六输入 | 1 | 等待六输入整项回报超时；不能记为原 native 回收失败。 |
| 125 agent_wait 双产品 | 2 | 等待父轮真实工作流完成超时。 |
| 22 自动审查 | 3 | 自动批准、确定性转人工、审查超时三项均等待任务完成超时；未从这里证明具体底层原因。 |
| 45 GitHub | 5 | 均为 TimeoutError: The operation was aborted due to timeout；未得到业务 Assertion，不能由单个112 profile归因。 |
| 83 integrate 停止边界 | 1 | 等待目标临时单元产生超时；无 reaped/identity_unavailable 事实。 |
| subagent-workspace-snapshot | 3 | 双产品 reviewer 终态及保护任务终态等待超时。 |
| workflow-role-integration | 1 | ruukoto 普通审查完成超时；同文件 Code 后项通过。文件后续在自有INT记录内，须保留中断上下文。 |
| personal-tools | 1 | 单项 60000ms timeout；文件后续在自有INT记录内，不能记为完整文件覆盖。 |
| 32 / personal-command-work 文件级 | 2 | 仅 test failed；对应自有INT记录，不据此推新业务故障。 |

仅按日志现象重新计数：25 个 waitFor 等待超时、5 个 Abort TimeoutError、3 个测试 timeout、6 个 Assertion、2 个 TypeError、2 个文件级 test failed。这个维度与上表是同一批 block 的不同切分，不能相加。原全仓 native101 的 reaped:false/identity_unavailable 不在本部分详情中，仍独立保留，不与112或36合并。

汇总者已核实并更正 app-rest-interrupt.json：plannedTargets=5，actualSignalsSent=3；另两个计划目标在枚举前已退出，加上32单独JSON，实际共4个自有INT。未把计划数量写成实际发送数量。

详情与每项旧工具依赖见同目录 failure-groups.json；原日志 SHA 与 runner 数字一起锚定。没有重跑测试、修改断言或主树源码。
