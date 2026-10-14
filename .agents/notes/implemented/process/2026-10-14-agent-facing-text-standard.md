# Agent Note: 模型可见文本的编写标准

Status: implemented

## 问题

宿主写给模型看的文本——工具名与描述、参数 schema、工具结果与错误文本、系统提示措辞、宿主追加的提示——是模型唯一的接口说明，但仓库里没有任何标准覆盖它。[prose-standard](2026-10-10-postmortem-and-prose-standards.md) 管注释、文档与提示词的写法，判断依据是人或开发者 agent 能否读懂；模型可见文本的判断依据不同：模型只能按这份文本决定调什么、怎么解读失败、下一步做什么。

缺口靠真实会话暴露：2026-10-14 拥有者的一次本地网页测试里，模型连续误调 browser 与 bash 工具，[诊断](../../../../.scratch/agent-browser/evidence/owner-session-diagnosis.md)确认主因之一是接口说明有缺口——参数前提只在校验代码里、错误文本要求做当前状态下做不到的事、后台进程回收时机没写——不能全部归因于模型。这类缺陷在评审时本该看得出来，但评审没有对照物。

## 决定

新增 `.agents/skills/agent-facing-text/`，与 prose-standard 分工：本 skill 管模型可见文本**写什么**，prose-standard 管**怎么写**。

- `SKILL.md`：触发条件、审计步骤、硬规则 J1–J8、量化要求。审计对象是 prompt 快照里模型实际看到的文本，不是源码常量。硬规则只写一般陈述，示例不取自引发本标准的 browser 与 bash 工具。
- `references/cases.md`：引发本标准的会话案例，记录现象、文本缺陷与规则编号，细节链接既有诊断，不复制会话正文。
- 改工具描述、参数 schema 或系统提示时，在工单证据里记录前后 `toolSchemas`／`systemPrompt` 估算；只记数字不设上限，省 token 不能以多一次错误调用为代价。
- 根 `AGENTS.md` 的文档落点表新增一行指向本 skill；prose-standard 的「skill 与提示词」条加指针。
- 不加门禁：判断是语义的，机械检查会退化成关键词扫描。

### 规则与案例分离

`SKILL.md` 不含案例答案，是为了让 skill 的有效性可测：盲审者只读 `SKILL.md` 与材料，若能独立挑出案例中的缺陷，才说明规则本身有效，而不是示例对上了答案。案例只进 `references/cases.md`；盲审有遗漏时回 `SKILL.md` 补一般规则，不往案例表加条目。

## 备选方案

- **并入 prose-standard** — 少一份 skill，写作判断集中一处。否：prose-standard 的读者是人与开发者 agent，规则围绕「保住命题、删冗余」；模型可见文本的核心问题是覆盖面（前提、状态、下一步、生命周期写没写），并入后两种判断标准混在一节里，prose-standard 也会因此膨胀。
- **照抄 dsh 的 agent-experience** — 现成且经过使用。否：它绑定 dsh 的工具形态与术语，规则来自它自己的事故；本仓库的规则应从本仓库实证得出，与 [prose 与错误处理 skill](2026-10-10-postmortem-and-prose-standards.md) 不照抄上游的理由相同。
- **只覆盖工具定义** — 范围最小，案例里多数缺陷落在描述与 schema。否：案例中同样多的缺陷落在错误文本、结果内容与宿主追加的提示上；只管定义会让评审漏掉一半。
- **加关键词门禁**（例如禁止错误文本出现某些内部术语）— 能自动拦截。否：「当前状态下可执行」「模型能否影响」是语义判断，关键词表要么漏报要么误报，且会诱导改字面绕过。

## 后果

- **收益**：模型可见文本的评审有了逐条可对照的清单与审计步骤；下一次工具描述出缺口，有机会在评审阶段而非真实会话里被发现。改工具文本时有 token 估算的前后记录，可回看取舍。
- **代价与已知上限**：skill 没有门禁，靠触发条件与评审者自觉生效。规则来自单次会话的案例，覆盖面受其限制；泛化审之外的新缺陷类型要等出现后再补。skill 的有效性以[工单](../../../../.scratch/agent-facing-text/issues/01-agent-facing-text-skill.md)的盲审与泛化审报告为准；本笔记 implemented 只表示文件已落地，不代表该工单已验收。
- **未修**：browser 与 bash 的文本缺陷本轮只记录不修，按 skill 另开工单。

## 验证

- `SKILL.md` 不含案例标识：对 `file://`、`http/https`、`outcome_unknown`、`browser_not_ready`、`browser_paused`、`resume`、`socketDir`、`cdpUrl`、`核实原执行`、`artifact`、`nohup`、`main/dev` 逐个 grep 无命中，命令与输出记在工单证据里。
- `npm run check:static` 覆盖链接、预算、换行与笔记格式。
