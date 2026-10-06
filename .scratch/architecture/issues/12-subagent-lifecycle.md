Status: resolved

# SubAgent 生命周期：状态转换与资格判定收进 SubAgent manager

## 目标

SubAgent manager 是 `sub_agents.state` 的唯一写入者，负责「执行终态 → idle/unverified 并冲刷」「启动恢复」「unverified → idle」；继续、复用、加入、收消息共用一个带原因的资格判定；计划模式规则搬进 manager（「只有一层」已归工单 08 决定 9）。来源：2026-10-05 架构审查的候选 05。

## 背景

2026-10-05 核对（develop d109dbe）：

- `sub_agents.state` 有 4 个写入点分布 3 个文件：`subagents.ts:578`、`:901`，`orchestrator.ts:572`，`runtime.ts:3114`；读者不信它，另查 `findActiveSubAgentTask`（`subagents.ts:852`、`:875`、`:1198`，`runtime.ts:3113`）。
- 守卫重复：宿主评审来源 `hasInboundSourcedSubAgentTask` ×4（345、739、775、1194）；已关闭 ×4（616、772、844、1189）；已取消 ×4（323/443、754、828）。
- 重启恢复拆三处：`runtime.ts:1356–1380`（排队委派任务定 interrupted）、`orchestrator.ts:161–176`（冲刷与恢复暂停的队列）、巡检 → `handleSubAgentTerminal` → idle/unverified。
- 「SubAgent 不能委派下级」只在 modify 分支检查（`subagents.ts:281`）；SubAgent 会话 `kind: "dev"`（:523），analyze 委派只靠工具层挡（`subagent-tools.ts:193` 的 `ownerOriginated`、`subagent` 类别为空）。
- `planMode` 参数（`subagents.ts:137`、:288）没有调用方传入，真实检查在工具里；mode/work_id 检查在工具（`subagent-tools.ts:~246–250`）与 manager（:289–296）各一份。
- 消息路径绕过模型门闩（工单 09 决定 5 移交）：`deliverAsTask` 与 `deliverAsParentWake`（`subagents.ts` 881、903）直接 `insertQueuedTask`，不经 `resolveSelection` 的门闩与执行入口检查；模型配置应用期间可能插入引用正被删除 provider 的任务，运行时失败、消息实际未送达。委派（`delegate`，:366）与 `submit` 都有门闩。两处一并处理。
- 「取消工作 + 消息待投递 + 重启」现在约需 60 行准备：startKit、两次真实委派加一次 join、SQL 写入消息与 `canceled_at`（`cancelWork` 会立即冲刷，崩溃窗口无法自然到达）、停止再 `Runtime.start`、`waitFor`。

## 待访谈

- 与候选 09 共享消息冲刷、与候选 08 共享「是不是 SubAgent」：先做 08/09，再评估本单剩余部分。
- 08 落地后：`delegate()` 的父会话判定已按会话身份收成一条（两种 mode），本单不再处理「只有一层」。
- 资格判定的原因集合与现有错误码（`invalid_state` / `forbidden`）的对应。

## 相关 ADR

- ADR 0020 issue 12/14/15 补充段：只收拢，不矛盾。

## Comments

### 2026-10-06：当前事实与第一轮设计决定

核对基线为 develop `33571b4`（第四条已通过 PR #14 合入）。第一轮 Q1–Q4 和接口方向已由拥有者确认全部按推荐。

- `SubAgentManager` 拥有 SubAgent 的状态转换、资格判定和恢复后的待核实出口。`Store` 保留 SQL 原语；编排器保留结果、事件与入站终态登记；Runtime 保留通用队列和占用处理。结果、状态与结果事件仍在同一事务内登记。
- 消息登记和待投递冲刷需要异步预检与事务内重核，SQLite 事务内不得等待异步操作。现有直接投递到子会话和 main 唤醒的两条路径都补齐模型配置门闩与执行入口检查。
- 计划模式由管理器依据父任务及 `resumesTaskId` 链自行计算，删除调用方传入的 `planMode` 参数；工具层继续负责参数形状校验。
- 同步运行文档和相关图解页，并通过管理器接口验证状态转换、资格拒绝和消息门闩；现有集成测试作为回归。

当前状态写入仍有四处：管理器的委派和消息投递（`subagents.ts:576,892`）、编排器的终态结果登记（`orchestrator.ts:562`）、Runtime 的恢复队列（`runtime.ts:2946`）。新建 Agent 的初始状态也由管理器写入。离线实例导入的行复制不纳入在线生命周期写入规则。

消息门闩缺口已通过临时真实 Store 探针确认：给管理器注入必定报 `model_config_busy` 的模型预检和必定报执行入口错误的 launcher，发给 SubAgent 的消息仍创建投递任务，发给 main 的消息仍创建唤醒，两个预检均未调用。探针只验证入队绕过预检，没有模拟真实 provider 删除，也不声称消息内容已送达模型。脚本保存在系统临时目录 `ruukoto-lifecycle-probe-v9llvqjr/probe.mts`。

计划模式探针确认：直接调用 manager，对 `/plan` 父任务发起 `mode=modify`，不传 `planMode` 时会到达执行入口预检。正常计划模式的工具可用性会拒绝 `subagent_delegate`（`PLAN_TOOL_NAMES` 不包含它），因此这是管理器入口的校验缺口，不能描述为模型可以突破计划模式；本单不扩大计划模式工具清单。

独立只读复核确认：

- `resumeQueue` 在释放占用、把 Agent 从 unverified 记回 idle 后，未冲刷待投递消息；没有其他触发时消息持续等待，是可达的恢复缺口。
- 旧任务首次补记会无条件覆盖 Agent 当前工作与任务指针。但正常终态监听在父级异步送达之前同步完成登记，尚未找到正常入口制造“旧结果缺失、Agent 已承接新工作”的路径。这项作为历史恢复的条件性风险处理，验收必须区分播种防护与生产复现。
- 终态结果登记失败后 Agent 可能仍为 running；恢复入口不能返回成功却让 Agent 永久忙碌。结果与空闲仍须同事务，不能跳过缺失结果直接宣称空闲。

### 2026-10-06：第二轮设计决定与实施验收

Q5–Q7 已由拥有者确认全部按推荐：

- 模型配置忙时新消息明确失败且零新增记录；既有待投递消息保留，并在配置应用结束（成功或回滚）后补投。重复键在预检之前返回原记录，不因配置忙而破坏对账。
- 异步准备后在登记事务内重核取消、关闭、当前工作与活动执行；旧结果可以补记历史，但不覆盖新执行的状态与指针。
- 计划模式检查既有工作的实际 `writeTarget`，不只检查显式 `mode=modify`；工具可见性沿用现有规则。

管理器的三个同步入口分别位于已有事务中：`resultRecorded(task)` 只核实当前任务并转换状态；`recoverQueuedTasks()` 收拢排队子执行的重启分类；`executionVerified(sessionId)` 接收拥有者核实后的状态转换。结果正文与结果事件继续由编排器登记。若当前终态执行的结果还未登记，恢复明确报 invalid_state，不能跳过结果直接宣称空闲。`start()` 与 `flushPendingMessages()` 在事务外做异步准备，在同步事务内重核并写入，提交后唤醒。

验收覆盖消息两个入队方向的模型和执行入口预检、等待期间资格变化、事务内门闩重检、既有消息补投与幂等、旧结果不倒写当前指针、恢复后补投、结果缺失拒绝恢复、计划模式真实任务与继续链、重启分类和既有集成回归。源码变更后按 visual-docs 同步相关图解页；最终运行 typecheck、完整测试及相应变异验证，记录既有失败及新失败。实现与验证后本地提交，不推送。

实施分支为 `subagent-lifecycle`，工作区位于 `/Users/eitrous/mirasim-worktrees/ruukoto/subagent-lifecycle`。原工作区的发布验收改动保留；本单不将其纳入提交。


### 2026-10-06：实现与验证记录

分支 `subagent-lifecycle` 的实现已完成，基点为 develop `33571b4`：

- 管理器统一在线状态写入，新增 `resultRecorded`、`recoverQueuedTasks`、`executionVerified` 与 `start`；编排器在结果事务交出状态更新，Runtime 在恢复事务交出排队子任务分类和核实后的 Agent 状态转换。
- 终态更新按当前任务 ID 仲裁，旧任务首次补记只保留历史结果，不覆盖后来执行。恢复遇当前终态结果缺失明确拒绝，并回滚释放占用，不能虚称空闲。
- `message` 和 `flushPendingMessages` 在事务外预检模型与受限执行入口，在登记事务内重核身份、当前工作、关闭/取消、模型选择及门闩。新消息预检失败零新增；既有消息保留待投递；查重先于预检。
- `resumeQueue` 提交后按父会话冲刷消息；模型配置应用的 finally 在解除门闩后补投，成功与回滚同一规则。main 消息唤醒使用已经核实的模型选择，消息补建从 ParentDelivery 的巡检移入管理器；无执行任务的 dev 父注入不做执行入口预检。
- 关闭仍是同步操作，关闭事务内按同一消息资格判定清理该 Agent 的待投递消息。它不异步冲刷其他 Agent，也没有后台未等待的消息投递。
- 管理器从真实父任务及继续链判断计划模式，检查显式修改及既有写入目标；工具只传实际指定的 mode，重复的语义检查集中到管理器。计划模式工具清单未扩大。

验证：

- `npm run typecheck` 通过，退出码 0。
- 定向测试 95 项通过：92、86-recovery、86-messaging、88 共 47 项；80、81、82、83、84 共 48 项。新增 92 号包含 26 项管理器接口用例；86-recovery 另补实际 Runtime 的恢复补投、配置成功与回滚补投。
- 完整测试 942 项：939 通过、1 跳过、2 失败。这两项均为已确认的基线或环境问题，没有新增失败：08 号 DNS 在批准时固定用例因 `.invalid` 解析等待 60 秒超时；32 号档案路径测试写死仓库目录名 ruukoto，在独立工作区 subagent-lifecycle 中失败。
- 两项分别在干净 `33571b4` 导出副本复现。32 号目录名的修正已在原工作区的发布验收任务中进行，本单没有修改 32 号或引入那项修正。
- 完整日志与退出码：`/var/folders/y4/36h8kvvd4q52vjptp522rzfc0000gn/T/ruukoto-subagent-lifecycle-final-2fkly70k/`。干净基线副本及 DNS 复现日志：`/var/folders/y4/36h8kvvd4q52vjptp522rzfc0000gn/T/ruukoto-lifecycle-baseline-gqitzlo1/`。
- 四项变异在独立临时源码副本中执行，不改实施工作区：删除当前任务保护命中两项旧结果断言；删除等待后的资格重核命中关闭/取消/转工作三项断言；删除事务内门闩检查命中两个消息方向的零新增断言；删除配置结束补投命中成功与回滚两个 Runtime 断言。所有副本源码均已还原，日志在 `ruukoto-lifecycle-mutations-wf08qjk2/`。
- 独立只读源码复核未发现生产可达的 P1/P2；未在 tx 上运行真实模型验收。

### 2026-10-06：最终交付与图解核实

第五条实现与验收完成，工单标记为 resolved，在 `subagent-lifecycle` 分支本地提交。

- 图解同步范围：`orchestrator.html` 的 bridge、subagent-state、subagent-message、subagent-close、child、subagent-modify 及启动恢复说明；`task-lifecycle.html` 的 stop、queue、subagent、restart；`tool-call-path.html` 的 path、availability 与静态宿主工具族说明。运行文档与 ADR 0020 同步修订。
- 原图解把终态后冲刷描述为同步续段并早于新委派，代码现为事务外异步预检、事务内重核（`subagents.ts` 的 message、flushPendingMessages、pendingMessageContext）；原图解将状态与子会话恢复归编排器，现经管理器 resultRecorded、start、executionVerified 处理，Runtime 保留通用队列与占用。
- 渲染逐张核实：orchestrator 21 张、task-lifecycle 8 张、tool-call-path 15 张，未发现文字重叠、截断或箭头错位；新增源码锚点已去除参数与括号。
- 最终 `npm run typecheck` 与 `npx tsx --test test/67-visual-docs.test.ts` 通过（图解测试 4/4）；`git diff --check` 通过。完整测试的两项基线或环境失败仍按上节如实保留。
- 最终补跑 92、86-messaging、86-recovery、88 共 47 项通过；评审重提路径仍调用 Runtime 的通用 resumeQueue，该入口在事务内交管理器 executionVerified 更新状态，符合本单职责划分。
- 清理本次测试使用的 node_modules 符号链接，不修改其指向的原工作区依赖。
