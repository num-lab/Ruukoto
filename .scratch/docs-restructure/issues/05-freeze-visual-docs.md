Status: ready-for-agent

# 冻结可视化文档

无依赖。范围见 [spec](../spec.md)。可视化文档暂停维护，不是删除。

## 做法

1. 删除 `test/67-visual-docs.test.ts` 和 `.agents/skills/visual-docs/`，把最后提交号记入 Comments，以后恢复维护时从这里取回。
2. 删除 AGENTS.md 的「### 可视化文档」小节；`docs/development.md` 的测试导航表里删掉 test/67 那一行。第 118 行的 Linux 基线记录属于历史数据，保留原文。
3. `docs/visual/` 里的 11 个 HTML 页面（10 页加 index.html），在正文最上方加横幅：「2026-10-09 快照，已停止维护，以 docs/ 模块文档为准。」用 `style.css` 现有的 `aside.callout.limit`（首个 `<b>` 作标签），不新增 CSS。页面内容和失效链接都不修。
4. README「文档」一节里图解页那一行，标注为「2026-10-09 快照，已停止维护」。
5. `.scratch/agent-direction/issues/24-release-acceptance.md` 链接到 `.agents/skills/visual-docs/SKILL.md`，删除 skill 后改为纯文本，并注明「已于 2026-10-09 移除，见本工单 Comments 的提交号」。

## 验收

- [ ] `npm test` 不再包含 test/67；`git grep -n "visual-docs"` 只命中 `.scratch/` 与 `.agents/notes/`。
- [ ] 11 个页面都有横幅；挑两页在浏览器里打开，确认横幅显示正常。
- [ ] `npm run check:static` 通过。

## Comments
