## AGENTS.md for Ruukoto

## 开发与验证

首次检出在仓库根目录运行 `npm run setup`；提交前运行 `npm run check`。
独立入口为 `npm run build`、`npm run lint`、`npm run typecheck`、`npm test`。
修改过程中运行 `npm run check:static` 和相关测试，例如
`npx tsx --test test/71-product-entry.test.ts`。环境前提、测试导航、耗时和外部验收入口见
[开发说明](docs/development.md)。当测试需要 Linux 环境时，可通过 `ssh tx` 访问服务器。

## 目录导航

- `src/runtime/` 编排任务与产品行为，`src/core/` 管理存储、身份与权限。
- `src/agent/` 管理模型、上下文与工具，`src/agent/tool-worker/` 是执行边界内的工作进程。
- `src/control/` 提供控制面；`src/tui/`、`src/config-tui/` 和平台适配目录提供用户入口。
- `test/` 是应用测试，`verification/foundation/` 是 SDK 与执行边界验证，`verification/smoke/` 是外部验收脚本。
- `deploy/` 是部署材料，`docs/adr/` 说明架构决策；构建产物 `worker/worker.mjs` 由 `npm run build` 生成。

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
