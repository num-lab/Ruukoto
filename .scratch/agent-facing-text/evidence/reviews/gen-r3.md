# 泛化审报告（第 3 轮，SKILL.md ee5f05a1…，补齐材料，新执行上下文）

材料：snapshot-tools.json（完整 systemPrompt + subagent_* 定义）、system-prompts.ts.L20-82.txt、subagent-tools.ts、subagents.ts。

| # | 工具 | 位置 | 规则 | 预期误调（摘要） |
| --- | --- | --- | --- | --- |
| D1 | delegate | 描述与 `work_id`「修改继续沿用首次钉定的写入目标」；`mode`「仅首次委派可指定」；`subagent-tools.ts:262`、`:290-292`；`subagents.ts:346-350`、`:430-434` | J1、J2 | 续修改工作：带 mode 被拒→去 mode 被要求 read_paths→加 target 被拒，三连错 |
| D2 | delegate | `subagents.ts:1171-1172`「等当前任务结束后再委派」 | J2 | 无等待工具，原样重发或换 sub_agent_id 重发，而不是先 subagent_result |
| D3 | delegate | `sub_agent_id` 描述「要求该 SubAgent 空闲且未关闭」；总览 `subagent-tools.ts:342`、`:382-390`；`subagents.ts:1171` | J8 | 总览显示 idle 仍被拒（unverified/活动任务）；或放弃复用另建 |
| D4 | delegate | `mode` 描述未写互斥；`subagent-tools.ts:273-277` | J1 | modify 附 read_paths 被拒 |
| R1 | result | `subagent-tools.ts:402` 直接父任务 id；`:455` | J5 | 把直接父任务 id 当可引用标识；为决定复用需再取总览 |
| R2 | result | length/offset/artifact_id 无描述；`subagent-tools.ts:337-339`、`:458` | J1 | length:200 或 50000 被拒；上限提示与描述措辞不一 |
| R3 | result | `subagent-tools.ts:434-435` messages 正文截到 200 字符无提示 | J5 | 重发 subagent_message 问同一内容，或去 part=reply 找 |
| M1 | message | `to_sub_agent_id`「发送方为主 Agent 时必填」；`subagent-tools.ts:67`、`:113`、`:147-149`；`subagents.ts:850-856`；subagent 系统提示 | J1 | SubAgent 按「必填」填自己或不存在的 id 被拒 |
| M2 | message | cancel 描述只禁继续委派；`subagents.ts:845`「工作已取消：不能投递消息」 | J3、J4 | 取消后发更正被拒，再 delegate work_id 被拒；正确出路（新工作+复用 sub_agent_id）未写 |
| C1 | close | close 描述；`subagents.ts:1171-1172`、`:676-682`、`:243-247` unverified | J3 | 任务已 completed 仍因 unverified 被拒，错误称「等任务结束」与事实矛盾，重读后原样重发 |
| C2 | close | `subagents.ts:680-682`「或由拥有者 ruukoto cancel <id> 后再关闭」 | J2 | 拥有者 CLI 无工具可执行；模型改调 subagent_cancel 取消整项工作 |
| X1 | cancel | cancel 描述「迟到结果保存为事实但不再主动送达」；`subagent-tools.ts:27-29` | J2 | 以为结果仍会注入，漏掉主动读取，后续重做分析 |
| I1 | integrate | `subagents.ts:1073-1074`「等该执行结束后再汇总」 | J2 | 原样重发 integrate 两次后才去查状态 |
| I2 | integrate | 描述「只读分析工作…不能汇总」vs `subagents.ts:1059-1061` 抛错 | J1 | 对全部工作收尾汇总，把失败当环境异常，多两轮 |
| S1 | 系统提示 | `system-prompts.ts:57` | J1 | 与 D1 同一省略，续派印象一致错误；cancel/close 措辞使模型只 cancel 不 close，名额被占 |

SKILL 意见：只有 dev 身份有快照；messageStateText、subagentOpCheck、WorkCopyError 在材料外，标未覆盖会漏掉规则最该保护的区域；J5「两种地址」无判据；第 3 步排除条件在「多处重复同一句错话」时会互相免责，建议写成「已给出正确做法」。
