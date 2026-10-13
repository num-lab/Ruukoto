# 任务跟踪：本地 Markdown

工单与规格以 Markdown 保存在 `.scratch/`。

## 文件约定

- 每个功能一个 `.scratch/<feature>/` 目录；共享需求放 `spec.md`，工单引用。独立小任务直接写目标。
- 工单路径为 `.scratch/<feature>/issues/<NN>-<slug>.md`，从 `01` 编号。
- 顶部只有一个当前 `Status:`，取值见 [triage 状态](triage-labels.md)。正文同步有效目标、方案、进展和验收；历史讨论按时间追加到 `## Comments`。

## 开发交接

[开发流程](../../.agents/skills/development-workflow/SKILL.md)定义角色与推进条件，重流程使用[工单模板](templates/task.md)。交接给出角色与工单路径，正文引用长期规范、决定与证据。

接手旧工单先核实当前代码与决定，再补必要字段。笔记 `implemented` 不代表工单已验收。

## 发布与读取

技能要求“发布”时按上述约定创建文件；要求“读取”时按用户引用。只给编号且跨功能重号时，确认所属功能。

## Wayfinder

仅 `/wayfinder` 探索任务使用以下状态，与普通开发工单分开：

- `.scratch/<effort>/map.md` 记录笔记、已有决策与未知事项；子任务写入 `issues/<NN>-<slug>.md`，从 `01` 编号，正文写待解决的问题。
- 顶部 `Type:` 为 `research`、`prototype`、`grilling` 或 `task`；`Blocked by: NN, NN` 指定前置，全部 `resolved` 才解除阻塞。
- 从未解决、未领取且无阻塞的任务中，优先选最小编号；开工前保存 `Status: claimed`。
- 解决后追加 `## Answer`，保存 `Status: resolved`，把结论摘要与任务链接追加到地图的已有决策部分。
