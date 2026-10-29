# Coding 侧聊方案审查证据

## 被审内容

目标是完成本次规划，不实现功能。审查对象为[规格](../spec.md)、[决策草案](../../../.agents/notes/implemented/feature/2026-10-29-coding-side-chat.md)与[工单](../issues/01-side-chat.md)，依据是本聊天拥有者对 Q1–Q12 的三轮确认，以及当前工作区实际源码。

调研 HEAD：`5c55e96b5de38f068eabb0aa58b7885e9e085781`。消息控制、技能执行和个人文档存在其他未提交改动；审查应读取当前文件，不能把 HEAD 当未提交内容快照。审查完成后记录这三份方案文件的摘要与源码假设，后续实质变化只复核受影响范围。

## 调研事实

- 普通 `/branch` 已固定完整 JSONL 前缀并准备后发布，父子共享目录；来源规则与跨文件恢复可复用，普通身份和切换行为不能照搬。
- 现有 SDK 显式 `tools: []` 不回落到默认工具；Driver 已有独立任务历史、流式、选择记录、prompt 快照及用量。仅做静态源码核实，未启动模型实验。
- 普通用户会话未发现全局模型槽位限制，目录占用是直接复用普通分支的并行障碍；provider 配置锁和上游限流仍适用。
- 主 Agent 默认能查询同项目的其他普通会话及产物；隔离必须同时覆盖 history、artifact 与 memory source 访问，而不是只隐藏列表。
- TUI 的输入框上方悬浮层可复用，但列表的 q 关闭规则、全局 Ctrl+C 和主视图推断中断目标需要限定作用范围。

产品参考只用于区分设计空间，不作为 Ruukoto 的验收契约：[Claude Code 的 /btw](https://code.claude.com/docs/en/interactive-mode#side-questions-with-btw)明确采用无工具旁问；[Codex 的 /side](https://learn.chatgpt.com/docs/developer-commands)描述独立侧聊。没有实际操作这两个产品，Codex 的精确快照和工具边界不据此推定。

## 独立方案审查

2026-10-29，独立架构审查者 `side_plan_arch_review` 与独立产品审查者 `side_plan_product_review` 分别读取原始需求、确认记录、三份方案及实际源码，结论均为通过，无未解决阻断；二者没有写入文件。

审查发现正式任务链存在两条侧聊无法自行恢复的路径：接纳后尚未启动的 queued 任务重启时保留并暂停；ContextSendBlocked／ContextOverflow 在运行中暂停队列。规格、草案和工单已明确侧聊的专门收尾与再次提交规则，两个审查者均复核关闭。另将工作流侧栏抢 Tab／翻页键及忙时中断补为显式验收负例。

架构审查者亲自核实安全前缀、分支发布、身份、调度与恢复、资料读取、模型装配和安装版 SDK 的空工具实现；产品审查者亲自核对 TUI 键盘、悬浮层、退出／切换、SessionView、主提交与中断恢复。三份方案的末尾换行及分支笔记 `git diff --check` 已核实。

两路最终审查共同对应以下 SHA256；审查后只更新工单的状态与交接／证据信息，产品、技术和验收要求未变。规格与草案保持所列摘要。

| 对象 | SHA256 |
| --- | --- |
| `spec.md` | `85e54270fa8b976c43de9052b9dd131e2af8712601bb9faa2a0e26b2617a0f98` |
| `2026-10-29-coding-side-chat.md` | `82c1d406779f72d45624b74b81b571756ab95075646f3a74132429ebc059dcfa` |
| `issues/01-side-chat.md`，更新交接信息前 | `75fcccc2b39ce0accf03dc9ae61ea42e4aa16f5b5531ee2be8d870cfb19a87f2` |

## 检查与未覆盖项

- 作者执行 `npm run verify-notes`：通过。
- 作者执行 `npm run check:docs`：相对链接、源码引用、字符预算与物理段落检查通过。
- 作者执行 `git diff --check`：通过；本任务新建 Markdown 另核实只留一个末尾换行。
- 作者执行 `npm run check:static`：lint 通过，typecheck 失败，后续门禁未由该组合命令执行，已单独验证。失败来自本任务未修改的消息控制源码与调用方：`store.ts` 的 `cancelRequested` 参数不匹配，Task 的 `queueOrder`、Session 的 `queueRevision` 尚未补齐 demo／view／test fixture。本任务不修改这些并行工作，也不声称全仓静态检查通过。
- 未运行行为测试、真实模型、真实 TUI 或 Linux 实验；它们属于实现后的工程与产品验收，本轮不记为通过。相邻源码变化后，实施者须重新核实当前前提。
