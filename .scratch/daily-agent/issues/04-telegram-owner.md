Status: ready-for-agent
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
