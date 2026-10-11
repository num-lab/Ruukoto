---
name: writing-docs-for-human
description: 写或改 docs/ 下面向人类的文档（architecture、modules、usage）。改了某模块的可观察行为就同步 docs/modules/ 对应的那篇；新增或删除模块更新 docs/architecture.md 的模块地图；运行、配置、启用入口与故障排查的改动更新 docs/usage.md。
---

# 维护面向人类的文档

`docs/` 面向人类读者，写**现在怎么运作**；为什么这么选、放弃了什么在`.agents/notes/`，不重复写进来。分工：

| 位置 | 写什么 |
|---|---|
| `docs/architecture.md` | 模块地图与跨模块主流程 |
| `docs/modules/<模块>.md` | 单个模块的设计：职责、接口、数据、流程、不变量 |
| `docs/usage.md` | 操作手册：运行、配置、启用入口、故障排查 |
| `.agents/notes/` | 决定、理由、被否方案、后果；docs 单向链接到它 |

`docs/agents/` 是例外：它是 agent 配置（issue tracker、triage、domain），不按本 skill 维护。

## 1. 什么时候改哪篇

| 改动 | 落点 |
|---|---|
| 模块的可观察行为、对外接口、数据与状态、主要流程、不变量或失败处理变了 | `docs/modules/` 里对应的那篇 |
| 新增、拆分、合并或删除模块 | `docs/architecture.md` 的模块地图 |
| 运行、配置、启用入口、旧实例导入命令或故障排查步骤变了 | `docs/usage.md` |
| 决定翻转，或理由与被否方案要留档 | `.agents/notes/`（按 maintain-notes），docs 只同步现状 |

源目录到模块文档的对应：

| 源码 | 模块文档 |
|---|---|
| `apps/ruukoto/`、`apps/ruukoto-code/` | `docs/modules/products.md` |
| `packages/runtime/src/` | `docs/modules/runtime.md` |
| `packages/core/src/` | `docs/modules/core.md` |
| `packages/agent/src/` 的上下文、模型、记忆、技能与计划 | `docs/modules/agent-context.md` |
| `packages/agent/src/` 的工具、MCP、Web Search、应用数据与授权；app 的调度与服务工具 | `docs/modules/agent-tools.md` |
| `packages/agent/src/execution/`、`packages/agent/src/tool-worker/` | `docs/modules/execution.md` |
| `packages/control/src/` | `docs/modules/control.md` |
| `packages/tui/src/`（共享 CLI、入口分发、开发启动器与两个界面） | `docs/modules/tui.md` |
| `packages/channels/src/`（`scheduler/` 除外） | `docs/modules/channels.md`；旧实例导入的流程在 `docs/modules/runtime.md` |
| `packages/channels/src/scheduler/` | `docs/modules/scheduler.md` |
| `deploy/` | `docs/modules/deploy.md` |

一次改动牵动多篇时逐篇核对，不只改最显眼的那篇。`npm run check:docs` 机械检查链接、源码引用、篇幅与段落形态，但**检查不了内容与代码是否一致**；内容同步仍靠本 skill 的触发条件。

## 2. 动手前

1. 读目标文档与入库的 `docs/` 现状，确认结构与术语；只更新变化的事实，不重写已有段落。
2. 术语按根目录 `CONTEXT.md`；遇到词表里没有的概念，先确认该用哪个已有术语。
3. 理由、边界与被否方案在 `.agents/notes/` 里查（按 maintain-notes「动手前检索」），事实自己查完再动笔。

## 3. 模块文档的固定六节

每篇 `docs/modules/<模块>.md` 依次是这六节，一个不少；某节当前没有内容时保留标题并写明原因（如「本模块不持久化状态」）。

1. **职责与边界** — 一段说清它负责什么、不负责什么。
2. **对外接口** — 谁调用它、它调用谁，以及协议名、工具名、命令名。
3. **数据与状态** — 表与字段、状态机、落盘位置与生命周期。
4. **主要流程** — 正常路径的关键步骤与分支。
5. **不变量与失败处理** — 必须始终成立的约束，以及失败、超时、取消、重启时的行为。
6. **设计依据** — 相对链接到 `.agents/notes/` 里解释该设计的笔记。

骨架见 [templates/module.md](templates/module.md)，文风与常见返工见[references/prose.md](references/prose.md)。

## 4. 另外两篇的形态

- `docs/architecture.md`：先是模块地图——每个模块一句职责，标出主要依赖方向；再写四条主流程：任务生命周期、入站消息到回复、工具调用与审批、SubAgent 委派。
- `docs/usage.md`：操作手册，按运行、配置、各入口的启用、旧实例导入命令、故障排查组织。命令与配置只在这里出现一次，机制解释留给模块文档。与 `deploy/systemd/README.md`重复的操作步骤只留一处，另一处链接过去。

## 5. 落笔红线

- 现在时，只写 HEAD 怎么运作；不写演进史与修订流水。
- 标题与正文都不出现 issue、ADR、工单编号；溯源靠「设计依据」链接。
- 术语一律用 `CONTEXT.md` 的词，不用笔记里的内部代号替代。
- 链接只有 docs → notes、docs → 源码与脚本、docs 内部互链三个方向；notes 不指向 docs。
- 图用 Mermaid，只画状态机与时序；其余示意用表格或文字。

## 6. 写完自检

- 六节齐全，且没有与当前代码矛盾的陈述。
- 本次改动的每个可观察行为都能在某篇模块文档里找到落点；新增或删除的模块已反映在模块地图里。
- 「设计依据」的每条链接都指向 `.agents/notes/` 里真实存在的文件，路径从仓库根成立。
- `grep -nE "^#.*(issue|ADR|工单)" docs/modules/*.md docs/architecture.md docs/usage.md` 无命中。
