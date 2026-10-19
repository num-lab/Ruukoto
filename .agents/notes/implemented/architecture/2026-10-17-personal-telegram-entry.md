# Agent Note: 个人拥有者双平台收件与固定回复由 durable 任务衔接

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

QQ 使用同一收件、Task、菜单和报告规则，只复用共享 `OneBotClient` 传输，不引入 QqAdapter 或旧 Store。为保留既有 Telegram 接纳证据，内部 document/task kind 与 `telegram` 来源字段名沿用，新增 `platform: "qq"` 区分；缺省只代表 Telegram，不把 QQ 账号编码为 Telegram 身份。入口、菜单、审批、长期授权、追加和核实逐处比较平台、账号、owner 与代次。默认模式分平台持有，QQ 换代恢复自动审查并递增权限版本，主会话历史共享不携带另一平台的权限；QQ 扩展标记使旧程序拒绝忽略新语义。

QQ 停机向导核实在线登录账号，通过随机好友私聊短语选择另一拥有者账号；每次配对/停用都换代，服务地址及 token 指纹固定。只接纳 `message/private/friend`，核对事件 self_id 与真实在线连接，不接纳群临时会话、自身消息或缺失身份。消息 ID 保留有符号整数，稳定键为 `qq:account:owner:message`，按键去重，不作数值水位。以随机短语证明新鲜的配对事件保存平台时间与稳定消息身份；该消息重投、平台边界及同秒消息不执行，不用本机时钟推断平台积压，避免配对短语进入主会话；旧入口换代不移动或删除已提交历史。

[OneBot 正向 WebSocket](https://github.com/botuniverse/onebot-11/blob/master/communication/ws.md)没有入站 ACK 或断线补拉。durable commit 才算本地受理；启动、断线、重连事实和接收缺口持久留存并由向导展示，不能承诺断线消息自动恢复。队列有界且逐条接纳，持久化或冲突失败停止入口；正常停止收齐接纳和连接记录，再释放后台。

QQ 未开始发送且原账号离线时，沿原任务延后等待连接；请求已经发出后丢答一律未知。[NapCat 的动作处理](https://github.com/NapNeko/NapCatQQ/blob/main/packages/napcat-onebot/action/OneBotAction.ts)可把执行后的内部异常也返回 `failed/1200`，共享传输因此不再把该码当确定失败。新入口只把已知的参数/未知动作拒绝码判为未发送，不解析 wording 猜限流；OneBot/NapCat 未提供可核实的结构化限流重试契约时保留未知，Telegram 明确 429 仍按原规则延后。echo 仅关联应答，不作幂等键。

QQ 图文沿共用媒体接口保存平台 file 身份，URL 只作瞬时下载凭据；缺 URL 时通过 `get_image` 解析，只从已列明的 QQ HTTPS 图片 CDN 下载，包含 NapCat 当前使用的 `multimedia.nt.qq.com.cn`，不读取平台本地路径、不携连接 token、不跟随跳转。图片与原 QQ receipt/Task/Submission 双向核实；拒绝时整条文字不单独送模型，caption 不解释为控制。

## 既有笔记审计

按 durable、Telegram、入站、发送、拥有者绑定和本机管理检索 active notes；没有 rejected 目录。[本机管理](2026-10-17-personal-local-management.md)、[档案基础](2026-10-17-personal-durable-foundation.md)、[服务操作](2026-10-17-personal-service-operations.md)与迁移提案部分重叠，保留并互链；[原 IM 审批与汇报](../feature/2026-10-02-im-approval-and-final-report.md)、[长期授权](../feature/2026-10-03-standing-permissions.md)仍服务共享底座，本切片不替代其审批与授权决定。[旧 QQ 共享主会话](../feature/2026-09-24-qq-private-shared-main.md)与[媒体](2026-10-18-personal-browser-media.md)部分重叠，保留各自旧装配与媒体决定；其他渠道、调度和外部执行笔记持有独立业务能力，没有完全吸收或待归档记录。

## 备选方案

- 仅增加拥有者来源宿主 API：更容易隔离权限改造，但仍不能证明真实平台身份，也不能供拥有者实际聊天；选择先交一条文本纵切片。
- 复用旧 Telegram adapter：已有图片、凭据和通知机制，但依赖旧核心与调度状态；保留旧调用方，新入口只使用平台 fetch 和独立 durable 事实。
- 永久保存单调 update offset：轮询较直接，但平台空闲后的 ID 随机化使其不安全；采用短期单次确认和永久消息键去重。
- 同时加入服务审批与长期授权：更快形成业务闭环，但还需要服务请求来源、操作选择、审批及未知效果核实交互；先建立可验证的入站与外发，再接这些业务。

- 为 QQ 复制另一套收件与控制状态机：平台命名清楚，但会复制审批/恢复规则并使双平台权限校验漂移；只分离传输与配置，复用已有执行与控制。

## 后果

拥有者可通过隔离 QQ、Telegram 与本机向导使用同一主会话；平台重投和进程恢复有稳定来源，未知发送不会制造重复回复。代价是每条入站保留来源与发送事实、一个 background Task；HTTP 错误保守分类可能需要人工通过平台核实。Telegram 宿主审批、权限和长期授权另按上述决定接入；后台分析最终外发由[委托报告](2026-10-17-personal-delegation-reports.md)持有；图片由共用媒体扩展提供，模型写工具按各自能力决定接入。只验进程崩溃，不声称跨平台和 SQLite 原子或断电保留最近提交。

验证、独立审查与真实环境缺口见[文本入口工单](../../../../.scratch/personal-pi-durable/issues/07-telegram-entry.md)。

QQ 实现及真实双平台验收缺口见[双平台入口工单](../../../../.scratch/personal-pi-durable/issues/31-qq-owner-entry.md)。
