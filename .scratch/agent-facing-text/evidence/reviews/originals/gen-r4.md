# gen-r4 原文

审查者最终回复原样抽自其执行上下文的会话转录；只去掉了行尾空白，正文未改。

# SubAgent 工具族模型可见文本审计报告

审计对象是 `snapshot-tools.json` 里 dev 会话（完全访问、首轮）的系统提示和 6 个工具定义，加上 `subagent-tools.ts` 与 `subagents.ts` 里会返回给模型的结果和错误文本。SubAgent 身份没有快照，它的系统提示从 `system-prompts.ts.L20-82.txt` L71-80 取，任务输入从 `subagents.ts` 的 `taskInput` / `messageTaskInput` 取。

**越界声明：** 审计中途我有一次越出了允许范围。我列出了 `/tmp/aft/` 目录，又在文件系统里搜索 `pi-coding-agent` 的位置，这暴露了 `/tmp/aft` 下的其他文件名和几个 SDK 安装路径。我没有读取其中任何文件的内容，下面的结论没有用到它们。

---

## subagent_delegate

### D1. 继续修改工作的唯一可行写法没有写出来，三条文本都把模型引向会被拒的调用（J1、J2）

**文本位置**
- 快照 `subagent_delegate.description`：「补充原工作用 work_id（修改继续沿用首次钉定的写入目标）」。参数 `work_id.description` 写法相同。
- 快照 `read_paths.description`：「仅限开发会话：……待读路径」，没说分析时必填。
- `subagent-tools.ts` L249、L278：`mode` 缺省按 analyze 处理，analyze 且没有 read_paths 和 materials 时报「必须指定分析对象：开发会话用 read_paths，main 会话用 materials」。
- `subagent-tools.ts` L261-262：「mode=modify 时不指定 read_paths 或 materials（写入目标包含自己的资料路径）」。
- `subagents.ts` L338-340、L346-347：带 work_id 时报「work_id 沿用工作原有模式，不能指定 mode」。

**模型会做错什么。** 修改工作汇总后验证失败，模型按描述续派：
1. 调 `subagent_delegate({request:"修复测试失败", key:"fix-1", work_id:"work_x"})`，被拒「必须指定分析对象」。
2. 改成 `subagent_delegate({..., work_id:"work_x", mode:"modify", target:"packages/foo"})`，又被拒「work_id 沿用工作原有模式，不能指定 mode」。

真正能通过的只有 `work_id` 加上 `read_paths`、且不带 mode 这一种组合。但 L262 的错误理由（「写入目标包含自己的资料路径」）恰好暗示修改工作不需要 read_paths，模型很可能就此放弃，或者另开一项新修改工作。新工作会建一个新 worktree，丢掉原副本的上下文。

只读工作的续派（只带 work_id）和协作加入（work_id + sub_agent_id）也会撞上同一个 L278 拒绝。描述只在 sub_agent_id 复用时写了「读范围与资料按本次重新确定」，续派时模型自然以为读范围沿用。

### D2. 修改委派与 read_paths 互斥，但使用点没写（J1）

**文本位置**：快照 `mode.description`「modify 需要 target」和 `target.description`，都没写不能同时带 read_paths 或 materials。拒绝只在 `subagent-tools.ts` L261-262。

**模型会做错什么。** 想给修改任务附参考资料时，模型会调 `subagent_delegate({request, key, mode:"modify", target:"src/a", read_paths:["docs/spec.md"]})`，被拒后多一次往返。描述前半句「开发会话用 read_paths 指定资料路径」还在鼓励它这样附资料。

### D3. 活动任务名额上限 3 不在描述里（J1）

**文本位置**：上限只在 `subagents.ts` L76 `SUBAGENT_LIMITS.perParentSession: 3`，以及 L405-408（「本会话的活动 SubAgent 任务已达上限 3，等现有任务结束后再委派」）和 L512 的拒绝里。快照的描述和系统提示都没提。

**模型会做错什么。** 要并行分析 5 个模块时，模型会连发 5 次 `subagent_delegate`，第 4、5 次被拒，之后还得等待、重新发起。

### D4. read_paths 和 materials 按身份分叉，但 dev 模型拿不到能核对的身份词（J8）

**文本位置**：快照 `read_paths.description`「仅限开发会话」，`materials.description`「仅限 main 会话：……{kind:'text',text} | …」。快照系统提示没有出现「开发会话」或「main 会话」这两个词，只写了「在当前工作区里协助开发」，而且它的 SubAgent 段没提 read_paths。

**模型会做错什么。** 想把一段背景说明交给 SubAgent 时，`{kind:'text'}` 看起来正合适，模型会调 `subagent_delegate({request, key, materials:[{kind:"text", text:"背景……"}]})`，被拒「开发会话不能指定 materials」（`subagent-tools.ts` L272）。整个 materials 参数及其 4 种资料形状在 dev 装配里都是不可用项。

### D5. 父会话占着目录时，非 Git 直接写入的委派结果写「已在后台执行」（J2、J5）

**文本位置**：`subagent-tools.ts` L318-327，结果原文是「直接写入 X（与父会话按目录占用串行）。子任务已在后台执行；完成后宿主会通知……」。父会话持有该目录占用时，任务实际停在 queued。正确的下一步「等待本会话释放目录，请结束本轮」只在随后调 subagent_result 时才出现（L410-419）。

**模型会做错什么。** 模型在本轮里等结果：先调一次或多次 `subagent_result({work_id})` 才拿到「请结束本轮」，或者继续在同一目录做别的事。委派结果本身就应该写明「父任务结束后才开始，请结束本轮」。

---

## subagent_result

### R1. 描述承诺结果里有「产物列表」，结果里没有（J5、J1、J2）

**文本位置**
- 快照 `subagent_result.description`：「part=artifact 按字节分页读该任务的产物（artifact_id 见结果中的产物列表）」。
- 参数 `artifact_id` 没有描述。
- `subagent-tools.ts` L395-422：part=result 只输出工作行和每个任务的 id、状态、直接父任务、截止时间、摘要，没有任何产物信息。
- `subagent-tools.ts` L453-454：错误文本「产物不存在或不属于该任务的执行」也没说去哪里找 id。

**模型会做错什么。** 模型先调 `subagent_result({work_id})`，找不到产物列表；接着试 `subagent_result({work_id, part:"artifact"})`（没有 artifact_id），或者把任务 id、文件名猜成 artifact_id，被拒；再去翻 part=reply。在可审的文本里，没有哪个结果会给出 artifact_id。

### R2. 总览不标出已取消的工作，却声称是「供挑选继续或复用对象」（J5）

**文本位置**：快照描述「省略 work_id 列出……名下工作……供挑选继续或复用对象」。`subagent-tools.ts` L374-376 的总览行只列 `名下工作 W1、W2` 和 `当前工作`，没有取消标记。拒绝在 `subagents.ts` L373-376（「工作已取消（…）：不能继续委派」）。

**模型会做错什么。** 模型从总览里挑了一项已取消的工作续派，调 `subagent_delegate({request, key, work_id:"work_canceled"})`，被拒。

### R3. 原始状态值 `unverified` 没有定义，对应的阻塞状态也没有对照（J3、J2）

**文本位置**
- `subagent-tools.ts` L340：总览直接输出 `agent.state`，模型会看到 `idle` / `running` / `unverified`。
- `subagents.ts` L232-236：任务结束时只要还有占用，就会被宿主自动置为 `unverified`。
- `subagents.ts` L1172：复用或续派时报「SubAgent 正忙或待核实（状态 unverified）：等当前任务结束后再委派」。这时其实可能已经没有当前任务。
- 退出途径只有 L261-276 的拥有者核实 `executionVerified`。快照里所有描述和系统提示都没说明这个状态。

**模型会做错什么。** 拿到这个错误后，模型会等待，然后反复重试 `subagent_delegate({..., sub_agent_id:"sagent_x"})` 或轮询 `subagent_result()`，但没有任务会结束，状态不会自己变。另外，发给该 SubAgent 的 `subagent_message` 会返回「已发送……待投递」，但在拥有者核实前不会投递（L1172 判为 busy，消息保持 pending）。正确的做法是改为新建 SubAgent，或停下来告诉拥有者需要核实，文本里两条都没写。

---

## subagent_close

### C1. 有活动任务时，拒绝文本只给拥有者的 CLI，漏掉模型自己的 subagent_cancel（J2、J4）

**文本位置**
- 快照 `subagent_close.description`：「有活动任务时拒绝（等任务结束或由拥有者取消）」。
- `subagents.ts` L678-682：「SubAgent 有活动任务 T：等任务结束，或由拥有者 ruukoto cancel T 后再关闭」。错误只给任务 id，没给工作 id。

**模型会做错什么。**
- 一种情况是模型请拥有者执行 `ruukoto cancel task_x`，多出一次拥有者往返。
- 另一种情况是在完全访问的 dev 会话里，模型直接调 `bash({command:"ruukoto cancel task_x"})`，绕开自己的工具。

模型自己就能完成的路径是：调 `subagent_cancel({work_id})`，等停止完成后再 close。要拿到 work_id，还得先调一次 `subagent_result()` 总览，从「当前工作」里查。兄弟工具 subagent_cancel 的描述写了它会停止活动任务，但 close 的文本明说「由拥有者取消」，两者冲突，所以这条不满足第 3 步的不成立条件。

---

## subagent_cancel

本工具的描述和结果文本没有找到足以写出确定误调的问题。

结果「N 个任务仍在停止中」（`subagent-tools.ts` L521）之后，迟到结果「不再主动送达」，模型可能要靠轮询才知道停止何时完成。但 `cancelTask` 在 Runtime 里，是否等停止完成才返回无法从材料核实，所以我没把它列为发现。

---

## subagent_message

### M1. 要求 SubAgent 联系「其他 SubAgent」，却不给对方的 id（J2）

**文本位置**
- `subagents.ts` L1288（协作加入的任务输入）：「本工作可能还有其他 SubAgent 协作」，没有列出 id。
- `subagents.ts` L1302：「用 subagent_message 向主 Agent 或当前承接本工作的其他 SubAgent 发送……」。
- 快照 `to_sub_agent_id`：「接收的 SubAgent id」。
- SubAgent 只装配了 subagent_message（`subagent-tools.ts` L67），没有 subagent_result 可以查参与者。

**模型会做错什么。** 加入方 SubAgent 想直接问原承接者时，会调 `subagent_message({work_id, key, text, to_sub_agent_id:"<猜测或编造的 id>"})`，被拒「SubAgent 不存在」（`subagents.ts` L850）。在收到对方来信（来信带「来自：SubAgent X」）之前，它没有任何途径拿到 id。父 Agent 这边也没有文本提醒它把协作方 id 写进 request。

---

## subagent_integrate

### I1. 部分汇总后，冲突错误建议「让 SubAgent 继续修正后再汇总」，在该状态下必然再次失败（J2）

**文本位置**
- `subagents.ts` L1082-1087：「……父工作区同文件已有本地改动或此前已部分汇总。……待处理：由你或拥有者在父工作区核对差异后手动处理，或让 SubAgent 继续修正后再汇总」。
- 汇总总是套用副本相对基线的完整差异（`subagents.ts` L1077-1078 的套用路径）。已套用过的修改块会挡路，所以「汇总 → 续派修正 → 再汇总」一定冲突，副本里再怎么修都没用。
- 快照的系统提示和 delegate 描述又在鼓励修改工作用 work_id 续派。

**模型会做错什么。** 标准修正循环是：`subagent_integrate({work_id})` 成功，验证失败，`subagent_delegate({work_id, ...})` 续派修正，再 `subagent_integrate({work_id})`，冲突。模型照错误建议再续派一次，再汇总，还是冲突，如此反复。

这个状态下真正可执行的下一步是下面两条之一，文本都没写：
- 用 bash 对比副本路径（错误文本里已给出）和工作区，把增量手工套进来；
- 先撤回此前套用的改动，再整份汇总。

描述里「此前已部分汇总时拒绝」也只写了拒绝，没写配套的正面做法（J4）。

---

## 没有覆盖的部分

- `messageStateText`（`@ruukoto/agent/subagent-message.ts`）没有提供，subagent_message 和 part=messages 的投递状态文本没审。
- 结果完成后宿主怎么「通知」dev 会话，没法核实。源码头注释说是「下一次模型调用的宿主资料注入」，但 parent-delivery 和 Runtime 代码都没提供。如果 dev 不会被唤醒，delegate 结果里「完成后宿主会通知」就没说清该结束本轮还是留在本轮，可能引出轮询。这一条按未覆盖处理。
- 「待提交改动区」指 Git 暂存区还是工作树，取决于 `work-copy.ts` 的 apply 参数，材料里没有。如果是暂存区，模型用 `git diff` 验证会看到空结果。这一条未核实。
- 抛出的 `Error` 是否原样作为工具错误结果交给模型，我按 SDK 惯例推定为是，没有核实。
- main / scheduled 身份没有快照，只按源码推断，没有逐条审。

---

## SKILL.md 本身难以套用的地方

1. **第 1 步要求从同一会话的事件流取结果，但材料只有首轮快照。** 所有结果和错误文本只能从源码推。SKILL 没说明在这种情况下怎么判断「哪些拼装分支模型真的会走到」，尤其是依赖运行时状态的分支（占用、unverified）。
2. **第 3 步的不成立条件在文本冲突时不好判。** 兄弟工具描述写了正确做法、但当前错误文本给了相反指引时（C1：cancel 描述对 close 错误），算「已写明正确做法」还是算冲突，SKILL 没给裁决。
3. **J8 要求「让模型能确认自己的身份」，但没说身份要用什么词、出现在哪里才算可确认。** D4 里系统提示用「协助开发」，参数描述用「开发会话」，两边对不上。
4. **宿主拼给 SubAgent 的任务输入（`taskInput` / `messageTaskInput` 的固定行）是否属于被审对象，范围表述不明确。** frontmatter 列举了「系统提示与参考块里宿主写定的措辞」，任务输入首行只能类推进来。M1 就依赖这一类推。
5. **J2 禁止用「描述与系统提示里都没定义过的内部术语」，但内部术语也可能以状态值的形式出现在结果里（R3 的 `unverified`）。** 这类情况归 J2 还是 J5 不清楚，SKILL 也没要求为状态枚举提供对照表。
