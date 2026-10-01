## AGENTS.md for Ruukoto

当测试需要 Linux 环境时，可通过 `ssh tx` 访问服务器。

## Agent skills

编写计划和执行时都需要使用 `ponytail` skill。

### Issue tracker

任务以本地 Markdown 保存在 `.scratch/<feature>/`。读取、创建或更新任务前，先读 `docs/agents/issue-tracker.md`。

### Triage labels

使用五种默认 triage 标签。分类任务或更新其状态前，先读 `docs/agents/triage-labels.md`。

### Domain docs

采用 single-context：根目录 `CONTEXT.md` 与 `docs/adr/`。探索代码库前，先读 `docs/agents/domain.md`。

### 可视化文档

`docs/visual/` 是随代码维护的图解页面，与 `docs/` 同等对待。改动 `src/` 或 `deploy/` 下的文件后，用 `grep -l <文件路径> docs/visual/*.html` 找到描述它的页面，同步更新图、表与正文；作图组件与约定见 `docs/visual/style.css` 顶部注释。改完跑 `npx tsx --test test/67-visual-docs.test.ts`。