Status: resolved
Depends on: 01, 03

# Telegram owner 入口

## 目标

通过 Telegram 私聊使用 main agent，作为第一条日常助手可用链路。

## 实现范围

- long polling 连接；连接 token 通过受保护配置提供，不进入模型上下文和日志。
- 可信配置绑定固定 `user_id + chat_id`；不匹配的消息忽略并记录受限事件。
- 入站消息先持久化，再按稳定外部消息 id 去重和创建 main 任务。
- 消息携带平台、chat、user、message id、时间和回复关联信息。
- 出站目标由宿主固定，main 只生成候选正文；发送经 outbox 完成。
- owner 确认只改变指定操作，不改变任务权限模式；Telegram 消息不能开启 `full_access`。
- 连接断开、重复更新、限流和发送结果未知沿用公共恢复规则。

## 验证

- 认证 owner 私聊能进入同一个 main 会话；
- 重复 update 不重复创建任务或发送消息；
- 非 owner 消息不能触发 main、读取数据或执行命令；
- 断线重连不会丢失已登记但未入队的消息；
- 发送失败和结果未知不会自动重复造成副作用。

## Comments

### 2026-09-24：实施前确认

拥有者确认：① tx 在国内，本次不在服务器测试；② Telegram 内审批另开工单，本期审批仍在 TUI；③ 回复正文按任务读取（不取会话最新一条）；④ 429 限流保持 pending 并按 retry_after 延迟重试；⑤ 本期只做 CLI 与控制面，不做配置中心页面；⑥ 停机积压消息全部处理。

### 2026-09-24：实现交付

- **`src/telegram/adapter.ts`**（新）：`TelegramStore`（核心库 `telegram_config` 单行：API 地址、凭据绑定名、owner `user_id + chat_id`、启停、`config_version`、轮询偏移）+ `TelegramAdapter`（`getUpdates` long polling，只收 `message`；实现调度器 `NotifyChannel`）。无新依赖，直接用全局 `fetch`。
- **身份门**：只接纳私聊、`from.id / chat.id` 与配置一致的文本；其余只记 `telegram.rejected`（id + 原因，不含正文），不登记、不建任务。
- **入站**：经编排器登记（`source = telegram`，外部 id `<botId>:<chatId>:<messageId>`，目标 main），登记成功后才推进偏移；正文固定模板带平台/chat/user/message id/时间，回复消息时附被回复消息 id、发送方与 ≤500 字摘录。
- **权限**：编排器为入站事件建任务一律固定 `confirm`（原先只有 scheduler 来源）；会话默认 full_access 不再被继承。
- **回复**：编排器新增 `onInboundTerminal` 回调，在结果事务内登记 `owner_reply` 发送操作（发送键 = 入站事件 id，目标须与登记消息的 bot + chat 一致）；正文用新增的 `Runtime.readTaskReplyText(taskId)` 按任务历史条目读取，编排器子任务摘要也改用它（修掉同一个"读会话最新一条"的问题）。重启巡检补记结果时同事务补登回复。定时唤醒/子任务唤醒不自动外发。
- **发送**：`reply_parameters` 关联原消息，纯文本，超 4000 字截短。2xx → sent；429 → 新增 `RetryLaterError`，调度器把操作退回 `pending` 并写 `not_before`，到时同一操作再领取；其他 4xx 与连接未建立 → failed；5xx/超时/中途断开/回执不可解析 → effect_unknown。token 在 URL 中，错误信息入库/日志前脱敏。
- **补派**：调度器每 30s 补派已登记未派发的入站事件，范围从 scheduler 放宽到所有来源。
- **schema v13 → v14**：新增 `telegram_config`，`notification_ops` 补 `not_before` 列。
- **管理入口**：控制面 `telegram_configure / telegram_status / telegram_set_enabled`，CLI `ruukoto telegram configure|status|enable|disable`；凭据 purpose=`telegram_bot`、host 须与 API 地址一致、配置后 scope 收紧；`--api-base` 可指向受控反代（https，http 仅回环）。dev 实例注入 `RUUKOTO_DISABLE_TELEGRAM=1`。
- **文档**：`docs/runtime.md` 新增 Telegram 节与恢复第 9 条；ADR 0011（入站固定 confirm、owner 回复自动发送范围、限流退回重试——修订 ADR 0010 第 4 条）；`CONTEXT.md` 补"owner 回复"，并在"发送操作"注明限流例外。

**验证**（本机 macOS，mock 模型 + 本地模拟 Bot API）：`npm run typecheck` 通过；`npm test` 全量 393 项，392 通过、1 项按默认跳过（真实模型门禁）。`test/38-telegram-owner.test.ts` 5 项：owner 两条消息进同一 main 会话并各回复一次、关联原消息；平台重投同一消息不重复建任务/发送；陌生人/群聊/贴纸零模型调用且记拒绝原因；会话默认 full_access 时任务仍 confirm；token 不出现在模型请求、事件表、账本、状态与 stderr；400 → failed、502 → effect_unknown 均不重发，429 按 retry_after 只再发一次同一正文；API 断开期间的消息在重连后处理；构造"任务已结束、结果与回复未落库 + main 之后已跑别的任务 + 偏移回退"后重启，补发的是该任务自己的回答且重投不重复建任务；配置校验（用途/host/token 格式/协议/版本冲突）、停用后被限流退回的回复取消不改发；重叠启停只留一个轮询循环；schema v13 → v14 升级保留账本。代码评审发现 1 项（重叠配置变更可能留下无法停止的第二个轮询循环），已改为串行并补回归（去掉修复时该测试失败）。

未执行：真实 Telegram bot 闭环、Linux 服务器（tx 在国内，按确认不测）。模拟平台通过不代表真实部署已通过；国内部署需要可达的 `--api-base` 反代或网络层代理（Node `fetch` 不读 `HTTP_PROXY`）。

