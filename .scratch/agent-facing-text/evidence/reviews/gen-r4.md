# 泛化审报告（第 4 轮，SKILL.md 8577506f…，第 3 轮材料，新执行上下文）

审查者自报越界：列出了 `/tmp/aft/` 目录（看到其他文件名）并在文件系统搜索 SDK 安装路径；未读取其中任何文件内容，结论未用到。

| # | 工具 | 位置 | 规则 | 预期误调 |
| --- | --- | --- | --- | --- |
| D1 | delegate | 描述与 `work_id`「修改继续沿用首次钉定的写入目标」；`read_paths` 未说必填；`subagent-tools.ts:249`、`:278`、`:261-262`；`subagents.ts:338-340`、`:346-347` | J1、J2 | 续修改只带 work_id 被拒→加 mode/target 被拒；唯一可行组合未写，L262 理由暗示修改不需 read_paths，模型另开新工作丢上下文；只读续派与协作加入同样撞 L278 |
| D2 | delegate | `mode`/`target` 描述未写与 read_paths 互斥；`subagent-tools.ts:261-262` | J1 | modify 附 read_paths 被拒 |
| D3 | delegate | `subagents.ts:76` 上限 3；`:405-408`、`:512` | J1 | 连发 5 次，第 4、5 次被拒 |
| D4 | delegate | `read_paths`「仅限开发会话」、`materials`「仅限 main 会话」；dev 系统提示无「开发会话」一词；`subagent-tools.ts:272` | J8 | dev 会话传 materials:[{kind:"text"}] 被拒 |
| D5 | delegate | `subagent-tools.ts:318-327`「子任务已在后台执行」；正确下一步只在 `:410-419` | J2、J5 | 本轮内轮询 subagent_result 才得「请结束本轮」 |
| R1 | result | 描述「artifact_id 见结果中的产物列表」；`subagent-tools.ts:395-422`、`:453-454` | J5、J1、J2 | 找不到产物 id，猜 id 被拒 |
| R2 | result | 描述「供挑选继续或复用对象」；总览 `:374-376` 无取消标记；`subagents.ts:373-376` | J5 | 续派已取消工作被拒 |
| R3 | result | 总览输出 `agent.state`（`:340`）；`subagents.ts:232-236` 自动置 unverified；`:1172`「等当前任务结束」；退出只有拥有者核实 `:261-276` | J3、J2 | 反复重试复用或轮询；消息 pending 不投递；未写改建新 SubAgent 或报告拥有者 |
| C1 | close | 描述「等任务结束或由拥有者取消」；`subagents.ts:678-682` 只给拥有者 CLI | J2、J4 | 请拥有者执行或用 bash 跑 `ruukoto cancel`；本可 subagent_cancel 再 close |
| M1 | message | `subagents.ts:1288`、`:1302`；SubAgent 只装配 subagent_message | J2 | 协作加入方猜 to_sub_agent_id 被拒「SubAgent 不存在」 |
| I1 | integrate | `subagents.ts:1082-1087`「或让 SubAgent 继续修正后再汇总」；汇总套完整差异 `:1077-1078` | J2、J4 | 部分汇总后续派修正再汇总必然冲突，循环 |

未覆盖：messageStateText；dev 会话通知送达方式；「待提交改动区」是暂存区还是工作树；Error 是否原样交给模型；main/scheduled 身份。

SKILL 意见：只有首轮快照时如何判断运行时分支会否走到；兄弟描述与错误文本冲突时第 3 步怎么判；J8「能确认身份」无用词标准；宿主拼给 SubAgent 的任务输入是否属被审对象；状态枚举值归 J2 还是 J5。
