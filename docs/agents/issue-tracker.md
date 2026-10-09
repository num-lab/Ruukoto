# 任务跟踪：本地 Markdown

本仓库的任务和规格以 Markdown 文件保存在 `.scratch/`。

## 文件约定

- 每个功能使用一个目录：`.scratch/<feature>/`。
- 规格保存在 `.scratch/<feature>/spec.md`。
- 每张工单单独保存为 `.scratch/<feature>/issues/<NN>-<slug>.md`，从 `01` 开始编号。
- 普通工单顶部用 `Status:` 记录 triage 状态，取值见 `triage-labels.md`。
- 评论和讨论按时间顺序追加到文件末尾的 `## Comments` 下。

## 发布与读取

技能要求“发布到任务跟踪系统”时，按上述约定创建文件及所需目录。

技能要求“读取相关工单”时，读取用户引用的文件。若只提供编号且多个功能下存在相同编号，先确认所属功能。

## Wayfinder

以下约定适用于 `/wayfinder` 探索任务：

- 地图保存为 `.scratch/<effort>/map.md`，记录笔记、已有决策和未知事项。
- 子任务保存为 `.scratch/<effort>/issues/<NN>-<slug>.md`，从 `01` 开始编号，正文写明待解决的问题。
- 顶部用 `Type:` 记录 `research`、`prototype`、`grilling` 或 `task`。
- 这里的 `Status:` 表示探索流程状态：领取后为 `claimed`，解决后为 `resolved`。
- 顶部用 `Blocked by: NN, NN` 记录前置任务；所有前置任务均为 `resolved` 后才解除阻塞。
- 从未解决、未领取且无阻塞的任务中，优先选择编号最小的任务。
- 开始工作前，先保存 `Status: claimed`。
- 解决后，将答案追加到 `## Answer`，保存 `Status: resolved`，并将结论摘要和任务链接追加到地图的已有决策部分。
