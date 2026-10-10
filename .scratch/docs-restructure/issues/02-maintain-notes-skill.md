Status: resolved

# 写项目版 maintain-notes skill，接入 verify-notes

依赖：01。范围见 [spec](../spec.md)，六条定制的理由见决策 note。

## 做法

1. 以 `~/.claude/skills/write-notes-like-deepseek/` 为底，写 `.agents/skills/maintain-notes/SKILL.md`（这个空目录已经存在）。保留原 skill 的判定红线、路径即分类、生命周期流转、当场审计和交互协议，并按下面六条改写：
   1. 中文正文与中文节名：问题、决定、备选方案、后果；提案用方案、验收标准、风险。头块的 `# Agent Note:` 和 `Status:` 保持英文，供脚本核对。
   2. 格式采纳日：`verify-agent-note-format.ts` 的 `FORMAT_ADOPTED` 改为 `2026-10-10`，必须晚于所有迁移来源的日期（最晚是 0017 补充段的 2026-10-09）。迁移来的 note 找不到当时的备选方案时，用 grandfather 注释代替 `## 备选方案`；新 note 一律要写这一节。
   3. 允许链接 `.scratch/`。
   4. 与工单的分工：工单（`.scratch/<feature>/`）记计划与进展，note 记理由与被否方案；工单做出非平凡决定时，在同一提交里写或改 note。
   5. 旧编号：迁移来的 note 在头块后、`## 问题` 前写一行「原编号：ADR 00xx」（从补充段拆出的写「原出处：ADR 00xx「补充：…」」）；检索旧编号用 `rg "ADR 00xx" .agents/notes`。
   6. 本仓库以 maintain-notes 为准；全局安装的 write-notes-like-deepseek 不用于本仓库。
2. vendor 脚本到 `.agents/skills/maintain-notes/scripts/`：`agent-note-tree.ts`、`verify-agent-note-tree.ts`、`verify-agent-note-format.ts`、`verify-archived-agent-notes.ts`、`archive-agent-note.ts`、`check-note-anchors.ts`。不要 board/bundle、assets 和 CI 模板。references 只保留 SKILL.md 实际引用到的，按中文约定改写；templates 改用中文节名。
3. `package.json`：新增 `verify-notes`，依次用 tsx 跑三个 verify 脚本；`check:static` 改为 `npm run lint && npm run typecheck && npm run verify-notes`。
4. AGENTS.md 的「Agent skills」下加一节「决策记录」，一行指针：做非平凡改动、选型、取代旧决定时，按 `.agents/skills/maintain-notes/SKILL.md` 操作。
5. 用现有的 [决策 note](../../../.agents/notes/implemented/process/2026-10-09-split-agent-and-human-docs.md) 验证脚本。

## 验收

- [x] `npm run verify-notes` 对现有决策 note 通过。临时造一篇缺备选方案、状态与目录不符的 note，两项都会报错（结果记在 Comments，不保留文件）。
- [x] `npm run check:static` 包含 verify-notes 并通过。
- [x] SKILL.md 不再出现 `write-notes-like-deepseek` 的安装路径或 npm 脚本名的旧说法；所有命令都能在仓库根直接运行。

## Comments

2026-10-09：完成。

- `.agents/skills/maintain-notes/`：SKILL.md 按六条定制改写；references 保留 note-format、classification、when-to-write、archiving、prose-checklist、quality-gate 六篇，节名改为中文，路径改指本 skill。note-format 补了「原编号」行和 grandfather 例外的写法，when-to-write 第 5 节改成本仓库的代码锚点约定。simplification-checklist（DeepSeek 自身的包路径）和 verification（并入 SKILL.md 第 7 节）没有带过来。templates 三份改用中文节名。
- 脚本：vendor 了 6 个，只改了 `FORMAT_ADOPTED = "2026-10-10"`。脚本只依赖 node 标准库，由仓库已有的 tsx 运行；eslint 与 tsc 本来就不扫 `.agents/`。
- `package.json`：新增 `verify-notes`（tree → format → archived），`check:static` 末尾接上它。
- AGENTS.md：新增「决策记录」一节指针。
- 验证：`npm run verify-notes` 对决策 note 三项通过（0 篇归档，0 个封印）。临时样本（检查完已删除）：状态与目录不符、缺备选方案都报错，退出码 1；日期 2026-10-12 的笔记用 grandfather 注释报「only valid before 2026-10-10」；日期 2026-09-19、带「原编号」行和 grandfather 注释的样本通过。`npm run check:static` 退出码 0。
- 已知限制：CI 没有设置 `AGENT_NOTE_ARCHIVE_BASE_REF`，所以封印只增不改的检查在 CI 上退化为哈希自校验，这一点已写进 SKILL.md。等到真有归档篇时，再考虑在 `check.yml` 里传入基线提交。
