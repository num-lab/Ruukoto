Status: resolved
Depends on: 04

# QQ 私聊入口

## 目标

在 Telegram owner 入口稳定后，通过 NapCat OneBot v11 正向 WebSocket 增加拥有者 QQ 私聊，并共享 main 身份与主会话。

## 实现范围

- NapCat 正向 WebSocket、token 鉴权、心跳、重连和登录账号核对。
- 固定 owner QQ 身份映射；QQ 私聊与 Telegram 共享 main 角色，但保留平台来源标记。
- QQ 消息先持久化再入队，按账号、私聊对象和消息 id 去重。
- QQ 入口不能开启完全访问、修改权限、批准开发操作或读取 QQ 群资料。
- 发送目标由宿主固定，复用 outbox 和 `effect_unknown` 规则。
- QQ 群聊仍由 `.scratch/personal-agent/issues/07-qq.md` 负责，不在此工单扩大范围。

## 验证

- 登录账号不匹配、token 错误和掉线时不接收新任务；
- QQ 私聊能进入已有 main 会话且不串入群聊历史；
- 重复事件不会重复任务或发送；
- QQ 消息无法冒充 owner 控制面操作；
- 不向真实 QQ 账号发送测试消息，除非拥有者另行授权真实验收。

## Comments

### 2026-09-24：实施边界与接入方案

在 issue05 提交 `59e8ad1` 上实施。复用同一个 NapCat 连接，增加固定 owner 好友私聊；群会话与群收发账本保持独立。QQ 私聊先登记 `qq_private` 入站事件，再进入既有 main，会话内权限固定 `confirm`。公共 outbox 按固定平台选择渠道，收件时持久化目标与配置版本，配置变化不改发。schema v15 只增加 owner 身份和入站回复目标两列。

资料边界按 ADR 0012 实施：main 与 coding 角色禁止直接读取原始 QQ 群项目及带群来源的派生资料，已有 main/coding 共享历史内容保留，不承诺清洗已复制或转述的群内容。这是共享主会话下的项目访问边界，不是两个平台之间的历史隔离。

管理使用现有 QQ CLI/控制面和配置中心；私聊必须配置 token。测试只运行本地模拟 OneBot 与模型，不向真实账号发消息。真实 NapCat 兼容性与闭环单列为部署验收。

### 2026-09-24：实现与验证完成

- 复用 `src/qq/onebot.ts` 与适配器的同一连接：Bearer 鉴权、get_login_info 核对账号、get_status/heartbeat 检查实际在线状态，断线退避重连，启停与配置应用串行。只接收固定 owner 的好友纯文本与回复 ID，临时群私聊、非文本、陌生人、自身回声及伪造账号不建任务；token 不进入模型输入、状态或账本。
- `qq_private` 消息在 `inbound_events` 中先持久化，按账号、owner 和消息 ID 去重，并钉版 `reply_target`。恢复、派发、任务启动与发送复核配置；旧配置的已登记/排队/运行任务按既有取消路径收尾，不改发到新 owner。
- 与 Telegram 共用 main，入站及 coding 子任务固定 `confirm`。QQ 来源可调用 `coding_delegate`；子任务结果回 main，唤醒不自动外发。控制面身份与 QQ 身份独立，QQ 正文和模型伪造调用不能批准开发操作。
- 回复复用公共 `notification_ops`，按任务读取最终回答、按原平台路由；QQ 入站申请的通知和定时发送也绑定原 QQ 目标，经统一审批。结果未知不重发。审查发现离线渠道的前 50 条积压会阻塞另一渠道，已改为每渠道取一批，并覆盖 51 条离线 Telegram 积压后 QQ 正常发送、恢复不重复的回归。
- main/coding 的原始群资料限制集中在 `AccessScope`；历史、产物、记忆列表与版本读取、自动记忆注入、委派资料、通知来源及旧计划/通知详情沿用统一范围校验。普通开发项目授权和 owner 控制面读取有效，已有共享副本保留。
- CLI 新增 `qq configure --owner-id / --no-owner`；配置中心可绑定或清除私聊 owner，TUI 显示绑定状态。schema v14 → v15 保留旧群数据，新增 owner 与入站固定目标两列，旧配置默认不开私聊。CONTEXT、ADR 0012、运行文档及 TUI 演示事件已同步。

实际验证（macOS，本地 mock 模型与 OneBot）：`npm run typecheck` 通过；最终 `npm test` **418 项，417 通过、0 失败、1 跳过**（默认关闭的真实模型检查）；`git diff --check` 通过。新增私聊集成 9 项、资料边界 1 项及 OneBot 传输检查 1 项，覆盖去重、QQ/TG 共用 main、身份和凭据、真实控制面审批、固定通知目标、掉线与心跳、明确失败/缺回执/异步回执、配置失效、重启恢复、coding 委派和数据库迁移；既有群聊、编码、调度、Telegram 与 TUI 回归通过。独立只读审查复核后未发现遗留问题。

未执行真实 NapCat/QQ 收发或 Linux 部署验收；本轮没有向真实 QQ 账号发送消息。模拟通过不代表真实平台版本和部署已验收。
