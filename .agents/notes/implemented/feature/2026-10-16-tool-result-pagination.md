# Agent Note: 工具结果的结构化字段按字节分页

Status: implemented

## 问题

桌面定稿界面的 more 需要读完长 Edit 补丁与 Write 原文。`read_tool_result` 的预览上限是每字段 64 KiB，`read_history_entry` 只能分段读普通结果文本，不能恢复独立保存的补丁或对应 Write 调用原文。拥有者于 2026-10-16 授权补齐最小后台支持，保留既有工具结果成功判定。

## 决定

`read_tool_result` 保留不带 `field` 时的全部预览参数与响应；新增 `field: text | patch | writeContent` 和可选的 UTF-8 字节 `offset`，附加单一 `content: BoundedText | null`。分页模式附带的旧字段预览固定为 16 KiB，content 按请求 length 读取，避免文本、补丁与分页正文在 JSON 六倍转义时超过 1 MiB 应答帧。`content` 严格取指定原字段，缺失返回 null，空原文返回总长为零的空页。补丁只取 Edit details.patch，Write 原文只取最近匹配工具调用参数，不从普通结果文本反推。

分页 length 默认 16 KiB，显式值为 4–65536 字节；下限保证下一字符最多四字节时仍有进展。offset 默认零，必须为安全非负整数及精确字符边界，超过总长或切在字符中间均报 `invalid_params`；总长处允许空末页，缺字段仅接受 offset 零。core 用带 code 的 HistoryReadError 报数据相关偏移错误，控制面校验外部参数类型，Runtime 沿原会话归属读取。

`content.offset`、`totalBytes` 与 text 的实际 UTF-8 字节数用于核实连续性和终点；沿用 BoundedText 的 truncated 语义，后续末页因省略前缀仍可为 true，不能拿它判断是否还需续读。查询不保存服务器游标；同条不可变历史字段总长固定，后续会话条目追加不改变它，客户端不得跨条目或字段拼接。返回原始内容不证明工具成功，调用者仍按原工具状态、effect_unknown 与 isError 判定是否展示。

## 既有笔记审计

按 read_tool_result、readToolResult、历史分段与 UTF-8 检索 proposed、implemented、rejected。与[桌面客户端提案](../../proposed/architecture/2026-10-15-desktop-client.md)部分重叠：其读取资格、失败及空写入边界保留，64 KiB 总读取上限由本篇扩展为单次预览/分页上限。其余命中涉及模型上下文、工作流参数、历史快照或 IM 分段，不改变这些决定。

## 备选方案

- 为 text、patch、writeContent 同时增加分页元数据，保留三个可并行读取的入口。三个字段长度不同，共用 offset 会产生不同的返回位置与终点；当前调用者一次只展示一个字段，选择单一 content 减少游标含义。
- 从 read_history_entry 的普通文本提取补丁或 Write 原文，直接复用现有分页。它不包含独立结构字段，无法可靠恢复内容或区分空写入与缺失，因此不采用。

## 后果

旧 TUI 与桌面预览调用不迁移，分页调用可使用原控制面认证、会话归属和持久条目身份。没有新文件读取能力、存储格式、数据库版本或工具执行行为。每页仍解析当前会话 JSONL 并携带旧预览，不缓存完整结果；超长会话的重复解析成本保留，出现实际读取瓶颈时再测量并调整历史读取实现。

`test/11-history-read.test.ts` 同时覆盖 core 边界和真实 Runtime/ControlServer：中文与 emoji 跨页、超过 64 KiB 的两个结构字段、追加条目后总长固定、旧调用预览不变、字段缺失、空写入、失败 isError 保留、非法参数及最坏 JSON 转义下的帧上限。桌面 more 的加载、拼接与过期响应由正式迁移调用方单独验收。
