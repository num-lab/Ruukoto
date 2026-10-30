# 39 当前候选晚改动与两 OS 制品独立终审（2026-10-19）

Status: completed

> 本文部分原始证据已移出 Git；原路径保留用于查找原件，见[归档说明](../../../../git-history-cleanup/archive.md)。

## 对象与快照

本次独立审查对象为 HEAD `b1e975437f4cd3ca8084a8b07e451f19ba80ba17` 之上的未提交候选工作区；`git status --porcelain` 为 64 个已跟踪改动加 4 个未跟踪路径（其中本证据目录为未跟踪），`git diff --stat HEAD` 合计 64 files / 914 insertions / 160 deletions，HEAD 在审查期间未变。审查范围限于工单指定的 6 份晚改动、其调用方、测试与文档一致性，以及 macOS/Linux 制品记录与已存档测试日志；不重审 A1–A12 全矩阵、其余候选改动文件及真实模型/IM 场景。

`source-manifest.json` 记录 649 个运行、测试、构建与基础验证文件，文件自身 sha256 为 `b2fa5776314c602ac89ab719d454e912a2e7edccd5edb582cac1e77f3998752d`；我按清单逐文件重算 sha256，当前工作区 649/649 全部一致，无缺失、无差异。68 个脏路径中 52 个（含两个未跟踪测试）在清单内且内容一致；未入清单的 16 个均为 `docs/`、`.agents/notes/` 与 `.scratch/` 文档，不是制品构建输入。

时间线需要区分两个清单：`source-delta.json` 记录的是 11:27（JST）v3 差异，其中 personal-work.ts 与 test/personal-service-operations.test.ts 的 “current” 哈希为 `98ac0e00…`、`0560c854…`；两文件随后分别在 11:55、12:03 再改（加入未知 callId 扫描核验与两条新用例），最终内容为 `a076508a…`、`2e928bf2…`，由 20:04 抓取的 source-manifest 覆盖。因此任务说明中“后两者在 source-manifest 后又改过一次”若指当前 handoff 清单不成立，若指 v3 清单则成立；现行工作区与 handoff 清单完全一致，`service-facts-v3-delta.patch` 只是 11:27 时点五文件的差异，不含最后两次改动与测试文件。

## 结论

范围内无阻断项：晚改动要解决的三个问题在代码中均真实成立，调用方、测试与文档一致，未发现可复现反例或违反已确认要求；macOS 与 Linux 制品记录都绑定同一源码清单 `b2fa…`，其包、成员与 worker 哈希和现存制品逐字节相符。有两处记录必须修正（Linux 全文件日志早于测试文件终态、source-delta 时效表述），但均不影响已核对代码内容，属证据表述与补证问题，非阻断。

逐项状态：服务事实投影（取消未消费）通过；未知 callId 伪造结果在 provider 前拒绝通过；报告登记与生成/发送分离通过；macOS 制品绑定通过；Linux 制品绑定通过但记录仅在远端 `/tmp`；测试日志与冻结测试文件的一致性部分通过；静态门禁的文档部分由我复跑通过，lint/typecheck 仅读存档日志。

## 逐项依据

### 服务事实投影（取消未消费操作）

`apps/ruukoto/src/personal-service-operations.ts:108-121` 定义 `unresolved` 与共用投影 `personalServiceResult`，输出原 effect/code、mode、approval、consumed、launcherStopped、verifiedEffect、requiresVerification 与中文 verification；该投影被 `apps/ruukoto/src/personal-service-work.ts:34`（工具返回）与 `:58`（证据读取）、`apps/ruukoto/src/personal-work.ts:399-403`（按 work 汇总）共同使用，`:457-459` 将 services 写入工作结果与 notice，`:467-468` 完成态结果携带 services，`:479-481` 摘要携带 services，覆盖“工具返回、证据读取、工作结果和摘要”四处。

`apps/ruukoto/src/personal-harness.ts:447` 在一次提交内取 `personalServiceTranscriptFacts(...)`，`:455` 仅在非空时把 `personal-service-facts` 追加到系统 section，文本明确“优先于旧工具中断文本和子回答；历史批准不授权本轮新操作”；该 section 随实际请求 input 持久留证，测试同时断言 actual input 与 payload 均含该文本。

模型可见说明与文档一致：`apps/ruukoto/src/personal-work-tools.ts:34` 的工具描述包含 `commands/services 是宿主当前原命令/服务事实…不能把历史 effect_unknown 或工具中断文本自行当作仍未知`，`:43` 的 offset 说明区分文本位置与条目位置；`docs/modules/personal-durable.md:33`、`:147` 与 `.agents/notes/implemented/architecture/2026-10-17-personal-subagent-service-operations.md:19`、`:21` 同步描述投影来源、只补当前输入内可核实结果、不继承批准。

实测：`npx tsx --test test/personal-service-operations.test.ts test/personal-work-tools.test.ts test/personal-reports.test.ts` 得 tests 135 / pass 135 / fail 0（20.4s），其中 `test/personal-service-operations.test.ts:597-628` 断言取消未消费操作在复用身份的每次实际请求与 payload 中为 not_executed、consumed=false、requiresVerification=false，notice 含“已知未执行”，摘要 services 与结果相同，且原工具 entry 保持不变。我在本机 Node 24.15.0 上亲自运行，非引用作者日志。

### 未知 callId 的伪造结果

`apps/ruukoto/src/personal-work.ts:406-449` 是修复主体：先按本身份与 `op.work.ref.agentId` 遍历服务操作，沿原 `pi.tool` 任务终态、结果 entry 的 kind/conversationId/byTaskId 及其 model 中同 callId 的 toolResult 逐对象核实（`:413-419`）；对仍未匹配的 service_restart 结果再扫描本身份终态 `pi.tool` 任务，沿结果 entry 与 assistant 原 toolCall 核实（`:429-448`）；最后 `:447` 要求输入中每个 service_restart toolResult 都已匹配，否则抛 `service_model_reference_invalid`，在 provider 前停止。成对移出上下文的历史不注入事实；接纳前参数拒绝可进入模型但不注入操作事实；未知或歧义 callId 不进 HTTP。

实测：同一 135 条运行包含 `test/personal-service-operations.test.ts` 的 919-938（原结果被替换）、941-967（上下文移出原调用后重复 callId）、970-989（重复工具调用歧义）、991-1013（未知 callId 伪造）、1015-1037（接纳前参数错误正例）、1040-1055（仅移出旧 result 产生 missing_result）全部通过。`service-reference-red.log` 保留修复前该用例失败（`assert.notEqual` 实际 completed），我只读了该红日志，未自行回退源码复现红态；本结论的红态证据来自存档日志与代码对照。

残余边界（非阻断，未单测）：若同一 callId 的 toolResult 被替换且 assistant 原消息同时不在输入中，`:419-425` 会先按成对移出跳过该 op，但这条被替换消息仍留在 unmatched 集合，最终由 `:447` 兜底拒绝；这条推演未另设组合用例。`personalServiceTranscriptFacts` 对根会话、已关闭或无占用身份早退返回空，这些身份不会发出新的模型请求，属防御性跳过。

### 报告登记与生成/发送

`apps/ruukoto/src/personal-report.ts:197-213` 现在只做 `requirePersonalDelegationInput` 加 `requirePersonalDelegationActive`（`apps/ruukoto/src/personal-delegation.ts:68-77`：仅核实原输入、原入口活性与未取消）后创建报告 Task；生成前的 `requireReportReady`（`personal-report.ts:55-58`）仍要求 membersStopped 与 `requirePersonalDelegationReady`（含 sourcesReady），发送门禁未放宽。`personalReportResult`（`:241-253`）增加 offset/totalChars，与工作文本页一致。

实测：`test/personal-command-work.test.ts:402` 的 running/unknown/restored 三阶段封组登记用例在本次 124/124 运行中通过（工作、委托、调度、配置控制、命令工作五文件），reports/work-tools/service 的登记与发送用例在 135/135 中通过；两条运行均 exit code 0。说明登记不等待成员停止，等待与汇总仍在原报告 Task 内。

### macOS 制品

`macos-artifacts.json` 记录 sourceManifestSha256=`b2fa…`、buildExit=0、node=24.15.0、platform=macOS arm64；ruukoto 包 sha256 `59ce90b8…`、270239 字节、75 成员；ruukoto-code 包 `92255af7…`、23057 字节、6 成员；workers 五项哈希。我实测 `dist/ruukoto-0.1.0.tgz` 的 sha256 与字节数、`dist/ruukoto-code-0.1.0.tgz` 的 sha256 与字节数均与记录一致；解包后两个包的 75/6 个成员逐个 sha256 一致；`worker/` 五文件哈希一致；81 个包成员哈希同时与当前源码文件一致（0 差异），说明记录、现存制品与冻结源码三者相符。`build-final.log` 显示 npm pack 输出 75/6 成员、时间 20:01，制品记录 20:04，清单内源码文件 mtime 最晚为 12:03:07（JST），因此构建输入就是冻结源码。

### Linux 制品

远端 `oracle-4c24g:/tmp/ruukoto39-handoff-linux-artifacts.json`（11:16 UTC）记录 sourceManifestSha256=`b2fa…`、sourceCount=649、sourceMatched=649、mismatches=[]、platform=Linux arm64、node=24.15.0、buildExit=0；两个包的 sha256/字节/成员数与 macOS 记录相同（平台无关的 npm 产物），workers 四项与 macOS 同哈希且不含 macOS 专用 native supervisor，与 `scripts/build-native.mjs` 只在 darwin 编译一致。我实测远端 `~/.local/ruukoto39/handoff-checks-XDuxYn/dist/*.tgz` 的 sha256 与记录一致；该目录 test/personal-service-operations.test.ts=`2e928bf2…`、apps/ruukoto/src/personal-work.ts=`a076508a…`、personal-harness.ts=`cbdf8f96…`、personal-service-operations.ts=`e47b801c…` 与冻结清单相符；远端 `/tmp/ruukoto39-handoff-source-manifest.json` 的 sha256 也是 `b2fa…`，与本地清单字节相同。

限制（非阻断）：Linux 制品记录只在远端 `/tmp`，仓库证据目录没有副本，tmp 清理或主机重置后无法复查；这些记录证明构建与源码/包字节绑定，不证明 Linux 上实际安装运行或可复现重建，我也没有在 Linux 重跑构建。

### 测试日志与证据自洽

已读并存档：`service-reference-red.log`（修复前 1 失败）、`service-reference-green.log`（5 通过）、`service-boundary-6-final.log`（6 通过）、`service-caller-tests.log`（164 通过）、`service-caller-final.log`（168 通过）、`service-projections-tests.log`（87 通过）、`linux-node24.log`（133 通过）、`linux-node22.log`（6 通过）。

我在冻结源码上复跑：service/work-tools/reports 三文件 135/135；delegations/scheduler/work-controls/scheduler-integration 四文件 87/87；另含 work/configuration-controls/command-work 的五文件组合 124/124。三条运行均 exit code 0，对应日志中的同类用例逐一出现并通过。

需修正之处：`linux-node24.log` 与 `linux-service24.log` 字节相同（sha256 `dc2f2c7c…`），`linux-node22.log` 与 `linux-service22.log` 相同（`987d3f6c…`），四份 static 日志也完全相同（`ad69e7d0…`），不同文件名不构成独立运行证据；`linux-node24.log` 只有 133 条，比当前三文件实际 135 条少“接纳前参数错误…”与“独立补充…”两条，即 Linux Node24 运行早于 12:03 的测试文件终态；handoff README 第 21 行只说“最后仅新增参数拒绝测试”，与实际两条不符，且“独立补充”在全部存档日志中都没有运行记录（本次独立审查在 macOS 上首次补跑通过）；87 条日志（11:43）早于 personal-work.ts 终态（11:55），168 条日志（12:02）早于测试文件终态（12:03），当前同四文件集合应为 170 条（135+35，其中 35 为 command-work），我分两次运行覆盖全部用例，截至审查没有一份存档日志在终态文件上一次跑过 170 条。

### QQ 当前事实

`qq-control-actual.json`（11:02 UTC，作者只读 GET）记录 work807 aborted/cancelRequested=true/stopVerified=true、work870 completed/totalChars=576、report792 delivery=sent/state=completed/totalChars=878、service824“已知未执行（source_inactive）”、serviceCount=3、tasks=0、inputs=0、pendingInspections=[]；我逐字段复核与 handoff README 第 11 行数字一致。该记录同时显示 qq.online=false、rejected=306，只能作为原委托事实读取，不能作为当前平台在线证据；我未重新查询 QQ 或接触生产/IM。

## 未覆盖项与待验项

未实跑：`npm run check:static` 的 lint/typecheck（只读存档日志，文档、笔记、链接与 md-wrap 由我复跑通过）；全量 `npm run check`（按指令不跑）；Linux 测试（只读 ssh 文件核对）；macOS 四文件 170 条合并运行（分两次覆盖）；修复前红态回退复现（只读红日志）。

未复核：A1–A12 其余范围、其余 58 个已跟踪改动文件（含文档）与未跟踪测试、NapCat/Linux/Docker、真实模型与 QQ/TG、A12 演练与发布接管步骤；这些沿用既有证据，不在本次结论内。

未验证：构建可复现性（未从源码重建比对）；`native-macos-supervisor` 与 worker 的实际执行；真实模型对 `personal-service-facts` 的遵从度；真实 compaction 路径（测试用通用 ContextEdit 合成）；Linux 上的实际安装运行。

以上“通过”仅覆盖我亲手运行或逐字节核对的项；作者日志中的其余主张按未覆盖处理，不据此记为通过。

## 非阻断建议

把 Linux 制品记录从 `/tmp` 归档进本证据目录，或在本记录写明可从 ssh 复查的具体路径与命令，避免记录随 tmp 清空而消失。

修正 handoff README 第 21 行：终态前新增的是两条用例（参数拒绝正例与仅移出旧 result），Linux Node24 的 133 条运行不含这两条；为“独立补充”补一次至少单 OS 的存档运行（本次审查已在 macOS 补跑通过，可作为跨身份复核，但作者侧仍宜留档）。

为 11:55/12:03 的终态改动补一份差异记录，或更新 source-delta 的说明使其明确只到 11:27，避免读者把 `service-facts-v3-delta.patch` 当作完整晚改动（该补丁只有五文件且不含测试）。

合并或标注重复日志命名（node24/服务24、node22/服务22、四份 static 内容相同），避免把副本当独立运行证据。

可选：为“结果被替换且 assistant 同时移出”的组合补一条最窄用例，明确 `personal-work.ts:447` 的兜底拒绝语义；当前该路径只由代码推演，未单测。
