# Agent Note: 决策记录移入 .agents/notes，docs/ 只放面向人类的设计文档

Status: implemented

## 问题

仓库文档同时服务人类与 agent，但没有按读者分开，四类材料混在 `docs/` 下：

- 决策记录以 ADR 形式存放，25 篇都没有备选方案节。核心几篇末尾堆了 9 段「补充」、0011–0014 开头叠了多段「修订」，读者要自己把多段修订合成现状。被否方案只散落在当时未入库的工单目录里，换一台机器就看不到。
- 运行文档有 2606 行，混着操作手册、机制说明、按编号的实施历史与验证清单；`CONTEXT.md` 的词条也夹带实现细节（SubAgent 一条就是一整段按编号排列的行为）。
- 可视化图解的 10 张 HTML 页由测试强制与代码同步，每次改 `src/` 或 `deploy/` 都要维护；Linux 基线上它还因引用未入库的工单文件失败过。
- 决策记录、`docs/release-acceptance.md` 和测试注释链接未入库的工单目录，新检出和 CI 上全是死链。

后果：agent 找一个决定要在决策记录、运行文档、术语表和工单四处拼；人要读模块设计，得从按编号组织的长文里挑。

## 决定

决定经 2026-10-09 两轮 grilling 确认，执行计划与工单见 [spec](../../../../.scratch/docs-restructure/spec.md)。

### 读者分层

- `.agents/notes/`：面向 agent 的决策记录，取代 ADR，按 `.agents/skills/maintain-notes/` 维护。
- `docs/`：面向人类。`architecture.md` 总览，`modules/*.md` 模块设计，`usage.md` 操作手册，保留 `development.md` 与 `release-acceptance.md`。`docs/agents/` 是唯一例外：mattpocock `code-review` skill 写死了 `docs/agents/issue-tracker.md`，AGENTS.md 写明它是 agent 配置。
- `.scratch/`：工单与验证证据，从原先未入库的工单目录移来并入库（含被 `*.log` 规则挡住的日志），仍排除在部署 rsync、docker 构建上下文与 eslint 之外。

### maintain-notes skill

以全局 `write-notes-like-deepseek` 为底写项目版，脚本只 vendor 校验、归档与 check-anchors（只依赖 node 标准库）。定制六条：

1. 正文与节名用中文（问题/决定/备选方案/后果；提案用方案/验收标准/风险）。
2. 格式采纳日改为迁移落地日；迁移来的 ADR 找不到当时的备选方案时用脚本的 grandfather 注释，不编。
3. 允许链接 `.scratch/`。
4. 工单记计划，note 记理由；工单做出非平凡决定时，同一提交写或改 note。
5. `npm run verify-notes` 接进 `check:static`，CI 经 `npm run check` 覆盖。
6. 全局 skill 保留（其他仓库在用），AGENTS.md 写明本仓库以 maintain-notes 为准。

### ADR 迁移

- 每篇 ADR 转成一篇 implemented note，`## 决定` 用现在时写出各段修订合成后的现状。
- 本身是独立决定的「补充」段拆成单独 note 并互链；纯事实更新（改名、写入者调整）并入正文；被完全取代的按归档规则删除或归档。逐篇映射见工单 03。
- 备选方案从 `.scratch/` 的 spec 与工单里找回。
- 迁移来的 note 在头块后写一行「原编号：ADR NNNN」，`.scratch/` 与提交历史里的旧编号用 `rg` 反查。
- src/test/verification/deploy 里约 40 处旧编号注释改成 `Note: 见 .agents/notes/...` 锚点；`verification/archive/` 是按原字节归档的文本，不改。
- 删除旧决策记录目录；`docs/agents/domain.md` 改指 notes，并禁止 `domain-modeling` 新建 ADR 目录。

### 人类文档

- 运行文档拆完后删除：机制进模块文档，理由与历史进 notes（与 ADR 去重），命令与配置进 `docs/usage.md`，验证状态并入 `release-acceptance.md` 或 `development.md`。README 里与 usage 重复的 TUI、命令行、数据目录节并入 usage，README 只留介绍与快速开始。
- 模块文档：runtime、core（含 schema 与数据布局）、agent-context、agent-tools、execution（含 tool-worker）、control、tui（含 config-tui）、channels（qq/telegram/github）、scheduler（含 outbox）、deploy。
- 固定节：职责与边界 → 对外接口 → 数据与状态 → 主要流程 → 不变量与失败处理 → 设计依据。只写现在怎么运作，标题不挂编号；理由与被否方案只在 notes；链接只从 docs 指向 notes。图用 Mermaid，只画状态机与时序。
- `.agents/skills/writing-docs-for-human/` 放模板、文风与触发条件（改某模块的可观察行为 → 同步对应篇；新增模块 → 更新 architecture.md 的模块地图），不加覆盖测试。
- `CONTEXT.md` 收回为纯术语表（定义 + _Avoid_），实现细节移入模块文档或 notes。

### 可视化文档暂停

删除可视化图解的覆盖测试、`.agents/skills/visual-docs/`、AGENTS.md「可视化文档」小节及 development.md 的对应行。`docs/visual/` 页面原地保留，顶部加横幅「2026-10-09 快照，已停止维护，以 docs/ 模块文档为准」；页面里失效的 ADR 链接不修。

## 备选方案

- **ADR 原地冻结，只有新决定写 notes** — 迁移成本最低，旧 ADR 被改动时再转。否：agent 要永久在两处检索决定，docs/ 里长期留着面向 agent 的内容，与本次目标相反。
- **整个 ADR 目录原样搬进 archived/** — 一步完成。否：归档篇冻结不可改，而 0017、0020、0021 仍是现行核心决定。
- **原样 vendor write-notes-like-deepseek** — 跟随上游最省事。否：中文节名、采纳日、scratch 链接、与工单的分工都要定制；代价是上游更新要手动合并。
- **只靠全局安装** — 零改动。否：Codex 等其他代理与 CI 拿不到 skill 和脚本。
- **notes 自成一体、禁止链接 scratch** — notes 不依赖工单目录。否：拥有者选择让 scratch 入库，链接在任何检出上都有效，迁移时不必把工单内容复制进 note。
- **docs 按机制切分（沿用图解页的 10 个主题）** — 读者理解更顺。否：一次代码改动牵动多篇，归属要查表。
- **运行文档保留，逐步吸收** — 不必一次拆完。否：过渡期有两份事实来源。
- **可视化文档连页面一起删** — 最干净，`rg` 不再搜到过时内容。否：拥有者要的是暂停，不是放弃。
- **保留图解覆盖测试但移出 npm test** — 恢复维护时现成可用。否：没人跑的测试只会腐烂。
- **docs/agents/ 移进 .agents/ 或并入 AGENTS.md** — 读者分层更彻底。否：第三方 skill 写死路径；并入会让 AGENTS.md 膨胀。
- **旧编号只留别名、代码注释不动** — 改动最小。否：代码里永久并存两种引用写法。
- **只改路径、不留别名** — 只有一种引用方式。否：`.scratch/` 里 86 个文件与提交历史中的旧编号无法反查。
- **命令与配置并入 README** — 用户只看一处。否：README 会超过 900 行。
- **命令与配置拆进各模块文档** — 设计与配置放一起。否：用户要配 Telegram，得先知道它属于哪个模块。
- **给 docs 加相对链接测试** — 能拦死链。否：图解页那套门禁正是维护变重的原因，先只靠 skill 触发。
- **CONTEXT.md 只换失效链接** — 改动小。否：词条里的实现细节会和模块文档形成第二份事实来源。

## 后果

读者分层到位：agent 的决策只在 notes，人的设计文档只在 docs，工单与证据在 `.scratch/`。25 篇原 ADR 各有一篇 implemented note 承接（0001–0025 全覆盖，个别拆成多篇并互链，0014 由退役篇取代），旧编号以「原编号」「原出处」别名行保留，可继续反查；模块文档按固定六节组织，`CONTEXT.md` 只剩术语定义。收益是两份事实来源消失，agent 不必再在四处拼凑同一决定，人不必再从按编号的长文里挑机制。

代价与遗留：

- 合成修订时可能丢细节或把历史写成现状。缓解靠逐篇对照原文，删除前的最后提交号记入对应工单，原文可从 git 取回。
- 运行文档原有 2606 行，模块文档初版可能漏内容。缓解靠拆分时逐节标注去向、删除前核对每节都有着落。
- 模块文档没有自动门禁，可能与代码漂移。缓解靠 writing-docs-for-human 的触发条件；漂移明显时再评估轻量检查。
- `.scratch/` 入库后，今后工单里的服务器细节都会进 git 历史。仓库私有，提交前仍需检查凭据。
- `docs/visual/` 冻结后其中约 120 处 ADR 链接失效；横幅已声明停止维护。
- 迁移期间并行开发的提交仍会引用旧编号：别名行保证可以反查。
- 文档契约的守卫要跟着文档走。`test/65` 原本断言 README 的命令表与 `src/tui/commands.ts` 的可见条目一致；命令表随本节移入 `docs/usage.md` §7.2 后，该用例改为读操作手册的同一节。移动被守卫的文档时必须一并移动守卫，否则门禁会在新检出上静默失效（切片取不到内容 → 提取出空数组 → 断言失败）。
- 旧编号与旧路径的检索门禁本身不能写进 notes——任何记录该模式的文本都会命中自己。门禁命令记在工单里，notes 只留别名行与「迁移前」的措辞。
