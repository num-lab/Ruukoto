# 消息重排与引导方案审查

日期：2026-10-28（Asia/Tokyo）。基点：`ebbfc255bbeddf73e84d45c673181a43c8d6d2da`。本记录只证明未提交规划材料的审查结果；没有实施新功能、切换数据目录或重启实例。

## 审查对象与结论

[规格](../spec.md)、[实施工单](../issues/01-queue-and-guidance.md)、[决策草案](../../../.agents/notes/proposed/feature/2026-10-28-coding-message-control.md)，以及四篇旧笔记的提案互链。作者为 `/root`；独立方案审查者为 `/root/plan_review`，客户端专项审查者为 `/root/input_facts`，均为不同执行上下文，只读审查，作者单独负责修改文件。

独立方案复审通过，无剩余阻断。客户端限定复审通过，输入身份与聊天顺序两项阻断已解除。复审后只同步工单阶段、证据、旧笔记数量、审计措辞及拥有者后续提交授权，不改变已审产品行为及技术契约。最终文件的可核对摘要列在文末。

## 初审问题与修订

| 初审问题 | 可复现依据／违反约定 | 最终修订 |
| --- | --- | --- |
| v53 自动迁移违反既有决定 | `db.ts` 版本门引用 Code MCP 不兼容切换笔记；后者明确原地延续旧历史须重审，不能暗加迁移 | 删除自动迁移，审计并互链旧决定；新 schema 只用新数据目录，旧档案原地保留，明确无法原地续用旧会话的代价 |
| 普通消息遇等待仍自动中断 | `Runtime.submit` 在 agent／process wait 时解除等待并 `requestStop(owner_input)`，违背 Enter 默认排队 | 明确普通 Code submit 移除该分支；显式引导只解除等待且保持同一 Task，增加对应反例验收 |
| 同 Task 多条 user 会被合并 | `EventFlow.addHistory` 以 `input:<taskId>` 为输入键；原要求与多条引导归入同一目标后只保留最后一条，答案卡按目标匹配也会错替换 | 区分源输入与执行目标；气泡按稳定输入身份及 entry 去重，答案卡只绑定自身输入，原提交／回答回执身份保持不变 |
| 聊天气泡使用排队创建时间 | B、C 创建后重排为 C、B，实际执行时仍按 createdAt 插回早先时间位置 | 普通输入按实际开始证据、引导按 JSONL 接入位置恢复聊天顺序；增加实时、回放、重连与冷恢复的 A→C→B 断言 |

## 审查者亲验与范围

`/root/plan_review` 直接核对了原始访谈决定、当前三份规划文件、相关规则与旧笔记，以及 SDK agent-loop／agent-session、Db 版本门、Runtime.submit／runQueueLoop／recover、OwnerQuestion、Driver、ApprovalGate 和上下文装配入口。初审亲跑 `npm run verify-notes`、`npm run check:docs`、`git diff --check` 通过；修订后重读受影响材料并亲跑 `git diff --check` 通过，没有重复全静态。

`/root/input_facts` 核对桌面／TUI 的实际提交、选择组件、快捷键、回执恢复与投影；用两条 `npx tsx` 内存断言复现同 Task 多 user 合并和创建时间错位。它对后续用户原答复的核对依赖父代理交接及规格，不宣称独立读取完整后续聊天；完整原始决定由上一路审查覆盖。专项复审重读输入身份、实际接入次序、回执与恢复调用方，无剩余阻断；未重复原断言或运行产品测试。这两条断言证明现有假设需要改动，不证明新功能已实现。

## 作者检查

检查环境为 macOS、Node v24.15.0。完整 `npm run check:static` 通过，包含 lint、根与各 workspace／foundation typecheck、笔记树／格式／归档检查，以及文档链接／源码引用／预算／段落换行检查。其后只修改规划文档和笔记，追加执行 `npm run verify-notes`、`npm run check:docs` 与 `git diff --check` 通过，不重复运行未受影响的类型检查。

常规文档门禁不扫描 `.scratch/`；另用一次性 Node／tsx 断言核对本功能三份 `.scratch/` 文件与 proposed 笔记的相对链接、单物理行段落和单个末尾换行，使用现有 `markdown-scan.ts` 解析能力，不新增检查脚本或产品测试。

没有跑完整 `npm run check`、产品行为测试、SDK 契约检查、真实 Electron／MyGo／TUI 或真实模型验收，因为本轮仅制定方案。对应工程、产品和真实环境要求已列入工单；这些仍是实施后的必要门槛，不能以本次静态检查与方案审查替代。

## 后续门槛与风险

下一角色是实施者，先验证公开 SDK steer 元数据保留、同批输入和中止队列行为，再落 core/runtime 契约，最后接两端。发现接口前提不成立时退回修订与复审，不降低用户约定。代码与决定发生实质变化后，本次结论不覆盖其实现。

关键风险是同一输入同时留在 SDK 和普通队列、日志与 SQL 分阶段事实混淆、多条 user 投影合并，以及未消费审批被旧工具批次抢先执行。部署还受既有严格 schema 规则约束：本能力上线需新数据目录，旧档案保留但不会自动出现在新实例。

## 最终交接快照

下列为最终交接文件的 SHA-256；证据文件不包含自己的摘要，避免循环。前三份文件复审后仅同步状态、审查措辞和来源目录事实，关键契约不变。

| 文件 | SHA-256 |
| --- | --- |
| `.scratch/coding-message-control/spec.md` | `f8fbc33b33c17da5509ab132621d8f619839673f814c171c7a2b87defe3b0703` |
| `.scratch/coding-message-control/issues/01-queue-and-guidance.md` | `d58d34f990e56ae9a90968cf0c45fd6f92cd588d9713192cdb3b2f06550d7d9a` |
| `.agents/notes/proposed/feature/2026-10-28-coding-message-control.md` | `b2e50be10b7608ddfe554e002d52f3a4928f8ad55e2c8f3e6be6b584807565ce` |
| `.agents/notes/implemented/architecture/2026-09-19-detach-terminal-from-task-runtime.md` | `d3be45076d2b9639aba773c7b277aa6587a43695a0048c4d52c4cbef30dca535` |
| `.agents/notes/implemented/architecture/2026-10-14-agent-wait-and-report-ownership.md` | `86c9b9a4f50f50d2b4e783bfa4f3074b5c224952ae9ed2336d564fb6f4ce8000` |
| `.agents/notes/implemented/architecture/2026-10-16-owner-attachments.md` | `12e7437f95dc6507883f70efd593c2d5f10ff5beee8db57ef3119c01dae4edae` |
| `.agents/notes/implemented/simplification/2026-10-24-code-instance-mcp.md` | `97d1f6fba0a86b954d4e0b3e84ed241731b817aab38748523262abbf46a9047a` |
