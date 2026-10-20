# QQ图片拒绝与TG定时回报只读取证

2026-10-19（JST），只读核对当前真实档案的私有一致备份。没有开第二Harness、创建计划、调用模型、重启服务或发送IM；通过mode=ro SQLite backup取得独立快照，远端/本机快照SHA256均为7cb907dc2d45d26181592a6ffd60600c340554ff8739f07990aa7ef6bb744325，quick_check=ok。完整库只留本次0700私有目录，不纳入拟交付小包。原始全文与记录均未改写。

## QQ：下载拒绝，没有新图进入模型

| 原消息 | 原媒体与收件 | 结果 |
| --- | --- | --- |
| 880487927 | mediaDoc641，received entry642，receiptDoc643/task644 | media rejected/download_unavailable，artifacts=0，无Submission；明确下载失败回执已sent，平台消息1833531421 |
| 940475107 | mediaDoc659，received entry660，receiptDoc661/task662 | 同样rejected/download_unavailable、artifacts=0、无Submission；拒绝回执已sent，平台消息2091129559 |

两条身份均与原私有event的图片file匹配。原event是HTTPS gchat.qpic.cn，无userinfo，identity有效，当前代码明确允许该精确主机。因此本轮不能再归为先前漏.com.cn主机修复，也不能说新图已成功入模而模型忽略。后续entry666是单独纯文字pi.user，没有image part；assistant671从已有上下文回答旧TG图，没有消费新QQ图。

原URL只在进程内使用，未复制原event，不输出/归档完整URL或rkey，没有附带OneBot连接token。Oracle单次GET、redirect:error返回HTTP400、text/plain、0字节、无Location，空体SHA256=e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855；这与personal-media对非429的4xx归类download_unavailable一致。该采样晚于原收件，不能证明原收件时恰是400或将过期URL/地域/CDN策略推断成唯一根因。

本机GET有一次发起，但最初取证编排的远端eval换行语法错误使主进程在本机metadata落盘前退出；不把它记作成功，也未重复本机请求。远端前置脚本错误发生在GET前，修正后只有上述一次实际GET。当前缺本机status/MIME/体摘要对照；若仍需该对照，应另获一次预算。原失败工具输出与脚本保留，不能据缺记录声称本机可下载。

对应事实和探针metadata：qq-image-facts.json、qq-image-records.json、image-download-probes.json。没有采集图片内容或原始下载地址入包。

## 定时：整项业务和原入口送达成立，正文有偏差

原TG消息550→receipt/submission676/entry675→模型schedule_create task681（原assistant指令与保存的plan.instruction逐字相等）→plan74e4327c…/runef78ab58…；完整ID及接纳链见schedule-fact-chain.json。

运行Task694、独立conversation688，只有成员work717/agent711；子Task completed，纯算术结果187×239=44693与固定文本正确。宿主sealed，summary admission745/submission747→assistant752→result753(status=completed)；sendTask754/admission755/claim756→observation757，state=sent/platformMessageId552。保存目标与原消息550的bot/owner/generation/权限快照一致。assistant752、result753及固定发送正文逐字符相同，没有改写或改路由。

未改全文在schedule-answer-original.txt，共562个UTF-16单元；其SHA与完整plan/run/task/entries保存在schedule-original-records.json及fact-chain中。这证明真实定时独立会话、单次派生子工作、整项收尾和原TG入口送达，不计其它计划规则/漏期/取消/未知窗口；本次没有重开或重发来验证新的故障点。

正文偏差分两项：

- 创建计划的主模型将root背景工具的report/progress步骤写进独立定时instruction，实际定时工具只有delegate/list/result/cancel。初答744先把这一自造编排步骤写成动作缺失，最终752再次称失败；独立定时并不缺最终汇总能力，本轮宿主已经自动封组、汇总并送达。原工具schema没有错误开放report/progress，错在主模型生成的目标说明和最终解释。
- 最终正文称“本次运行全程未发生任何 IM 发送”，随后宿主按固定原目标真实送达552。生成正文时尚未发生后续发送，不能把该局部时间事实扩成整次运行结论。宿主发送正常不等于全文准确。

## 最小agent-facing修复

不改运行状态机、工具权限、旧记录或旧plan，不重跑已执行任务。只补两个实际使用点：

1. schedule_create的instruction字段描述补目标会话语义：`完整任务和明确资料，不依赖主聊天中的省略指代。独立定时会话的background_work仅支持delegate/list/result/cancel；安排完子工作后结束初轮，宿主自动封组、等待全部成员和外部核实，再请求本会话汇总并固定回报原入口。` 主模型在填写目标说明时就能看见目标动作集合与auto-seal，不能只依赖它未看到的定时工具说明。
2. summary参考末段明确正文范围，例如：`本轮已封组。只查询本轮结果，汇总业务结果、失败和未完成之处；不能发起新的操作或委派。本回答只交付最终报告正文，生成后的回报状态由宿主记录并供查询，正文不评价本次运行的发送状态。` 不在多处追加笼统禁令，不伪造将来sent事实，也不从模型正文改写宿主发送状态。

最窄回归是在现有实际PersonalHarness请求里读取schedule_create schema的instruction描述，以及实际汇总input末段；应在旧文本下缺说明而红，新文本下同时看到四动作/自动封组和正文范围。保留原独立会话/成员收尾/固定目标断言，工具集合不变。另用一个专门脚本responder消费实际说明，验证不再把root report/progress编入新说明；这只能证明文本契约，真实模型改善仍需后续新授权任务，不重放本次已完成业务。

从原真实请求entry679的实际工具JSON作候选文本反事实估算，使用共享pi-coding-agent estimateTokens(role:user字符串、UTF-16/4向上取整)：systemPrompt237→237，toolSchemas4671→4696；原已保存汇总参考273→281。只有候选参数/末段替换，没有真实after请求，数值不是供应商usage。原文字、候选文字与方法在proposed-text-estimates.json。

## 取证限制与交付

取证首次在SCP尚未结束时误读部分副本产生SQLite malformed；等待传输完成后本机SHA与远端一致、quick_check=ok。该错误来自取证时序，不归产品存储损坏。此后只在完整私有副本上查询。

本次没有读model/IM凭据值；GET下载不带连接凭据。小包只选事实JSON、原定时正文/相关记录及脚本，不复制原QQevent、完整URL或完整主会话库。主Agent仍应按本轮既有四凭据策略补最终归档扫描，不能把本报告中的格式/原URL扫描冒充凭据原值扫描。
