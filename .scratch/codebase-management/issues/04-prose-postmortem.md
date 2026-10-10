Status: resolved

# 04 — prose 与错误处理标准、postmortem 层、TODO 语义、换行检查

**What to build:** 补齐外围：可复用的写作与错误处理标准、事故复盘的落点、TODO 标记的排序语义、以及行尾换行的机械检查。

**Blocked by:** 03（prose 标准会约束 notes 与 docs 的写法，先让门禁就位）

## 验收标准

- [x] `.agents/skills/prose-standard/SKILL.md`：写与审 prose 的判断标准——保留完整命题（主体、条件、时序、情态、否定性保证、归属、失败、后果）再删冗余；`contract`／`boundary`／`shape` 是要检查的词，不是禁词；按位置（JSDoc、内部注释、模块注释、测试、文档、notes）列出必须覆盖的内容。
- [x] `.agents/skills/error-handling/SKILL.md`：类型化失败与稳定判别、处理与上报的归属、包含与保证、可见且可行动的报告；空 `catch` 必须点名错误与原因。内容按本仓库已实证的做法写（见工单 02 的错误处理证据），不照抄 DSH 的包级约定。
- [x] `docs/postmortem/README.md` 定义何时写复盘、与 notes 的分工、固定节（执行摘要在前），以及 `NNNN-slug.md` 编号。
- [x] `docs/postmortem/0001-*.md`：从 `docs/development.md` 已记录的两起真实事故中选一起写成复盘，含执行摘要、机制、为什么每一道防线都漏掉了它、据此新增或收紧的护栏。
- [x] TODO 标记语义写进 `docs/development.md`：`FIXME` 发布阻断、`TODO` 尽快修、`XXX` 将来再说。
- [x] `.githooks/pre-commit` 增加 `git diff --cached --check`；补上 `.agents/skills/maintain-notes/references/quality-gate.md` 缺失的行尾换行（实测唯一一个无行尾换行的文件）。
- [x] 更新 `.agents/skills/writing-docs-for-human/SKILL.md` 里「docs 没有自动门禁」的旧说法，改指 `check:docs`。
- [x] 决策 note 与工单同批落盘。

## 候选复盘素材

`docs/development.md` 的耗时基线一节记录了两起已复现、已修复的真实事故，都有非显然机制：

1. **旧实例锁依赖命令行中的项目名**：检出名不含 `ruukoto` 时可能接管仍存活的锁；Node 24.15 与 24.21 均复现。现有护栏是核实系统采集的 `processIdentity`，无法核实时保留锁。
2. **Node 22 的 SQLite 编号占位符 `?1` 需要按名称绑定**：两处账本查询经原生 SQL 与真实 Store 方法复现后修正。

另有一类值得复盘的测试夹具缺陷：人工审批快照必须等 `reviewStatus=asked_owner`、模型请求需等实际就绪，不能只凭任务运行或投递登记。若选此题材，需先确认护栏（等待条件）仍有据可查。

## Comments

### 2026-10-10：只写有据可查的复盘

复盘要求「机制非显然、逃逸是流程缺口而非一次性笔误、重新发现的代价高」。素材必须能在仓库里找到证据（提交、notes、工单或 development.md 记录）；找不到证据的事故不写。
