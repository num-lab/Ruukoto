Status: resolved

# 13 — 让同项工作的 SubAgent 相互通信

**What to build:** 同项工作中的多个 SubAgent 交换有来源的消息并协作，复用到新工作后旧协作者失去通信资格。

**Blocked by:** [12 — 继续委派、跨工作复用并显式关闭 SubAgent](12-subagent-reuse-close.md)

依据：[已确认规格](../spec.md) 与 [ADR 0017](../../../docs/adr/0017-two-agent-products.md)。

## 验收标准

- [x] 两个 SubAgent 可在同项工作内发送和接收消息，消息及来源可追溯，上级也能向其发送补充。
- [x] 跨主 Agent、用户会话、工作区或当前工作范围的消息被拒绝，消息本身不扩大权限。
- [x] 接收者被复用于新工作后，旧成员及迟到旧消息不能进入新的工作上下文。
- [x] 重复投递不重复形成同一条逻辑消息；关闭后的投递有明确结果，不把关闭视为重新创建 Agent 的理由。
- [x] 完成相关端到端检查、类型检查及仓库要求的验证；同步本次行为涉及的运行说明和图解，验证记录区分模拟结果与真实环境结果。

## Comments

### 2026-10-05：实施完成与验收证据

按 ADR 0020 补充段「工作内消息与协作加入」实施。方案（六项取舍，已入 ADR）：协作加入（`work_id` 与 `sub_agent_id` 同现把空闲 Agent 拉入既有只读工作，参与者经任务关联列记录，修改工作与宿主评审不接受加入）；发送方身份完全由发起任务核实；存储 `subagent_messages`（v29）按（工作, 发送方, 键）幂等，同键重放不受此后状态影响；资格 = `active_work_id` 正是本工作且未关闭（复用即失去旧资格，关闭不当成重建理由，工作取消明确拒绝）；投递不扩大权限（SubAgent = 本工作的 confirm 任务 `smsg:<消息ID>`、readScope 沿用其本工作最近钉定；主 Agent = dev `[工作内消息]` 参考块注入 / main 唤醒任务）；忙/名额满待投递，编排器终态、启动恢复、整项取消与显式关闭后冲刷，资格已失记明确未投递结果并发 `subagent_message.dropped`。

**验收证据（离线逻辑测试，模型为 MockModelServer 模拟）：**

1. **双向消息与来源、上级补充**：`test/86-subagent-messaging`「dev 双向协作与来源追溯」——协作加入登记独立执行任务（工作行保持首次承接者），A→B 经工具、B→A 经工具、主 Agent→A 补充均投递为本工作 confirm 任务；任务输入带宿主来源首行（发送方 SubAgent/主 Agent + 发起任务），消息行、sent 事件、from_task_id 可追溯；投递任务的模型调用仍只有 read/read_artifact/subagent_message（不扩大权限）。「main 通道」——SubAgent→主 Agent 按 `smsg:<消息ID>` 固定键登记唤醒任务（agentId=main、confirm、无截止时间），主 Agent 在唤醒轮次经工具补充并投递。
2. **范围拒绝**：「范围拒绝」——跨父会话、发送方不在本工作、接收方当前不在本工作、发起任务不存在、自发自收、正文超限（4096）、主 Agent 省略接收方、异参冲突；关闭后报错含「已关闭＋消息未投递」且不含「新建」（不把关闭当作重建理由）；已取消拒绝且全部拒绝零消息行。协作组合加入经 dedupWorkTask 与继续同一口径查重。
3. **复用后资格转移**：「复用后资格转移」——B 复用于新工作后，父级与旧协作方的 W 内消息均明确拒绝；W2 的模型上下文不含旧消息正文；迟到旧消息的冲刷判定记 moved_work、投递零发生（复合态在正常时序不可达——终态冲刷同一同步续段早于任何复用/关闭登记，测试按最终状态布置验证守卫）。
4. **幂等与关闭**：「幂等与账本」——同键同参（管理器与真实装配的工具层各级）返回原记录不新增消息行/任务/事件，异参冲突；冲刷重入不重复；`subagent_message` 账本按（工作, 发送方, 键）核实 committed/not_committed、发送方彼此独立。「关闭后的投递」——与 moved_work 同口径布置 pending→closed，冲刷记 `closed:<时刻>`、发 dropped 事件、同键重放仍返回原记录。
5. **注入通道**：「dev 注入通道」——SubAgent→主 Agent 的消息经下一次拥有者任务的宿主 `[工作内消息]` 参考块送达（来源标注、不是拥有者新指令），收集与标记送达同事务，不重复注入；已取消工作的消息记 work_canceled 不注入。「v28 → v29 迁移」——旧库补表为空、旧 sub_agents/工作保留、账本 not_committed。
6. **仓库要求的验证**：`npm run typecheck` 无错；`test/86` 8/8、计划列出的定向套件（86/80/81/82/83/27/39×2/45/44/59/62/64/66/13/14/29/34/36/16/21/68/19/75/85×2）全绿；`test/67-visual-docs` 4/4；`npm test` 全量 897 项：893 通过、1 跳过、3 失败；干净基线 d2f6f74（889 项，887 通过、1 跳过）= 897 − 8（本单新增测试全过）。三处失败逐项核实均为环境项、与本改动无关：DNS 批准固定在基线同样 60s 超时失败（本机无法快速解析不可达域名）；「档案路径」按仓库目录名取 slug，本 worktree 目录名 issue-13 与测试硬编码 ruukoto 前缀不符（干净 checkout 目录名为 ruukoto 时同代码通过）；「长正文冷重连」在基线通过、单跑 `test/14` 27/27 通过，仅全量负载下偶发（PTY 时序），与本改动涉及的模块无关。code-review 两轴：无硬性违规；messageStateText 文案重复、dedup 三胞胎两处意见已采纳合并，undeliveredReason 字符串与 review-time 装配维持现状（判断级，理由见 ADR 与本记录）。visual-docs 同步另见下图解记录。

**真实环境（模型/平台仍为模拟，模型为 MockModelServer）：** `.scratch/agent-direction/smoke-13-subagent-messaging.mts` 在真实 Runtime + 控制面 + SQLite + 独立 JSONL + Docker 受限 worker + 真实 CLI（`work show`）上运行，本机 macOS 与 `ssh tx` Linux 各一轮 **6/6 PASS**：协作加入独立执行记录；A↔B 双向消息经工具在受限 worker 任务内收发、来源可追溯；主 Agent 补充投递与 SubAgent→主 Agent dev 注入；同键重放与冲刷重入零新增（无残余容器）；复用与关闭后的明确拒绝；真实 CLI 读 messages 列表；重启后消息记录保留、冲刷不重放。

**同步**：`CONTEXT.md`（SubAgent、工作委托条目）、`docs/runtime.md`（导言五个工具 + 新节「工作内消息与协作加入（issue 13）」）、ADR 0020 补充段、ADR 0017 实施记录、控制协议 v14 → v15、核心库 v28 → v29、legacy-import 的 TABLE_POLICY 折叠登记。图解（visual-docs 流程）：`docs/visual/` orchestrator（lede/三层记录/幂等与拒绝面/新节协作加入与工作内消息+时序图/首版限制）、control-protocol（work_get messages、两类新事件、v15 行）、storage-layout（subagent_messages 表与索引、v29 行、legacy-import 折叠）、context-pipeline（视图分层与估算分类 + [工作内消息] 块）、tool-call-path（subagent 装配与账本行），shoot.sh 逐张核对（5 页 73 片无重叠/截断），test/67 4/4；子代理草稿经人工按代码修正三处（joinInput 虚指改为 taskInput 说明行、竞争仲裁口径、worker_get 笔误），期间未发现文档与代码的新不一致。

**已知取舍/边界**：协作加入只限既有空闲 Agent（没有「一步新建协作者」入口，需要另立）；legacy-import 的消息随所属工作账本条目折叠（不设新账本类别）；宿主评审消息豁免在管理器断言层覆盖（未构造评审场景）；发给 SubAgent 的投递任务用后台默认模型（与委派同口径）。**未实测**：真实 QQ/Telegram 平台（模型与消息平台均为模拟）。
