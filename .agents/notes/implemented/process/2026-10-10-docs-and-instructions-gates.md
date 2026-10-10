# Agent Note: 给 docs 与 notes 加纯文本结构门禁

Status: implemented

## 问题

文档同步此前只靠 `writing-docs-for-human` 的触发条件，没有任何可执行检查。它翻转的是[决策记录与人类文档分层](2026-10-09-split-agent-and-human-docs.md)时被否的一条：「给 docs 加相对链接测试 — 否：图解页那套门禁正是维护变重的原因，先只靠 skill 触发」。当时的判断有据：被删的 `test/67-visual-docs.test.ts` 把 `docs/visual/` 的 10 张 HTML 页与 `src/`、`deploy/` 的内容强绑定，每次改代码都要维护图解，且在独立检出上因引用未入库文件而失败。

但那条判断留下三个真实缺口，本次盘点逐个复核过：

- **断链无人拦。** `.scratch/` 里有 7 处指向已删除 `docs/runtime.md` 的死链。更关键的是门禁本身的盲区：`.agents/notes/implemented/architecture/2026-09-26-lossy-context-compaction.md` 指向 `docs/modules/agent-context.md#上下文压缩`，而该文档按固定六节组织，从来没有这个标题——链接从未生效，也没人发现。
- **`.agents/notes/` 对读者不友好。** 规则都写在 `maintain-notes` skill 的 `references/` 里，只有调用 skill 才看得到；直接走进目录的读者没有路标说明布局、封闭集与「一篇一个决定」。DSH 在 `.agents/notes/` 与每个 lifecycle 目录都放了 `README.md`／`AGENTS.md`。
- **常驻文档没有篇幅上限。** 根 `AGENTS.md` 是常驻指示层，长起来会挤占上下文，而没有任何护栏。

## 决定

新增 `npm run check:docs`，由四道纯文本结构门禁组成，接进 `check:static`（实测总耗时 1.25 秒）：

- **`verify-md-links`**：相对链接、图片与引用定义的目标必须存在；指向 Markdown 的 `#锚点` 必须命中真实标题 slug 或显式 `<a id>`。外部 URL、根绝对路径与模板占位符（`<…>`、含省略号的示范路径）不判。
- **`verify-doc-refs`**：`src/`、`bin/`、`scripts/` 注释里引用的 docs 与 notes 路径必须存在。
- **`verify-doc-budgets`**：按 manifest 的字符上限校验 8 份常驻文档。
- **`verify-md-wrap`**：prose 段落一段一物理行。

### 与代码解耦是这次能成立的关键

四道门禁都**不读 `src/` 的内容**，只做 Markdown 与路径的结构检查。`verify-doc-refs` 读源码，但只提取注释里的路径令牌再 `existsSync`，不理解代码语义。因此改代码不会让它们变红——这正是 `test/67` 被删的原因，也是本次翻转旧决定的依据。

### 共享扫描器

`scripts/markdown-scan.ts` 提供解析（`mdast-util-from-markdown` + `mdast-util-gfm`）、遍历、标题 slug、文档锚点集（带缓存）、跨行段落检测与 glob 收集。四道门禁共用，扫描范围一致：根文档、`docs/`、`.agents/notes/`、`.agents/skills/`、`deploy/`、`verification/**/README.md`，排除 `archived/` 与 `node_modules/`。

标题 slug 用 GitHub 的算法手写（转小写，去掉字母、数字、下划线、空格与连字符之外的字符，空格转连字符）。**已对照 `github-slugger` 全量验证：576 个标题零差异**，含中文标题，因此不必新增该依赖。

### 篇幅单位用字符数

DSH 的 `verify-doc-budgets` 用 `wc -w`。本仓库文档是中文，实测 `docs/architecture.md` 316 词对应 3957 个非空白字符、`CONTEXT.md` 422 词对应 9160 个，词数几乎不随正文增长。改用**非空白字符数**（中文语境的「字数」）。上限见 `scripts/doc-budgets.manifest.json`，只覆盖常驻与结构性文档，不含 `docs/usage.md` 等随功能增长的参考手册。

### 一次性重排

`verify-md-wrap` 初始有 **214 处**违规，分布在 15 个文件（`docs/modules/channels.md` 75、`CONTEXT.md` 56、`docs/development.md` 20、`docs/release-acceptance.md` 19 等）。用一次性脚本按 mdast 段落源范围合并，并加两道保护：含硬换行（`break` 节点）的段落跳过，改写后重新解析并断言每段的**非空白字符序列**逐一相同。13 个文件、212 处自动改写；2 处引用块段落因 `>` 标记会被吞掉而中止，手工合并。

### notes 路标

新增 `.agents/notes/README.md`（面向读者：布局、封闭集、文件形态、怎么找、与其他层的关系）、`.agents/notes/AGENTS.md`（一篇一个决定、写前审查、归档冻结、`Status:` 与目录一致）与 `.agents/notes/implemented/AGENTS.md`（同步事实但不改写决定、何时归档）。

## 备选方案

- **保持无门禁，只靠 skill** — 零维护。否：本次盘点已发现两处真实且无人察觉的缺陷（死链与失效锚点）；靠人记触发条件正是它们长期存在的原因。
- **原样照搬 DSH 的 `doc-typecheck`** — 让 ` ```ts ` 代码块参与编译。否：它依赖 DSH 的 workspace `paths` 与 `tsc -b` 项目引用，本仓库单包结构下收益远小于移植成本。
- **`verify-export-jsdoc`（导出必须有 JSDoc）** — DSH 价值最高的一道。否：本仓库实测导出函数 JSDoc 覆盖 179/298（60%），无门禁；一次性补齐近 120 处导出注释是独立批次，且会把 60% 的既有事实突变。留待单独评估。
- **预算改用 `wc -w` 与 DSH 一致** — 便于对照上游。否：中文词数不随正文增长，`CONTEXT.md` 的词数与字符数相差 22 倍，词数上限形同虚设。
- **引入 `github-slugger` 依赖** — 少写 3 行、少担算法风险。否：手写算法已对 576 个标题全量验证零差异，不值得为零差异新增依赖。
- **`verify-md-wrap` 不做，只留链接与预算** — 少改 214 处。否：一段一物理行是本仓库既有的书写习惯（`AGENTS.md` 与多数文档已是），门禁只是把既有习惯固定下来；不做就会持续漂移。
- **重排用脚本一次改完全部 214 处** — 最快。否：含硬换行的段落与引用块会被改坏；两处引用块确实需要手工处理，脚本的保护机制证明了这一点。
- **把预算上限一次压到接近现状** — 立刻防膨胀。否：上限是护栏不是缩减目标；留约 9%~10% 余量，超限时先搬运再压缩。
- **给 docs 加内容一致性检查** — 门禁覆盖更全。否：内容与代码是否一致是语义判断，机械检查会退化成关键词扫描，误报比漏报更贵；仍靠 `writing-docs-for-human` 的触发条件。

## 后果

`check:static` 从约 8 秒增至约 9.3 秒，换来：断链与失效锚点在提交前被拦（已实测两类负例都会红）、常驻文档有篇幅护栏、`.agents/notes/` 对直接走进来的读者可读。重排后全仓 Markdown 段落形态统一，diff 只影响空白。

代价与遗留：

- 214 处重排产生一次性 diff，涉及 13 个文件。已逐文件核验非空白内容不变、表格与代码块数量不变、AST 结构除既有无关改动外一致。
- `docs/usage.md`、`docs/release-acceptance.md`、`docs/modules/*.md` 等随功能增长的文档**不在预算内**，仍可能无限增长。预算只覆盖常驻与结构性文档；把参考手册也纳入会迫使压缩本应有空间的内容。
- 门禁只查结构，不查内容正确性。文档描述了过期行为、或漏掉了某个模块的新行为，四道门禁都不会红。
- 手写的 slug 算法与 GitHub 当前行为一致，但 GitHub 若改算法不会被同步。影响面仅限锚点链接，失效时表现为误报。
- `verify-doc-refs` 只认 `docs/` 与 `.agents/notes/` 前缀的 `.md` 路径；其他形式的文档引用（相对路径、不带扩展名）不在检查范围。
- 新增依赖 `mdast-util-from-markdown`、`mdast-util-gfm`、`micromark-extension-gfm`、`@types/mdast`（devDependencies）。

## 测试

- 四道门禁各自通过，正常路径与负例均实测：`verify-md-links` 对坏锚点与坏目标分别报错并退出 1；`verify-doc-refs` 对注入的不存在路径报错并退出 1；`verify-doc-budgets` 超限退出 1、`--list` 恒退出 0。
- 门禁在开发过程中真实拦下两处缺陷：本笔记引用的 `.agents/notes/README.md`（当时尚未创建）与一条失效锚点。
- slug 算法对照 `github-slugger` 验证 576 个标题零差异。
- 重排核验：非空白字符序列不变、`channels.md` 的 12 个代码块与 61 行表格数量不变、25 个标题不变、AST 结构对比仅 3 个含既有无关改动的文件有差异。
- `npm run check:static` 与 `verify-notes` 通过。
