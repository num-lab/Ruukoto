# Agent Note: 个人 Telegram 收件与固定回复由 durable 任务衔接

Status: implemented

## 问题

[个人迁移](../../proposed/architecture/2026-10-17-personal-pi-durable.md)已有本机会话与服务宿主 API，但无法证明拥有者来自哪个真实平台。旧 Telegram adapter 依赖 core Store、Runtime 与 SchedulerStore，直接接入会恢复旧运行权威；只增加来源 API 又不能形成拥有者实际可用的聊天入口。

## 决定

隔离向导接入 Telegram 文本私聊，直接以平台 HTTP API 和 durable 原生 Task 衔接唯一主会话，不装配旧 adapter。绑定只经停机持锁的向导配置：凭据留在环境，配置存环境变量名和 SHA-256 指纹；getMe 核实 bot，随机配对消息让操作者选择拥有者身份。每次配对或停用生成新的配置代次，凭据变化须重新配对。没有自由填写 owner ID、请求键或水位的用户入口。

拥有者明确选择后，向导过滤专用 bot 旧积压，再观察配对批次；身份选择后必须在该批响应收到后 60 秒内完成一次 `getUpdates(last + 1)`，成功才保存绑定。这次调用确认的批次及之前消息不受理，响应中的更新仍未确认，留给后台。平台确认与配置文件不能跨存储原子；保存失败明确提示边界可能已确认，重新配对。

运行时不持久复用数值 offset，也不按 ID 大小排除消息。每批最多 16 条，为 1 MiB 有界回执中的正文与引用留出预算；全部提交后，仅下一次请求可在响应收到后 60 秒内携带该批末尾 ID + 1；空批、失败或超期清空，重启不传 offset。原因是 Telegram 空闲至少一周后可能随机分配 update ID；永久递增水位会漏收新消息。确认批次与负 offset 的语义来自[官方 getUpdates](https://core.telegram.org/bots/api#getupdates)，随机 ID 来自[官方 Update](https://core.telegram.org/bots/api#update)。

每条拥有者文本在同 commit 保存固定 bot/owner/代次、原正文、稳定消息键与 background Task，运行水位只作诊断。Task 向 main 使用原消息键 admission，跨提交窗口恢复仍接同一个 Submission；回答只取对应 `Submission.answer`。完整回答在 durable 中保存，单条平台正文按 Unicode 字符有界截断。收件事实保存来源，服务权限另由[原收件快照和宿主控制](2026-10-17-personal-telegram-permissions.md)持有。

回复正文和原目标固定后，Task 先持久化 sending 与 verify checkpoint，再发一次请求。结果提交丢失、超时、断线、5xx、畸形回执都保留效果未知；恢复只记未知，不重发。只有校验通过的明确 429 拒绝回执能持久延后原发送，其他明确 4xx 拒绝记失败。配置变化取消旧待执行输入和待发回复；已进入 main 的历史不清除，已开始发送的未知事实不因换代消失。

后台独占 Harness、轮询与 Unix 管理接口。正常停止先收齐轮询，再关闭 Harness；故障关闭在放锁前收齐轮询与接口。不调用 main.abort 来停后台，不把客户端断开当作取消。CLI 提供最近 16 条收发状态与连接诊断，未知发送没有重新发送按钮。

## 既有笔记审计

按 durable、Telegram、入站、发送、拥有者绑定和本机管理检索 active notes；没有 rejected 目录。[本机管理](2026-10-17-personal-local-management.md)、[档案基础](2026-10-17-personal-durable-foundation.md)、[服务操作](2026-10-17-personal-service-operations.md)与迁移提案部分重叠，保留并互链；[原 IM 审批与汇报](../feature/2026-10-02-im-approval-and-final-report.md)、[长期授权](../feature/2026-10-03-standing-permissions.md)仍服务共享底座，本切片不替代其审批与授权决定。其他渠道、调度和外部执行笔记持有独立业务能力，没有完全吸收或待归档记录。

## 备选方案

- 仅增加拥有者来源宿主 API：更容易隔离权限改造，但仍不能证明真实平台身份，也不能供拥有者实际聊天；选择先交一条文本纵切片。
- 复用旧 Telegram adapter：已有图片、凭据和通知机制，但依赖旧核心与调度状态；保留旧调用方，新入口只使用平台 fetch 和独立 durable 事实。
- 永久保存单调 update offset：轮询较直接，但平台空闲后的 ID 随机化使其不安全；采用短期单次确认和永久消息键去重。
- 同时加入服务审批与长期授权：更快形成业务闭环，但还需要服务请求来源、操作选择、审批及未知效果核实交互；先建立可验证的入站与外发，再接这些业务。

## 后果

拥有者可通过隔离 Telegram 与本机向导使用同一主会话；平台重投和进程恢复有稳定来源，未知发送不会制造重复回复。代价是每条入站保留来源与发送事实、一个 background Task；HTTP 错误保守分类可能需要人工通过平台核实。Telegram 宿主审批、权限和长期授权另按上述决定接入；QQ、图片、模型写工具及后台工作最终外发仍沿总方案继续。只验进程崩溃，不声称跨平台和 SQLite 原子或断电保留最近提交。

验证、独立审查与真实环境缺口见[文本入口工单](../../../../.scratch/personal-pi-durable/issues/07-telegram-entry.md)。
