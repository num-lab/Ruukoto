Status: resolved
Depends on: 03, 12

# 添加 auto-review 模式

## 目标

为个人 Agent 添加可由拥有者选择的 `auto-review` 模式，接入当前 session 的 `/mode` 选择流程。

## 背景

[12：session 模式选择](12-session-mode-command.md) 已记录将 `auto-review` 延后实现，现有模式为 `confirm` 与 `full_access`。[ADR 0003](../../../docs/adr/0003-enforce-explicit-access-modes.md) 将自动审批列为后续能力，本工单跟踪该能力的定义与实现。

## 已确认的审批语义

本计划按“自动审查待执行操作的审批请求”展开。`auto-review` 使用与 `confirm` 相同的受限执行环境；已授权范围内的操作继续直接执行，原本需要审批的操作交给独立审查调用。这里的独立指独立输入、无工具的模型调用，不要求使用另一家模型服务。

以下规则已于 2026-09-22 确认（见 Comments）：

- 审查模型先复用任务创建时固定的模型配置和现有模型调用能力，使用单独的审查提示与严格结果校验；记录实际模型及策略版本。暂不增加审查模型选择界面。
- 首版自动批准范围限于：与拥有者明确请求相关、目标明确、无需凭据且不传送私有数据的外部文件读取和 HTTP 读取。HTTP 方法不能单独证明操作安全；目标或数据用途无法确认时转人工。外部写入、带凭据的请求和有副作用的 MCP 调用保留人工确认。
- 结果为 `approve`、`reject` 或 `ask_owner`。明确不允许的操作拒绝；上下文不足、模型失败、输出格式错误或超时均转人工确认，并说明原因。拒绝后不执行，拥有者可修改请求重新发起。
- 每个审批请求最多进行一次有时限的自动审查，不循环重试、不因失败放宽权限。时限与输入上限在实施时依据现有模型配置确定并记录。

本工单为 `ready-for-agent`；时限与输入上限属于实施配置，按现有模型配置确定并记录。

## 实施范围

- 明确审批语义及权限边界，更新相关 ADR 后实现。
- 在 session 模式选择、后台控制接口及持久化中支持新模式；任务创建时固定所选模式，切换 session 默认值不改写既有任务。
- 复用现有审批请求流程，审查结论绑定具体操作及其授权范围；保存审查结果和理由供拥有者查看。
- 自动审查不得静默升级为 `full_access`；模型输出、项目指令和工具结果不能修改审批策略或扩大授权范围。

## 实施计划

### 1. 固定审批策略与边界

将上述建议整理为按 `ApprovalScope` 分类的明确规则，确定哪些操作可自动批准、哪些转人工、哪些必须拒绝。补充 `CONTEXT.md` 中的模式语义，并新增 ADR 说明自动审查如何扩展 ADR 0003 的首期两模式约定、继续遵守 ADR 0004 的隔离及单次批准消费要求。

审查输入仅包括后台保存的拥有者请求、必要的任务上下文、不可变操作参数、审批范围和策略。项目指令、网页、工具输出及模型自述均作为待审查数据，不能成为授权依据；不得把凭据原值、无关历史或未获资料授权的内容发送给审查模型。输入超过上限或关键正文缺失时转人工，不能只凭摘要批准。

### 2. 接通模式类型、数据库与执行后端

在 `src/core/types.ts`、`src/core/db.ts`、`src/core/store.ts` 中加入统一模式值 `auto-review`。核查并迁移 tasks 的 `access_mode`、`pending_access_mode` 及 sessions 的 `default_access_mode` CHECK 约束；SQLite 需要重建表时保留索引、外键、原始模式及版本。新建数据库和升级数据库都必须能保存新模式。

更新 `src/runtime/runtime.ts`、`src/control/server.ts`、`src/cli.ts` 的模式校验，覆盖 session 默认值、submit、continue、task 级切换及仍在使用的调用入口。继续使用现有 session 版本条件更新和任务模式固定规则。

检查 `src/agent/execution/launchers.ts` 的选择与启动校验：目前 `mode !== "confirm"` 会选择完全访问执行入口，必须明确将 `auto-review` 路由到受限容器。缺少隔离后端时继续报错，不能落到 systemd 完全访问或宿主执行。开发专用 local 后端沿用既有用途，不作为隔离验证依据。

### 3. 增加一次性审查调用与持久记录

在 `src/agent/` 增加一个小型审查模块，复用现有模型目录、认证和调用能力，不创建另一个可执行工具的 Agent 会话。先应用确定性策略，再对允许审查的请求发起无工具调用，严格验证决策枚举和理由；所有异常统一转为 `ask_owner`。

在现有审批记录上补充必要的审查状态、结论、理由、模型、策略版本及决策来源，区分自动审查建议与最终批准者。旧记录没有审查信息时按历史人工审批展示。记录与审批绑定，不建立独立审批服务或另一套批准凭证。

### 4. 接入审批桥并处理并发

以 `src/agent/driver.ts` 的 `awaitApproval()` 为生产接入点：创建持久审批请求并注册等待者后，再启动自动审查，避免同步返回时丢失结果。复用现有批准/拒绝状态转换与 `consumeApproval()`，使决定、理由、来源和事件在同一事务中落盘。

审查返回后重新核查请求仍为 pending、任务仍活动、模式和权限版本仍匹配；人工决定、取消、模式切换与自动结果竞争时，只有一次条件更新可以成功。人工接管后取消审查或忽略其迟到结果；模式切换及任务停止解除等待并取消模型请求。后台重启继续沿用中断任务和失效审批的恢复规则，不自动重放操作或复用旧批准。

保留路由器已有的单次消费、文件版本及路径校验、HTTP 地址固定和禁止自动重定向约束。自动批准只覆盖原请求，不能新增路径授权、凭据权限或跨项目资料授权。同步调整错误信息，自动拒绝不能显示成“拥有者拒绝”。

### 5. 接入公共审批与用户界面

GitHub 专用模块按 Issue 17 退役。auto-review 以公共审批桥为接入点，后续 MCP 写工具由 Issue 18 接入，不新增 GitHub 发布专用逻辑。若实施时旧模块仍在线，保持其现有安全边界直至退役；该临时兼容不作为最终架构。

更新 `src/tui/app.ts` 的 `/mode` 列表、说明、状态栏及审批详情，以及 `src/tui/state.ts`、`src/core/views.ts` 和控制协议中受影响的展示。区分“自动审查中”“待拥有者确认”和已决结果；显示理由与来源，刷新、重连后与后台一致。复用现有人工审批入口，更新 CLI 帮助和受影响的使用文档；按项目约定处理协议版本变化。

### 6. 验证并收尾

复用当前 mock provider 与 Node 测试设施，新增审查行为测试并扩展相关回归测试：

- `test/10-access-modes.test.ts`：三种模式的 session 持久化、任务固定、显式覆盖、版本冲突和任务级切换；将当前拒绝 `auto-review` 的断言改为支持新模式，并继续拒绝未知值。
- `test/08-approvals.test.ts` 及生命周期测试：自动批准、拒绝、转人工、错误结果、超时、取消、人工抢先处理、权限版本变化、迟到结果、单次消费和后台重启。断言实际工具执行次数，不能只检查审查文本。
- 数据库迁移：使用带旧 CHECK 约束及既有任务/审批的数据库验证升级，核对数据与索引/外键保留，并验证新库可写入新模式。
- 执行及公共审批测试：验证新模式选择容器、缺少容器时报错、不会选择完全访问入口；需人工批准的操作不会被新枚举绕过，参数变化使批准失效，效果不明不重发。
- `test/13-tui-state.test.ts`、`test/14-tui-app.test.ts` 与重连测试：模式名称、审查状态、理由、来源和人工接管。审查测试另覆盖输入中伪造审批指令不能改变策略，关键上下文缺失不能批准。

运行 `npm run typecheck`，再运行上述受影响的测试文件。由于模式与审批横跨运行时、协议和存储，合并前运行一次 `npm test`。真实容器边界在具备 Linux/Docker 的环境验证；若本机不具备该环境，在交付中明确记录未验证项，不能用 local 测试代替。完成后更新本工单的实施记录。

## 验收标准

- `/mode` 可选择 `auto-review`，重连和后台重启后保留 session 默认值，新任务正确采用该模式。
- 按明确的策略覆盖自动批准、拒绝、需要人工确认和审查失败，未获得有效批准的操作不执行。
- 拥有者可以查看具体操作的审查结论与理由；批准不能被其他操作或任务复用。
- 现有 `confirm`、`full_access` 和人工审批行为不回归；运行类型检查及受影响的模式、权限和审批测试。

## Comments

### 2026-09-22：创建工单

用户要求新增“添加 auto-review 模式”issue。先记录为 `needs-triage`，审批语义和策略范围在实施前明确。

### 2026-09-22：补充实施计划

已核对现有审批桥、模式入口、SQLite 约束、执行后端与 GitHub 发布分支，补充按依赖顺序执行的六步计划及验证范围。审查策略明确标记为建议，状态保持 `needs-triage`。

### 2026-09-22：确认审批策略和语义

已确认审批策略和语义，状态转为 `ready-for-agent`。

### 2026-09-22：访谈确认

本轮保留既有已确认策略，修正正文仍写“建议/needs-triage”的过时表述。按 Issue 17 的替换方向移除最终交付中的 GitHub 专用发布要求；普通 MCP 写工具在 Issue 18 通过公共审批桥接入。

### 2026-09-22：实现完成

按 `.scratch/personal-agent/15-auto-review-plan.md` 实施完成：

- 模式值：`AccessMode`/`SESSION_DEFAULT_MODES` 加入 `auto-review`；runtime/server/cli 全部校验入口复用该常量；协议版本 6 → 7。
- 数据库：SCHEMA_VERSION 5 → 6。新库 CHECK 直接含新模式；旧库（v1–v5）在迁移事务外关闭外键、事务内重建 tasks/sessions（显式列清单保留原模式与权限版本，重建任务索引）；confirmations 经 ensureColumns 追加 6 个可空审查列（review_status/review_decision/review_reason/review_model/review_policy_version/decision_source）。
- 审查模块 `src/agent/review.ts`：确定性策略先行（仅越界文件读取与无凭据 HTTP GET/HEAD 可审查），无工具 `streamSimple` 调用，30s 自管超时 + 外部中止联动，输出严格校验（枚举 + 非空理由，容忍 code fence），一切失败/超限/超时转 ask_owner；外部中止抛 ReviewAbortedError 不转人工。首版配置：30s、maxTokens 1024、输入上限 8KB、策略版本 auto-review-v1。
- Driver 接入：awaitApproval 先注册等待者再启动单次审查；approve/reject 走条件更新（pending + 权限版本 + 任务仍活动），与人工决定/取消/模式切换竞争只有一次成功，迟到结果标 superseded；人工路径同事务把 in_progress 审查标 superseded 并记 decision_source='owner'；自动拒绝文案与“拥有者拒绝”区分（driver 与 tool-router 两处）。
- 启动器：auto-review 路由到受限容器（与 confirm 同边界）；systemd 入口拒绝；缺 docker 报 execution_unavailable 不回退。
- TUI/展示：/mode 列表加“自动审查”（二次确认浮层仍只对 full_access）；状态栏显示模式与“审查中 N”；审批详情按 reviewStatus 展示审查中/转人工/结论与来源；新增 task.confirmation_reviewed 事件，confirmation_resolved 携带 source/reason。
- 文档：新增 ADR 0005；CONTEXT.md 补“自动审查模式”术语；README/docs/runtime.md 的模式表述同步。
- 测试：新增 test/22-auto-review.test.ts（17 项：端到端批准/拒绝/转人工/非法输出/超时/人工抢先/取消/权限版本变化/重启/重连/注入防护，自动批准单次消费复核，review.ts 单元，v5→v6 迁移，启动器路由）；10/13/14 扩展新模式断言。`npm run typecheck` 通过；全量 `npm test` 175 项：174 通过、0 失败、1 跳过（既有 RUN_MODEL_CHECK 门控的连通性测试）。

评审修复（2026-09-22 第二轮）：githubPublish 不再把显式 auto-review 静默改写为 confirm（模式原样传递，publishDraft 的 mode 类型放宽为 AccessMode，非 full_access 均逐次审批）；stalePendingConfirmations 同事务把 in_progress 审查标记 superseded（重启后不再残留"审查中"）；runAutoReview 的转人工块收敛为 markReviewAskedOwner；新增 isAccessMode 类型守卫替换六处手工校验；补齐取消、单次消费、重连三项测试。

偏差与未验证项：

- 计划称 awaitApproval “唯一调用点 tool-router.ts:337”，实际还有 runtime.ts githubPublish 适配器；已同步改为取 `.decision`（github_publish 范围按确定性策略一律转人工，行为不变）。
- 为让 TUI 实时显示“审查中”，task.awaiting_confirmation 事件载荷补充了 reviewStatus/reviewModel/reviewPolicyVersion 可选字段（计划未列出，属最小补充）。
- mock-provider 增加 res error 兜底（客户端中止审查请求后写已断开 socket 不再砸测试进程）。
- 真实容器边界（Linux/Docker）本机不具备，未验证；启动器测试只断言路由与报错（构造/早期启动级），未在真实容器内跑过 auto-review 任务。

### 2026-09-23：关联更新（issue 17 实施完成）

GitHub 专用模块已按 Issue 17 退役删除（含 runtime.ts 的 githubPublish 适配器与
github_publish 审批范围；上文评论中的相关描述为历史记录）。auto-review 的接入点
保持公共审批桥；历史 github_publish 审批记录只读展示、按确定性策略视同转人工。
通用 MCP 写工具的自动审查由 Issue 18 接入。
