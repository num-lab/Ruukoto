Status: ready-for-agent
Depends on: 03, 12, 21

# 增加计划模式（`/plan`）

## 目标

拥有者在 TUI 用 `/plan <内容>` 提交一次计划任务：Agent 只调研、不修改，最终回答就是计划。拥有者的下一条普通消息即按计划执行，执行时仍按访问模式逐次审批（术语见 `CONTEXT.md`「计划模式」）。

## 背景

2026-09-25 核对：

- pi 0.85.1 不内置计划模式（README：“No plan mode.”，`node_modules/@earendil-works/pi-coding-agent/README.md:505`）。示例扩展 `examples/extensions/plan-mode/` 用 `/plan` 开关常驻模式：禁用 edit/write，bash 命令按白名单过滤，从回答的 `Plan:` 段落提取步骤，执行时靠 `[DONE:n]` 标记追踪进度，并在同一会话中切到执行。本项目关闭了 pi 扩展（`src/agent/session-factory.ts:71`），示例不能直接加载。
- 按任务收窄工具已有现成机制：GitHub 评审的 `allowTool`（`src/github/events.ts:136-140`，接入于 `src/runtime/runtime.ts:2106`），在任务开始激活工具时（`src/agent/driver.ts:1161-1165`）、发送请求前（`:830-836`）与工具调用时（`:1551`）三处检查。工具集在任务开始时固定，任务中途不变。
- 委派 coding 的 analyze 模式是先例：宿主写入首行 `[委派 coding · analyze]` 与「只做读取、运行与分析，不修改文件」，模式由首行判定，只靠说明约束（代码注释称「非只读沙箱」，`src/runtime/orchestrator.ts:100-111, 157-161`）。
- 会写东西的工具：`edit`、`write`、`bash`（`src/agent/tool-router.ts:42`）；`request_file_access` 可申请写工作区外文件、`http_request` 可发任意方法，二者均逐次审批（`:795-812`）；`memory_save`、`memory_revoke` 修改长期记忆（`src/agent/host-tools.ts:330, 415`）；MCP 工具带只读/写/副作用不明类别。
- 执行环境：默认后端 `local`，直接在本机执行（`src/cli.ts:156`）；容器后端把工作区读写挂载（`src/agent/execution/launchers.ts:181-182`），已支持对授权路径只读挂载（`:190`）；完全访问模式经 systemd 在本机执行（`:331-360`）。只读挂载只能在服务器容器后端提供硬保证。
- 任务输入原样作为用户消息发给模型（`src/agent/driver.ts:1186`）；TUI 事件流先显示任务输入，再用会话历史中的用户消息替换（`src/tui/event-flow.ts:78-80, 247`）。任务开始时钉版的上下文前缀已有项目指令与继续来源两类（`src/agent/driver.ts:260-263, 700-712`；`src/agent/context-selector.ts:480-535`）。
- `continue` 只接已中断任务，新任务带 `resumesTaskId`，任务开始时读取原任务输入（`src/runtime/runtime.ts:1574-1590`、`src/agent/driver.ts:704-708`）。
- TUI 把 `/` 开头的输入都当命令，未知命令只提示（`src/tui/app.ts:1385-1388, 1548-1549`）；命令列表见 `SLASH_COMMANDS`（`src/tui/app.ts:641-666`）。Telegram/QQ 私聊输入被包装为 `[入站事件]…`，不会以 `/` 开头。状态栏显示任务模式与会话默认模式（`src/tui/app.ts:2929-2966`）。

## 实施范围

### 1. 提交

- TUI 新命令 `/plan <内容>`：把整行作为任务输入提交，沿用现有提交与 `request_id` 去重；不带内容时只显示用法。CLI `ruukoto submit … "/plan …"` 走同一路径。
- 标记规则：任务输入以 `/plan` 加空白开头且其后有内容。不加会话状态，不改控制协议与表结构。
- 只限普通开发会话：`Runtime.submit`（`src/runtime/runtime.ts:1442`）对角色会话（main、coding、chat）与 QQ 群会话中带标记的输入返回 `invalid_params`，不创建任务。

### 2. 判定与说明

- 任务开始时判定并钉在 `pinnedContext`：输入带标记，或经 `continue` 继续的原任务输入带标记（中断的计划任务继续后仍是计划任务）。
- 任务输入照原样发给模型，事件流照原样显示 `/plan …`。计划说明作为宿主固定文本的前缀消息注入：与继续来源同一注入路径，只在计划任务中出现；`/context` 新增「计划模式」类别。说明内容：只调研、不修改；bash 只运行只读命令；最终回答给出计划。
- 回答格式自由，宿主不解析步骤：不提取 `Plan:` 段落，不做 `[DONE:n]` 追踪。

### 3. 工具收窄

- 与 GitHub 评审的 `allowTool` 组合，计划任务只允许白名单中的工具：`read`、`bash`、`request_file_access`、`http_request`、`read_artifact`、`history_search`、`history_read`、`memory_list`、`memory_read`、`web_search`、类别为只读的 MCP 工具，以及 `todo_write`（[25](25-todo-list.md)）与 `skill`（[22](22-skills.md)）。未实现的工具留在名单里也无影响。
- 效果相当于在现有工具中去掉 `edit`、`write`、`memory_save`、`memory_revoke` 与不是只读的 MCP 工具；今后新增的工具在计划任务中默认不可用。
- bash 保留，只靠说明约束。用 `ponytail:` 注释标明：bash 仍可能写入工作区，需要硬保证时改为容器只读挂载或去掉 bash。
- `request_file_access`、`http_request` 保留：请求确认与自动审查模式下逐次审批；完全访问模式下与 bash 一样只靠说明。
- 访问模式不变（提交时的会话默认或显式模式）；计划模式只收窄工具，不扩大授权。

### 4. TUI

- 命令补全与 `/help` 加 `/plan`。
- 计划任务运行时，状态栏在访问模式旁显示「计划」；按任务输入判定，继续的计划任务查看原任务输入。
- 计划完成后不加额外提示；执行即发送普通消息，状态栏已显示执行任务将使用的会话默认模式。

### 5. 文档

- README 的 TUI 命令表加 `/plan`。
- `docs/runtime.md` 记录计划模式：标记规则、适用会话、工具白名单、bash 只靠说明、继续时继承，以及批准计划不等于审批其中的操作。

## 已确认范围

2026-09-25 访谈确认（Q2–Q4、Q9–Q11、Q13–Q15 均按推荐）：

- 计划以任务为单位：计划任务的最终回答就是计划，拥有者的下一条普通消息即执行。不在同一任务内审批后切换执行：工具集在任务开始时固定，中途换工具集与此冲突，还要新增一类审批请求。
- 批准计划不等于审批计划中的具体操作，执行任务按访问模式逐次审批。
- 一次性命令 `/plan <内容>`，不做会话开关：开关要照搬 [12](12-session-mode-command.md) 的会话字段、版本 CAS 与事件广播，执行前还得先关闭。
- 计划格式自由，不解析步骤；执行进度交给工作清单（[25](25-todo-list.md)）。计划是否转成清单由模型决定，两张工单不写耦合代码。
- 收窄工具而不只靠说明；bash 保留，因为调研需要搜索、`git log` 与运行只读命令。计划模式是工作流程，不是安全边界（安全边界由访问模式负责）。不做只读挂载：默认的 `local` 后端与完全访问模式都在本机执行，只读挂载只能覆盖服务器容器后端。
- 同样去掉 `memory_save`、`memory_revoke`：修改长期记忆也属于修改。`request_file_access`、`http_request` 保留，工作区外的读取与联网调研仍可用。
- 只限普通开发会话：角色会话各有固定职责与工具，main 也没有编码工具。
- 中断后继续时继承计划模式，避免继续的任务直接开始修改。
- 任务输入照原样保存与显示，计划说明走前缀注入：执行任务的上下文里不再有「不修改」的说明；前缀只在计划任务与普通任务切换时变化。
- 用白名单而不是黑名单：今后新增的写工具不会在计划任务中默认可用。
- 不写 ADR：计划模式只收窄工具，不改访问模式，与 [ADR 0003](../../../docs/adr/0003-enforce-explicit-access-modes.md) 不冲突。

## 验收标准

离线集成测试（mock 模型）覆盖：

- `/plan <内容>` 提交后任务输入保持原样，事件流原样显示；模型上下文含计划模式前缀，`/context` 显示「计划模式」类别；下一条普通消息的任务没有该前缀，工具集恢复。
- 计划任务的工具集只含白名单工具：`edit`、`write`、`memory_save`、`memory_revoke` 与非只读 MCP 工具不可见，伪造调用在发送前或调用时被阻断；`read`、`bash`、`web_search` 与只读 MCP 工具可用。
- 请求确认、完全访问与自动审查模式下，计划任务的访问模式均不变；`request_file_access`、`http_request` 的审批行为与普通任务一致。
- 角色会话与 QQ 群会话提交带标记的输入返回 `invalid_params`，不创建任务；`/plan` 不带内容只显示用法；Telegram/QQ 私聊输入不会被识别为计划任务。
- 中断的计划任务经 `continue` 继续后仍按计划模式运行，状态栏显示「计划」。
- 重连重试不重复提交。

`npm run typecheck` 与 `npm test` 通过；README 与 `docs/runtime.md` 同步更新。

## 关联与后续

- 复用 [daily-agent 08](../../daily-agent/issues/08-github-events.md) 的按任务工具收窄、[05：上下文与资料授权](05-context-and-memory.md) 的前缀注入与钉版、[14：上下文分解](14-context-breakdown.md) 的分类、[12：会话模式选择](12-session-mode-command.md) 的状态栏显示与 [21：交互入口与开发实例](21-interaction-and-dev.md) 的 TUI 命令。进度追踪见 [25](25-todo-list.md)。
- 另行立项：会话级计划模式开关；TUI 一键「按计划执行」；容器只读挂载或去掉 bash 的硬保证；角色会话与 Telegram/QQ 私聊使用计划模式；同一任务内审批后切换执行。

## Comments

### 2026-09-25：创建工单与访谈确认

用户要求给 Agent 增加 plan 和 todo 功能。grilling 访谈三轮，Q1–Q15 全部按推荐确认，拆为 [25](25-todo-list.md) 与本工单，本工单相关的是 Q2–Q4、Q9–Q11、Q13–Q15。事实核对覆盖 pi 0.85.1 的 plan-mode 示例扩展、按任务工具收窄机制、写工具与执行环境、任务输入的显示路径与 `continue` 语义，结论见「背景」。

实施说明中有两处在访谈里没有单独提问，按已确认的决定推导：为了让事件流照原样显示 `/plan …`（Q15），计划说明改走前缀注入，不改写任务输入；工具收窄写成白名单，今天的效果与 Q10、Q13 列出的去除项相同，但新增工具默认不可用。
