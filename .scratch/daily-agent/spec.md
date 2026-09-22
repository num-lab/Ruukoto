# 日常助手与事件编排：可执行规划

状态：需求讨论完成，进入实施拆分。

本规划把个人 Agent 从“拥有者经 TUI 提交编码任务”扩展为“拥有者通过消息入口使用日常助手”。它补充 `.scratch/personal-agent/spec.md`，不改写已经完成的后台运行时、权限、上下文、记忆和 GitHub 历史决策。

## 目标

- 建立一个持久的 `main` 角色，负责拥有者的日常对话、信息整理和任务编排。
- 保留独立的 `coding` 角色处理仓库、测试和 PR 分析。
- 保留独立的 `chat` 角色处理群聊资料和群聊回复。
- 让消息入口、定时器、GitHub 事件和子任务都通过持久事件进入同一个后台编排器。
- 保证模型不能借助外部消息、项目文本或子 agent 结果提升拥有者权限。

## 已确认决策

1. 本规划作为新的日常助手阶段加入，不重写旧阶段；旧 QQ 群聊设计继续保留为后续能力。
2. 第一条可用链路是：Telegram owner 私聊 → main 持久会话 → main 管理的应用数据 → 定时通知；随后加入 main → coding 委派。
3. QQ 私聊优先于 QQ 群聊。QQ 群聊沿用 `.scratch/personal-agent/issues/07-qq.md` 的 NapCat 规划，使用独立 `chat` 会话和资料范围。
4. main、coding、chat 是同一后台中的逻辑角色，各自使用独立 Project/Session/工作目录；不拆成三个必须独立部署的系统进程。
5. 子任务通过父子任务、来源事件和结构化结果通信；模型不持有 owner token，也不能直接调用控制面创建任务。
6. 读取、整理、记录、已配置的提醒和通知可自动执行；代码写入、GitHub 评论、权限变更和未预先授权的外部发送仍需拥有者确认。
7. 使用单进程 SQLite 调度器和 outbox，不引入 Redis 或其他消息中间件。发送结果未知时标记 `effect_unknown`，不自动产生第二次外部副作用。
8. 待办、提醒、习惯等领域数据不预建固定业务表。main agent 可以在独立的应用数据空间中按需声明表和字段；运行时核心表不对模型开放。
9. main agent 通过宿主提供的受控数据工具管理自己的 schema 和数据。非破坏性变更自动执行，删表、删字段和批量迁移需要确认；所有变更留来源和版本记录。
10. Telegram 第一版使用 long polling，通过可信配置绑定固定 owner `user_id + chat_id`。其他身份默认不执行任务。
11. 主人私聊消息立即处理；提醒按时间触发；低优先级新闻和群聊摘要批量汇总；普通内部事件只记录不唤醒模型。
12. 用户明确提出编码、仓库、PR、测试或修改请求时，main 可自动创建 coding 子任务。coding 默认交付分析或修改草稿；外部发布仍需确认。
13. GitHub 第一版保留拥有者手动触发；后续 webhook 只负责创建 review 草稿和通知，不默认发表评论。
14. 新闻推送放在提醒链路稳定之后，使用现有 Web Search/Tavily 能力，保留来源 URL，不自动写入长期记忆。
15. 第一版不设置硬性产品验收门槛，由拥有者手动验收；`npm run typecheck`、`npm test`、数据完整性检查和安全边界测试仍是工程交付要求。
16. main 会话、应用数据和已触发的外部消息第一版不自动删除，由拥有者通过可信入口手动清理。

## 运行模型

```text
Telegram / QQ / Scheduler / GitHub
                 ↓
          入站事件持久化
                 ↓
             编排器
          ↙      ↓      ↘
       main    coding    chat
          ↘      ↓      ↙
             结果事件
                 ↓
          main 有界唤醒
                 ↓
            outbox 通知
```

后台进程常驻，模型按事件执行短回合。main 的 JSONL 会话用于连续对话，应用数据空间用于 main 自己决定的结构化业务数据，SQLite 核心数据库继续只保存运行时元数据、任务、审批和事件。调度器可以拥有固定的运行记录和发送操作账本，但不预建 `todos`、`reminders`、`habits` 或 `outbox_messages` 这类业务表。

任务至少需要具备 `agent_id`、`parent_task_id`、`source_event_id`、`deadline` 和结构化结果引用。结果包含摘要、产物引用、是否需要拥有者和错误状态。子任务失败后，安全的读取/分析任务最多自动重试一次；外部副作用任务不自动重试。

## 动态应用数据边界

新增独立的 main 应用数据存储，例如 `<dataDir>/agent-data/main.db`。main 只能通过宿主工具操作该空间，工具负责：

- 表、字段、索引和版本的校验；
- 行数、字段大小、查询时间和结果大小限制；
- 非破坏性 schema 迁移；
- 破坏性迁移的确认请求；
- 变更来源任务、版本和理由的审计记录。

coding 只能收到委派任务明确传入的数据和产物引用；chat 默认不能读取 main 的个人数据；main 可以读取 coding 结果和 chat 摘要。跨角色数据传递必须可追溯。

## 分阶段实施

实施顺序：`01 → 02 → 03 → 04 → 05`，之后 `06`、`07`、`08` 可按需要推进；`09` 依赖消息入口、调度和子任务结果协议稳定。

1. [01 — 角色、事件与子任务编排](issues/01-orchestration.md)
2. [02 — main 应用数据空间](issues/02-main-data.md)
3. [03 — 调度器与通知 outbox](issues/03-scheduler-outbox.md)
4. [04 — Telegram owner 入口](issues/04-telegram-owner.md)
5. [05 — main 委派 coding](issues/05-coding-delegation.md)
6. [06 — QQ 私聊入口](issues/06-qq-private.md)
7. [07 — 新闻推送](issues/07-news.md)
8. [08 — GitHub 事件编排](issues/08-github-events.md)
9. [09 — QQ 群聊与 chat agent 衔接](issues/09-qq-group-bridge.md)

每张工单都应补充实现事实、迁移说明和测试结果。产品行为由拥有者手动验收，不把模拟平台测试描述为真实部署已通过。

## 明确不做

- 不建设插件市场或动态第三方插件平台；
- 不让模型直接修改核心 SQLite schema；
- 不把主会话历史当作待办、提醒和习惯的唯一数据库；
- 不让 QQ 群成员获得 owner 身份、完全访问或开发审批能力；
- 不在第一版自动发布 GitHub 评论、自动合并或自动修复；
- 不引入 Redis、分布式队列或多机调度。

## Comments

### 2026-09-22：需求讨论完成

通过 `grilling` 逐轮确认。Q1–Q5、Q7–Q13、Q15–Q22 采用推荐方案；Q6 改为由 main agent 自主决定领域数据是否结构化及其 schema；Q14 改为由拥有者手动验收，不设硬性产品验收门槛。
