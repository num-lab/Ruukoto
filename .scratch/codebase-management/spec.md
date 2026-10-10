# 借鉴 DSH 的 codebase 管理方法

2026-10-10：拥有者在四轮问答中确认范围（A+B+B2+C+D 全要）、动机（降低 agent 每次改动的效率与返工成本）、解析依赖（装 mdast）、交付顺序（A → C → B → D，分四次交付）与 postmortem 种子（写 1 篇真实复盘）。理由与被否方案见 [决策 note](../../.agents/notes/implemented/process/2026-10-10-docs-and-instructions-gates.md)，本规格只写范围、顺序与约束。

## 范围

借鉴 `~/Developer/Temp/dsh/repo/` 的管理方法，补上本仓库缺的两层：把规则变成可执行门禁，把「跑什么检查」从全量改成按改动面选择。

只改指示层、文档层与门禁脚本；不改产品行为、配置、持久化格式与协议。允许改动的非文档文件：`package.json` 与 `package-lock.json` 的 scripts 与 devDependencies、`.githooks/pre-commit`、`scripts/setup.mjs`、`.agents/skills/maintain-notes/scripts/`（仅补齐路标所需的校验）。

## 四批

| 批次 | 内容 | 工单 |
|---|---|---|
| A | 证据阶梯：`scripts/change-scope.ts`、`pre-push-checks` skill，改掉三处「收尾跑全量」措辞 | [01](issues/01-pre-push-ladder.md) |
| C | 根 `AGENTS.md` 增设「约定」章节，只写取证成立的规则 | [02](issues/02-conventions-section.md) |
| B | docs/notes 门禁（链接、引用、预算、一段一行）、notes 路标、修完 191 处多行段落 | [03](issues/03-docs-gates.md) |
| D | prose 与 error-handling skill、postmortem 层与 1 篇复盘、TODO 语义、pre-commit 换行 | [04](issues/04-prose-postmortem.md) |

顺序 A → C → B → D，每批独立提交。B 必须排在 C 之后：C 会让 `AGENTS.md` 变长，B 的预算上限要按 C 之后的长度校准。A 必须最先：后续批次都要按改动面选检查，先有阶梯才不必每批跑全量。

## 约束

- 每批完成时跑该批自己的门禁与相关测试，不默认跑全量 `npm run check`；全量只在明确要求或诊断 CI 时跑。这正是批次 A 要建立的规则。
- 只写被证据支持的规则。取证结论里「NOT actually followed」的 9 条不得进入 `AGENTS.md`；先前的初步判断「execution 是唯一产生进程的地方」已被反例推翻（`node:child_process` 出现在 9 个文件，含 `core`），不得写入。
- 门禁脚本只依赖 node 标准库与 `mdast-util-from-markdown` + `mdast-util-gfm`（后者仅批次 B）。
- 中文文档的预算按**非空白字符数**计，不用 `wc -w`：实测 `CONTEXT.md` 是 422 词 / 9160 非空白字符，比值 22 倍，词数在中文语境下没有约束力。
- 批次 B 的门禁必须与既有的「不加 docs 门禁」决定显式互链：那篇 note 的「备选方案」里有一条「给 docs 加相对链接测试」被否，本次翻转它。决定翻转按 maintain-notes 新开一篇并互链，旧篇的 `## 决定` 保持原样。

## 验收

- A：`npm run change-scope -- --base develop` 输出合法 JSON；`AGENTS.md`、`docs/development.md`、`README.md` 三处不再指示「收尾运行全量 check」，改为指向 pre-push skill。
- C：`AGENTS.md` 新增的每条约定都能指向 2 条以上实测证据；9 条未遵守的规则零出现。
- B：`npm run check:docs` 通过；`verify-md-wrap` 在修完 191 处后为 0 违规；故意断一条链接与改超一个预算能分别让门禁红。
- D：`docs/postmortem/0001-*.md` 存在且含执行摘要；`git diff --cached --check` 接进 pre-commit；`quality-gate.md` 补上缺失的行尾换行。
- 每批：`npm run check:static` 与相关测试通过，决策 note 与工单同批落盘。
