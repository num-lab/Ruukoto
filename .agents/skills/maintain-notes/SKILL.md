---
name: maintain-notes
description: 在 .agents/notes/ 写或改本仓库的决策笔记。用于非平凡改动（行为、架构、跨文件契约、流程与工具链、测试策略、落盘/协议/配置格式）、在方案间取舍、取代旧决定、写复盘；纯机械改动不用。
---

# 维护决策笔记

`.agents/notes/` 是本仓库的决策记录，面向 agent：为什么这样改、放弃了什么、怎么证明改对了。它和另外两处分工：

| 位置 | 写什么 |
|---|---|
| `.agents/notes/` | 决定、理由、被否方案、后果 |
| `.scratch/<feature>/` | 工单：计划、进展、验证记录 |
| `docs/` | 给人看的设计文档：现在怎么运作；「设计依据」单向链接到笔记 |

工单做出非平凡决定时，在同一提交里写或改笔记。方法来自全局 skill `write-notes-like-deepseek`；在本仓库以本 skill 为准。

## 1. 先判要不要写

**快速返回**：纯机械或局部改动直接改代码，不写笔记——排版、错别字、无歧义重命名；不改行为的样式调整与依赖补丁、版本打标；常规 CRUD、单模块内看 diff 就懂的逻辑修复。

**非平凡，必须写**：改了行为、架构、跨文件契约、流程与工具链、测试策略、落盘/协议/配置格式，或其他维护者日后可能重访的选择。代码和测试说不出来的意图、边界、取舍，就是非平凡；判不准时从严。

写之前想清楚这篇守住什么：

1. **立新规**：跨模块契约、状态流转、访问边界、运行时不变量。不记，后来的 agent 各写一套。
2. **记妥协**：为看不见的约束放弃了直觉解法。不记，被否的老路会被重走。
3. **做减法**：裁剪代码、收窄 API。不记，没人知道退出条件和迁移边界。

| 借口 | 现实 |
|---|---|
| 只是改个默认值/重命名 | 默认值和命名都是决策事实；原地更新老笔记只要 30 秒 |
| 先合并，以后再补 | 以后等于永远不会 |
| 代码即文档 | 代码只说是什么，说不出为什么和放弃了什么 |
| 改动很小 | 规模小不等于不用记 |

四条纪律：

- **就地同步优先**：改动已有归属，就直接更新那篇笔记的事实（路径、符号、默认值），正文始终反映当前代码，不追加流水账。
- **一篇一个决定**：事实就地改；决定或理由翻转，新开一篇并互链，旧篇的 `## 决定` 保持原样。
- **当场审计**：写新篇前按模块名、关键词搜 proposed、implemented、rejected，每篇命中当场归类——无关 / 部分重叠（互链）/ 完全吸收（删或归档）/ 过时提案（转 rejected 或删），结果和新笔记一起落盘。
- **归档只收有价值的**：过时提案转 `Status: rejected — <原因>`；没有防坑价值的被否记录直接删除。

## 2. 路径即分类

`.agents/notes/{lifecycle}/{class}/yyyy-mm-dd-topic.md`，日期是首次提出日。目录用到才建，不建 `INDEX.md`。

lifecycle（这篇走到哪一步）：

- `proposed`：有方案，还没落地
- `implemented`：已落地，与代码同批改动保持同步
- `rejected`：审慎否掉的提案，只在能防止重犯时保留
- `archived`：已完成、未来参考价值低的 implemented 记录，冻结不可改

class（就这 6 个，再加要改脚本）：

- `feature`：用户或模型看得见的能力与行为选择
- `bug-fix`：修好了什么，或补上复盘暴露的缺口
- `simplification`：不加能力，只删代码、行为或表面
- `architecture`：源码怎么组织、模块怎么连、运行时词汇
- `process`：检查、发布、协作等围绕代码的流程
- `testing`：测试策略与测试设施

重构不单列：可观察行为变了归对应类，没变就是 `simplification`。细判据见 [classification](references/classification.md)。

## 3. 文件格式

前三行固定，`Status` 与所在 lifecycle 目录一致（`rejected` 带一句话原因）：

```markdown
# Agent Note: <标题>

Status: <状态>
```

正文节名一律用中文（脚本也认英文原名，本仓库不用）：

- `proposed`：`## 问题` → `## 方案` → 自由节 → `## 备选方案` → `## 验收标准` → `## 风险`
- `implemented`：`## 问题` → `## 决定`（现在时）→ 自由节 → `## 备选方案` → `## 后果`
- `rejected`：冻结的 proposed 形态，结论在 `Status:` 行

备选方案必填：只写真实考虑过的方案，先写它最强的理由再否定。

从 `docs/adr/` 迁移来的笔记有两处例外：头块后写一行「原编号：ADR 00xx」；文件名日期早于 2026-10-10 且找不到当时的备选方案时，用 grandfather 注释代替 `## 备选方案`。写法见 [note-format](references/note-format.md)。模板在 `templates/`。

## 4. 动手前检索

重构或选型前，先查历史约束：

1. **代码锚点**：入口注释里的 `Note: 见 .agents/notes/...`，顺着读。
2. **分类树切片**：架构看 `implemented/architecture/`，避坑看 `rejected/`。
3. **全局检索**：`rg --hidden --glob '!.agents/notes/archived/**' "<机制名或关键词>" .agents/notes/`；旧 ADR 编号用 `rg "ADR 0017" .agents/notes`。
4. **模块文档下钻**：`docs/modules/*.md` 的「设计依据」链接到对应笔记。

这四法能答的事实自己查；只有取舍和拍板才问用户。

## 5. 什么时候写、什么时候改

触发信号：「就选 X」「决定用 X」「先用 X 顶着」触发笔记；「X 和 Y 怎么选」触发备选方案记录；同一段理由被解释第二遍，就该写下来了。

- **重构、路径迁移、参数改动**：在持有该决定的笔记里原地修正事实。核心理由变了才新建。
- **新想法、还没动手**：先写 `proposed`，评审完再动手。
- **施工完（proposed → implemented）**，与代码同一提交：移到 `implemented/<class>/`，文件名日期不动；`Status: implemented`；`## 方案` 改成现在时的 `## 决定`；`## 验收标准`、`## 风险` 折进 `## 后果`（或现在时的 `## 测试`、`## 验证`）；删掉计划段。
- **被新决定部分取代**：两篇都留，互加相对链接，只更新仍成立的事实。
- **被新决定完全取代**：新篇写入旧篇全部独特的理由、备选、后果和验证缺口；入站链接与代码锚点改完后，能删则删，旧篇仍有独立价值才归档。指针写在新笔记里。

向用户提问时：

1. 先分事实和决定，事实自己查完。
2. 一轮全抛：待拍板的问题编号列出，每题带推荐答案 `➡️ <推荐>`。
3. 落笔或动手前复述全部决定，用户确认后再执行。
4. 开放决策超过五个，说明改动太大：拆成多篇，或先交 proposed 草稿评审。

细则见 [when-to-write](references/when-to-write.md)，归档与删除见 [archiving](references/archiving.md)。

## 6. 怎么写好

- `## 后果` 同时写代价和收益。
- 自由节（拓扑、协议、schema 等）放在 `## 决定` 与 `## 备选方案` 之间，保留可检索的机制名与 must / may / never 的时序强调。
- 跨笔记引用用相对 Markdown 链接，例如 `[topic](../../implemented/architecture/2026-…-….md)`，不写裸编号。可以链接 `.scratch/` 里已入库的工单与证据。
- 承载决定的代码入口留锚点 `Note: 见 .agents/notes/<路径>`，写法见 when-to-write 第 5 节。
- 文风与去泄露见 [prose-checklist](references/prose-checklist.md)。
- 写完过一遍 [quality-gate](references/quality-gate.md) 的语义自检，只向用户报缺口和写得好的地方（不超过 5 行），每个缺口给出具体修法。

## 7. 校验与命令

在仓库根目录运行：

```sh
npm run verify-notes
npx tsx .agents/skills/maintain-notes/scripts/archive-agent-note.ts <笔记路径> [--superseded-by <新笔记路径>]
npx tsx .agents/skills/maintain-notes/scripts/verify-archived-agent-notes.ts --write
npx tsx .agents/skills/maintain-notes/scripts/check-note-anchors.ts
```

- `verify-notes` 依次检查：目录与分类、文件名、笔记间相对链接；头块、必备节与备选方案；归档封印（头部布局、`archived/manifest.json` 哈希、只增不改）。已接入 `npm run check:static`，CI 经 `npm run check` 运行。
- 封印只增不改的检查以 `AGENT_NOTE_ARCHIVE_BASE_REF`（默认 `HEAD`）为基线。CI 没有设置它，所以 CI 上只做哈希自校验。
- `archive-agent-note` 插入 `Archived:` 行、移入 `archived/`、写封印并报告入站死链；`--write` 为未封印的归档补封印。
- `check-note-anchors` 是软报告，退出码恒为 0：列出悬空锚点和没有锚点指向的 implemented 笔记。
