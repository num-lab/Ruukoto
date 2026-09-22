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