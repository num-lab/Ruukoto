# 领域文档

本仓库采用 single-context 布局：

- 根目录 `CONTEXT.md`：领域术语表。
- `.agents/notes/`：决策记录，按 `.agents/skills/maintain-notes/SKILL.md` 维护；决策只记在这里。

## 探索前读取

探索代码库前，读取 `CONTEXT.md`，并按 maintain-notes「动手前检索」找出与当前工作相关的决策笔记。

`CONTEXT.md` 不存在时，静默继续，由 `domain-modeling` 在术语确定时按需创建。`domain-modeling` 需要记录决策时，改为按 maintain-notes 写笔记，决策只记在 `.agents/notes/`。

## 沿用领域术语

任务标题、方案、假设和测试名称中的领域概念，应采用 `CONTEXT.md` 定义的术语。

需要的概念尚未收录时，先判断是否应使用已有术语；确有缺口时，交由 `domain-modeling` 补充。

## 明确指出决策冲突

方案与已有决策笔记冲突时，明确标出相关笔记的路径，并说明重新讨论该决策的理由；决定翻转按 maintain-notes 新开一篇并互链。
