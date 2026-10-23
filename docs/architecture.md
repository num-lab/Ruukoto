# 架构总览

`ruukoto` 个人 Agent 与 `ruukoto-code` Coding Agent 同仓交付；个人端由 durable 持有运行状态，Coding 继续使用共享底座；细节见[模块文档](modules/)。

## 模块地图

| 模块 | 一句职责 | 主要依赖方向 |
| --- | --- | --- |
| [products](modules/products.md)（`apps/ruukoto`、`apps/ruukoto-code`） | 持有各产品入口与专属业务装配 | 个人装配 durable，Coding 注入共享 runtime/CLI；产品包互不依赖 |
| [personal-durable](modules/personal-durable.md)（个人 app 内） | 个人会话、工作、档案与请求证据、权限、IM/本机管理和工具 | 依赖 Pi 1.3.0 与独立底层能力；正式 bin/start/dev 同装配 |
| [runtime](modules/runtime.md) | 拥有任务生命周期、会话身份、队列与 SubAgent 委派的编排；模型配置与栈归 RuntimeModels | 依赖 core 的存储、agent-context 的模型装配、agent-tools 的工具、execution 的执行边界；被 control 与 channels 驱动 |
| [core](modules/core.md) | 定义数据布局、schema、任务状态机与会话身份判定 | 不依赖其他模块，被全部模块依赖 |
| [workflows](modules/workflows.md)（runtime 内） | 为模型与拥有者入口提供定义库、固定后台运行、持久步骤及控制 | 依赖 core 的事务、agent 的脚本与执行边界；默认接真实 Driver、来源权限与冻结汇总 |
| [agent-context](modules/agent-context.md) | 组装每次模型调用的上下文：资料范围、历史、参考块、压缩与记忆 | 依赖 core 的存储与会话文件；被 runtime 的驱动循环调用 |
| [agent-tools](modules/agent-tools.md) | 决定会话有哪些工具，并经统一审批与操作账本执行 | 依赖 core、execution；被 runtime 装配 |
| [execution](modules/execution.md) | 执行工具与受限脚本，核实进程停止 | 依赖 core；工具由 agent-tools 调用，脚本经注入回调请求宿主 |
| [control](modules/control.md) | 提供控制面 socket、拥有者认证与协议 | 调用 runtime 与 core；被 tui、desktop 与 view 消费 |
| [view](modules/view.md) | 共享界面投影与历史读取编排 | 依赖 core 与 control 的浏览器可用模块；被 tui 与 desktop 消费 |
| [desktop](modules/desktop.md)（`apps/desktop`） | 桌面连接（Electron／MyGo） | Node 宿主依赖 control/core/view，renderer 依赖 view；后台独立运行 |
| [tui](modules/tui.md) | 共享 CLI、交互终端与配置中心 | 界面只经 control 协议连接后台；CLI 的 `server` 入口在本进程装配 runtime |
| [channels](modules/channels.md) | 拥有者 IM 入口、图片入站与 GitHub 事件来源 | 依赖 core 登记入站事件；驱动 runtime 建任务；经 scheduler 的 outbox 外发 |
| [scheduler](modules/scheduler.md) | 持久调度计划与通知 outbox 的发送账本 | 依赖 core；驱动 runtime 建唤醒任务；经 channels 发送 |
| [deploy](modules/deploy.md) | 部署的系统身份、单元、提权入口与服务管理 | 不参与运行时调用；定义当前账户的后台与可选服务 OS 授权 |

`packages/` 含七个共享包；agent-context、agent-tools 与 execution 属于 agent，scheduler 属于 channels；Coding 的 `product.ts` 声明旧底座能力，个人 app 直接持有 durable 业务接线。

运行时值依赖为 `agent → core`、`channels → agent/core`、`runtime → channels/agent/core`、`control → core`、`view → control/core`、`tui → view/control/runtime/agent/core`；control 通过注入的 Runtime 实例提供服务。依赖声明与静态约束见[产品装配](modules/products.md#不变量与失败处理)。

## 主流程一：任务生命周期

以下任务、工具与 SubAgent 图描述 Coding 底座；保留的旧个人身份分支不构成新个人入口。个人会话、执行、队列与恢复由 durable 原生记录持有，宿主只记录业务归属与外部证据，见[个人持久会话](modules/personal-durable.md)。

任务由会话提交产生，持久化后由队列串行执行，终态在一个事务内收尾。

```mermaid
sequenceDiagram
  participant C as 客户端（TUI/CLI/入站事件）
  participant Rt as runtime
  participant St as core（SQLite + JSONL）
  participant D as Driver + agent-context
  participant CP as 控制面事件流

  C->>Rt: submit（session, request_id, 输入, accessMode）
  Rt->>St: 幂等查重（session + request_id）
  Rt->>St: 登记任务 queued 并写 task.* 事件
  Rt->>CP: 发布持久事件
  Rt->>Rt: 队列取出，计算 executionProfile
  Rt->>St: queued → running
  Rt->>D: 组装模型上下文并流式调用
  D-->>CP: task.output_fragment / task.thinking / task.tool_result
  D-->>Rt: 工具调用、审批、继续
  Rt->>St: endTask 条件更新为 completed/failed/canceled/interrupted
  Rt->>St: 释放目录占用、清除待生效模式、失效未消费审批
  Rt->>CP: 发布 task.* 终态事件
```

要点：

- 提交幂等键的唯一范围是会话；同键同参重放返回原任务，同键异参报 `request_conflict`。重试先核实原请求，不换键重复提交。
- 任务携带 `accessMode`、`planMode`、权限版本与授予路径；模式与范围进入幂等比较，切换只在无执行中工具的边界生效。
- 执行画像（会话类别、SubAgent 工具集、资料受限、计划资格）在任务开始算一次并钉到任务结束；工具集变化时重建 SDK 会话。
- 终止状态只有 `completed`、`failed`、`canceled`、`interrupted`；所有在线终态路径都经同一个收尾事务，只有当前状态仍在起点集合时才继续。
- 普通目录占用按任务释放；会话后台持有独立占用，停止核实后才释放，同一目录保持单写入者。
- 后台重启把 `running`／`awaiting_confirmation` 定为 `interrupted`（原因 `backend_restart`），未决审批标 `stale`，有排队任务的会话暂停自动调度，由拥有者用 `resume-queue` 显式恢复。

## 主流程二：入站消息到回复

个人 QQ/Telegram 与本机菜单共用 durable 主会话；平台消息先提交持久接纳事实，再推进接管水位。

```mermaid
sequenceDiagram
  participant P as QQ / Telegram / 本机菜单
  participant A as 个人入口
  participant H as durable Harness
  participant M as main Conversation
  participant R as 原入口回复 Task
  P->>A: 输入与固定来源
  A->>H: 提交来源、稳定请求与后台 Task
  H->>M: 原键 admission
  M-->>H: 对应 Submission 的回答
  H->>R: 固定平台、账号、owner 与代次
  R->>P: 核实原入口后发送
```

重复消息定位原 Submission，不新建第二份执行；QQ/Telegram 配置换代使旧审批和未发送回复失效，不改发。未知发送保留事实、不自动重发；客户端断开不取消工作。独立定时会话和后台分析先等整项工作及外部停止核实，再沿原来源汇总，详见[个人持久会话](modules/personal-durable.md)。旧 channels/outbox 的记录与实现见[消息渠道](modules/channels.md)，正式个人入口不装配它们。

## 主流程三：工具调用与审批

模型调用工具后，宿主先判定可用性，越界操作进入审批闸门，执行发生在执行边界内。

```mermaid
sequenceDiagram
  participant D as Driver
  participant Av as agent-tools（可用性）
  participant G as 审批闸门
  participant R as agent-tools 审查/核实
  participant W as execution（原生沙箱或启动账户）
  participant L as 工具操作账本

  D->>Av: 调用工具（宿主注入身份与操作编号）
  Av->>Av: 检查本任务工具集合与调用门
  alt 需要审批
    Av->>G: 登记不可变审批并转入等待确认
    G->>R: auto-review 先经无工具审查调用
    G->>G: 等待拥有者决定（TUI 或 IM）
    G->>G: 获批后同一事务内复核并单次消费
  end
  G->>W: 以审批快照为参数执行
  W-->>L: 结果与 task.tool_result 成对写入
  L-->>D: 有界模型视图（超长正文入产物）
```

要点：

- 工具可用性是唯一来源：会话类别清单减去宿主按任务的收窄（计划模式、GitHub 评审、项目关闭的 Web Search），激活、发送前检查与调用门共用同一集合。
- 审批是结构化且不可变的：绑定目标、内容指纹、方法与完整 URL、凭据名称与用途；批准经条件更新单次消费，其他 URL／方法／正文／任务不能复用。
- 完全访问的所有已开放工具免操作审批，仍核实活动任务、权限版本、目标、修订与凭据，记录真实任务授权及操作结果。
- 效果分类是硬边界：审批未消费一律已知未执行；只读工具中止记无写入效果；其余效果无法核实的记 `effect_unknown`，不重放。
- 工具输出在上游截断前捕获为产物文件，中断或写失败保留已捕获部分并标 `partial`；按任务归属可跨重启按 id 读取。

## 主流程四：SubAgent 委派

主 Agent 登记工作委托，创建独立上下文的 SubAgent，结果回到父级。

```mermaid
sequenceDiagram
  participant PA as 主 Agent（普通开发会话 / main）
  participant SM as SubAgent 管理器
  participant St as core（work_delegations / sub_agents / tasks）
  participant SA as SubAgent 子会话
  participant PD as 父级送达（runtime）

  PA->>SM: subagent_delegate（request, key, role, target）
  SM->>SM: 准备（模型门闩、执行入口、工作目录、资料快照）
  SM->>St: 事务登记工作、Agent、Session 与排队任务
  SM->>SA: 提交后 kick 子会话（独立目录或目标副本）
  SA-->>St: 终态结果（setTaskResult 一次写入）
  SM->>St: resultRecorded：按占用记 idle / unverified
  SM->>PD: 结果已登记 / 消息已登记
  PD->>PA: main 建 wake:<子任务>；普通开发会话下次任务注入
  PA->>SM: subagent_result / subagent_integrate / subagent_cancel
```

要点：

- 只有拥有者直接提交或经拥有者 IM 入口核实身份的任务可以委派；定时唤醒、子任务回报与其他来源拒绝。
- 一层委派：SubAgent 不能再派生下一层，也不能与拥有者直接交互。
- 普通委派与工作流共用角色与来源能力：省略 role 为 general，工具继承或显式要求，权限只能收紧；target 独立指定代码目标，verify 由工作流宿主持有冻结验证资格。单次批准与长期授权不继承。
- 目标委派在 Git 上先捕获当前稳定内容，再登记独立 worktree；保护来源的角色只写副本检查产物，原目录和共享 Git 只读。主 Agent 用 `subagent_integrate` 只汇入捕获后的子增量，冲突保留双方；非 Git 普通目标直接写入并按目录占用串行。
- 送达与登记分开：结果与消息的登记只是投递登记，进入父模型调用才算送达；已取消的工作不建唤醒、不注入，队列循环在唤醒启动前再检查一次。
- 任务终态、TUI 退出与空闲都不关闭 SubAgent；关闭是独立列，关闭后拒绝新委派但保留历史与产物。
- 后台重启时排队的委派任务定 `interrupted` 不自动继续；宿主固定评审的排队任务由编排器启动恢复自动继续；占用未核实的旧执行保留占用并由拥有者用 `resume-queue` 释放。

## 一条消息穿过全部模块

Coding 请求由 `control` 交给 `runtime` 建任务并取出，`agent-context` 组装上下文，`agent-tools` 判定可用性并取审批，`execution` 在边界内执行，`core` 存下每一步的事实，`control` 把事件流推给 `tui`，个人请求由 app 的 durable 会话与发送 Task 衔接 IM，运行事实不写旧 Task Store。

## 设计依据

- [后台任务与终端](../.agents/notes/implemented/architecture/2026-09-19-detach-terminal-from-task-runtime.md)：后台与客户端分离、事件流恢复与请求幂等的基础决定。
- [两个 Agent 产品](../.agents/notes/implemented/architecture/2026-10-02-two-agent-products.md)：两个产品同仓交付，各自独立运行、档案与实例锁。
- [同仓 workspaces 分包](../.agents/notes/implemented/architecture/2026-10-11-in-repo-workspace-packages.md)：产品装配、共享包与 import 检查的归属。
- [工具工作进程与受限容器](../.agents/notes/implemented/architecture/2026-09-20-tool-worker-per-task-container.md)：执行边界的形态与失败策略。
- [Coding Agent 的原生受限执行](../.agents/notes/implemented/architecture/2026-10-10-native-execution-sandbox.md)：原生工具链、停止核实与占用保留。
- [会话历史与模型上下文](../.agents/notes/implemented/architecture/2026-09-19-preserve-session-history.md)：历史与上下文的分工，决定了 core 与 agent-context 的边界。
- [工作委托、SubAgent 与任务](../.agents/notes/implemented/architecture/2026-10-03-work-delegation-subagent-task.md)：委派三层数据模型与一层派生的来源。
- [人类文档与决策记录](../.agents/notes/implemented/process/2026-10-09-split-agent-and-human-docs.md)：本页与模块文档的读者分层与固定节约定。
