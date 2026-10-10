# AGENTS.md — 决策记录

本目录是决策记录（Agent Note）。布局、命名与文件格式见 [README](README.md)，写与改的流程见 [`maintain-notes` skill](../skills/maintain-notes/SKILL.md)。

- **一篇一个决定。** 事实（路径、符号、默认值）在持有该决定的笔记里就地更新；决定本身或理由翻转时新开一篇并互链，旧篇的 `## 决定` 保持原样。
- **写新笔记前先审查。** 按模块名与关键词检索 `proposed/`、`implemented/`、`rejected/`，把命中的笔记当场归类：无关、部分重叠（互链）、被完全吸收（删或归档）或过时提案（转 `rejected`）。不要推迟。
- **归档冻结。** `archived/` 里的笔记不再编辑、翻译或移动，也不再是当前行为的权威依据。
- **`Status:` 与目录一致。** `implemented/` 里不得残留提案期的节名（`## 方案`、`## 计划`、`## 验收标准`）。
