# 定时来源文档与模型可见文本核实

2026-10-18，只读根工作区最终9篇文档；根目录 `npm run check:docs` 的相对链接、源码引用、预算和段落4项均通过。README 3346/3350、CONTEXT 10095/10100、development 9670/9700；未提高预算。核对实现/规格未发现需更正文档的矛盾：正式共享 SchedulerStore/Runtime/outbox 与新个人原生调度分别说明；新实现只复用time；固定原权限/工具/资料快照、配置内容变化停止旧计划后续新执行、独立真实来源、自动整项收尾与独立发送、原目标不改发、CLI26及两平台原草稿确认均有落点。浏览器按原完全访问快照向独立定时会话开放，子会话/最终汇总仍不开放；旧共享装配的禁止定时浏览器说明保留并标明适用范围。

## 模型可见文本估算

在独立worktree同步最终app代码后，`npx tsx test/.scratch-schedule-text-size.ts` 以真实 `openPersonalHarness`、本机OpenAI Chat Completions兼容HTTP替身运行主聊天、独立定时首次执行和自动汇总3次调用，未联络外部模型或平台。工具配置只有一个空资料目录和资料/HTTP/搜索/产物工具，无MCP、服务、命令或浏览器；任务22字，无子工作，返回简短固定回答。三份 `*-request.json` 是服务端实际收到的完整HTTP请求，durable有6条 `ruukoto.model-request`（每次规范输入和payload各1条），3条payload与HTTP请求深相等；会话归属依次为1、31、31，后两份不含主聊天正文。

方法：`JSON.stringify({messages: payload.messages, tools: payload.tools}).length` 的UTF-16字符数，除以4并向上取整；仅为可重复的文本体量粗估，不是模型tokenizer或计费结果，尤其中文可能低估。不采用HTTP替身的模拟usage。下表包括工具完整描述/schema及消息JSON结构，排除model/stream等wire元数据。

| 实际请求 | 输入字符 | 粗估token | system正文字符 | 工具JSON字符 | 工具 |
| --- | ---: | ---: | ---: | ---: | --- |
| 主会话 | 7767 | 1942 | 204 | 7466 | background_work、read_file、write_file、http_request、web_search、read_artifact、schedule_create/query/cancel |
| 独立定时首次执行 | 4561 | 1141 | 190 | 4266 | background_work及原资料/HTTP/搜索/产物工具，未带schedule三个工具 |
| 自动整项汇总 | 1664 | 416 | 190 | 1159 | background_work、read_artifact，宿主只准查询 |

主会话新增 `schedule_create`、`schedule_query`、`schedule_cancel` 的单项实际schema分别为1088/372/350字符（272/93/88粗估token）；三项加入tools数组的净增加为1813字符，粗估454token（含3个数组分隔逗号）。定时独立system正文190字符，粗估48token；本次汇总新增宿主事实输入131字符，粗估33token；汇总工具收窄后总输入1664字符。实际任务说明、子结果、MCP定义及历史会改变总量，本次不代表最大上下文或全部组合成本。

## 剩余缺口

- 这次只补文档一致性与离线请求体量证据，不替代真实模型自主选择schedule工具、定时委派/审批与完整汇总、原QQ/Telegram平台的一次真实最终送达。
- Linux原生命令、helper/systemd停止核实与真实浏览器/截图组合仍按工单外部验收要求单独记录；HTTP/平台/浏览器替身不算真实通过。
- 记忆、技能、历史及应用数据消费者的定时组合仍依赖其后续工单实现，不将当前共同来源接口算作这些能力已交付。
- 输入体量只测openai-completions、短说明和无子工作；没有测真实tokenizer、Responses/Anthropic编码、长结果/图片或多工具配置的上界。
