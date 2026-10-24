# AGENTS.md

Ruukoto 同仓交付两个产品：`ruukoto` 个人 Agent 与 `ruukoto-code` Coding Agent。改 `packages/` 前先读[架构总览](docs/architecture.md)；改动、接手工单或审查前，按[开发流程](.agents/skills/development-workflow/SKILL.md)确定角色、有效要求与验收依据，简单修改走轻量路径。

## 开发与验证

首次检出运行 `npm run setup`。各[独立入口](docs/development.md#日常反馈)见开发说明。修改时跑 `npm run check:static` 与相关测试，提交前按[改动面选最小检查集](.agents/skills/pre-push-checks/SKILL.md)；完整 `npm run check` 只在拥有者明确要求、诊断 CI 失败或改动确实横跨全仓时跑。定向测试写文件名，如 `npx tsx --test test/71-product-entry.test.ts`；环境前提、测试导航、模块与用例映射、开发实例、耗时基线和外部验收入口见[开发说明](docs/development.md)。测试需要 Linux 环境时用 `ssh tx`。

**提交与 CI。** pre-commit 依次执行 `git diff --cached --check`、`scripts/check-staged-eol.mjs` 与 `npm run check:static`；CI 在 macOS / Linux 固定 Node 24.15.0，job 时限 90 分钟，执行 `npm run setup -- --skip-hooks` 与 `npm run check`，不因缺 Python 或 PTY 跳过用例。真实模型与真实 IM 属外部验收，缺前提时报告不可验证，不记为通过。文件末尾留且只留一个换行。

## 仓库布局

```
apps/ruukoto/       个人 Agent 的 bin、能力声明与专属装配；apps/ruukoto-code/ 同构
apps/desktop/       桌面客户端
packages/core/      数据布局、schema、任务状态机、会话身份；不依赖其他 workspace 包
packages/agent/     上下文装配、工具与审批、执行边界、SubAgent 与 worktree；src/tool-worker/ 是工作进程
packages/runtime/   任务生命周期、会话身份、队列与委派编排
packages/channels/  IM 入口、图片入站、GitHub 事件来源与 scheduler outbox
packages/control/   控制面 socket、拥有者认证与协议
packages/view/      浏览器可用的共享快照、事件与历史投影
packages/tui/       共享 CLI、交互终端、配置中心与开发启动器
test/               应用测试；verification/foundation/ 基础验证（独立包与锁文件）；verification/smoke/ 外部验收
deploy/             系统身份、单元、提权入口与服务管理
worker/             构建产物 worker.mjs，由 npm run build 生成
docs/               面向人类；docs/modules/ 按模块；docs/agents/ 是 agent 配置
.agents/notes/      决策记录；.agents/skills/ 操作规范；.scratch/ 入库的工单与证据
```

模块职责、依赖方向与产品差异见[模块地图](docs/architecture.md#模块地图)与[产品模块](docs/modules/products.md)。

## 约定

**模块边界。**

- 跨包引用使用包名与 exports，并按本包 `dependencies` 声明；反向类型引用列入 `devDependencies`，运行时反向调用改用注入回调。ESLint 拒绝未声明依赖与跨包相对路径。
- 同一工作区同一时刻只有一个写入者；并行实现用独立工作副本，汇总后按实际结果重定验证范围。
- 优先复用已维护的依赖，不手写等价实现。

**错误处理。**

- 跨层错误转成带 `code` 的类型；调用方按 `instanceof` 与 `.code ===` 判别，不解析 `message`。
- 不写空 `catch`；确需吞掉时写明吞的是哪个错误与原因，`try` 只包一条语句。
- 诊断写 `process.stderr.write` 并带 `[ruukoto:*]` 前缀；`console.log` 只出现在 `packages/tui/src/` 的 `cli.ts`、`tui/index.ts`、`config-tui/index.ts`。
- 失败要么在加载时自包含地报错，要么在最可解析的点报错；不静默跳过缺失的引用对象。设计失败路径按 [error-handling](.agents/skills/error-handling/SKILL.md)。

**类型。**

- 类型逃逸（`any` / `as unknown`）只允许在三类边界出现：SQLite 行映射、JSON／wire 解析、第三方 SDK；内部同进程接口用真实类型，不重复运行时校验。
- 跨边界的代理或句柄用具名类型，不用裸 `string`。
- `noUncheckedIndexedAccess` 关闭，越界访问自己判断。

**持久化。**

- 状态与其事件在同一事务内写入，提交成功后才应答与广播（[core](docs/modules/core.md)）。
- 会话 JSONL 是消息历史的唯一权威副本；core 只读不写，不得声称 SQLite 与 JSONL 之间原子。
- `SCHEMA_VERSION` 单调递增；比当前代码更新的库直接拒绝启动。
- 已提交的会话与归档笔记不移动、不覆盖、不删除；取代关系用新文件加互链。

**测试。**

- 默认离线：真实模型用例要 `RUN_MODEL_CHECK=1` 才跑，`test:app` 固定关闭。
- 直读 SQLite、写裸 SQL 断言落盘布局是刻意做法，不得以「测试只应测行为」为由改写。
- 用例编号可重号也可跳号；按功能词找文件。
- 每处行为改动配一条会因该回归失败的最窄用例；过期行为连同它的用例一起改。

**语言与形态。**

- **交互设计**：面向人的操作用选择与逐步引导，内部 ID、版本与请求键由程序管理；适用边界见[渐进交互原则](.agents/notes/implemented/process/2026-10-14-progressive-human-interaction.md)。
- ESM-only；相对 import 带 `.ts` 扩展名；文件名 kebab-case。
- 一段一物理行，靠编辑器软换行；`npm run verify-md-wrap` 拒绝跨行段落。
- 注释与文档用中文，标识符用英文；术语按 [CONTEXT.md](CONTEXT.md)，缺概念时先确认该用哪个已有术语。
- 注释只写非显然事实：不变量、竞态顺序、归属、安全边界、意外失败；不复述代码，不保留评审历史。
- 承载决定的入口留锚点 `Note: 见 .agents/notes/<路径>`，一个注释块引用多篇时每篇各占一行。
- **模型可见即已记录**：进入模型请求的输入都要能从会话记录重建；新增这类输入要配事件或持久字段。
- 待办标记按紧急度分三种：`FIXME` 发布阻断、`TODO` 应尽快、`XXX` 以后再说；都写明要做什么。

## 文档与决策落点

常驻文档按 `scripts/doc-budgets.manifest.json` 限字符。上限是护栏而非缩减目标：超限先按[决策记录](.agents/notes/README.md)搬走其他层内容，再压缩；提高上限须在同一改动说明理由。内容与代码的一致性须按各 skill 触发条件逐篇核对，门禁查不出。

| 改了什么 | 落到哪、跑什么 |
| --- | --- |
| 行为、架构、跨文件契约、流程、测试策略、落盘或协议格式 | 决策笔记（[maintain-notes](.agents/skills/maintain-notes/SKILL.md)），`npm run verify-notes` |
| 某模块的可观察行为 | `docs/modules/` 对应那篇；新增模块同时改[模块地图](docs/architecture.md#模块地图)，`npm run check:docs` |
| 注释、JSDoc、docs、notes、skill、提示词、诊断文本 | 按 [prose-standard](.agents/skills/prose-standard/SKILL.md) 判断该写什么、删什么 |
| 模型可见工具定义、参数 schema、结果、错误与系统提示 | [agent-facing-text](.agents/skills/agent-facing-text/SKILL.md) 定内容，prose-standard 定措辞 |
| 命令、脚本、依赖或入口 | 同一改动里更新 `README.md`、[开发说明](docs/development.md) 与[提交前检查](.agents/skills/pre-push-checks/SKILL.md)中受影响的命令 |
| 本文件或 `.agents/skills/` | 被链接目标存在，被引用命令与 `package.json` 一致 |

## Agent skills

- **Issue tracker**：任务以本地 Markdown 存在 `.scratch/<feature>/` 并入库；读、建、更新任务前先读 [issue-tracker](docs/agents/issue-tracker.md)。
- **Triage labels**：用默认标签；分类或改状态前先读 [triage-labels](docs/agents/triage-labels.md)。
- **决策记录**：目录结构与一篇笔记的形态见[决策记录](.agents/notes/README.md)；写新笔记前先按模块名与关键词检索既有笔记。
- **领域入口**：single-context；根 `CONTEXT.md` 是术语表，探索前先读 [domain](docs/agents/domain.md)。
- **复盘**：机制非显然、系统性、重新发现代价高三条同时成立时按 [postmortem](docs/postmortem/README.md) 写；一次失误不直接扩成常驻规则。

## 编辑这份指示

`CLAUDE.md` 是指向本文件的符号链接，改真实文件。每条规则自带结论并链接高层文档，不复制别处正文。清晰度不变时压缩；需要更多空间时按上文提高预算并在同一改动里说明理由。
