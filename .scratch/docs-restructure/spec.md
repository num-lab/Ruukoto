# 按读者拆分文档：决策记录给 agent，设计文档给人

2026-10-09：拥有者在两轮 grilling 中确认 16 项决定。除 Q2（写项目版 maintain-notes skill）和 Q7（notes 可以链接 scratch，scratch 移到 `.scratch/` 并入库）外，其余均按推荐定案。决定的理由与被否方案见 [决策 note](../../.agents/notes/implemented/process/2026-10-09-split-agent-and-human-docs.md)，本规格只写范围、顺序与约束。

## 范围

`.agents/notes/` 存放面向 agent 的决策记录，取代 `docs/adr/`；`docs/` 只放面向人类的总览、模块设计、操作手册、开发与发布验收文档；`.scratch/` 存放入库的工单与验证证据。`docs/runtime.md` 拆完后删除，`CONTEXT.md` 收回为术语表，可视化文档冻结。

产品代码只改注释；不改行为、配置、持久化格式与协议。允许改动的非文档文件：`.gitignore`、`.dockerignore`、`eslint.config.mjs`、`package.json` 的 scripts、`deploy/systemd/README.md` 里的 rsync 排除项，以及删除 `test/67-visual-docs.test.ts`。

## 工单与顺序

| 工单 | 内容 | 依赖 |
|---|---|---|
| [01](issues/01-track-scratch.md) | scratch 移到 `.scratch/` 并入库，改写引用 | — |
| [02](issues/02-maintain-notes-skill.md) | maintain-notes skill、vendor 脚本、`verify-notes` | 01 |
| [03](issues/03-migrate-adrs.md) | ADR 迁移为 notes，删除 `docs/adr/`，改 `domain.md` | 02 |
| [04](issues/04-code-anchors.md) | 代码注释里的 ADR 引用改为 note 锚点 | 03 |
| [05](issues/05-freeze-visual-docs.md) | 冻结可视化文档 | — |
| [06](issues/06-split-runtime-doc.md) | 拆 runtime.md 为总览、模块文档与操作手册，写 writing-docs-for-human | 03 |
| [07](issues/07-context-glossary.md) | CONTEXT.md 收回为术语表 | 03、06 |
| [08](issues/08-wrap-up.md) | AGENTS.md、README、development.md 收尾，决策 note 转 implemented | 全部 |

01 必须最先完成，其后新工单一律写在 `.scratch/`。05 可与任何工单并行。

## 约束

- 删除或改写前先看目标。被删文件的最后提交号记在对应工单的 Comments 里。
- `verification/archive/` 是按原字节归档的文本，任何工单都不改。
- 批量改写（03 的逐篇迁移、06 的逐模块拆分）用带重试、并发 3 的 Workflow，先把骨架落盘，再逐篇填写。
- 每张工单完成时跑 `npm run check:static`；08 跑完整 `npm run check`。本机 test/08 DNS 用例在基线上即失败，如果只有它失败，须先在基线上核对。

## 验收

见决策 note 的「验收标准」。
