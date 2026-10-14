# gen-r3 原文

审查者最终回复原样抽自其执行上下文的会话转录；只去掉了行尾空白，正文未改。

# SubAgent 工具族「模型可见文本」审计报告

被审主体：`snapshot-tools.json`（ruukoto-code / dev 会话 / 完全访问 / 首轮）中模型实际看到的系统提示与六个工具定义，加上源码会返回给模型的结果与错误文本（`/tmp/aft/gen/subagent-tools.ts`、`/tmp/aft/gen/subagents.ts`）。源码行号均为该目录下文件的行号。

审前先确认了三件事实，后面多处发现依赖它们：

- 工具层 `mode` 缺省 `analyze`（`subagent-tools.ts:262`），并强制 `mode==="analyze" && readPaths===null && materials===null` 就抛错（`subagent-tools.ts:290-292`）。
- runtime 对 `work_id` 的续派只认两样东西：工作原有 `writeTarget` 与本次传入的 `read_paths`；原工作一律拒绝 `mode`（`subagents.ts:346-348`、`430-434`）。
- 因此**修改类工作（mode=modify）的续派，在工具层参数形状上与被拒绝的形状完全重合**——下面第一条发现就是它。

---

## subagent_delegate

### D1（J1、J2）修改工作续派的参数形状与描述相反，形成三次连错、无出口
**位置**：工具描述 `subagent_delegate.description`（快照，原文）：

> "首次省略两参数建立工作；补充原工作用 work_id（**修改继续沿用首次钉定的写入目标**）"

`work_id` 参数描述："沿原工作增加新的分析执行；**修改工作继续沿用首次钉定的写入目标**"。
`mode` 参数描述："委派模式；仅首次委派可指定，modify 需要 target"。
`read_paths` 参数描述："仅限开发会话：父工作区内或父任务已授予的待读路径（最多 16 个，只读）"。

**规则**：J1（动作前提写在使用点）、J2（指引给出真实可执行的下一步）。

**模型会做错什么**：模型委派过一次 `mode=modify + target` 的工作（这是最常见的「用隔离副本改代码」用法），拿到 `work_id`；现在要往里补一轮工作，于是按描述照抄首次的参数：

```
subagent_delegate(work_id:"work_x", request:"...", key:"k2", mode:"modify", target:"src/")
```

被 `subagents.ts:346-348` 拒：`work_id 沿用工作原有模式，不能指定 mode`。错误文本读起来像"你把两个都写上了"，于是模型删掉 `mode` 再试：

```
subagent_delegate(work_id:"work_x", request:"...", key:"k3")
```

被 `subagent-tools.ts:290-292` 拒：`必须指定分析对象：开发会话用 read_paths，main 会话用 materials`——**模型此时仍在做修改工作，却被要求给只读路径**，而 `read_paths` 的 schema 又写着"只读"，`target` 的 schema 写着"写入目标"，模型合理的下一步是把 `target` 加回来：

```
subagent_delegate(work_id:"work_x", request:"...", key:"k4", target:"src/")
```

被 `subagents.ts:349-350` 拒：`target 仅 mode=modify 使用`。三步走完，模型手里唯一能过校验的形状是 `{work_id, request, key, read_paths:[...]}`（即"给只读路径续派一项修改工作"），而没有任何一段文本告诉它这就是正确形状。每一轮都是只读委派的三次连续误调，且三轮错误文本里没有一条写出完整可用组合。

### D2（J2）忙碌拒绝只写"等任务结束后再委派"，工具层没有任何等待动作
**位置**：`subagents.ts:1171-1172`：

> `SubAgent 正忙或待核实（状态 ${agent.state}${activeTask ? `，活动任务 ${activeTask.id}` : ""}）：等当前任务结束后再委派`

`subagent_delegate` 的结果只给 `任务 ${...}` 与"完成后宿主会通知"（`subagent-tools.ts:316-325`）；`subagent_result` 的 `part=result` 里能看到任务状态与 `activeTask.id`（`subagent-tools.ts:401-403`）。

**规则**：J2（不写已被阻塞的动作；忙时的正确做法是去读结果而不是重发委派）。

**模型会做错什么**：委派同一 SubAgent 的第二项工作时被拒，模型按字面"等"，但没有等待工具，于是把同一个调用原样重发一遍（`subagent_delegate{work_id:..., request:..., key:"k5"}`，或改用 `sub_agent_id` 再发一次 `subagent_delegate{sub_agent_id:"sagent_y", request:..., key:"k6"}`），而不是先 `subagent_result{work_id:"work_x"}` 看活动任务是否结束。描述里也没有"等它结束"的可执行替代（取消/关闭都不适用，只会更糟）。

### D3（J8）复用要求"空闲"是模型看不见的内部状态，描述只写"未关闭"
**位置**：`subagent_delegate.sub_agent_id` 描述与工具描述：

> "把相关的另一项工作交给同一个空闲 SubAgent 用 sub_agent_id 复用（保留上下文，读范围与资料按本次重新确定，**要求该 SubAgent 空闲且未关闭**）"

而 `subagent_result` 总览输出的字段是（`subagent-tools.ts:382-390`）：

> `- SubAgent ${agent.id} · ${agentStateText(agent)} · 当前工作 … · 名下工作 … · 最近任务 ${recent.id}（${recent.status}）`

`agentStateText` 输出的是状态**显示值**（`已关闭（…）` / `agent.state` 字面值 running、idle、unverified，`subagent-tools.ts:342`）。runtime 的忙碌判定是 `subagent-tools` 之外的 `subagents.ts:1171`（`state !== "idle" || activeTask`）。

**规则**：J8（分叉依据要让模型能确认）。

**模型会做错什么**：总览显示 `SubAgent sagent_y · idle`、`最近任务 t7（completed）`，模型据此判断"空闲、已结束"，于是复用；若此时恰有活动任务或状态仍是 `unverified`，被 `subagents.ts:1171` 拒。反向也成立：模型看到 `running` 时无法区分"正在跑任务"（要等）与"刚结束、状态尚未回落"（可以直接复用），于是多跑一次 `subagent_result{work_id:"work_x"}` 去核对任务状态，或者白白放弃复用、另建一个新 SubAgent（丢掉上下文，正是这个参数存在的理由）。

### D4（J1）参数互斥只由 `mode` 的一句话承担，`read_paths`/`target`/materials 各自不提
**位置**：`mode` 描述："modify 需要 target（dev 与 main 均可发起；计划模式与 SubAgent 自身不能发起）"；两边都没有写 `modify` 与 `read_paths`/`materials` 互斥。运行时拒绝见 `subagent-tools.ts:273-277`：

> `mode=modify 时不指定 read_paths 或 materials（写入目标包含自己的资料路径）`

**规则**：J1（互斥组合写在该参数描述里）。

**模型会做错什么**：模型想让子代理改 `src/` 并顺手给它两个参考资料：

```
subagent_delegate(request:"...", key:"k7", mode:"modify", target:"src/", read_paths:["src/","docs/x.md"])
```

被拒。修复信息足够（错误文本点名了两个参数），但前提条件写在另一个参数的描述里、而这个意图（"修改时顺带指定资料"）在文本里没有任何禁止迹象，属于可避免的一次误调。

---

## subagent_result

### R1（J5）结果把内部任务标识当主字段输出，而缺了挑选复用真正要的事实
**位置**：`subagent-tools.ts:402`：

> `` `- 任务 ${t.id} · ${t.status} · 直接父任务 ${t.parentTaskId ?? "?"} · 截止 ${t.deadline ?? "无"}` ``

同页 `subagent-tools.ts:455`：`模型上下文快照不属于交付产物`。

**规则**：J5（每个实体只留模型后续要引用的那一个标识；实现管道不进结果）。

**模型会做错什么**：模型把 `直接父任务 t12` 当成一项可放入其他工具调用的标识——典型误调是反过来把它填进 `subagent_delegate`，或在总览里把"最近任务 t12"与"直接父任务 t12"混为一谈，向拥有者转述时把任务标识当成工作归属。同时 `part=result` 只给任务的 `截止`，不给 SubAgent 的 `已关闭` 之外的状态判定依据（总览才给），要决定"继续沿本工作派、还是复用这个 SubAgent"，模型必须再调一次 `subagent_result`（不带 `work_id`）取总览，得到一次纯查询的往返。

### R2（J1）`length` / `offset` / `artifact_id` 是裸参数，约束只在代码里
**位置**：快照中 `length`、`offset`、`artifact_id` 三个参数**没有 description**；描述文本只说 "`part=reply` 按 UTF-8 字节分页读指定/最新任务的最终回答（length 为 256–16384）"。运行时拒绝见 `subagent-tools.ts:339`：

> `reply length 必须至少为 256 字节`；`artifact length 必须至少为 4 字节`（`:458`）；`offset 必须是 0–${max} 的整数`（`:337`）

**规则**：J1（取值范围写在该参数描述里）。

**模型会做错什么**：答案很长时模型习惯按需取一段，写 `subagent_result(work_id:"work_x", part:"reply", offset:0, length:200)` 被最小长度拒（一次误调）；或写 `length:50000` 被上限拒（`subagent-tools.ts:337` 的 0–16384 检查在 `length<256` 之前触发，报"必须是 0–16384 的整数"，与描述里的"256–16384"不是同一句话）。artifact 的 4 字节下限完全不可见。

### R3（J5）`part=messages` 的正文被静默截到 200 字符，结果里没有截断提示
**位置**：`subagent-tools.ts:434-435`：

> `` `${m.body.length > 200 ? `${m.body.slice(0, 200)}…` : ...}` ``

而 `part=reply` / `part=artifact` 都在真正分页时明确写了"继续用 offset="（`subagent-tools.ts:448`、`::465`）。

**规则**：J5（描述承诺结果里会有的事实，结果里要真的有）。

**模型会做错什么**：协作方发来一条 300 字符的补充说明，模型 `subagent_result{work_id, part:"messages"}` 看到以 `…` 结尾的正文，但既没有 offset 也没有第二页入口，于是**改从别处猜**：重发 `subagent_message` 去问同一条内容（多一次消息投递往返），或转而读 `part=reply` 想找到那句话（那不是消息的去处）。

---

## subagent_message

### M1（J1）"主 Agent 发送时必填"对 SubAgent 子会话同样显示，且它的正解（省略）被工具层先拒
**位置**：`to_sub_agent_id` 参数描述（快照）：

> "接收的 SubAgent id；省略 = 发给主 Agent；**发送方为主 Agent 时必填**"

工具描述同一句；而工具层对**所有身份**调用同一个 `createSubAgentMessageTool`（`subagent-tools.ts:113` 与 `:517-522`），其校验只认字面（`subagent-tools.ts:147-149`）。runtime 对 SubAgent 声称自己发给主 Agent 的处理是 `subagents.ts:850-856`：先 `SubAgent 不存在`，再 `不能发送给自己`，最后才是"主 Agent 发送时必须指定接收的 SubAgent"。

**规则**：J1（谁必填、谁可省，写在使用点）。

**模型会做错什么**：SubAgent 只被钳到这一个工具（`subagent-tools.ts:67`），系统提示 `subagents.ts:74-75` 只说"向主 Agent 或当前承接同一项工作的其他 SubAgent 发送"，没给可选性。SubAgent 想让主 Agent 补资料时按工具描述的直觉走：要么传自己看到的父会话任务对应的 id——`subagent_message(work_id:"work_x", key:"k", text:"...", to_sub_agent_id:"sagent_none")` 被 `SubAgent 不存在` 拒；要么在被拒后照着"必填"补一个目标，填成自己——`to_sub_agent_id:"sagent_y"`（自身 id）被 `不能发送给自己` 拒（`subagents.ts:852`）。正解是不传该参数，而文本把"省略"只解释为"省略 = 发给主 Agent"，与"发送方为主 Agent 时必填"并读，SubAgent 无从确认省略对自己合法。

### M2（J3、J4）工作取消后消息通道被封，禁令没有替身动作
**位置**：`subagent_cancel.description`：

> "取消后不能**沿该工作继续委派**"（这是描述里唯一的取消后禁令）

runtime 多封一条：`subagents.ts:845` `工作已取消（…）：不能投递消息`（还有 `:836-837`、`:399-403` 的跨工作/评审拒绝）。`subagent_delegate.description` 的取消后指引也只覆盖委派。

**规则**：J3（阻塞状态要在描述里有对照）、J4（禁令配正面下一步与失效范围）。

**模型会做错什么**：拥有者说"那项工作先别做了"，模型 `subagent_cancel{work_id:"work_x"}`，随后在同项工作里发现一个要交代的更正，按 `subagent_message` 描述"在同项工作内…发送有来源的消息"照发：

```
subagent_message(work_id:"work_x", key:"k8", text:"更正：…", to_sub_agent_id:"sagent_y")
```

被 `工作已取消：不能投递消息` 拒。文本没有写过消息会被取消一并封掉，模型下一步最自然的动作是换 `subagent_delegate{work_id:"work_x",…}` 想把更正带过去——描述里恰好写了"取消后不能沿该工作继续委派"，于是两次误调；正确出路（新建一项工作 + 复用同一 `sub_agent_id`）在任何文本里都没有出现。

---

## subagent_close

### C1（J3）"空闲"是被拒的主因，但该状态与退出方式都不在描述里
**位置**：`subagent_close.description`：

> "有活动任务时拒绝（**等任务结束或由拥有者取消**）；重复关闭幂等返回；关闭后新委派被拒绝。**任务终态与空闲不会自动关闭。**"

runtime 的拒绝条件是显示状态而非终态（`subagents.ts:1171-1172`，经 `:676-682` 抛出）：

> `SubAgent 正忙或待核实（状态 unverified）：等当前任务结束后再委派`（close 路径同样由它抛）

**规则**：J3（说明进入条件，包括宿主自动进入的情形；写明谁能触发退出）。

**模型会做错什么**：任务已 `completed`（`subagent_result` 的 `part=result` 显示 `任务 t7 · completed`），模型据此 `subagent_close{sub_agent_id:"sagent_y"}`，却因状态停在 `unverified`（占用未释放时宿主置位，`subagents.ts:243-247`）被拒，错误文本仍说"等当前任务结束后再委派"——**模型看到的事实（任务已结束）与文本给的原因（任务未结束）互相矛盾**，模型的下一步是再读一次 `subagent_result{work_id}` 核对任务状态，然后原样重发 `subagent_close`。`unverified` 的退出方式（宿主何时、凭什么条件回落 idle）没有任何文本交代。

### C2（J2）拒绝文本指向模型无法执行的动作，且"等任务结束"的等待没有落点
**位置**：`subagents.ts:680-682`：

> `SubAgent 有活动任务 ${activeTask.id}：等任务结束，**或由拥有者 ruukoto cancel ${activeTask.id} 后再关闭**`

**规则**：J2（不要求模型做它无法用任何工具完成的事；没有可执行动作时明写停下来报告拥有者）。

**模型会做错什么**：`ruukoto cancel t9` 是拥有者的 CLI 子命令，模型没有执行它的工具，快照的系统提示里也没有 `ruukoto cancel`（`system-prompts.ts:52-59` 只提 subagent_cancel 管"工作"）。模型会把这句话当成"跳过这一步、改用别的办法"的信号：它转去调 `subagent_cancel{work_id:"work_x"}` 想"取消掉活动任务"，但 `subagent_cancel` 取消的是整项工作（`subagents.ts:730-770`）而非那一条任务，结果是**为关一个 SubAgent 把整项工作连历史一起停掉**——比它原本想做的动作重得多。

---

## subagent_cancel

### X1（J2）"迟到结果保存为事实但不再主动送达"是被钳掉的整条通知路径，描述当承诺写
**位置**：`subagent_cancel.description`：

> "…迟到结果保存为事实但**不再主动送达**。"；`subagent_delegate.description`：

> "子任务入队后立即返回，结果完成后经宿主通知，用 subagent_result 读取。"

dev 身份的送达是下一次模型调用的资料注入（`subagent_tools.ts:27-29` 头注：`dev 会话再经下一次模型调用的宿主资料注入送达`）。

**规则**：J2（写清当前状态下还剩哪些可用动作）。

**模型会做错什么**：取消后模型按"保存为事实"放心地不再过问，认为结果到点会出现在上下文里；实际不会再被注入。要拿到那部分成果，唯一动作是它自己回头 `subagent_result{work_id:"work_x", part:"reply"}`。描述里的措辞（"保存为事实"）读起来像"仍在某处自动到达"，模型因此漏掉这次主动读取——漏读后它会在后续汇总里把这项工作的结论当成"没有结论"，转而在别处重做一遍分析。

---

## subagent_integrate

### I1（J2）汇总拒绝只说"等该执行结束"，没有点名任务、也没有可用的状态查询入口
**位置**：`subagents.ts:1073-1074`：

> `工作有活动任务 ${active[0]!.id}：等该执行结束后再汇总`

工具描述里"忙碌"完全没有出现；描述只承诺四种结果（套用/幂等/空/非 Git 直接写入）。

**规则**：J2。

**模型会做错什么**：模型在续派之后立刻汇总（常见节奏：派一轮 → 想看改动），被拒。文本给了 id 也给了条件，但没有告诉它"这个 id 怎么判终态"，而 `subagent_result` 的 `part=result` 恰好能给任务状态（`subagent-tools.ts:401-403`）。模型最省事的一步是**原样重发 `subagent_integrate{work_id:"work_x"}`** 等它自己过去；重发两次仍被拒后才转而查询，多出两轮空转。

### I2（J1）`busy` 之外还有"只读分析工作"这条硬拒绝，描述只写了"没有副本可汇总"这一半
**位置**：`subagent_integrate.description`：

> "非 Git 直接写入的工作没有副本，调用只会如实告知。只读分析工作没有写入目标、不能汇总。"

运行时对只读工作是**抛错**而不是"如实告知"（`subagents.ts:1059-1061`）：

> `工作 ${work.id} 是只读分析工作：没有写入目标，没有副本可汇总`

只有 `target.kind === "direct"` 才返回 `state:"direct"`（`subagents.ts:1062-1064`）。

**规则**：J1（动作前提写在使用点：不是每项工作都能汇总）。

**模型会做错什么**：模型手里同时有分析工作与修改工作时，"顺手对全部工作收尾汇总"是自然动作：

```
subagent_integrate(work_id:"work_analyze_1")   // 只读分析工作
```

得到的是错误（工具失败），而描述说它"只会如实告知"（成功语义）。模型会把这次失败当成"环境异常"，转而去核对 `subagent_result`、甚至怀疑汇总需要先关闭 SubAgent（`subagent_close` 描述的"关闭后新委派被拒绝"与 integrate 描述的"已关闭的 SubAgent 也可以汇总"并列，容易让它按这个顺序试），多出两轮无效调用。

---

## 系统提示（dev，`system-prompts.ts:57`）

### S1（J1）一句话把六个工具与三个参数拍在一行，模型要的"哪个先、哪个必填"全在斜杠里
**位置**：`system-prompts.ts:57` 单行：

> "需要独立完成的只读分析或用隔离副本修改仓库时用 subagent_delegate 创建 SubAgent（mode=modify + target 修改委派在宿主生成的本地副本上工作，不提交、不推送；Git 仓库目标建 worktree 副本，非 Git 目录直接写入并与父会话串行）。副本改动由你用 subagent_integrate 按工作 id 汇入你的待提交改动区——冲突时不覆盖、双方保留，拿到冲突就把待处理内容说清楚；汇总后用你自己的检查验证改动。补充原工作用 work_id，相关的另一项工作可用 sub_agent_id 复用同一个空闲 SubAgent（保留上下文）；work_id 与 sub_agent_id 同现可把空闲 SubAgent 拉入既有只读工作协作，同项工作内用 subagent_message 向其中的 SubAgent 补充（消息带来源、不扩大对方权限）。完成后用 subagent_result 按工作 id 读结果（省略 work_id 看总览，part=messages 看工作内消息）；不再需要的工作用 subagent_cancel 取消（已取消的工作不能继续委派）；不再需要后续协作时用 subagent_close 关闭。"

**规则**：J1。

**模型会做错什么**：这句话在"补充原工作用 work_id"处与工具描述的 D1 一字不差地省略了 `read_paths`，模型把系统提示与工具描述对读，得到的是"续派只需要 work_id"这一致的（错误）印象，D1 的三连错因此更不可能被自查发现。同时它对 `subagent_close` 的措辞是"不再需要后续协作时"——而 `subagent_cancel` 已经被写成"不再需要的工作"，模型完成一整套"委派→读结果→汇总"之后，按这两句的字面判断是"工作做完了 = 不再需要这项工作 = cancel"，于是**只 cancel 不 close**，SubAgent 长期挂在 idle，`perParentSession: 3` 的名额（`subagents.ts:84`）在后续委派中被 `limit_exceeded` 吃掉；这时的提示"请等待现有执行结束"（`subagents.ts:512`）与实情（等的是一个不会自己结束的空闲 SubAgent）不符，模型会继续重发委派。

---

## SKILL.md 本身难以套用的地方

1. **第 1 步的"取真实调用的快照"只覆盖了六工具的一半身份。** 按 SKILL.md，同一定义装配给多种身份时每种身份各取一份快照。本材料实际能取到快照的只有 dev；main 与 subagent 的系统提示只能从 `system-prompts.ts` 源码取（工具描述与 dev 是同一份源码常量，可推定一致，但**未取快照**）。最吃紧的是 `subagent_message`：它被装配给 SubAgent 子会话（`subagent-tools.ts:67`），而该身份的完整工具列表（是否还有评审用只读 MCP，见 `subagents.ts:76`）无从确认。M1 这类"同一句必填规则对两种身份语义相反"的问题，恰好是快照规则想抓的，却因为缺 SubAgent 身份的快照而只能靠源码反推。
2. **被审文本的边界在本次审计中不可闭合。** 六工具的结果与错误文本有三个关键生成点在这份材料之外：`messageStateText`（`@ruukoto/agent/subagent-message.ts`，决定 `subagent_message` 与 `part=messages` 里"待投递/未送达/…"的全部措辞）、`subagentOpCheck`（`@ruukoto/agent/subagent-ledger.ts`，决定被冻结时的拒绝文本）、`WorkCopyError` 的 `code/message`（`./work-copy.ts`，`worktree_gone`、副本身份失效等直接改写成模型看到的错误）。SKILL.md 只说"取不到的标未覆盖"，但这三处正好是 J2/J3 最密集的地方（状态怎么退出、谁冻结、下一步是什么），标注未覆盖会漏掉规则要保护的区域。
3. **J5 的"两种地址不算管道"没有判据。** `subagent_result` 的 `part=result` 里 `直接父任务 t12`、`worktree` 的 `分支 wt/x`、`基线 abc123def456`（`subagent-tools.ts:319-321`、`::485`）属于哪一种，标准里只有举例（"它被要求核对的副本或页面"、"要转交给拥有者的"），没有可套的检验。这直接决定 R1 成立与否：我按"模型后续不引用、只用于内部关联"判定它们不该进结果，但同一个标准下也可以判成"要转交给拥有者的事实"。
4. **第 3 步的不成立条件对"多处重复同一句错话"没有说法。** D1 与 S1 是同一句省略（`补充原工作用 work_id`）在两处出现，按不成立条件的字面（"调用前必然读到的其他文本已写明正确做法"）它不成立——因为那些文本写的是**同样的错做法**。建议把该条件补成"已写明**正确**做法"，否则同源重复的错误文本会互相为对方免责。
