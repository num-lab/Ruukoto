# 模型可见文本标准：方案审查

## 2026-10-14 — 首轮独立方案审查

角色：独立方案审查者，独立执行上下文，只读核对工单全文、[诊断](../../agent-browser/evidence/owner-session-diagnosis.md)、开发流程、prose-standard、maintain-notes、文档预算脚本与当前源码（检出 `c1f5041`）。没有读原会话 JSONL，也没有直接核对访谈原文，Q1–Q13 以工单表格为准。

| 被审全文 | SHA-256 |
| --- | --- |
| [工单](../issues/01-agent-facing-text-skill.md) | `68aa3a754d372c160f4e14b14f264c97caee5640b90526e30249b9e68643d4ee` |

结论：两项阻断，返方案者修订。交付物分工、范围与非目标在确认范围内；J1–J8 能把第 1–10 条案例逐条归类（第 7 条除外，按设计不计）。问题出在验收方法：按现写法，它证明不了 skill 有效。

### 阻断

**B1 盲审不盲，结果由构造决定。** 盲审者读 `SKILL.md`，而工单拟定的 J1–J8 示例直接写出了答案：J1 点名 `open`/`attach`/`tabs --url` 只收 http/https（案例 1），J2 引用「请核实原执行」（案例 4），J3 点名 `outcome_unknown`、`browser_not_ready`、`resume`（案例 3、5），J5 列出 pid/pgid/socketDir/cdpUrl（案例 8），J7 写出 bash 回收后台子进程（案例 2）。审查者只要把示例和材料对一遍就能全部命中，不能证明 skill 对没见过的文本有效。验收第 2 步「补规则直到全部命中」再把规则往案例集上拟合，违反开发流程「验收是否真能证明行为」。修订要求：

- `SKILL.md` 的硬规则只写一般陈述；示例不得取自 browser 与 bash 工具，案例专属示例只进 `references/cases.md`（盲审本来就不给它）。
- 验收记录交给盲审者的 `SKILL.md` 哈希，并写明一项检查：其中不出现案例标识（`file://`、`http/https`、`outcome_unknown`、`browser_not_ready`、`browser_paused`、`resume`、`socketDir`、`cdpUrl`、`核实原执行`、`artifact`、`nohup`、`main/dev`）。
- 第 2 步补的规则同样只能是一般陈述，每补一轮，新规则都要经过泛化审（B2）复核，避免只为命中案例而加。

**B2 泛化审没有通过条件，也没人判定误报。** 第 3 步只写「出报告、记录误报、误报回 SKILL.md 修规则」，没写谁判定一条发现是真问题还是误报，也没写什么情况算通过。被审工具族没有已知缺陷清单，召回率无从衡量，所以这一步只能证明 skill 能产出意见。修订要求：明确判定者（实施者以外的角色，或拥有者），写清每条发现的判定依据：模型实际看到的文本位置、对应规则，以及模型据此会做错什么。通过条件至少包括：判定后无未处理误报，修规则后用同一材料复审一次。另需写明被审工具族从哪个产品、哪类会话取 prompt 快照：`app-data/tools.ts` 只在个人 Agent 装配，`subagent-tools.ts` 两个产品都有，取法不同。

### 事实更正（非阻断，交付前修正）

- **F1 AGENTS.md 没有超预算。** `scripts/verify-doc-budgets.ts:18` 统计的是去除空白后的字符数，当前 4112 / 4300，还剩 188；`npx tsx scripts/verify-doc-budgets.ts` 实测通过。`wc -m` 得到的 4567 含空白。「已超 267，必须同批压缩或提高预算」这句前提不成立，应改为「余量 188，新增一行若超出再压缩或提高预算」。
- **F2 bash 描述不是上游 pi 的。** `packages/agent/src/tool-router.ts:806-815` 的 `bashTool` 由宿主 `routedTool` 定义，描述是本仓库自己写的「在工作区执行 bash 命令（在任务执行边界内；输出完整捕获为产物）。」，案例 2、10 的修复都在仓库内。非目标里「不修改上游 pi 提供的 bash 工具描述」应改为「不修改 bash 工具描述（`tool-router.ts`）」；后续工单也照此确定范围。
- **F3 案例 5 的缺陷写多了。** browser 描述里已有「新消息的新任务才能 resume」（`browser-tools.ts:94`），实际缺的是：`outcome_unknown` 且状态为 unavailable 时宿主会自动 pause（`browser-tools.ts:169-171`），以及 pause 不只用于人工登录。表格应据此改写，否则 cases.md 会记错因果。
- **F4 J7 的示例行为可能变化。** [bash 后台生命周期提案](../../../.agents/notes/proposed/feature/2026-10-14-bash-background-lifecycle.md)拟改变「返回即回收」，cases.md 的案例 2 应注明记录的是 `c1f5041` 时的行为。这个示例本来就要按 B1 移出 `SKILL.md`。

### 可选

- AGENTS.md 新行可写成「模型可见的工具定义、参数 schema、结果与错误文本、系统提示措辞 → agent-facing-text（写什么）+ prose-standard（怎么写）」，与既有的「提示词」一行区分清楚，余量够用。
- 决策笔记与 skill 同一提交落在 `implemented/process/` 符合 maintain-notes；笔记的 `## 后果` 应写明 skill 的有效性证据以盲审与泛化审报告为准，笔记 implemented 不代表工单已验收。

### 审查者亲验

- `npx tsx scripts/verify-doc-budgets.ts`：通过，8 份常驻文档均在上限内；AGENTS.md 去空白计数 4112。
- 逐条对照源码核实案例文本：`browser-manager.ts:120`（案例 3）、`:608`（案例 4）、`browser-tools.ts:58`（案例 1，校验代码中的 http/https）、`:94`（案例 5、9 的描述）、`:169-171`（自动 pause）、`browser-manager.ts:32-40`（binding 含 socketDir、cdpUrl，案例 8）、`tool-router.ts:403-408`（无条件追加产物提示，案例 10）。
- 核实验收所用工具存在：`ruukoto selection-records`（`packages/tui/src/cli.ts:1032`）与 TUI prompt 快照格式化（`packages/tui/src/tui/app.ts:78`）。
- 检查集脚本与工单所列一致：`check:static` 已包含 `verify-notes` 与 `check:docs`。

未覆盖：没有读原会话核对案例 2、8、10 的实际字节数和次数，以诊断为准；没有核对 Q1–Q13 的访谈原文；没有运行 `check:static`，本次只改了工单与本记录。

## 2026-10-14 — 修订方案独立复审

角色：独立方案审查者，独立执行上下文；按方案者列出的受影响部分复核，并对照当前源码核实验收取材是否可行。

| 被审全文 | SHA-256 |
| --- | --- |
| [工单](../issues/01-agent-facing-text-skill.md) | `42a02ac6a088536ac241b5c451fe77b206b23a8fa710887a95f1ba4135a6cfcc` |

结论：无阻断，转 `ready-for-agent`。

- **B1 已解决。** J1–J8 底稿不再含取自 browser 与 bash 的示例，案例对应关系只出现在案例表；盲审记录 `SKILL.md` 哈希并检查案例标识，补规则同样只写一般陈述，最多两轮，仍有遗漏交拥有者，不降低命中要求。
- **B2 已解决。** 泛化审的被审对象、判定者（独立实现审查者）、三项判定依据、通过条件都已写明，召回率明确由盲审负责。核实 `createSubAgentFamily` 在共享 runtime 中装配（`packages/runtime/src/runtime.ts:3536`），两个产品都有，取 ruukoto-code 快照可行。
- **F1–F4 已更正。** 复测 AGENTS.md 去空白计数仍为 4112；非目标、案例第 2、5 行、cases.md 表头注记都与源码一致。

非阻断，实施时注意：

- **快照会话的前提。** browser 只在完全访问、非计划模式、非 SubAgent 的 main/dev 任务中装配（`browser-tools.ts:19-23` 的 `browserTaskAllowed`，另见 `runtime.ts:3484` 排除工作流投递任务）。ruukoto-code 会话的身份是 dev，但要用完全访问模式开，否则快照里没有 browser 定义。实施者在证据里写明会话模式。
- **标识检查的覆盖范围。** 交给盲审者的如果不只有 `SKILL.md`（例如另有展开规则放在 `references/`），标识检查和哈希记录同样覆盖这些文件。

审查者亲验：工单内相对链接可解析；AGENTS.md 预算复测；browser 与 SubAgent 工具族的装配条件按源码核实。未覆盖：与首轮相同，没有读原会话，也没有读访谈原文。
