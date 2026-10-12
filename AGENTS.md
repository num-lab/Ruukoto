## AGENTS.md for Ruukoto

## 开发与验证

开始改动、接手工单或承担审查时，先按[开发流程](.agents/skills/development-workflow/SKILL.md)确定当前角色、有效要求和验收依据；简单修改走轻量路径。

首次检出在仓库根目录运行 `npm run setup`。独立入口为 `npm run build`、`npm run lint`、`npm run typecheck`、`npm test`。修改过程中运行 `npm run check:static` 和相关测试，例如 `npx tsx --test test/71-product-entry.test.ts`；提交前按改动面选最小检查集，不要默认跑全量，见 [提交前检查](.agents/skills/pre-push-checks/SKILL.md)。环境前提、测试导航、耗时和外部验收入口见[开发说明](docs/development.md)。测试需要 Linux 环境时用 `ssh tx`。

## 目录导航

- `apps/ruukoto/` 与 `apps/ruukoto-code/` 持有各产品的 bin、能力声明与专属装配。
- `packages/` 是共享模块，职责与依赖见[模块地图](docs/architecture.md#模块地图)；`packages/agent/src/tool-worker/` 是执行边界内的工作进程。
- `test/` 是应用测试。
- `verification/foundation/` 是 SDK 与执行边界验证，`verification/smoke/` 是外部验收脚本。
- `deploy/` 是部署材料；构建产物 `worker/worker.mjs` 由 `npm run build` 生成。
- `docs/` 为**面向人类**的文档，入口见 [README](README.md)；`docs/agents/` 是 agent 配置的例外。
- `.agents/notes/` 是**面向 Agent** 的决策记录，`.agents/skills/` 是操作规范，docs 也链接它。
- `.scratch/` 是入库的工单与验证证据。

## 约定

改动前先对照以下约定，细节见所链接的文档。

**模块边界**

- `core` 不得 import 其他 workspace 包；它是全部模块的底座（[架构总览](docs/architecture.md)）。
- 跨包引用使用包名与 exports，按本包 dependencies 声明；反向类型引用列入 devDependencies，运行时反向调用改用注入回调。依赖方向由 ESLint 执行。

**错误处理**

- 跨层错误转成带 `code` 的类型；调用方用 `instanceof` 与 `.code ===` 判别，不解析 `message`。
- 不写空 `catch`。确需吞掉时，写明吞的是哪个错误与原因。
- 诊断写 `process.stderr.write` 并带 `[ruukoto:*]` 前缀；`console.log` 只出现在 `packages/tui/src/` 的 `cli.ts`、`tui/index.ts`、`config-tui/index.ts` 三个入口。
- 设计或评审失败路径时按 [error-handling](.agents/skills/error-handling/SKILL.md)。

**类型**

- 类型逃逸（`any` / `as unknown`）只允许在三类边界出现：SQLite 行映射、JSON／wire 解析、第三方 SDK。内部同进程接口用真实类型，不重复校验。
- `noUncheckedIndexedAccess` 关闭；越界访问需要自己判断。

**持久化**

- 状态与其事件在同一事务内写入，提交成功后才应答与广播（[core](docs/modules/core.md)）。
- 会话 JSONL 是消息历史的唯一权威副本；core 只读不写，不得声称 SQLite 与 JSONL 之间原子。
- `SCHEMA_VERSION` 单调递增；比当前代码更新的库直接拒绝启动。

**测试**

- 默认离线：真实模型用例要 `RUN_MODEL_CHECK=1` 才跑，`test:app` 固定关闭。
- 直读 SQLite、写裸 SQL 断言落盘布局是刻意做法，不得以「测试只应测行为」为由改写。
- 用例编号可重号也可跳号；按功能词找文件，映射见[开发说明](docs/development.md)。

**语言与形态**

- ESM-only；相对 import 一律带 `.ts` 扩展名；文件名用 kebab-case。
- 注释与文档用中文，标识符用英文；术语按 [CONTEXT.md](CONTEXT.md)。
- 承载决定的代码入口留锚点 `Note: 见 .agents/notes/<路径>`，一个注释块引用多篇时每篇各占一行。

## Agent skills

### Issue tracker

任务以本地 Markdown 保存在 `.scratch/<feature>/`。读取、创建或更新任务前，先读 `docs/agents/issue-tracker.md`。

### Triage labels

使用默认 triage 标签。分类任务或更新其状态前，先读 `docs/agents/triage-labels.md`。

### 决策记录

决策记在 `.agents/notes/`。做非平凡改动（行为、架构、跨文件契约、流程与工具链、测试策略、落盘/协议/配置格式）、在方案间取舍或取代旧决定时，按 `.agents/skills/maintain-notes/SKILL.md` 操作；它优先于全局的 write-notes-like-deepseek。

### 人类文档

`docs/` 面向人类，只写现在怎么运作。改了某模块的可观察行为，同步 `docs/modules/` 里对应的那篇；新增模块时，更新 `docs/architecture.md` 的模块地图。写法按 `.agents/skills/writing-docs-for-human/SKILL.md`。

### Domain docs

采用 single-context：根目录 `CONTEXT.md` 与 `.agents/notes/`。探索代码库前，先读 `docs/agents/domain.md`。

### 写作与复盘

写注释、JSDoc、`docs/`、notes、skill、提示词或诊断文本前，按 `.agents/skills/prose-standard/SKILL.md`。事故满足「机制非显然、系统性、重新发现代价高」三条时，按 `docs/postmortem/README.md`（agent 读的写法规范）写一篇复盘。
