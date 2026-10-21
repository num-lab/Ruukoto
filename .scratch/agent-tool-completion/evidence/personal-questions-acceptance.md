# 个人持久提问适配验收

2026-10-21；独立工作副本 `personal-questions-04`，基点 `5739a291`。本证据仅对应04工单的提问适配；检索、后台执行、最终组合与真实平台证据由各自验收持有。

## 实际行为

`ask_user` 独立 durable 保存问题、创建 entry、答复 admission、回执与唯一续接 Task；每会话一批，成功立即返回，本轮仅保留状态/输出查询并结束。后续普通聊天继续。CLI及QQ/Telegram原宿主菜单逐题单选、多选、自由输入、Skip或整批跳过，完整核对后提交；题目、选项、答案和已答历史每页正文最多3000字符，确认只在原末页开放，不缩减字段上限。原平台、账号、owner和代次绑定；可信本机可查询与取消IM问题，不能替答。

答案固定实际答复时权限，`ruukoto.question-answer` 显式来源串通工具、委派、追加、服务、报告、定时与浏览器，不走普通输入默认权限。Task固定原键接main，发送未知不重发。恢复双向核对全部document、原工具、不可改entry、回执、Task、Submission/Inbox；索引与document一起丢失仍拒绝。新扩展首次启用核实旧未决工作；定时与子会话不取得提问工具。

## 验证

- 最终 `npm run check:static` 通过：lint、根与所有workspace及foundation的typecheck、notes和docs门禁。副本外部依赖用只读链接，workspace包解析回副本，未改根依赖。
- 最终定向回归 `npx tsx --test test/personal-questions.test.ts test/personal-cli.test.ts test/personal-telegram.test.ts test/personal-qq.test.ts test/personal-work-tools.test.ts test/personal-delegations.test.ts test/personal-reports.test.ts test/personal-scheduler-authority.test.ts test/personal-browser.test.ts`：195项，194通过、1项原有跳过、0失败，23.9秒。
- 前一轮14文件扩大回归另覆盖personal-work/work-notes/services/service-operations/scheduler-controls：396项，395通过、1项原有跳过、0失败；随后实质补修的提问、菜单、恢复与来源调用方由最终集合复核，不将旧结果外推到新代码。
- 提问窄测覆盖待答聊天、唯一消费/同键冲突、答复时模式、文件和模型委派的新来源恢复、调用门、规范输入之后来源损坏及payload重新加回业务工具的零HTTP外发、索引/document与不可改entry反链、SDK数字题干/label及字符串布尔值规范化恢复。
- 三处真实SIGKILL：question admission提交后而tool result未落盘、answer admission提交后、main新来源entry提交后；重开仍仅一条原问题、一份答案Task和一个续接Submission。
- 模拟QQ/Telegram测试覆盖同数字身份跨平台不能替答、quote伪造不消费、原菜单逐题多选/Skip、换代失效、unknown发送重开不重发；最大合法3题及3个4096字答案完整分页提交、已答历史分页和重开通过，每条发送不超过3900字符，多选标记跨3000字符阈值取消后仍有有效页。
- CLI使用真实Unix socket验证菜单选择、Skip、整批核对、发送前原请求文件及丢答原键回执恢复，不要求人填写内部编号。`git diff --check` 通过。

实际SDK规范输入与HTTP payload保存在[离线请求证据](personal-questions-offline.json)，同次请求分别保存两边界，含4个实际HTTP请求和8条记录。按UTF-16字符数/4向上取整估算：`toolSchemas` 4235→4476，`systemPrompt` 119→119；前值从同次原请求移除新增ask_user取得，不伪称另一场真实模型请求。

## 独立实现审查

`plan_delta_review` 在独立上下文读取实际实现，亲跑问题相关4文件19/19通过、零跳过，确认无剩余阻断。发现并闭合三项：不可改entry反扫、合法长菜单完整分页、SDK规范参数恢复。审查同时核实三处SIGKILL、双平台错答、CLI原键恢复及跨页阈值回归。未重复全量静态或396项，未使用真实模型与IM凭据。

## 未验证与交付

真实模型结果见下一节；本片未使用真实QQ/Telegram凭据，模拟HTTP/WebSocket与菜单不记为真实平台验收。[最终组合](personal-final/README.md)负责根工作区和产品环境验收。未提交、推送、部署或改变日常实例，个人切片工程证据不能单独将04整单记为完成。

## 追加真实模型证据

源码冻结后按拥有者明确授权读取指定模型配置，独立 `deepseek/deepseek-flash` 验收通过；未复制凭据配置或修改日常实例。真实ask、待答期间普通聊天、多选/Skip/自由口令、同键唯一续接及答复时full_access来源的实际read_file/write_file全部通过，6次请求/12条规范和payload记录；详见[真实模型证据](personal-questions-model/README.md)。真实IM缺口由最终组合交接继续持有。
