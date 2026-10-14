# 泛化审报告（第 1 轮，SKILL.md 730c2740…）

审查者：独立执行上下文（general-purpose 子代理），只读 `/tmp/aft/gen/`。报告原文的发现编号与要点如下；三项（位置、规则、误调）每条齐备。

| # | 工具 | 位置 | 规则 | 预期误调（摘要） |
| --- | --- | --- | --- | --- |
| D1 | delegate | 描述「补充原工作用 work_id」；源码 249、278–279 | J1、J2 | 只给 work_id 继续工作时 mode 默认 analyze，被要求 read_paths；修改工作被误导补读路径 |
| D2 | delegate | 源码 261–262 | J1 | modify 附 read_paths 被拒后重试 |
| D3 | delegate | required 只有 request/key；源码 278 | J1 | 分析委派不带 read_paths 被拒后重调 |
| D4 | delegate | 描述与 `mode`/`materials` 参数中的会话资格 | J8 | 开发会话里传 materials 被 272 行拒绝 |
| D5 | delegate | 描述「非 Git 目录直接写入并与父会话串行」；源码 319、416 | J3、J7 | 委派后同轮反复 subagent_result 轮询；子任务需父任务结束本轮才开始 |
| D6 | delegate | 描述「结果完成后经宿主通知」；源码 327、18 | J7 | 同轮循环 subagent_result 轮询；截止后行为未写 |
| D7 | delegate | 源码 317 输出分支名与基线提交 | J5 | 用 shell git merge 绕过 subagent_integrate |
| D8 | delegate | `work_id` 参数未提取消/关闭后不可继续 | J1 | 对已取消工作继续委派被拒 |
| D9 | delegate | 源码 239 拒绝文本 | J2、J3 | 回报唤醒轮次里继续委派被拒后换参重试 |
| R1 | result | 描述「artifact_id 见结果中的产物列表」；源码 395–422 无此列表 | J1、J2 | 找不到产物 id，猜 id 被 454 行拒绝 |
| R2 | result | 源码 457–458，artifact length 4–65536 未写 | J1 | length 越界被拒重调 |
| R3 | result | 源码 374–376 总览缺取消状态与模式 | J1 | 继续已取消工作或对分析工作 integrate；或逐个查询 |
| R4 | result | 源码 399、402、340、397 输出发起任务 id 等 | J5 | 把发起任务 id 当 task_id 被 443 行拒绝 |
| C1 | close | 描述「等任务结束或由拥有者取消」 | J4、J2 | 漏写模型自己可 subagent_cancel，停下请拥有者或反复 close |
| X1 | cancel | 源码 521、525「仍在停止中」 | J7 | 取消后立即复用 SubAgent 被拒 |
| X2 | cancel | 描述「效果未知的已有操作只标记、不重放」 | J8 | 无可行动内容，占注意力（轻） |
| M1 | message | 描述与参数「省略 = 发给主 Agent」；源码 106 共用定义 | J8、J1 | 主 Agent 省略接收方被拒后重发 |
| M2 | message | 描述只说接收方忙时的投递 | J7 | 同一指示既 message 又 delegate，重复执行 |
| I1 | integrate | 源码 566、573「可比较副本」 | J2 | 拿不到副本路径，用 shell 猜 git worktree |
| I2 | integrate | 描述「工具工作进程」；源码 572 基线与父 HEAD | J5、J8 | 「父 HEAD 读取失败」诱导 shell 排查 |
| G1 | 族内 | 源码 139、181、183 宿主错误 | J2 | 无法修复的错误原样重试 |

审查者对 SKILL.md 的意见：

1. 只取一份快照，按身份/状态装配的规则核不了；skill 没要求按装配身份各取快照。
2. 同一定义装配给多种身份时 J1 与 J8 方向相反，skill 未裁决。
3. J5 只管多余，不管缺失（R1、R3 只能借 J1/J2）。
4. 「模型要引用的标识只留一个」在多实体工具族中有歧义。
5. J6 只管截断提示，无条件附加的操作指引算不算噪音未覆盖。
6. 步骤 1 要求从事件流取结果原文，本次材料里没有；runtime 层文本无法审。
