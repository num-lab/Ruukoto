# 工单 39：分页界面补全独立审查与真实模型复核

结论：本次原文首字误述复核通过，实现没有阻断发现。新增元数据保持原切片语义和任意 offset 读取；真实模型最终正确报告起始标记完整、生成截断及具体遗漏，固定回报与重开零重发成立。模型仍在已到末页后多读一次空 offset8192，保留为真实偏差，不能写成完全遵循续页规则。

## 实现与独立窄回归

只读审查根仓库的 personal-work.ts、personal-report.ts、personal-work-tools.ts 及三份对应测试；未写根仓库。两个有文本的结果响应分别提供本页 offset 与保存全文的 totalChars，继续使用原字符串切片位置与原 emoji 页末处理。没有 text 的未完成结果不伪造0长度。共享参数描述区分文本与条目位置，补列 report_result，并明确无 nextOffset 是本页到末尾；partial 仍只由模型生成 stopReason=length 得出。新增字段未禁止合法 offset1 或重读，partial 条件提示不再使用“翻完页”措辞。

独立执行 `node --import tsx --test --test-name-pattern='模型输出截断与结果分页|实际委派不阻塞主聊天|原 Submission 完成后真实强杀' test/personal-work-controls.test.ts test/personal-work-tools.test.ts test/personal-reports.test.ts`：5/5 通过、0 跳过，约2.92秒。覆盖 stop/length、短保存片段 offset0 完整与 offset1 切片、模型实际工具路径、多页和 emoji 报告结果字段。日志 `/tmp/ruukoto39-offset-independent-narrow.log`；未重复根持有的60项集合或全量check。

## 真实模型事实

输出目录 `/tmp/ruukoto39-offset-real-IXxLAF`。在原先专供本机验收的隔离档案追加一项拥有者明确说明的独立机械压力任务，复用已空闲身份33；没有重用过时数据库哈希作启动前提。先取得独占 profile 锁并 checkpoint，保存新 before-personal.sqlite；结束再保存 after-personal.sqlite。没有触及 live-profile、真实 IM 或隧道。

使用授权 model-source.json 选择 deepseek-flash，maxTokens=4096，400行给定虚构字符串；模型真实外调新增9次，硬上限12，无额外重试。凭据只在进程环境中供 SDK 请求使用，未打印或保存；输出全文件扫描原值、base64与URL编码三种形式均0命中。

- 原始子回答 entry223 的实际 stopReason=length，保存5990个既有字符串计数单位；起始标记完整，第1至208行逐行完全匹配给定固定文字，第209行输出至“209 甲乙丙丁戊己庚辛壬癸，这是已给定的虚构”，没有结束标记。
- 模型实际收到 offset0/totalChars5990/text4096/nextOffset4096，随后 offset4096/text1894/无nextOffset；两页精确覆盖保存原文。随后又自行读取 offset8192，收到 offset8192/totalChars5990/空text/无nextOffset。没有 offset1 调用；没有将空页或分页切片解释成原文首字缺失。
- 最终报告明确写起始标记完整、5990字符为截断保存片段、第1至208行完成、第209行中断、后续行及结束标记遗漏，与逐行独立核对一致。没有借当前生成阶段误称等待发送或仅存本机。
- 真实宿主通过回环 Telegram 替身将本报告固定发送至 owner456、原消息101，匹配最终报告正文的发送恰好1次，delivery=sent、平台消息3001。整轮2次发送还包括登记回复，不能把2写成重复报告。
- 关闭、重开、查询原报告后模型HTTP仍9、发送总数仍2。进程退出、profile锁可重获，替身端口可重新绑定。原before快照和此前所有失败证据均保留。

原始证据包括 executed-probe.mts、9份实际HTTP body、18份已落盘request快照（每次调用输入/带payload各1）、last-request-payload.json、固定发送记录、before/after数据库、result.json、逐行validation与清理核实。实际系统文本和工具定义都已进入本次请求，未只依据源码断言。

## 同方法的改前改后估算

以此前错误复核实际 last-request-payload 为改前，本轮最终实际 last-request-payload 为改后，取 provider payload 的 system 文本与完整 JSON.stringify(tools)，各包装为一条仅含文本的 user 消息调用共享 estimateTokens。函数按 UTF-16 string.length/4 向上取整，未使用 provider usage、未加校准；旧新采用相同序列化。

| 项目 | 改前 | 改后 | 差值 |
| --- | ---: | ---: | ---: |
| systemPrompt | 107 | 107 | 0 |
| toolSchemas | 3338 | 3364 | 26 |
| 工具数 | 15 | 15 | 0 |

实际两份 system 文本完全相同；唯一变化工具为 background_work 的 offset 参数说明。方法、具体来源和数值在 `prompt-estimates.json`，估算脚本 `/tmp/ruukoto39-offset-estimates.mjs`。

## 保留偏差与范围

一次多余 offset8192 查询说明补全并未让该模型完全遵守“后页只用nextOffset”。它没有改变保存内容、触发外部业务操作或造成这次错误汇总，不能通过收紧任意 offset 来掩盖。原始请求与结果已保留，不继续消费剩余3次HTTP预算。

本次证明这次真实模型报告与给定机械字符串相符，不能据一次复核推广为模型未来均正确，也不替代真实QQ/TG、定时身份或其他能力验收。根负责同步note/docs与最终工单结论。
