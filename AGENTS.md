## AGENTS.md for Ruukoto

当测试需要 Linux 环境时，可通过 `ssh tx` 访问服务器。

## Agent skills

编写计划和执行时都需要使用 `ponytail` skill。

### Issue tracker

任务以本地 Markdown 保存在 `.agents/scratch/<feature>/`。读取、创建或更新任务前，先读 `docs/agents/issue-tracker.md`。

### Triage labels

使用五种默认 triage 标签。分类任务或更新其状态前，先读 `docs/agents/triage-labels.md`。

### Domain docs

采用 single-context：根目录 `CONTEXT.md` 与 `docs/adr/`。探索代码库前，先读 `docs/agents/domain.md`。

### 可视化文档

`docs/visual/` 是随代码维护的图解页面，与 `docs/` 同等对待。改动 `src/` 或 `deploy/` 下的文件之后、编辑图解页时、`test/67-visual-docs.test.ts` 失败时，按 `.agents/skills/visual-docs/SKILL.md` 操作。
