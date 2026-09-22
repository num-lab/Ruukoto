Status: ready-for-agent
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
