# 为 Coding Agent 添加持久无工具侧聊

Status: in-progress

## 目标与边界

实现[规格 R1–R12](../spec.md#已确认的行为)，理由与备选见[决策记录](../../../.agents/notes/implemented/feature/2026-10-29-coding-side-chat.md)。拥有者已于 2026-10-29 连续三轮确认全部推荐；本次请求是制定方案，不是开始实现。首版只有普通 Code 会话的 TUI 入口、一个固定快照的多轮无工具侧聊，不包括桌面侧聊、工具调研、专用回传、嵌套、重置或独立模型配置。

## 方案

| 顺序 | 最小改动与调用方 | 完成依据 |
| --- | --- | --- |
| 1 | core 的 `types.ts`、`session-identity.ts`、`db.ts`、`store.ts` 及分支准备回执：新增持久父子唯一绑定与 `side` 身份，确保准备期间也只保留一个目标；实际 schema 版本跟随落地时基点递增。 | 直接查询 SQLite 验证身份、唯一约束与原快照；并发、重试、空来源和崩溃发布用例。 |
| 2 | runtime 的 `branch-session.ts` 抽取现有快照准备／发布共用步骤；`runtime.ts` 增加创建／重开与身份分流，复用正式任务链，侧聊不申请目录、不接纳第二个未终结任务、不触碰父任务控制；重启时 queued 侧聊也终结为 interrupted，不留下暂停队列。Driver 发送受阻／超限不暂停侧聊执行队列，新的显式提交继续完整校验。 | 父持锁及等待审批时并行；双客户端发送竞争；幂等参数钉版、失败隔离及接纳后启动前崩溃恢复。 |
| 3 | agent 的 `driver.ts`、`tool-availability.ts`、`session-factory.ts`、`context-assembly.ts`：空工具、无 MCP、简短侧聊提示、独立历史与压缩，阻断父进展的自动参考注入；core `access.ts` 与模型资料读取共同排除侧聊。 | 检查 SDK 实际发送的 system/messages/tools 与选择记录，不只 mock 画像；逐条历史、产物、记忆来源负例。 |
| 4 | control 的协议、server／client；view 的类型、state／event-flow 及普通会话投影：提供侧聊绑定、创建／重开结果和独立流式恢复；普通列表与搜索排除，owner 侧聊读取可用。 | 复用既有认证、幂等、原键核实和事件恢复；桌面普通会话列表不出现侧聊，未知旧协议明确拒绝。 |
| 5 | TUI 的 `commands.ts`、`app.ts` 与最少的独立侧聊组件：`/side`、悬浮层、独立编辑与滚动、主状态保留，作用域限定的 `/interrupt` 与 Ctrl+C。 | PTY 验证焦点、q、粘贴、中文、窄终端、草稿保护、回答期间禁止提交与重开恢复。 |
| 6 | 对照最终实现更新文档与笔记状态，独立实现审查后再做拥有者体验与真实模型验收。 | 文档门禁、定向测试、独立审查和明确的外部验收证据。 |

复用现有依赖、JSONL 格式、SDK 和任务／流式循环，不新增模型调用器或通用派生框架。身份不得由客户端参数绕过，工具权限不能只靠提示词。控制面操作名与具体 DDL 属实现选择，但必须满足规格与准备／发布不变量。

### 文档落点

实现时同步 `docs/modules/core.md`（身份与持久绑定）、`runtime.md`（并行、接纳与恢复）、`agent-context.md`（来源快照、专用输入与可重建性）、`agent-tools.md`（空工具与资料隔离）、`control.md`／`view.md`（协议与投影）、`tui.md` 和 `docs/usage.md`（命令、焦点、收起与中断）。模块地图已有这些模块，不新增模块；若实际职责变化再核实架构总览。新增命令同时核对 README、`docs/development.md` 和 pre-push-checks 的相关命令／测试导航，只改受影响内容；`CONTEXT.md` 增加侧聊定义并列入会话身份。模型提示按 agent-facing-text 检查真实 payload，记录 systemPrompt／toolSchemas 估算。

### 验证范围

新增最窄的 `test/side-chat-core.test.ts`、`test/side-chat-runtime.test.ts`、`test/side-chat-context.test.ts`、`test/side-chat-clients.test.ts`；按现有 fixture 分层复用，避免另建测试运行器。行为覆盖矩阵如下。

| 要求 | 必须能失败的检查 |
| --- | --- |
| R1、R4 | 父任务持有目录、等待审批及等待结果时侧聊能发送请求；主任务 ID、状态、审批与队列不变；侧聊提交不调用父 stop／steer。 |
| R2、R3、R10 | 活动尾部工具批次、部分 JSONL 行、空来源、坏行；首次前缀固定，后续父追加不进入；创建应答丢失、双客户端、发布中崩溃、重启和缺文件负例。 |
| R5、R12 | 实际 SDK 请求 tools 为空且无 MCP；复制的旧工具调用不能执行；每轮沿父当前模型选择，同键重放不改；项目指令／记忆／目录、Jev、清单、父结果和报告不进入侧聊；侧聊仍能独立自动压缩。 |
| R6、R7 | 父及其他普通 Agent 的默认搜索、指定 session／task／entry 读取、直接 artifact、记忆来源保存／自动注入均不能读回；owner 可重开读取；没有父历史／delivery 记录。 |
| R8、R9 | 真实 PTY 的悬浮层、长输出、窄终端、中文与 q；Esc 不停任务，侧聊忙时仍能中断且不触主任务，Ctrl+C 只清获焦草稿／退出客户端；工作流侧栏不抢 Tab／翻页键，主审批状态继续显示。 |
| R11 | 流式期间保留草稿但不提交；跨客户端两个请求竞争最多接纳一个，拒绝端不丢草稿；失败或中断后可发新的追问。 |
| 恢复与配置 | 接纳后启动前崩溃、生成中崩溃都标中断而不重放，重启后不残留 queued／paused，可提交新追问且父暂停状态不变；发送受阻／超限后新的显式提交仍走完整校验，旧输入不重放；模型配置门闩只影响本次接纳；侧聊 JSONL／身份缺失和异常占用明确拒绝，旧库不被新代码修改。 |

实现后跑 `npm run check:static` 与新增定向文件；core 身份／schema 加 01／03／04／05，快照加 `test/102-branch-session.test.ts`，工具与访问加 11／16／62 及 `test/history-search.test.ts`，上下文／压缩加 18／60／61，生命周期／协议加 66／94，view 加 36／37，TUI 加 13／14／15／65，普通列表按实际改动加 `test/69-session-list.test.ts`、`test/74-workspace-sessions.test.ts`。数字是现有文件前缀，执行前按功能词核实完整文件名；最终检查集根据真实 diff 收窄，不机械运行整表或全量 check。若改到旧实例导入，显式定义侧聊为不支持的跨实例对象并覆盖拒绝路径，不新增导入机制。

真实模型验收只在显式 `RUN_MODEL_CHECK=1` 的既有约定下执行；新增验收入口及所需凭据／模型选择在实现时记入开发说明。真实 TUI 体验与双任务并行缺前提时保持待验收，不用离线 mock 代替。

## 进展与交接

- 当前角色与阶段：实施者；R1–R12 已按方案落地，`test/127-side-chat.test.ts` 五条用例全绿，`check:static`（lint/typecheck/notes/docs）通过；独立实现审查已完成，应修项已修复并回归。
- 下一角色与动作：拥有者体验与真实模型验收；TUI 悬浮层与真实终端行为缺前提，保持待验收。
- 当前内容：实现面横跨 core（`side` 身份、`side_chats` 绑定表、schema 55）、runtime（`side-chat.ts` 创建/重开/恢复、`submit_side_chat`、queued 重启中断、普通列表与搜索排除）、agent（空工具画像 `side: []`、侧聊系统提示、上下文装配隔离）、control（三 ops、快照 `sideChats`）、view（绑定投影与列表排除）、tui（`/side` 与悬浮层）、Code 产品能力声明与旧实例导入拒绝（`side_chat_import_unavailable`）。
- 阻塞与恢复条件：无已知阻断。`test/102-branch-session.test.ts` 两处失败（图片连续分支拒绝、双客户端 `queueRevision`）已在未改动 HEAD 上复现，确认为消息控制遗留问题，非本改动引入，不在本工单修复范围。

## 验收与证据

- 方案审查：2026-10-29，两路独立审查通过；曾发现 queued 崩溃与发送失败暂停缺口，修订后均复核关闭，见[审查证据](../evidence/plan-review.md)。
- 工程验收：`test/127-side-chat.test.ts` 覆盖唯一绑定与重开、快照冻结、空来源与损坏拒绝、无工具 payload 与侧聊提示、`side_busy` 与同键幂等、普通 submit 拒绝、父会话并行不暂停、queued 重启中断、产品关闭 `unavailable`、会话清单排除与派生参考块负例；`test/62-tool-availability.test.ts`、`test/66-control-seam.test.ts` 已按新身份与 ops 更新并通过。
- 独立实现审查：核心机制（绑定/快照/无工具/队列/隔离）无结构问题；审查发现的会话清单泄漏、`[工作清单]` 与 `[执行资源]` 注入、未发布绑定下发、侧聊默认模型钉版、`/interrupt` 参数与 failed 原键核实六处已修复并补回归断言；`test/102` 两处失败为 HEAD 既有问题。
- 产品验收：待验收；按规格产品验收节执行。
- 真实模型与真实 TUI：未执行，实施后补前提与结果。

## Comments

2026-10-29：拥有者确认三轮共十二项建议，形成首版边界。本次只制定与审查方案，不开始实施、提交或发布。
