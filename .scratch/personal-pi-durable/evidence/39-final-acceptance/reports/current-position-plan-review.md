# 当前拥有者消息位置事实：独立方案审查

2026-10-18，只读方案审查；没有改根仓库、读私钥或发真实模型/IM请求。前一笼统来源section的真实模型B续轮仍只查旧工作，不能把该实现当行为已修。本报告支持下一窄方案，不是新实现终审或真实成功结论。

结论：保留原ROOT+宿主personal section+唯一活动Submission+持久entry kind的来源选择，只在本次prepareInput原始input的最后user消息与原source entry.model中的user逐对象深相等时增加位置事实，是可审查的最小补全；不匹配时沿用原来源说明，不宣称位置，不更改工具/权限/历史。无需改写消息或新增purpose框架。

实际SDK依据：

- pi-durable/dist/harness/generation.js在prepare固定cutoff，在request以`runtime.context(...,{at:cutoff})`读取该范围；context.js明确界限内entries不可变，消息数组按已捕获范围派生。并发model-visible write经inbox排队，于工具/最终边界放置，不能在已交给prepareInput的数组中插队。
- compaction.js使用独立摘要system和序列化历史user，虽然sessionId和活动owner可能相同，但没有宿主personal section；原结构gate继续排除该请求。
- generation.js的onYield续写能追加合成user但沿用原run.inputs。这是不能仅凭唯一Submission无条件声称“最后user身份”的具体SDK形态；当前个人装配未注册该hook，深相等fallback仍是更稳妥的本地事实判定。
- personal-skills.prepareTranscript只替换原user的content，不改变其位置；因此在技能展开前做原消息对照，再给同位置追加事实合理。媒体恢复同样不改变user位置，实际provider转换由已有请求记录验证。

建议匹配时文案：`本轮来源为拥有者输入，当前最后一条user消息承载本轮要求；它是独立输入，不属于此前宿主汇总参考的正文。请按本条要求与已记录权限处理。` 不匹配沿用已审原来源句。报告来源维持只读说明。避免泛称“参考只约束自己”或断言旧正文绝无相同字符；这里只确认原消息独立位置，不按模型自报选择消息，也不替拥有者决定必须新建后台。

最窄验证应保留失败参考→新owner、同活动owner并发compaction、未知kind/报告只读/浏览器旧门禁；新增一个实际最后user不匹配的fallback断言，不能把合成user或压缩摘要称为原owner。应证明位置文本进入现有input/payload，显式skill展开后仍保持原位置与来源，不需要对所有参数再加运行时框架。

## 有界真实对照脚本的安全边界

另只读审`/tmp/ruukoto39-qq-position-candidate.mts`，SHA256 `1480eda81ebda000f4254f7cfa22e353f91e5e62e8226a0f7701811a50fa3036`。脚本readOnly打开已保存SQLite，media.prepare仅核原图片/读引用；投影commit是只读适配，无产品执行器、live admission或IM发送。模型fetch限定选中origin，每步一次、新增最多2次、累计最多5次；其它工具意图即停。只允许两种精确历史只读查询，必须唯一原结果，回放只改toolCallId，不执行background_work。

该脚本边界可接受；建议发HTTP前显式核对captured.input最后user与entry453原user深相等，以证明位置文案的前提，而不只依赖固定id标签。脚本自身只扫选中模型密钥四种变体，最终归档仍需根按本轮四份凭据规范补扫。没有运行该脚本，不报告其模型行为。
