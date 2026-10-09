# 按需阅读：Note 文件格式

> SKILL.md「文件格式」的展开。写/改 Note 时对照；只改代码不动 Note 时跳过。

## 头块（前三行，检查脚本会核对）

```markdown
# Agent Note: <标题>

Status: <状态>
```

- `proposed` → `Status: proposed`
- `implemented` → `Status: implemented`
- `rejected` → `Status: rejected — <一句话原因>`

标题前必须带 `Agent Note: ` 前缀；状态不含日期与括号；必须与所在 lifecycle 文件夹一致（脚本会交叉核对）。文件名日期是首次提出日，git 承载其余时间信息。

从 `docs/adr/` 迁移来的笔记在头块之后、`## 问题` 之前多一行旧编号，供 `rg "ADR 00xx" .agents/notes` 反查：

```markdown
原编号：ADR 0017
```

从某篇 ADR 的补充段拆出的写 `原出处：ADR 0020「补充：整项取消」`。新笔记不写这一行。

## 正文骨架

每篇 Note 都以 `## 问题` 开头——动机要能脱离方案独立成立。之后按 lifecycle区分：

**`proposed/`**

```markdown
## 问题
## 方案
…自由节…
## 备选方案
## 验收标准
## 风险
```

`方案` 可用将来时；`验收标准` 说清什么可观察状态算完成；`风险` 同时写风险与已知取舍。

**`implemented/`**

```markdown
## 问题
## 决定
…自由节…
## 备选方案
## 后果
```

`决定` 用现在时描述已落地事实；门禁只拒提案标题（`## 方案` / `## 计划` / `## 迁移计划` / `## 验收标准` 及其英文原名）；用 `## 后果` 同时记录代价与收益；可按需加 `## 测试` / `## 验证` 等现在时事实节。现在时靠人写，不靠词法扫描。

**`rejected/`**

冻结的 proposal 形态，verdict 在 `Status:` 行；保留提案时的 `备选方案` 等节，不改写为对立面。

## 备选方案（必写）

每篇 Note 必含 `## 备选方案`：每个**真考虑过**的备选为何没选，一段一备选（可用 `### 为何不选 <X>` 子节）。没有过的选项不要编。「不做 / 复用现状」仅当当时真的权衡过才写。脚本只检查这一节在不在。

唯一例外：从 `docs/adr/` 迁移来、文件名日期早于 2026-10-10、且在 `.scratch/` 里找不到当时备选方案的笔记，用下面这行注释代替本节（两者不能并存；日期不早于 2026-10-10 的笔记用了会报错）：

```markdown
<!-- agent-note-format: alternatives-not-recorded (pre-format Agent Note) -->
```

## 时态与禁止改写

- `proposed` 可用将来时；`implemented` 一律现在时，描述已落地事实。
- 一条 Note 永远不被改写成另一个决定；被取代用新 Note 接管，旧 Note 按归档/合并规则处理。

头块标题兼容全角冒号（`# Agent Note：标题`，中文输入法常打出全角）；新笔记建议半角。

## 自由节与文风

- 自由节（package 拓扑、wire 契约、schema 等）放在 `决定` 与 `备选方案` 之间。
- 保留可检索的机制名与 `must`/`may`/`never` 时序强调；一个事实只在一处讲透，其余链过去。
- 跨 Note 引用用相对 Markdown 链接 `[topic](../../implemented/architecture/2026-…-….md)`，不要裸数字。

格式对齐 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的 notes 规范。本仓库正文与节名一律用中文（脚本也认英文原名，不用）；头块 `Agent Note:` 与 `Status:` 保持英文，供脚本核对。
