# gen-r2 原文

审查者最终回复原样抽自其执行上下文的会话转录；只去掉了行尾空白，正文未改。

# SubAgent 工具族模型可见文本审计报告

**审计对象**：`snapshot-tools.json`，即 ruukoto-code 开发会话、完全访问、首轮调用时模型看到的六个工具定义；以及 `subagent-tools.ts` 产生的结果与错误文本。

**审计范围**：只读了 `/tmp/aft/gen/` 下的三个文件，没有修改任何文件。

**材料缺口**：SKILL.md 第 1、3 步要求的以下材料都没有，因此 SKILL 第 3 步的排除条件（「调用前必然读到的其他文本已写明正确做法的不成立」）只能按「快照与源码都没有写」来判断：

- 系统提示与完整工具列表。
- 同一会话事件流里的真实结果与通知文本，包括完成通知是否带产物 id。
- 其他身份的快照：main 会话、SubAgent 子会话（只装配 `subagent_message`）、回报唤醒轮次。
- `deps.delegate`、`close`、`cancelWork`、`message`、`integrate` 在 runtime 层抛出的错误文本。
- `messageStateText` 与 `resultNotice` 的输出。

下文凡依赖这些材料的地方都已注明。

---

## subagent_delegate

**D1：开发会话做分析时 `read_paths` 实际必填，描述里没写**
- 位置：快照 `subagent_delegate.parameters.required` 只有 `["request","key"]`。描述只写了「开发会话用 read_paths 指定资料路径」，`read_paths` 参数描述写的是「最多 16 个」，都没说必填。拒绝发生在源码 L278–279：`if (mode === "analyze" && readPaths === null && materials === null) throw new Error("必须指定分析对象：开发会话用 read_paths，main 会话用 materials")`。
- 规则：J1。
- 误调：模型以为 SubAgent 能自行读取整个工作区，会调用 `subagent_delegate({request:"分析 packages/agent 的审批流程", key:"a1"})` 并被拒。用 `work_id` 补充原工作时也是同样情况，`subagent_delegate({work_id:"w1", request:"再看一下错误路径", key:"a2"})` 照样被拒。描述只在 sub_agent_id 复用一处写了「读范围与资料按本次重新确定」，没写续委派也必须重新给 `read_paths`。

**D2：按描述继续修改工作，必然被拒，错误文本还把模型引向错误方向**
- 位置：描述写「补充原工作用 work_id（修改继续沿用首次钉定的写入目标）」，`mode` 描述写「仅首次委派可指定」。源码 L249 `const mode = params.mode ?? "analyze"`，L278 的检查在 `deps.delegate` 之前执行。
- 规则：J1、J2。
- 误调：模型照描述只传 work_id，调用 `subagent_delegate({work_id:"w_mod", request:"把剩下两处也改掉", key:"m2"})`。此时 mode 被当成 analyze，L279 抛出「必须指定分析对象：开发会话用 read_paths……」。模型照这条提示补上 `read_paths:["packages/x"]` 再调一次，L261 并没有拦，因为 mode 已不是 modify。结果是在一项修改工作里追加了一次被当作分析的执行，或者在 runtime 层被拒，具体文本不在材料里。描述承诺的路径，在工具层根本走不通。

**D3：modify 与 read_paths／materials 互斥，描述里没写**
- 位置：源码 L261–263 `"mode=modify 时不指定 read_paths 或 materials（写入目标包含自己的资料路径）"`。快照里 `mode`、`target`、`read_paths` 三个参数的描述以及工具描述都没有提这个互斥。
- 规则：J1。
- 误调：模型想让 SubAgent 修改时参考设计文档，会调用 `subagent_delegate({mode:"modify", target:"packages/agent", read_paths:["docs/architecture.md"], request:"…", key:"m1"})`，被拒一次。

**D4：非 Git 直接写入的委派，返回结果自相矛盾，模型会空等或轮询**
- 位置：源码 L319 给出 `"直接写入 ${wt.path}（与父会话按目录占用串行）。"`，紧接着 L327 无条件追加「子任务已在后台执行；完成后宿主会通知」。真实状态见 L416：子任务排队，要等父任务结束才推进，「等待本会话释放目录，请结束本轮」。这句只出现在 `subagent_result` 里，委派描述只写了「与父会话串行」。
- 规则：J3、J7、J2。描述没写「父会话本轮不结束，子任务就不会开始」这个进入条件和退出方式；结果中「已在后台执行」与事实不符。
- 误调：模型在同一轮里反复调用 `subagent_result({work_id:"w_dir"})` 等完成通知，或者继续在同一目录做别的工作并等待结果。只有碰巧读到 L416 那一句后，才知道应该结束本轮。

**D5：不允许委派的任务，被拒后的文本既用了未定义术语，也没有下一步**
- 位置：源码 L239 `"只有拥有者任务、独立调度运行或宿主保存来源授权的工作唤醒可以委派 SubAgent"`。快照描述里没有说明哪些任务（例如回报唤醒轮次）不能委派。按文件头 L8–10 注释，close／cancel／integrate 在回报唤醒轮次也可用，delegate 则不行。
- 规则：J1（前提没写在使用点）、J2（「宿主保存来源授权的工作唤醒」「独立调度运行」在描述中从未定义，也没写明「停下来报告拥有者」或其他可执行的动作）。
- 误调：收到子任务完成的唤醒后，模型想续派，调用 `subagent_delegate({work_id:"w1", request:"继续…", key:"k3"})` 被拒。由于看不懂拒绝条件，它会换 key 或改用 `sub_agent_id` 重试，每次都会再被拒一遍。

---

## subagent_result

**R1：描述承诺的「产物列表」在结果里不存在，part=artifact 实际无法使用**
- 位置：快照描述写「part=artifact 按字节分页读该任务的产物（artifact_id 见结果中的产物列表）」。源码 L399–406 的 part=result 只输出工作行、任务行和 `摘要：${t.resultSummary}`；总览分支 L374–376 也没有产物。整个文件里没有任何位置把 artifact id 列给模型。
- 规则：J5（描述承诺的事实，结果里要真的有）。
- 误调：模型调用 `subagent_result({work_id:"w1", part:"artifact"})`，或者猜一个 id，调用 `subagent_result({work_id:"w1", part:"artifact", artifact_id:"report"})`，都会在 L454 得到「产物不存在或不属于该任务的执行」，而且没有恢复路径。如果产物不属于缺省选中的那个任务（L442 取的是「最近一次带摘要的任务」），即使 id 正确也会失败，错误文本没有提示要补 `task_id`。完成通知是否带产物 id，材料里没有。

**R2：artifact 分页的取值约束没写在参数上**
- 位置：快照里 `artifact_id`、`offset`、`length` 三个参数都没有 description。工具描述只给了 reply 的 length 范围（256–16384）。artifact 的实际约束在源码 L456–458：length 为 4–65536，offset 不能超过 byteCount，并且要对齐 UTF-8 字符边界（L465）。
- 规则：J1。
- 误调：模型套用 reply 的规则，或者为了一次读完而调用 `subagent_result({work_id:"w1", part:"artifact", artifact_id:"…", length:100000})`，在 L335 被拒（`length 必须是 0–65536 的整数`）。

**R3：part=result 每行混入了不需要的任务标识，容易被误当成 task_id**
- 位置：源码 L399 `发起任务 ${work.originTaskId}`，L402 `直接父任务 ${t.parentTaskId ?? "?"}`。同一行里还有子任务 id，`closedBy`／`canceledBy` 则以 `agent:<任务ID>` 的形式出现（L340、L397）。
- 规则：J5（每个实体只留模型后续要引用的那一个标识）。
- 误调：同一行有三四个「任务 id」，模型可能拿父任务 id 去读回答，调用 `subagent_result({work_id:"w1", part:"reply", task_id:"<直接父任务 id>"})`，在 L443 得到「任务不属于工作…」。

---

## subagent_close

**C1：有活动任务时被拒，描述给的下一步是「由拥有者取消」，可模型自己就有取消工具**
- 位置：快照描述「有活动任务时拒绝（等任务结束或由拥有者取消）」。
- 规则：J2、J4（禁令配的下一步应当是模型可以执行的动作。模型手里就有 `subagent_cancel`，描述却把这一步说成只能由拥有者做）。
- 误调：模型想停掉一个还在运行的 SubAgent，`subagent_close` 被拒后，会停下来请拥有者取消，或者干等任务结束；而它本可以直接调用 `subagent_cancel({work_id})`，再调用 `subagent_close({sub_agent_id})`。runtime 的拒绝文本是否给出了取消路径，材料里没有。按 L23 注释，拒绝文本只「给出任务 id」，而 `subagent_cancel` 不接受任务 id。

---

## subagent_cancel

**X1：取消是异步完成的，返回「仍在停止中」后，什么时候能关闭或复用，没有交代**
- 位置：源码 L521 `${running} 个任务仍在停止中`。快照描述写「取消停止它的活动与排队任务……空闲未关闭的 SubAgent 可复用于其他工作」，没说停止是异步的，也没说停止完成后会不会通知。
- 规则：J7。
- 误调：模型紧接着调用 `subagent_close({sub_agent_id:"s1"})`，因为还有活动任务而被拒；或者调用 `subagent_delegate({sub_agent_id:"s1", …})` 复用，因为 SubAgent 还不空闲而被拒。之后它只能反复调用 `subagent_result()` 轮询状态。

---

## subagent_message

**M1：一份定义同时写给主 Agent 和 SubAgent，主 Agent 拿到的默认值恰好对它无效**
- 位置：快照描述「省略 to_sub_agent_id 发给主 Agent……主 Agent 发送时必填」，以及参数 `to_sub_agent_id` 的描述「省略 = 发给主 Agent；发送方为主 Agent 时必填」。源码 L119 用同一个 `createSubAgentMessageTool` 同时装配给父会话（L530）和 SubAgent 子会话（L69）。
- 规则：J8。参数约束按身份分叉了，但这份快照只会装配给主 Agent，可以按身份分别装配描述；schema 里该参数又是 optional。
- 误调：主 Agent 想回复协作方，调用 `subagent_message({work_id:"w1", key:"r1", text:"…"})` 而不填接收方，被 runtime 拒绝（拒绝文本不在材料里），之后还得调 `subagent_result()` 查 SubAgent id 再重发。

---

## subagent_integrate

**I1：冲突和「重新核对」的提示，要求模型操作一份它找不到的副本**
- 位置：快照描述「拒绝并点名冲突文件，双方成果都保留供处理」。源码 L566 是「如需重新核对，可比较副本与当前工作区；副本原样保留」，L573 是「冲突或验证失败都能找回」。整个工具族的结果里，只有委派时 L317 给过 `基于提交 …（分支 …）`，并且明确说「子任务不能提交，改动留在工作树」。也就是说分支上没有提交，副本的工作树路径从未告诉过模型。
- 规则：J2（不要求模型做它无法用任何工具完成的事）。
- 误调：遇到冲突或需要核对时，模型会执行 `git diff <base>..<branch>`，结果为空，因为改动没有提交；或者执行 `git worktree list`、`git log <branch>` 去找副本，多出好几次调用，仍然拿不到改动。正确做法应该二选一：给出副本路径，或者明写「冲突时停下来，把冲突文件报告给拥有者」。冲突时的 runtime 拒绝文本不在材料里。

---

## 未能核实，没有列为发现

- integrate 能否在子任务还没结束时调用：描述和工具层都没写，runtime 的行为不在材料里。
- `mode` 描述中「计划模式与 SubAgent 自身不能发起」是否属于 J8 所说的冗余装配条件：SubAgent 子会话确实不装配 delegate（L67）。但计划模式是否装配 delegate 不详，也写不出具体误调，因此不报。

---

## SKILL.md 本身难以套用的地方

1. **排除条件依赖系统提示，但规则没说缺材料时怎么判。** 第 3 步把「系统提示已写明正确做法」作为排除条件，在只拿到工具快照时无法判断。上面每条发现都隐含「前提是系统提示没写」，SKILL 没给缺材料时的处理口径。
2. **J5 和 J2 互相拉扯。** J5 把「内部路径」划为管道，豁免只覆盖「转交给拥有者的地址」；J2 又要求结果里的下一步可执行。I1 里的副本路径正卡在中间：它是模型自己要用的地址，但不是交给拥有者的。SKILL 没说这种情况该给路径，还是该删掉指引。
3. **「必须写出具体误调」与 J8 的部分动机冲突。** J8 的理由之一是「模型会花推理判断一个已成立的条件」，这是推理成本，不是一次调用。纯描述噪音（如 integrate 的「宿主经工具工作进程」、delegate 的「dev 与 main 均可发起」）按第 3 步一律不成立，J8 的这一半实际上无法落地。
4. **J6 只管截断提示。** 结果中无条件追加的固定句（L327「子任务已在后台执行…」、L573「请接着用自己的检查验证…」）有同样的噪音问题，D4 中还和事实冲突，但没有一条规则直接覆盖，只能借 J2 去套。
5. **J8 的「让模型能确认自己的身份」没说怎么做。** 没有给出判断标准：系统提示里写一句，还是工具描述自带身份？审计时也无法从单份工具快照确认身份是否可知。
6. **大部分拒绝文本不在被审文件里。** SKILL 说「没触发过的路径从源码取」，但这一族的大部分拒绝文本在 runtime 的 `deps.*` 里，跨多个包。SKILL 没说审计边界划到哪一层。
