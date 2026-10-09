Status: ready-for-agent

# 把代码注释里的 ADR 编号改为 note 锚点

依赖：03。范围见 [spec](../spec.md)。

## 做法

- 范围：`src/`、`test/`、`verification/foundation/`、`verification/smoke/`、`deploy/`、`README.md` 里的「ADR 00xx」，约 40 处。**`verification/archive/` 不改。**
- 写法：从括号里删掉 ADR 编号，保留「agent-direction issue NN」等工单出处；在同一注释块里加一行 `Note: 见 .agents/notes/implemented/<class>/<file>.md`，路径从仓库根算起，`check-note-anchors.ts` 能识别。一个注释块引用多篇时，每篇各占一行。
- 「ADR 0012 修订段」「ADR 0020 补充」这类引用，指向工单 03 里实际承载这段内容的 note（可能是拆出篇）。
- `docs/runtime.md` 和 `CONTEXT.md` 里的引用不在本单处理，由 06、07 处理。

## 验收

- [ ] `git grep -nE "ADR ?0[0-9]{3}" -- src test verification/foundation verification/smoke deploy README.md` 无命中。
- [ ] `npx tsx .agents/skills/maintain-notes/scripts/check-note-anchors.ts` 报告的锚点全部指向存在的 note，报告摘要记在 Comments。
- [ ] `npm run check:static` 通过，diff 只涉及注释。

## Comments
