Status: resolved

# 冻结可视化文档

无依赖。范围见 [spec](../spec.md)。可视化文档暂停维护，不是删除。

## 做法

1. 删除 `test/67-visual-docs.test.ts` 和 `.agents/skills/visual-docs/`，把最后提交号记入 Comments，以后恢复维护时从这里取回。
2. 删除 AGENTS.md 的「### 可视化文档」小节；`docs/development.md` 的测试导航表里删掉 test/67 那一行。第 118 行的 Linux 基线记录属于历史数据，保留原文。
3. `docs/visual/` 里的 11 个 HTML 页面（10 页加 index.html），在正文最上方加横幅：「2026-10-09 快照，已停止维护，以 docs/ 模块文档为准。」用 `style.css` 现有的 `aside.callout.limit`（首个 `<b>` 作标签），不新增 CSS。页面内容和失效链接都不修。
4. README「文档」一节里图解页那一行，标注为「2026-10-09 快照，已停止维护」。
5. `.scratch/agent-direction/issues/24-release-acceptance.md` 链接到 `.agents/skills/visual-docs/SKILL.md`，删除 skill 后改为纯文本，并注明「已于 2026-10-09 移除，见本工单 Comments 的提交号」。

## 验收

- [x] `npm test` 不再包含 test/67；`git grep -n "visual-docs"` 只命中 `.scratch/` 与 `.agents/notes/`。
- [x] 11 个页面都有横幅；挑两页在浏览器里打开，确认横幅显示正常。
- [x] `npm run check:static` 通过。

## Comments

2026-10-09：完成。

- 删除前的最后版本：`test/67-visual-docs.test.ts` 与 `.agents/skills/visual-docs/`（SKILL.md、drawing.md、shoot.sh）在提交 9c6ee2b 中仍完整存在，恢复维护时用 `git checkout 9c6ee2b -- <路径>` 取回。
- 11 个页面都在 `<main class="page">` 之后插入 `<aside class="callout limit"><b>快照</b>…</aside>`；页面正文、页脚的「随代码维护」说明与失效链接都没改。用 headless Chrome（1100×520）截了 index 与 outbox 两页，横幅显示为深色主题下的琥珀色 callout，位于面包屑之上，没有重叠或截断。
- AGENTS.md 删掉「可视化文档」一节；development.md 删掉测试导航表中 test/67 那一行，第 118 行的 Linux 基线记录保留；README 的图解页条目加上「2026-10-09 快照，已停止维护」。
- `.scratch/agent-direction/issues/24-release-acceptance.md` 中指向 visual-docs skill 的链接改为纯文本，并注明提交 9c6ee2b。
- `git grep visual-docs`：除 `docs/visual/` 页面自身的历史说明外，只命中 `.scratch/`、`.agents/notes/` 和 test/81 的一个用例名（指 visual-docs-review 工单，与图解维护无关）。
