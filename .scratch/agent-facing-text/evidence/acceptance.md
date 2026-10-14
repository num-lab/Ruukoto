# 模型可见文本标准：工程验收记录

日期：2026-10-14。实施者：本工单独立实施者（Claude Opus 5.5，单一执行上下文）。审查者与判定者均为实施者另起的独立执行上下文（general-purpose 子代理），每轮新开，只读指定目录；不读 `references/cases.md`、本工单、诊断、原会话与方案审查。各轮报告与判定的摘要见 [reviews/](reviews/)；审查者与判定者的最终回复原文原样抽自各自的会话转录，见 [reviews/originals/](reviews/originals/)。

结论：**盲审通过（四轮 8/8）。泛化审按工单字面的通过条件未达成，拥有者 2026-10-14 决定接受现状（选项 B），残余误报与措辞缺陷记为已知上限；独立实现审查无阻断。** 记录见「拥有者决定」与「独立实现审查」。

## 交付物与当前哈希

| 文件 | SHA-256 |
| --- | --- |
| [SKILL.md](../../../.agents/skills/agent-facing-text/SKILL.md)（v4，验收对象） | `8577506f3400d2dcd8bbdb7df790e8934600d4e8c5d5cfb213f46ef2668e0393` |
| [references/cases.md](../../../.agents/skills/agent-facing-text/references/cases.md)（不交审查者） | `2698d9630757a01562050e52cfbe416398ba1c773650f354f822e446bad7c277` |

另改：[prose-standard](../../../.agents/skills/prose-standard/SKILL.md) 加指针；`AGENTS.md` 落点表加一行（预算 4235/4300）；决策笔记 [2026-10-14-agent-facing-text-standard](../../../.agents/notes/implemented/process/2026-10-14-agent-facing-text-standard.md)。

## SKILL.md 版本与标识检查

| 版本 | SHA-256 | 改动原因 |
| --- | --- | --- |
| v1 | `730c27405df5394fd909438d38b0522dc7d115b791a41feca048190fa8aeed24` | 初稿 |
| v2 | `bea80f1c5ed351dbffd068ded1e466ccbf7722c2f32c3d5605d6a18ac57fca6d` | 泛化审第 1 轮误报 D8、X2、M1、D4 归属；见 [judge-r1](reviews/judge-r1.md) 末节 |
| v3 | `ee5f05a107587683a1e7a49fe1854dacd0ff8401750fedbdda7801c4ac33c8d8` | 泛化审第 2 轮误报 C1、M1 与审计边界缺口；见 [judge-r2](reviews/judge-r2.md) 末节 |
| v4 | `8577506f3400d2dcd8bbdb7df790e8934600d4e8c5d5cfb213f46ef2668e0393` | 拥有者选 A：J2 写明「结束本轮、等宿主通知」属可执行下一步；J8 划清「整个工具的装配条件」与「调用某动作的前提」；见 [judge-r3](reviews/judge-r3.md) |

每版交付前在仓库根运行同一检查，四版输出均只有结束行（无命中）：

```sh
for pat in 'file://' 'http/https' 'outcome_unknown' 'browser_not_ready' 'browser_paused' 'resume' 'socketDir' 'cdpUrl' '核实原执行' 'artifact' 'nohup' 'main/dev'; do grep -n -- "$pat" .agents/skills/agent-facing-text/SKILL.md && echo "命中: $pat"; done; echo "--- 标识检查结束"
# 输出：--- 标识检查结束
```

审查者只拿到 `SKILL.md`，没有 `references/` 下的文件，标识检查只需覆盖它。

## 快照取材

[snapshot-capture.mts](reviews/snapshot-capture.mts) 以 `buildChildEnv` 起 ruukoto-code 开发后台（档案 `~/.ruukoto-code-dev/ruukoto-2159f2e3/`，检出 `c1f5041` 加本工单未提交改动，未改源码），对 `~/Developer/Temp` 调 `open_workspace` 新开会话 `sess_221a61994f2b36a4fef14982`（kind=dev），以 `full_access`、`magpie/mirasim/deepseek-flash` 提交一句「只回复 OK，不调工具」，取首轮选择记录 `promptArtifactId` 的快照后停后台。会话新开、无历史、无失败；工具列表含 browser、bash 与六个 `subagent_*`。改动前估算 `systemPrompt` 1323、`toolSchemas` 9251（本工单未改工具文本，量化要求不适用，此数作为后续修复工单的基线）。

快照中 browser、bash 与 `subagent_*` 的定义与 `c1f5041` 源码逐字一致。

## 1. 盲审

材料（`/tmp/aft/blind/`，审查者只读此目录）：

| 文件 | 来源 | SHA-256 |
| --- | --- | --- |
| `snapshot-tools.json` | 快照 tools 中 browser 与 bash | `89f7901745b314effe90a8c11c55f8c5492cf571d8bc387feaf42cd712d416f3` |
| `browser-tools.ts` | 全文 | `6f08c3255a3b5c82d74ac7a7a58287ddc7a11ad84dd85a13a2a2f634614f2a34` |
| `browser-manager.ts` | 全文 | `b135e234ec75bf1afa518648abc3580cb7761dd97a00b149ee2e9fb488336757` |
| `tool-router.ts.L320-420.txt` | 结果追加段，加 bash 定义 805–815 行，带行号 | `2431d9b01cc5509ab8dd8b3ad41e122747e263e97e519ab6e4c3b00d3f95dc13` |
| `tool-worker-worker.ts.L85-155.txt` | bash 执行与回收段，带行号 | `b42867c688aa6aaa2ba5d7025218fbc742274a54a7ec5af1741112c93aa62d07` |

工单所列材料之外多给了 worker 段：bash 结果由它产生，没有它审查者无从得知后台进程的回收行为，案例 2 无法判定。

| 案例 | 第 1 轮（v1） | 第 2 轮（v2） | 第 3 轮（v3） | 第 4 轮（v4） |
| --- | --- | --- | --- | --- |
| 1 | B16 J1 | B2 J1 | 8 J1 | B3 J1 |
| 2（须归 J7） | S1 J7 | S1 J7 | 4 J7 | S1 J7 |
| 3 | B10 J2 | B9 J2、J3 | 10、14 J3、J2 | B6 J2、J3、J4 |
| 4 | B10 J2 | B9 J2 | 14 J2 | B6、B11 J2 |
| 5 | B11、B9 J3 | B11 J3 | 11 J3 | B7 J2、J3 |
| 6 | B10 J4 | B9 J4 | 15 J4 | B6 J4 |
| 8 | B14 J5 | B6 J5 | 12 J5 | B9 J5 |
| 9 | B18 J8 | B16 J8 | 18 J8 | B13 J8 |
| 10 | S4 J6 | S5 J6 | 5 J6 | S5 J6、J5 |

四轮均 8/8 命中、第 2 条归 J7，无遗漏，未因盲审补规则。比对结果未告知任何审查者。各轮另报 9–20 条案例外发现，留给后续修复工单。

## 2. 泛化审与判定

被审：SubAgent 工具族（`subagent-tools.ts`），同一份快照。判定者每轮新开，可读 `packages/` 源码核实，不由实施者或出报告的审查者兼任。

| 轮次 | SKILL | 材料 | 发现 | 真问题 | 部分成立 | 误报（规则措辞诱发） |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | v1 | 快照 `subagent_*` + `subagent-tools.ts` | 21 | 8 | 10 | 3：D8（J1 使用点）、X2（J8 注意力理由）、M1（J8 身份资格） |
| 2 | v2 | 同上 | 13 | 6 | 5 | 2：C1（材料缺系统提示）、M1（J8「花推理判断」） |
| 3 | v3 | 加完整系统提示、各身份系统提示源码、runtime `subagents.ts` | 15 | 1 | 7 | 7，其中规则措辞诱发：D3（J8「装配条件」与 J1「动作前提」未划界）、D2/I1 部分（J2「无法用任何工具完成」覆盖了「结束本轮等通知」）；其余 5 条判为审查者失误 |
| 4 | v4 | 同第 3 轮；审查提示另加两条要求（源码注释不是被审文本；先核对所引代码路径确会走到） | 11 | 5 | 1 | 3 条完整误报加 1 条部分，均判为规则措辞诱发：D1 误报成分与 D5（第 3 步未规定兄弟描述与错误文本冲突时以哪侧为准）、R3（状态枚举值被当成 J2 的内部术语）、C1（同 D5）；D4 待裁决（J8 身份用词无标准） |

第 3 轮材料：在前两轮基础上加 `systemPrompt`（快照）、`system-prompts.ts.L20-82.txt`（`213596a8…`）、`subagents.ts`（`306d1a39…`）；新 `snapshot-tools.json` 为 `eaed7ae0…`。工单第 3 步要求「连同产生其结果与错误的源码」，前两轮只截工具层属实施者取材不全，第 3 轮补齐；材料变化使第 3 轮与前两轮不是严格的「同一材料」复审。

第 4 轮判定点出三处会诱发误报的措辞缺陷：第 3 步未规定兄弟描述与错误文本冲突时以哪一侧为准；J8「让模型能确认自己的身份」没有用词标准；J2 的术语条款与 J5 未划清，状态枚举值被当成内部术语。

泛化审真问题（跨轮去重，供后续工单）：续修改工作须补无意义的 `read_paths`（D1/D2）；modify 与 `read_paths` 互斥未写（D3/D4）；描述承诺的产物列表不存在（R1）；artifact 分页范围未写（R2）；`subagent_close` 拒绝只给拥有者 CLI、不给 `subagent_cancel`（C1/C2）；dev 会话结果在下一任务注入、同轮轮询读不到（D5/D6）；空闲 SubAgent 收消息立即触发执行未写（M2 第 1 轮）；integrate 成功路径要求核对副本但不给路径（I1）；宿主故障错误无「停下报告」（G1）；结果含多余任务标识（R3/R4）。

## 未覆盖

- 只有 ruukoto-code dev 会话、完全访问一种身份的快照；main、SubAgent 子会话、受限模式没有快照。
- 结果与错误文本全部从源码取，没有事件流原文；`messageStateText`、`subagentOpCheck`、`WorkCopyError` 与审批拒绝文本（`grant.text`）不在材料内。
- 独立实现审查（`in-review`）尚未进行；本记录的审查者只覆盖 skill 有效性，不覆盖交付物与工单要求的逐项核对。
- 第 4 轮泛化审的审查者自报越界：列出过 `/tmp/aft/` 目录（看到其他文件名，含前几轮报告文件名）并在文件系统搜索 SDK 安装路径；声明未读取任何文件内容。它只看到文件名，未看到案例表，本轮结论按此采信。
- 产品验收不适用：本工单没有主观体验取舍。

## 检查

- `npm run check:static`：通过（v1 交付时运行；之后只改 `SKILL.md` 文本，`check:docs` 与 `verify-notes` 在 v3 后复跑通过）。
- 未跑全量 `check`：不动源码。

## 副作用

开发档案 `ruukoto-2159f2e3` 多了会话 `sess_221a61994f2b36a4fef14982` 与一次模型调用记录；后台取完快照即以 SIGTERM 停止，该会话的任务终态为 `interrupted`。

## 拥有者决定

第 1 次（第 3 轮判定后）拥有者选 A：授权补规则一轮，通过条件不变，据此产出 v4。

第 2 次（第 4 轮判定后）拥有者选 B：**接受 v4，转 `in-review`。** 未处理的误报与措辞缺陷作为已知上限记录如下，不在本工单继续修；后续修复工单评估。

已知上限：

- 泛化审通过条件「判定后无未处理误报」未达成。第 4 轮经独立实现审查者按原文改判后的口径（见[实现审查](implementation-review.md)）：措辞诱发的误报 1 条（D4，J8 身份用词判准）；两处第 3 步判法缺口（同一份文本自相矛盾、兄弟工具描述与错误文本冲突）各使 1 条发现降为「部分成立」（D5、C1）；R3 由误报改判为真问题。前四轮由实施者自派子代理判定，与工单指定的角色不符，已在本轮改判补正。
- 三处未修的措辞缺陷：第 3 步未规定同一份文本自相矛盾、兄弟工具描述与错误文本冲突时怎么判；J8「让模型能确认自己的身份」没有用词标准；J2 的术语条款与 J5 未划清。
- 判定者在第 4 轮自报一次取证越界（见「未覆盖」末条）。
- 泛化审材料从第 3 轮起才补齐系统提示与 runtime 层源码，前三轮与第 4 轮不是严格同一材料。

第 4 轮真问题（供后续修复工单）：D2、D3、R1、R2、R3、M1、I1。

给后续工单的待裁决项：D1 修实现还是只改文本（续派修改工作须补无意义的 `read_paths`）；dev 与 main 的身份词能否让模型对上（第 3 轮 D4、第 4 轮 D4）；同一段校验的多条发现怎么计数；`effectUnknown` 类说明改写还是删除；main 会话总览把宿主评审 SubAgent 显示为 idle（需运行时快照确认）；总览是否应显示工作是修改还是分析。

## 独立实现审查

见 [implementation-review.md](implementation-review.md)。首轮一项阻断（B1：泛化审判定者用了实施者自派的子代理，且只拿到实施者的摘要而非审查者原文），返工后由该审查者按原文改判第 4 轮，B1 解除，结论无阻断。审查者另提两处非阻断订正，均已处理：副作用一节补任务终态 `interrupted`；`reviews/` 处标明摘要与原文的分别。

## 已知偏差（与工单写法的差异）

- 泛化审材料：工单第 3 步要求「连同产生其结果与错误的源码」，前两轮只截工具层，第 3 轮起补系统提示、各身份系统提示源码与 `subagents.ts`。三轮材料不完全相同。
- 盲审材料比工单所列多一份 worker 段（`tool-worker-worker.ts.L85-155.txt`）：bash 结果由它产生，缺它无法判定第 2 条。
- 第 4 轮泛化审的审查提示另加两条要求：源码注释不是被审文本；下结论前核对所引代码路径确会走到。这是审查质量问题，不是 skill 内容。
- 泛化审第 1–3 轮的判定者由实施者自派子代理担任，与工单第 3 步指定的「独立实现审查者」不符；第 4 轮已按工单由独立实现审查者以原文改判（见上）。前三轮的产物是 v2、v3，已被第 2 步的逐版重跑覆盖，未回填。
