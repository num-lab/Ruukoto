Status: resolved

# 25 — 支持 Telegram/QQ 私聊图片消息

**What to build:** 为 Personal Agent 增加 Telegram 与 QQ owner 私聊的图片入站能力。图片在入站时完成下载、校验和持久化，作为模型的视觉输入参与首次任务与后续续聊；回复仍保持纯文本。

本工单依据 [agent-direction 已确认规格](../spec.md)、[CONTEXT.md](../../../CONTEXT.md)、[ADR 0017](../../../.agents/notes/implemented/architecture/2026-10-02-two-agent-products.md) 和现有 Telegram/QQ owner 私聊边界制定。

## 现状与关键缺口

- Telegram 当前只接受 `message.text`，QQ 当前只解析 `text` 与 `reply` 段；图片、附件和其他非文本入站不会建任务。
- `InboundEvent.body` 与 `Task.input` 当前是字符串，事件登记早于任务创建。
- `ArtifactStore` 的产物必须先绑定 `taskId`，不能在适配器收到消息时直接创建任务产物。
- pi Agent SDK 已支持 `prompt(text, images)` 与 `ImageContent`，但当前 Driver 只调用字符串 prompt；模型能力需通过所选模型的 `input` 是否包含 `image` 判断。
- 现有 `inbound_events.artifact_refs` 可保存任务产物引用，但暂存媒体需要单独的入站归属和恢复状态，不能把暂存文件伪装成已有产物。

## 已确认的产品边界

- **入口与输出**：只覆盖 Telegram owner 私聊和 QQ owner 私聊入站；TUI、控制面、调度、群聊和出站媒体不在本工单。模型回复仍经现有 outbox 发送纯文本。
- **媒体类型**：首版只支持 JPEG、PNG、WebP。必须校验实际文件 magic bytes 与声明 MIME 一致；不接 SVG、GIF 或其他 `image/*`，不转码、不缩放。
- **数量与大小**：每条消息最多 4 张图片，按平台原顺序生成多个图片块；单图不超过 8 MiB。超出数量或大小直接进入永久拒绝路径。
- **文字语义**：图片可没有文字。Telegram caption 与 QQ 文本段保留并作为同一用户消息的文字部分；只要一条消息含图片，就不把其文字解析为 IM 审批命令，避免媒体消息扩大控制能力。
- **模型能力**：任务开始前核对所选模型支持 image input。不支持时明确失败并保留原消息与原因，不静默删除图片、不自动切换模型、不引入 OCR 或外部视觉服务。
- **历史语义**：会话历史保存稳定媒体引用与元数据；发送模型前按引用从任务产物恢复 `image block`。不把同一图片的完整 base64 重复写入 JSONL。首次任务和沿 `resumesTaskId` 继续的任务都必须能重放原图片。

## 入站、暂存与任务归属

1. Telegram 取 `message.photo` 中分辨率最大的 `PhotoSize`，调用 Bot API `getFile` 后下载对应文件；QQ 使用 OneBot 图片段提供的 `url` 或 `file`，不根据消息正文访问任意 URL。平台 token 不进入暂存元数据、事件正文、日志或模型上下文。
2. 图片下载到受保护的数据目录后，校验字节数、magic bytes、允许 MIME 和最多 4 张数量。下载和校验成功后才登记普通入站事件。
3. 增加入站媒体暂存记录与文件，幂等键为 `(source, externalId, mediaIndex)`。记录至少要能恢复来源、顺序、MIME、字节数、内容哈希、文件位置、状态、创建/更新时间及最终 event/task/artifact 归属；同一消息重投不能重复下载或重复创建任务。
4. 编排器创建任务后，把已完成暂存提升为不可变任务产物，写入 `inbound_events.artifact_refs` 或等价的稳定引用，并在任务启动前完成归属核对。提升过程必须幂等，不能产生半绑定引用；任务创建失败或后台重启时保留可恢复的暂存记录。
5. 启动恢复继续处理未完成暂存和未完成提升；没有绑定任务的暂存文件超过 24 小时清理并留下可核查状态。已经绑定任务的图片沿现有任务产物资料范围保留，不在本工单增加自动删除策略。

## 失败、重试与回执

- 网络超时、连接中断等临时下载错误进行有界重试。Telegram 在最终决定前不推进 update offset；QQ 在适配器内完成有界重试，失败后记录拒绝。
- MIME 不允许、magic bytes 不匹配、超过 8 MiB、超过 4 张或下载重试耗尽属于永久失败：在入站媒体/拒绝账本中写入 `rejected`，Telegram 推进 offset，QQ 保留拒绝事实；不创建普通模型任务。拒绝记录和固定回执共用外部消息幂等键。
- 永久失败和视觉模型不支持都只发送宿主固定文本回执，不把平台错误正文、下载 URL、token 或模型自由生成内容作为错误说明。回执必须按入站外部 ID 幂等，不能因重投重复发送。
- 媒体任务的审批命令路径必须完全关闭；图片消息即使含有类似 `/approve` 的文字，也只能作为普通任务正文。

## 验收标准

- [x] Telegram 图片消息（含无 caption、含 caption、回复消息）可下载、校验、登记、建任务并把图片作为模型请求中的 `image` 内容块；下载失败时 offset 和重试行为符合上述规则。
- [x] QQ 私聊图片段（含无文字、含文本、最多 4 张）可下载、校验、登记、建任务并保持原顺序；无法取得 OneBot 图片文件时记录明确拒绝。
- [x] JPEG、PNG、WebP 通过；SVG、GIF、伪造 MIME、magic bytes 不符、单图超过 8 MiB、单条超过 4 张均进入永久拒绝路径。
- [x] 同一 `(source, externalId, mediaIndex)` 重投只保留一份暂存和一条任务，不重复下载、不重复建任务、不重复发送拒绝回执。
- [x] 后台在“下载完成但事件未登记”“事件已登记但任务未创建”“任务已创建但产物提升未完成”各崩溃窗口重启后，能够恢复或明确收尾，不能产生孤儿引用或重复任务。
- [x] `ArtifactStore` 产物有稳定的媒体元数据和内容哈希；会话 JSONL 不重复写入完整 base64，首次任务和 `resumesTaskId` 续聊均能在发送前恢复同一图片。
- [x] 所选模型不含 `image` 输入能力时，任务在模型请求前明确失败并保留原消息与原因，不发送缺图请求、不静默降级。
- [x] 含图片的文字不触发 `/approve` 等 IM 审批命令；普通文本消息的既有审批和回复行为不回归。
- [x] 永久拒绝、临时失败最终拒绝、视觉模型不支持三类固定文本回执均按原 Telegram/QQ 目标发送一次，且不创建普通模型任务；拒绝记录不冒充 `InboundEvent` 的普通任务状态。
- [x] 两个平台均有模拟端到端测试，覆盖模型请求 payload、暂存/提升、重启、重投、临时失败、永久拒绝、模型不支持和回执幂等；真实平台 smoke 单独登记，不能把模拟结果描述为真实平台已通过。

## 实施与文档同步

- 预计涉及入站媒体暂存与恢复、`src/telegram/adapter.ts`、`src/qq/adapter.ts`、`src/runtime/orchestrator.ts`、`src/runtime/runtime.ts`、`src/core/types.ts`、`src/core/db.ts`、`src/core/store.ts`、Driver/上下文组装及对应测试。实现可新增窄模块，但不要把媒体下载、任务编排和模型注入复制到两个适配器。
- 若新增数据库表或改变产物归属，补充对应 ADR、迁移和导入/恢复边界；不得把 staging 文件当作已完成 ArtifactStore 产物。
- 改动 `src/` 或 `deploy/` 后按仓库约定同步命中的 `docs/visual/` 页面并运行 `test/67-visual-docs.test.ts`；同时更新 `docs/runtime.md` 中 Telegram、QQ、存储布局、入站事件和模型上下文说明。
- 完成 `npm run typecheck`、相关单元/集成测试和仓库要求的全量检查；真实 Linux 平台测试若需要按仓库约定通过 `ssh tx` 单独记录。

## Comments

### 2026-10-07：grilling 决策完成

通过 `grilling` 分五轮确认：工单归属 `agent-direction` 25；首版只做 Telegram/QQ 私聊图片入站，回复保持文本；支持 JPEG/PNG/WebP、每条最多 4 张、单图 8 MiB；图片消息保留 caption/文本但关闭审批命令解析；入站媒体先进入按来源幂等的暂存，建任务后提升为任务产物；历史保存引用与元数据，发送前恢复 image block；临时失败有界重试，永久失败落 `rejected` 并发送固定文本回执；暂存孤儿 24 小时清理；验收区分两平台模拟端到端与真实平台 smoke。拥有者确认状态为 `ready-for-agent`。

### 2026-10-07：实现与验收

已完成 Telegram/QQ 拥有者私聊图片入站。共享 `InboundMediaStore` 负责下载、MIME/magic/数量/大小校验、暂存与拒绝账本、恢复和过期清理；schema v31 增加两个入站媒体表与产物 MIME/hash。任务创建后，事件绑定、不可变图片产物元数据和稳定引用在同一 SQLite 事务提交；文件提前准备，确定的产物 ID 与哈希支持崩溃后幂等重试。新增 [ADR 0024](../../../.agents/notes/implemented/architecture/2026-10-07-inbound-image-staging.md)，两种实例导入均排除暂存账本，已提升图片随任务产物保留媒体字段。

Driver 以 `ruukotoMediaRefs` 保存图片归属，JSONL 和 prompt 快照不重复写入 base64；选择使用标准图片占位块计预算，发送前按归属/MIME/大小/hash 恢复图片。首次任务、两级继续、已有压缩点覆盖原交互、重开会话均验证实际模拟模型 HTTP payload。模型能力在派发、提交与发送前核对；没有视觉能力时不静默降级。含图片消息关闭 IM 命令解析，回复和三类固定失败回执沿公共 outbox 去重。

独立审查发现并修复四个窗口：未提升图片被拒绝后遗留排队任务阻塞主会话；24 小时清理与活跃下载竞争；能力检查与提交之间默认模型变化；旧代次暂存图片重投被新入口信封重新包装。另补 Telegram 重新在线时派发/队列唤醒、二进制下载按平台文件扩展声明 MIME，以及 QQ 含图长文字保留原接收文字。图片损坏时已有任务明确收尾，后续文本可运行，拒绝回执与普通任务失败回执不会重复发送。

验证记录：`npm run typecheck` 与 `git diff --check` 通过；全量 `npm test` 为 995 项通过、0 项失败、1 项 RUN_MODEL_CHECK 门控跳过（[完整日志](../issue-25-validation.log)）；最后的模型选择、配置、图解与媒体相关检查 41/41 通过（[相关日志](../issue-25-validation-related.log)）。模型钉定用例随后补齐三个窗口，连同图解检查再次 5/5 通过（[补充日志](../issue-25-validation-pinning.log)）。新增媒体验收在 test/90、95、96、97、98；均使用真实 Runtime/SQLite/文件与模拟平台、模拟模型，未接入真实 Telegram/QQ。

全量首次检查还暴露既有测试前提：test/75 写死旧 schema 版本，现改为核对迁移后的数据库版本；test/34 的模拟提供方收到空正文 GET 后 JSON.parse 抛错，HEAD 隔离 worktree 也重现，已仅修 fixture 的空正文/取消处理并保留事件断言；本机 fake-IP DNS 将 nonexistent.invalid 解析成 198.18.0.126，test/08 现定向 mock 该域名的 ENOTFOUND。Linux tx 使用隔离源码目录运行未 mock DNS 的原 test/08，16/16 通过（Node v24.21.0、SDK 0.85.1；[Linux 日志](../issue-25-validation-linux.log)）；没有改动生产配置或后台，临时目录已清理。

真实平台 smoke 单独登记：Telegram Bot API 实际图片下载、真实视觉模型识图及回复未实测；QQ/NapCat 实际图片 URL/file 格式、下载、真实视觉模型识图及回复未实测。Linux 的审批回归不等于真实 IM 图片 smoke。


图解同步已完成并按当前代码核实：

- `inbound-events.html` 的 sources、media（新增）、dispatch、im-approval、recovery：图片接收、暂存/提升、拒绝、审批旁路、上线与重启恢复。
- `storage-layout.html` 的 roots、authority、core-db、schema、workspace：受保护文件、媒体元数据、schema v31、迁移与两种实例导入边界。
- `context-pipeline.html` 的 pipeline、send、observe：稳定历史引用、图片预算、发送前恢复与 prompt 快照。
- `outbox.html` 的 sender、keys、channels、restart：媒体账本来源键、三种固定回执、目标复核与不重发。
- `control-protocol.html` 的 telegram.rejected 事件说明、`orchestrator.html` 的 subagent 版本说明及 `index.html` 对应卡片同步更新。

核实依据包括 InboundMediaStore 的 stage/download/recover/promote/cleanup，Store 的 bindInboundMedia/createImageArtifact，ArtifactStore 的 importImage/readImage，Runtime 的 registerImInbound/prepareInboundMedia/enqueueMediaReceipt/verifySources，Orchestrator 的 dispatchEvent/start/checkDeadlines，以及 Driver、ContextAssembly 和两个适配器的实际调用路径。修正的旧说法包括“Telegram/QQ 只接纯文本”“Telegram 上线不派发”“SQLite 不存任何消息正文”“prompt 快照保存原样图片正文”和旧 schema 版本/迁移范围；当前 SQLite 保留安全入站信封，历史与快照保存图片引用，v31 支持从 v1 至 v30 迁移。

图解检查 test/67 全绿。四页渲染后的 55 张切片均已查看；新增媒体时序图的左向箭头和既有表格长 code 的截断问题已修复，重新渲染确认。核实时发现的“downloading 尚无最终文件应记 download_interrupted”也已修复并复核，未留未处理代码问题。最终 npm run typecheck 与 git diff --check 再次通过。所有验收项完成，真实消息平台 smoke 的未实测状态保留在上方单独登记。
