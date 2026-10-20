# 工单 39：Responses 工具图片快照最小修复方案审查

结论：赞成。实际 SDK 把含图工具结果放在 `input[].type=function_call_output` 的 `output` 数组；现有 actualPayload 分支仅处理 `message.content`，会漏掉该工具图片，最终 seen/expected 不一致而拒绝保存 payload。只补这一已触发的分支，不递归扫描普通对象或字符串，不新增 custom 工具未来支持。

## 读到的实际路径

- `apps/ruukoto/node_modules/@earendil-works/pi-ai/dist/api/openai-responses-shared.js` 的 `convertToolResultOutput`：含图片且模型支持图像时输出 `input_text/input_image` 数组；第269行把它放入 function_call_output.output。
- `apps/ruukoto/src/personal-media.ts` 的 snapshot：actualPayload 选择 result.input，却仍仅对 message.content 调用现有 content 转换；因此 user.content 中的入站图可计数，工具 output 内的图未计数。末尾精确 Map 比较正确地拒绝漏图，不应放宽该比较来绕过错误。
- `personal-model.ts` 的 recordedModels：先记录 input；SDK onPayload 经用户 hook 后使用 snapshot(actualPayload=true) 构造并 await record payload，随后检查 signal。SDK openai-responses.js 在 onPayload 返回之后才调用 client.responses.create，因此 payload 持久化回调结束后主动 abort 能保持新增 HTTP=0。

## 最小实现

在 actualPayload 的 input 项遍历内，仅当 item.type 精确等于 function_call_output 时，对 item.output 调用现有 content(...,true)。该 helper 仅处理数组；其中 input_image 仍经原 imageUrl 检查，保留 data URL、精确已核实字节、预期 MIME 对应关系及每次出现计数。不要放宽 expected/seen、来源 verify、会话归属、产物身份/哈希或总字节规则，不解析 function_call.arguments 或字符串 output。

## 最窄证据

用已经真实登记并绑定的入站 JPEG 与 capture 工具产生的 PNG 构造 Context，避免两种来源使用相同字节掩盖错误。通过 actual personalProvider(openai-responses) 与 recordedModels 走 SDK 序列化；不能只手造一个 Responses 对象作为唯一正例。

正例先 await record 回调提交带 payload 的快照，再主动 abort。检查 input 与 payload 两份记录、两种来源映射、工具 output 的替换引用、无原始 base64、探针阶段新增 fetch=0；主动 abort 的流无需成功生成文本。旧实现应只留下 input、没有 payload，使新断言先红。

四个负例在 onPayload 里仅变造实际 function_call_output.output：删除工具图、变造图字节、替换未登记外链、重复工具图。都应在保存 payload/HTTP 前拒绝，只有 input 记录，新增 fetch=0。保留普通工具参数及 output 字符串中的 type/image/data 或 JSON 文字不被当作媒体解析的断言。

如果 fixture 创建登记来源使用本机 mock HTTP，分别记录准备阶段和 Responses 探针阶段；“HTTP0”应对应本次待验证的序列化探针，不混淆夹具预先构造的调用。

## custom_tool_call_output 判断

SDK 只有 grammarToolInputProperties.has(msg.toolName) 时才发 custom_tool_call_output。该 Map 由已声明工具的 constrainedSampling grammar 和 supportsOpenAIGrammarTools 能力建立。当前 SDK 能力默认false，personalProvider未提供 compat 覆盖，个人端工具也未配置 grammar/constrainedSampling。因此当前产品路径不可产生这一类型，不需要同改。将来启用 grammar 时再以实际路径和快照增加支持；现在既不承诺支持，也不用合成未来类型扩大修复。

本轮只读方案审查，未改根仓库，未读取真实 IM/模型凭据，未调用模型/HTTP或操作 live-profile。实施后的独立运行与真实组合复核另记。
