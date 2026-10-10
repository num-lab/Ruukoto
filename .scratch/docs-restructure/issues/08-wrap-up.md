Status: resolved

# 收尾：入口文档、决策 note 转 implemented、完整验收

依赖：01–07。范围见 [spec](../spec.md)。

## 做法

1. AGENTS.md（编辑前读 mattpocock `writing-for-agents` skill）：
   - 目录导航删除「`docs/adr/` 说明架构决策」；`docs/` 一行列出 architecture、modules、usage、development、release-acceptance，并注明 `docs/agents/` 是 agent 配置例外；加上 `.scratch/` 一行（入库的工单与验证证据）。
   - Issue tracker 路径改为 `.scratch/<feature>/`（如果 01 已改，这里只核对）。
   - 核对 maintain-notes（02）与 writing-docs-for-human（06）两条指针都在，「可视化文档」小节已删（05）。
2. README「文档」一节、`docs/development.md`（第 161 行「CONTEXT.md 与 ADR 为准」、测试导航表）改指新结构。
3. 决策 note 按 maintain-notes 的流转规则转为 implemented：移到 `.agents/notes/implemented/process/`，文件名不变；`Status: implemented`；`## 方案` 改成现在时的 `## 决定`；验收标准与风险折进 `## 后果`（同时写代价和收益）。同步更新 spec 里指向它的链接。
4. 跑完整 `npm run check`。本机 test/08 DNS 用例若失败，先在基线上核对。
5. 新检出验证：在临时目录 `git clone` 本仓库，检查 notes、docs、release-acceptance 和 `.scratch/` 的相对链接全部有效。

## 验收

- [x] 决策 note「验收标准」中的每一条都满足，逐条结果记入 Comments。
- [x] `npm run check` 通过，并记录耗时与结果。
- [x] `npm run verify-notes` 对 implemented 状态的决策 note 通过。

## Comments

2026-10-10：完成。改动前的最后提交号：`27b22ec638c4abc790c47b3a54b19819cfe1c23b`（`27b22ec`）。

### 步骤 1：AGENTS.md

- 目录导航不再提 `docs/adr/` 与「可视化文档」（05 已删）。`docs/` 一行改为列出总览、模块设计、操作手册、开发与验证、发布验收五项，并注明 `docs/agents/` 是 agent 配置的例外；新增 `.scratch/` 一行「入库的工单与验证证据」。
- Issue tracker 路径第 01 单已改为 `.scratch/<feature>/`，本轮只核对。
- 两条指针都在：第 37 行 maintain-notes（02）、第 41 行 writing-docs-for-human（06）指向各自 SKILL.md。
- 按 `writing-for-agents` 的指针写法复核：每条一行、前置区分词（「面向人类」/「面向 Agent」/「入库的工单与验证证据」），不重复正文已有的身份说明。

### 步骤 2：README 与 development.md

- README「文档」一节在 06 已改指新结构，本轮核对：usage、architecture、modules、development、release-acceptance、CONTEXT、notes、visual（带冻结说明）、AGENTS 共 9 项，无失效目标。
- `docs/development.md` 第 190 行「架构原因以 CONTEXT.md 与 [ADR] 为准」改为「[决策笔记](../.agents/notes/)」。
- 测试导航表逐条核对 30 个测试路径，发现 1 处失效：`test/67-visual-docs.test.ts` 已被 05 删除。第 147 行的 Linux 基线记录属历史说明（成文于删除前），按 05 的约定保留；导航表本身未列该文件，无需改。

### 步骤 3：决策 note 转 implemented

`2026-10-09-split-agent-and-human-docs.md` 从 `.agents/notes/proposed/process/` 移到 `.agents/notes/implemented/process/`，文件名不变。`Status: proposed` → `implemented`；`## 方案` → `## 决定`；`## 验收标准` 与 `## 风险` 折进 `## 后果`（收益一段 + 代价与遗留七条）；删除计划段，正文改为现在时叙述。原 `.scratch/` 与被否方案逐条保留。三处入站链接同步改指：`docs/architecture.md` 设计依据、`.scratch/docs-restructure/spec.md` 第 3 行、工单 02 第 19 行。

### 决策 note「验收标准」逐条结果

1. **`docs/adr/`、`docs/runtime.md`、`.agents/scratch/`、`test/67-visual-docs.test.ts`、`.agents/skills/visual-docs/` 都不存在** — 通过。五项逐一 stat 确认不存在。
2. **每篇原 ADR 都能用 `rg "原编号：ADR 00xx" .agents/notes` 找到对应 note，或在工单 03 记明删除理由** — 通过。0001–0025 逐一 `grep -rl "ADR NNNN" .agents/notes/` 全部命中；其中 0014 由 `simplification/2026-10-02-retire-core-group-chat.md` 以「原编号：ADR 0014（核心群聊已退役，本篇取代原决定）」承接，删除理由已在工单 03 记明。
3. **`git grep -nE "docs/adr|\.agents/scratch|docs/runtime\.md|ADR ?0[0-9]{3}"` 只命中 `.agents/notes/`（别名行）、`.scratch/`、`docs/visual/` 和 `verification/archive/`** — 通过，但本轮**先修了 37 处超范围命中**。详见下节。
4. **`npm run verify-notes` 通过且包含在 `check:static`；`npm run check` 通过** — 通过。`check:static` = `lint && typecheck && verify-notes`，`verify-notes` 36 篇树/格式/归档全通过。`npm run check` 退出 0、墙钟 175 s；应用 1021 项中 1020 通过、1 跳过、0 失败，基础验证 10 项中 9 通过、1 跳过、0 失败；跳过项均为默认关闭的真实模型连通性检查。本机 `test/08` 的 DNS 用例本轮未失败（基线核对见下节）。
5. **`docs/architecture.md`、`docs/usage.md` 和 10 篇 `docs/modules/*.md` 存在，按固定节组织，标题不含 issue 编号** — 通过。10 篇各有且仅有六节（职责与边界、对外接口、数据与状态、主要流程、不变量与失败处理、设计依据）；`grep -nE "^#+ .*(issue|工单|ADR)"` 对 modules、architecture、usage 无命中。
6. **AGENTS.md 的目录导航与 skill 指针和上述结构一致；CONTEXT.md 只含术语定义** — 通过。见步骤 1；`CONTEXT.md` 对 `issue|ADR|工单|runtime\.md` 无命中（工单 07 已交付）。
7. **在不含任何本机未跟踪文件的新检出上，notes、docs、release-acceptance 的相对链接全部有效** — 通过。用 `git checkout-index -a -f --prefix=` 导出索引内容（与 `git clone` 等价地排除未跟踪文件，且覆盖本轮改动），再逐文件解析 Markdown 链接：notes 35 篇 366 链接、docs 17 篇 236 链接、release-acceptance 在 docs 内，死链均为 0。

### 验收标准 3 的 37 处超范围命中（本轮修复）

工单 04 只覆盖了 `src/`、`test/`、`verification/`、`deploy/` 的注释；本轮把门禁跑全，发现另有 37 处命中 14 个超范围文件。逐类处理：

- **notes 正文里的裸编号（16 处，6 篇）** — maintain-notes 明确「跨笔记引用用相对链接，不写裸编号」，这 16 处违反本仓库自己的规则。改为按目标笔记标题命名链接（如 `[ADR 0017](…two-agent-products.md)` → `[两个产品](…)`），链接目标不变，事实无损。
- **`bin/ruukoto.mjs`、`bin/ruukoto-code.mjs` 各 1 处** — 工单 04 漏掉了这两个入口。按 04 的锚点写法改为 `// Note: 见 .agents/notes/…`。
- **`docs/release-acceptance.md` 第 9 行** — 01–07 期间漏改。改为按标题命名的链接。
- **`docs/agents/domain.md` 第 6 行「不创建 `docs/adr/`」** — 表述本身命中模式。改为「决策只记在这里」，语义不变。
- **maintain-notes skill 的 4 处**（SKILL.md 2、note-format.md 2、verify-agent-note-format.ts 1） — 这些是教迁移别名写法的功能性文本。改为「迁移前的 ADR」措辞，占位符从真实的 `ADR 0017` 改为 `ADR NNNN`，反查命令从 `rg "ADR 0017"` 改为 `rg "原编号：ADR"`（仍可用，且不再自带命中）。
- **决策 note 自身 10 处** — 记录「删掉旧目录、旧编号别名的格式」这件事，天然要提到那些字面量。改为「旧决策记录目录」「原编号：ADR NNNN」等描述性措辞，并在 `## 后果` 明确记下这个自指约束：门禁命令本身不能写进 notes，只能记在工单里。

修复后超范围命中为 0。别名行（34 行）与白名单三处（`.scratch/`、`docs/visual/`、`verification/archive/`）保持不变。

### 步骤 4 额外发现并修复：test/65 的文档契约守卫失效

`npm run check` 第一次跑出 1 个失败：`test/65-slash-commands.test.ts` 的「README 命令表」用例。**这是 06 引入的既有回归，不是本轮改动造成的** —— 用 `git stash` 暂存本轮全部改动后在本轮起点 `27b22ec` 上复跑，同样失败；`test/65` 自 `60fa19e` 未再改过，而 README 的命令表在 `df9e982`（06）随操作手册化移入 `docs/usage.md` §7.2。

失败机制：该用例 `readme.slice(indexOf("**命令**"), indexOf("**断开与重连**"))` 在 README 里取不到锚点，两次 `indexOf` 都返回 -1，切片为空 → 提取出空数组 → 与 `VISIBLE_COMMANDS` 的 25 项比较后断言失败。也就是说这个守卫在移动后**静默地不再检查任何东西**，只会报失败。

修法：把用例改为读 `docs/usage.md` 的 §7.2 到 §7.3 之间（`### 7.2 命令` → `### 7.3 断开与重连`），用例名改为「操作手册命令表」。已验证切片能取出全部 25 个命令名，`test/65` 13/13 通过。选这个修法而不是把命令表搬回 README，是因为 06 已决定 README 只留介绍与快速开始、命令表归操作手册；把守卫指向文档的新家，契约才继续有效。这条经验已记入决策 note 的 `## 后果`。

### 步骤 4 的完整 `npm run check`

- 首次运行挂在 `test/14-tui-app.test.ts` 逾 46 分钟无输出；排查为本轮此前并发跑过一遍应用测试、留下竞争所致，清理残留进程后重跑正常。
- 重跑：`EXIT=0 WALL=175s`。应用 `tests 1021 / pass 1020 / fail 0 / skipped 1`，基础验证 `tests 10 / pass 9 / fail 0 / skipped 1`。跳过项是 `RUN_MODEL_CHECK=1` 才启用的真实模型连通性检查。
- 本机 `test/08` 的 DNS 用例本轮未失败，无需基线豁免。

### 步骤 5 新检出的相对链接验证

导出方式：`git checkout-index -a -f --prefix=/tmp/wrapcheck/`，即以索引内容建干净检出——等价于 `git clone` 地排除全部未跟踪文件（本机那份原生沙箱进行中的改动不在其中），同时覆盖本轮尚未提交的改动。

- notes 35 篇、366 个相对链接，死链 0。
- docs 17 篇、236 个相对链接，死链 0（release-acceptance 含在内）。
- `.scratch/` 122 篇、491 个相对链接中另有 7 处死链，全部指向已删除的 `docs/runtime.md`，出现在 06 成文之前的旧工单（`personal-agent`、`agent-direction` 的历史工单与评审记录）。它们不在验收标准 7 列举的范围内，属工单入库前的历史记录，按 06 的既有约定保留原文。
- 另有 3 处「链接」是 skill 模板里的占位符（`…-….md`、`<lifecycle>/<class>/<yyyy-mm-dd-topic>.md`），不是真实引用。

### 验证

`npm run check:static` 通过（lint、应用与 foundation `tsc --noEmit`、`verify-notes` 36 篇：树与相对链接、格式、0 篇归档）。`npm run check` 退出 0，见上。
