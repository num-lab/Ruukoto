Status: resolved

# CONTEXT.md 收回为纯术语表

依赖：03、06（实现细节要有着落）。范围见 [spec](../spec.md)。

## 做法

- 每个词条只保留定义和 _Avoid_。表名、工具名、实施状态、issue 编号与 ADR 编号移出：先查模块文档或 note 有没有同一事实，没有就补到对应模块文档（现状）或 note（理由），然后从词条里删掉。SubAgent 词条最长，逐句核对。
- 开头一段改为：项目包括两个产品，各一句话，架构见 `docs/architecture.md`。不再引用 ADR 和 runtime.md。
- 词条的增删仍由 `domain-modeling` 维护，`docs/agents/domain.md` 里的读取顺序不变。

## 验收

- [x] `grep -nE "issue|ADR|工单|runtime\.md" CONTEXT.md` 无命中。
- [x] 删掉的每个事实，都能在模块文档或 note 里找到（对照表记入 Comments）。
- [x] 术语名称和 _Avoid_ 列表没有改动，只删实现细节。

## Comments

2026-10-10：完成。`CONTEXT.md` 183 行 → 183 行（词条数与行数不变，正文由 33,479 字节收到 24,141 字节）。改动前的最后提交号：`df9e9824c4f5f0802744a564b01e193f88b586db`（`df9e982`）。

### 做法

先对 61 个词条提取全部实现细节（表名/列名/工具名/CLI/路径/令牌、issue 与 ADR 编号、实施状态叙述），对 123 条事实逐条回查 `docs/modules/*.md`、`docs/architecture.md`、`docs/usage.md`、`docs/development.md`、`docs/release-acceptance.md` 与 `.agents/notes/**/*.md`（`.scratch/` 与 `docs/visual/` 不计为有效去处：前者是工单、后者是冻结快照）。全部 123 条都能在范围内找到出处，无需新写 note。1 处事实缺口补进了模块文档：

- `docs/modules/core.md` 的 `tasks` 列清单缺 SubAgent 关联四列 `work_id` / `sub_agent_id` / `read_scope` / `result_delivered_at`，已补上（加注「SubAgent 关联四列」），原先只有 `.agents/notes/implemented/architecture/2026-10-03-work-delegation-subagent-task.md` 记录。

### 逐词条改动（27 处字段，其余 36 个词条正文原样）

| 词条 | 删掉的实现细节 | 事实现所在 |
|---|---|---|
| 开头段 | 「已按 ADR 0017 实施」「跨端共享记忆仍属于后续方向」与 ADR 链接 | 两产品各一句话；architecture.md、usage.md 链接保留 |
| SubAgent | 「当前实现（agent-direction issue 11–12，ADR 0020）」及 `sub_agents`/`work_delegations`/`tasks` 分存、`work_id` 继续、`sub_agent_id` 复用、`subagent_close`、`ruukoto work close`、`closed_at`/`closed_by`、`mode=modify + target`、worktree、`subagent_integrate` 预检与幂等、`coding_delegate` 删除、`coding_result`、宿主固定评审每修订一 Agent、`subagent_message` 幂等、投递与冲刷、`interrupted(backend_restart)`、`resume-queue`（−1381 字，最长的一条） | `docs/modules/runtime.md` 数据与状态、继续/复用与关闭（151–155）、工作内消息（161–166）、改动汇总（192–197）、宿主固定评审（209–213）、后台崩溃恢复（239–246）；`coding_result` 窄口见同模块 205 与 note `2026-10-03-work-delegation-subagent-task.md` |
| 拥有者 IM 入口 | 「（当前为 QQ 私聊与 Telegram）」「（平台、登录账号/bot、chat 与配置版本）」「配置停用与启动配置停用同义（架构工单 10）」 | `docs/modules/channels.md` 钉版目标（156–157）、代次（490）、启动配置停用同义（496） |
| 上下文压缩 | 「（ADR 0016）」「当前实现适用于 main 与普通开发会话（SubAgent 会话不压缩）」 | `docs/modules/agent-context.md` 压缩规划与执行（115：适用范围与 `compaction: null`）；理由见 note `2026-09-26-lossy-context-compaction.md` |
| 选择记录 | 「拥有者可在 `/context` 与 prompt 查看中查阅」 | `docs/modules/agent-context.md` 选择记录（35、60）；`/context` 见 `docs/modules/tui.md` |
| 工作区 | worktree 路径 `<dataDir>/../agent-work/worktrees/<workId>`、分支 `ruukoto/work-<workId>`、基线、不提交不推送、直接写入串行、`subagent_integrate` 汇入 | `docs/modules/runtime.md` 183–186、`docs/modules/execution.md` 77；不变量 289 |
| 工作区组织归属 | `sessions.workspace_project_id`、ADR 0018、括号内的资料身份清单 | `docs/modules/core.md` 123（列说明）；note `2026-10-03-legacy-workspace-org-attribution.md` 决定段 |
| 实例导入 | `instance_imports`/`instance_import_items`、两方向命令与 allow-list 全文、`agent-data/main.db`、preview/apply/revert/list、持锁离线、行 ID、收尾语义、交接维度、sha256 manifest、备份路径 | `docs/modules/runtime.md` 252–261（导入机制全文）、`docs/modules/core.md` 61 与 133–134（备份路径、两张表）、`docs/usage.md` 359–398（两方向命令、交接与旧实例停用要求）；方向细节见 note `2026-10-04-legacy-instance-import.md`、`2026-10-05-personal-instance-import.md` |
| 资料授权 | 「当前实现」措辞 | `docs/modules/agent-context.md` 66 |
| 项目指令 | 「当前」措辞 | `docs/modules/agent-context.md`；归属说明同 note 决定段 |
| 技能 | 「当前实现注入 main 与普通开发会话（SubAgent 不注入）」 | `docs/modules/agent-context.md` 125 |
| 工作委托 | 「当前实现（agent-direction issue 11）」、`work_delegations` 字段与首次委派键、`tasks.work_id`、取消三列与条件写入、`work_cancel`/`ruukoto work cancel`/`subagent_cancel`、登记事务内取消、`write_target`、`subagent_messages`、`work_delegation.integrated` 事件 | `docs/modules/runtime.md` 49–55（表与列）、171–176（整项取消）、182（写入目标）、196（汇总事件）、49（首次委派键） |
| 工作清单 | 「当前实现仅普通开发会话可用」 | `docs/modules/agent-tools.md` 184 |
| IM 审批控制消息 | 八条命令全文、issue 08/10、`inbound_events.event_kind = im_approval`、同事务与 outbox 回执 | `docs/modules/channels.md` 命令表（75–84）、解析与终态（339–344）、同事务（350）、回执目标（336） |
| 长期操作授权 | 「agent-direction issue 10」、白名单 restart、范围四元组、失效条件、已批准记录单次消费与授权不被消费 | `docs/modules/agent-tools.md` 187、218；`docs/modules/deploy.md` 21、126（首版仅 restart）；`docs/modules/channels.md` 520（不能创建/扩大/继承） |
| MCP 服务 | ADR 0006/0008、副作用类别括号、issue 18 | `docs/modules/agent-tools.md` 78（配置字段）、122（任务内钉版）、222（允许列表本地声明与逐次审批） |
| QQ 群聊入口（旧架构） | issue 20、忽略语义括号、`qq inbox`/`qq outbox`/`read_history`、撤回标记 | `docs/modules/channels.md` 436–450 |
| 逻辑角色（旧架构） | issue 20/23、存储约束保留旧取值、在途子任务收尾不重放 | `docs/modules/core.md` 191（存储不收缩、`CHECK` 仍含旧取值）；`docs/modules/runtime.md` 246（在途任务中断不重放）；note `2026-10-02-two-agent-products.md` 17 |
| 群聊结果 | issue 20、`chat_result_list`/`chat_result_accept`、复核清单与 `source_revoked` | `docs/modules/channels.md` 457、462–464、583；`docs/modules/scheduler.md` 176 |
| 入站事件 | 「（issue 01）」 | `docs/modules/channels.md` 502、`docs/modules/core.md` 130 |
| 应用数据空间 | issue 02/ADR 0009、`ruukoto.db` 与 `<dataDir>/agent-data/main.db`、六个工具名、破坏性清单 | `docs/modules/core.md` 61；`docs/modules/agent-tools.md` 186（六个工具）、195（含完全访问逐次审批）、216（偏好仍进长期记忆）；校验边界见 note `2026-09-23-main-app-data-space.md` |
| 配置中心 | `ruukoto config`、issue 21、面列表、摘要模型括号、离线模式清单与配置锁 | `docs/usage.md` 192（命令与范围）、195（应用时机）、199（离线模式与配置锁）；`docs/modules/tui.md` 188、215（修订校验） |
| 调度计划 | `schedule_create`、issue 03/ADR 0010、三种动作 | `docs/modules/scheduler.md` 17（工具）、42（`action` 取值）、134（时间规则与时区）；不支持编辑见 note `2026-09-24-scheduler-outbox.md` 23 |
| 发送操作 | `notification_ops`；`_Avoid_` 里的「，ADR 0011」 | `docs/modules/scheduler.md` 46、174（唯一回退例外与理由） |
| owner 回复 | 「当前实现（agent-direction issue 18）」、`owner_reply` 槽、发送键、正文构成、指向 runtime.md 失效小节的链接 | `docs/modules/runtime.md` 203（工作最终汇报全段）、226（归属） |
| GitHub 评审入口 | 「当前实现（agent-direction issue 19）」、ADR 0013 修订段、issue 23 删除旧分支 | `docs/modules/channels.md` 397、413；note `2026-10-02-two-agent-products.md` 17 |

另有 2 处 `_Avoid_` 行只去掉编号（实例导入的「（07）」「（21/22）」、发送操作的「，ADR 0011」），措辞未改。

### 验收记录

1. `grep -nE "issue|ADR|工单|runtime\.md" CONTEXT.md` → 无命中（exit 1）。删除后正文里只剩 7 个反引号令牌：`skill`/`/skill`（词条定义所需的概念名）、`ConfirmationRequest`（_Avoid_ 里的代码名对照）、`npm run dev`/`npm run code`/`ruukoto <路径>`（用户可见入口）、`schedule_create` 已一并移出。
2. 123 条事实全部有出处，见上表；唯一缺口（core.md 的 `tasks` 关联四列）已补齐。
3. 词条名 61/61 与 `_Avoid_` 56/56 逐行比对一致，仅去掉编号；`git diff` 确认无词条增删或重排。

### 验证

`npm run check:static` 通过（lint、`tsc --noEmit` ×2、`verify-notes`：36 篇笔记树与相对链接通过、格式通过、0 篇归档）。
