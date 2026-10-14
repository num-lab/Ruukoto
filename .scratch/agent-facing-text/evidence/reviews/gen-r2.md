# 泛化审报告（第 2 轮，SKILL.md bea80f1c…，同一材料，新执行上下文）

| # | 工具 | 位置 | 规则 | 预期误调 |
| --- | --- | --- | --- | --- |
| D1 | delegate | required 仅 request/key；read_paths 描述「最多 16 个」；源码 278–279 | J1 | 分析委派或 work_id 续委派不带 read_paths 被拒 |
| D2 | delegate | 描述「补充原工作用 work_id（修改继续沿用首次钉定的写入目标）」；mode「仅首次委派可指定」；源码 249、278 | J1、J2 | 续修改工作只传 work_id 被当分析拒绝；按提示补 read_paths 后变成分析执行或被 runtime 拒 |
| D3 | delegate | 源码 261–263 modify 与 read_paths/materials 互斥未写 | J1 | modify 附 read_paths 被拒 |
| D4 | delegate | 源码 319「直接写入…串行」后 327 无条件「子任务已在后台执行；完成后宿主会通知」；416 才说「请结束本轮」 | J3、J7、J2 | 同轮反复 subagent_result 轮询 |
| D5 | delegate | 源码 239 拒绝文本含未定义术语、无下一步；描述未写哪些任务不能委派 | J1、J2 | 回报唤醒轮次续派被拒后换 key/sub_agent_id 重试 |
| R1 | result | 描述「artifact_id 见结果中的产物列表」；源码 399–406、374–376 无产物列表 | J5 | 猜 id 被 454 拒；非缺省任务的产物未提示补 task_id |
| R2 | result | artifact_id/offset/length 无描述；源码 456–458、465 | J1 | length:100000 被拒 |
| R3 | result | 源码 399、402、340、397 多个任务 id 并列 | J5 | 拿父任务 id 当 task_id 被 443 拒 |
| C1 | close | 描述「等任务结束或由拥有者取消」 | J2、J4 | 停下请拥有者而不是 subagent_cancel 再 close |
| X1 | cancel | 源码 521「仍在停止中」；描述未写停止异步 | J7 | 立即 close/复用被拒，反复轮询 |
| M1 | message | 描述与参数「省略 = 发给主 Agent；发送方为主 Agent 时必填」；源码 119 同一定义装配给父会话与子会话 | J8 | 主 Agent 不填接收方被拒后查 id 重发 |
| I1 | integrate | 描述「双方成果都保留供处理」；源码 566、573；副本路径从未给出 | J2 | git diff/worktree list 找副本，多次调用拿不到改动 |

未列为发现：integrate 在子任务未结束时的行为；mode 描述中「计划模式与 SubAgent 自身不能发起」（写不出具体误调）。

审查者对 SKILL.md 的意见：
1. 第 3 步排除条件依赖系统提示，缺材料时口径未定。
2. 模型自己要用的内部路径（副本路径）卡在 J5 与 J2 之间。
3. J8 以推理成本为动机，与第 3 步「必须写具体误调」冲突，纯描述噪音一律不成立。
4. 结果里无条件追加的固定句无规则直接覆盖。
5. J8「让模型能确认自己的身份」未给判断标准。
6. 拒绝文本多在 runtime 层跨包，审计边界未划。
