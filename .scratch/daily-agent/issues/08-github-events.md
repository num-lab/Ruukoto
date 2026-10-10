Status: resolved
Depends on: 05

# GitHub 事件编排

## 目标

在 main → coding 委派稳定后，接入 GitHub PR webhook，由宿主创建固定的 main 父任务与 coding 子任务，生成只读评审报告，经 main 摘要后向固定 owner 发送一次通知。

## 已确认决策

遵循 [ADR 0007](../../../.agents/notes/implemented/simplification/2026-09-23-retire-github-module.md)：GitHub 资料经通用 MCP 读取，报告使用普通 Artifact 与 Task result；不恢复专用 REST 采集、草稿版本或发布状态机。宿主直接创建父子任务，不通过仅供 owner 来源任务调用的 `coding_delegate`。事件适配及自动通知边界见 [ADR 0013](../../../.agents/notes/implemented/feature/2026-09-24-github-event-review.md)。

2026-09-24 拥有者确认上述两项决策，并授权正式实施。本轮包含 webhook；原“后续再实现 webhook”顺序不再适用。

## 实现范围

- 可信启动配置指定端口、监听地址、webhook 凭据、repository ID 允许列表及通知渠道；CLI 从显式 JSON 文件读取，秘密值经既有凭据入口保存。
- 对原始请求字节校验 HMAC-SHA256，校验 delivery ID、事件类型/action、仓库范围与 PR 字段。正文上限 1 MiB，PR body 进入快照和模型输入前截取前 4000 字符并标注。
- 归一化快照先登记为入站事件，`(source, delivery ID)` 去重；持久化完成即返回 2XX，异步派发不等待模型或评审完成。
- 宿主固定 main 父任务和 coding 子任务的角色、会话、工作目录与 `confirm` 模式。coding 仅用 `read`、`read_artifact` 和本地 `effect = read` 的 MCP 工具；main 父任务无工具，结果唤醒仅有 `coding_result`。PR 资料不能扩大工具、权限或发布范围，不执行 PR 代码。
- 事件 JSON 保存 head/base SHA、`updatedAt` 和 PR 状态；完整评审回答保存为普通 Artifact，`result_ref.review` 保存来源事件、SHA、报告引用及 `staleReason`。无需恢复旧 GitHub 草稿表。
- 已观察到相同或更新 `updatedAt` 的不同修订、关闭或 draft 状态时，旧结果标记过期，未发送通知取消；同时间戳不同 SHA 保守失效。模型经 MCP 采集前后核对 head/base，不能核实时明确说明。缺失事件不保证远端最新状态。
- 启用配置即授权向选定渠道的固定 owner 发送一次 main 摘要；公共 outbox 使用 `sourceKind = inbound_event`、事件 ID 作为逻辑键，与 `owner_reply` 分开。入站时固定目标，发送前复核目标和修订；目标变化不改发，未知结果不自动重发。
- GitHub comment、merge、自动修复及其他写操作继续经过既有可信入口与审批流程；webhook 不注册或执行写工具，MCP 不可用时不回退 REST。

## 验证

- 签名错误、字段无效、仓库未授权和超大请求被拒绝；未支持事件/action 不创建任务。
- 重复 delivery 及重启恢复不重复创建父子任务或通知；入口响应不等待被阻塞的模型任务。
- 完整报告与固定 head/base 可追溯；新签名快照使旧结果过期，乱序事件和同时间戳不同 SHA 按既定边界处理。
- PR 文本不能修改权限、角色、通知目标或发布策略；实际模型工具列表与调用入口都阻止写工具，不执行 PR 代码。
- main 摘要只通过固定事件通知槽发送一次；停用、换目标、过期与结果未知不会导致改发或重复发送。
- schema v15 → v16 保留既有通知账本的全部字段、状态与索引，新增来源仍遵守幂等键。

## Comments

### 2026-09-24 实施开始

按拥有者确认的 ADR 0007 与宿主固定委派路径实施。以上是本轮验收范围，最终验证结果待完成后记录；当前状态保持 `ready-for-agent`。

### 2026-09-24：实施完成与验证

已交付 webhook 验签与有界入口、持久入站去重、宿主固定 main/coding 父子任务、普通报告产物及修订有效性、main 摘要与一次固定 owner 通知。沿用通用 MCP，不恢复旧 GitHub REST、草稿或发布模块；schema v16 仅扩展公共通知来源，旧发送账本完整迁移。后台可通过 `--github-webhook-config` 指定可信配置文件，配置与边界见 `docs/runtime.md` 和 ADR 0013。

恢复验证覆盖父任务已创建但子任务尚未创建、子任务已提交但回执丢失、后台默认模型变化、报告已定稿但结果事务未提交、main 摘要终态但 outbox 尚未登记；均复用原任务、产物和通知键。签名秘密用途收紧、模型工具列表与执行门、head/base 变更、乱序及同时间戳不同修订、目标变化、停用入口、未知发送结果也经本地模拟平台验证。独立检查发现历史分页失败可能误记为完整产物，已修复并加入回归：残缺报告保留 `partial`、记录 `captureError` 并要求拥有者核实。

验证结果：`npm run typecheck` 通过；`npm test` 共 437 项，436 通过、0 失败、1 跳过（既有真实模型连通性测试，默认关闭）；`git diff --check` 通过。新增验证位于 `test/42` 至 `test/46`。测试使用本地 HTTP、MCP、模型与通知渠道模拟，未向真实 GitHub 发布评论或向真实 owner 发送消息；真实 GitHub webhook、MCP 和 Telegram/QQ 部署收发未在本轮验收。
