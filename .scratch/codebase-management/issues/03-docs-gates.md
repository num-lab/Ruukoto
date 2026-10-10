Status: resolved

# 03 — docs 与 notes 门禁、notes 路标、修完多行段落

**What to build:** 用可执行门禁替代「靠 skill 触发」的文档同步约定，并给 `.agents/notes/` 补上读者路标。

**Blocked by:** 02（「约定」章节会让 `AGENTS.md` 变长，预算上限要按 02 之后的长度校准）

## 验收标准

- [x] `scripts/markdown-scan.ts` 提供共享的 Markdown 扫描：解析（mdast + GFM）、代码块／HTML 注释／frontmatter 掩码、块级行分类。
- [x] `verify-md-links`：相对链接与图片目标必须存在；`#锚点` 必须命中真实标题 slug 或 `<a id>`；外部 URL、根绝对路径、模板占位符排除。
- [x] `verify-doc-refs`：`src/**/*.ts` 与 `bin/**` 注释中引用的 docs／notes 路径必须存在（开局应即绿，实测 22 条全存在）。
- [x] `verify-doc-budgets` + `scripts/doc-budgets.manifest.json`：按**非空白字符数**卡上限；文件缺失、上限非正整数、超限分别失败；`--list` 列出当前用量。
- [x] `verify-md-wrap`：prose 段落必须一段一物理行。修完 191 处后为 0 违规。
- [x] `.agents/notes/README.md`、`.agents/notes/AGENTS.md`、`.agents/notes/implemented/AGENTS.md` 给出布局、封闭集、一篇一个决定与锚点要求，并把工作流指回 maintain-notes skill。
- [x] 新增 `npm run check:docs`，接进 `check:static`。
- [x] 决策 note 与工单同批落盘，并与既有「不加 docs 门禁」的决定互链。

## 已知违规基线

`verify-md-wrap` 实测定为多行段落的共 191 处、12 个文件：

| 文件 | 处数 |
|---|---|
| `docs/modules/channels.md` | 75 |
| `CONTEXT.md` | 56 |
| `docs/development.md` | 20 |
| `docs/release-acceptance.md` | 19 |
| `.agents/skills/writing-docs-for-human/SKILL.md` | 7 |
| `README.md` | 6 |
| `.agents/skills/writing-docs-for-human/references/prose.md` | 3 |
| `AGENTS.md`、`docs/agents/triage-labels.md`、maintain-notes 的 `archiving.md`／`quality-gate.md`／`when-to-write.md` | 各 1 |

链接与源码引用门禁开局即绿（docs/notes 范围内 72 个文件 0 死链；`src`+`bin` 22 条引用全存在）。`.scratch/` 内的历史死链（7 处指向已删除的 `docs/runtime.md`）与模板占位符不进扫描范围。

## 与既有决定的关系

[决策记录移入 .agents/notes](../../../.agents/notes/implemented/process/2026-10-09-split-agent-and-human-docs.md) 的备选方案里有一条「给 docs 加相对链接测试」被否，理由是「图解页那套门禁正是维护变重的原因」。本批翻转该决定：被否的是**与代码强耦合的图解覆盖测试**，本次加的是纯文本结构检查（链接目标、路径存在性、长度、段落形态），不依赖 `src/` 内容，不会随代码改动而红。按 maintain-notes，新开一篇 note 并互链，旧篇保持原样。

## Comments

### 2026-10-10：预算单位改用字符数

DSH 的 `verify-doc-budgets` 用 `wc -w`。本仓库文档是中文，实测 `docs/architecture.md` 316 词 / 3957 非空白字符、`CONTEXT.md` 422 词 / 9160 非空白字符，比值 10~22 倍，词数几乎不随正文增长。改用非空白字符数。
