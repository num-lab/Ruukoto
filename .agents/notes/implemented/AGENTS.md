# AGENTS.md — 已落地的决策记录

这里的笔记描述**已经交付**的决定。遵循[根指示](../../../AGENTS.md)、[目录说明](../README.md)与 [`maintain-notes` skill](../../skills/maintain-notes/SKILL.md)；`verify-agent-note-format` 校验结构。

## 与代码保持同步

报告路径、符号、默认值与机制时，在同一改动里就地更新——包括代码移动文件、重命名符号或改默认值的情形。**改写陈旧事实，不追加变更流水账。**

## 同步事实不等于改写决定

就地更新的是事实的落地形态；决定本身或其理由被推翻时，新开一篇笔记并互链。

## 不再指导未来的笔记

交付的决定已完全落地、依据不太可能再指导未来工作时，用 [`archive-agent-note`](../../skills/maintain-notes/scripts/archive-agent-note.ts) 归档；仍有独立的否定性保证、归属边界或重新引入条件时，继续作为活跃记录保留。
