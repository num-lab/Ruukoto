# .agents/notes — 决策记录

这里存放本仓库的决策记录（Agent Note）：代码与文档承载不了的**为什么**，以及**放弃了什么**。本文件面向**读者**，说明目录怎么组织、一篇笔记长什么样；写与改的完整流程见 [`maintain-notes` skill](../skills/maintain-notes/SKILL.md)。

## 布局与命名

每篇笔记的两个维度都编码在路径里：`{lifecycle}/{class}/yyyy-mm-dd-topic.md`。

**lifecycle** 是这篇笔记所处的阶段，随状态变化在目录间移动：

- `proposed/`：方案已定但尚未落地。
- [`implemented/`](implemented/)：决定已交付。正文描述**当前**的事实，随代码同批更新；见 [implemented/AGENTS.md](implemented/AGENTS.md)。
- `rejected/`：方案经审议被否，仅在仍能防止重蹈覆辙时保留，结论写在 `Status:` 行。
- `archived/`：已完成、未来参考价值低的 implemented 笔记，封印后冻结不可改。

**class** 是决定的种类，封闭集只有六个，新增要同时改校验脚本：

| class | 覆盖范围 |
|---|---|
| `feature` | 面向用户或模型的新能力与行为选择 |
| `bug-fix` | 修好的缺陷，或补上复盘暴露的缺口 |
| `simplification` | 不加能力，只删代码、行为或对外范围 |
| `architecture` | 源码怎么组织、模块怎么连、运行时词汇 |
| `process` | 围绕代码的工具与工作流：门禁、发布、协作 |
| `testing` | 测试策略与测试设施 |

文件名里的日期是**首次提出**的日期，随笔记在目录间移动而不变。`archived/` 里的笔记永不再改。

## 一篇笔记的形态

前三行固定，`Status:` 必须与所在目录一致：

```markdown
# Agent Note: <标题>

Status: <状态>
```

正文按 lifecycle 使用固定节名：

- `proposed`：`## 问题` → `## 方案` → `## 备选方案` → `## 验收标准` → `## 风险`
- `implemented`：`## 问题` → `## 决定`（现在时）→ `## 备选方案` → `## 后果`
- `rejected`：冻结的 proposed 形态，结论在 `Status:` 行

`## 备选方案` 是必填：只记录真正权衡过的方案，先写它最强的理由再写为何否掉。理由与细节见 [note-format](../skills/maintain-notes/references/note-format.md)。

## 怎么找

- 按主题浏览 `{lifecycle}/{class}/` 目录，或直接全仓检索。
- 源码里承载决定的入口带 `Note: 见 .agents/notes/<路径>` 锚点，从代码顺藤摸瓜。
- `docs/modules/*.md` 的「设计依据」一节链接到对应笔记。
- 没有集中索引，也不建 `INDEX.md`：它重复路径元数据，并让无关改动争用同一个文件。

## 与其他层的关系

| 位置 | 写什么 |
|---|---|
| `.agents/notes/` | 决定、理由、被否方案、后果 |
| [`.scratch/`](../../.scratch/) | 工单：计划、进展、验证记录 |
| [`docs/`](../../docs/) | 面向人类的设计文档：现在怎么运作；「设计依据」单向链接到笔记 |

写新笔记前先按模块名与关键词检索既有笔记，避免重复记录同一个决定。
