Status: ready-for-agent
Depends on: 05, 14, 21

# 增加技能系统（Agent Skills 全局技能库）

## 目标

拥有者把 Agent Skills 格式的技能（`SKILL.md`）放进全局技能库，main 与 coding 在任务中按需加载，拥有者也可在 TUI 用 `/skill` 显式调用。技能是拥有者提供的参考内容，不增加工具或权限（术语见 `CONTEXT.md`「技能」）。

## 背景

2026-09-25 核对：

- 运行时封闭：[session-factory](../../../src/agent/session-factory.ts) 以 `noSkills` 等开关关闭 pi 资源自动发现。pi 0.85.1 的显式技能路径（`additionalSkillPaths` / `skillsOverride`）不受 `noSkills` 影响，但原生用法在本项目走不通：
  - pi 只在存在名为 `read` 或 `bash` 的工具时把 `<available_skills>` 写进系统提示（`node_modules/@earendil-works/pi-coding-agent/dist/core/system-prompt.js:13-14`），main 两者都没有。
  - pi 让模型按宿主绝对路径读取 `SKILL.md`。容器把工作区重映射到 `/workspace` 且看不到 agentDir；服务器上 agentDir 为 0700 `ruukoto-backend`，执行账户也读不到；agentDir 还是受保护根（`src/runtime/runtime.ts:349-363`），`request_file_access` 一律拒绝。
- 超过 4000 字符的工具结果在模型视图中只保留首尾各 2000 字符（`src/agent/context-selector.ts:58, 556`）；技能正文常超过这个长度（mattpocock-skills 最大的 `SKILL.md` 约 12 KB）。
- 项目指令已有可复用的注入路径：任务开始读取并钉在 `pinnedContext`（`src/agent/driver.ts:720-769`），经选择器前缀消息注入（`src/agent/context-selector.ts:480-492`），计入固定预算、写入选择记录，并由 `dataScopeRestricted`（`src/agent/driver.ts:352-354`）自动排除 chat 与 QQ 群。
- TUI 把所有 `/` 开头的输入当命令，未知命令只提示（`src/tui/app.ts:1385-1388, 1548-1549`）；Telegram/QQ 私聊输入被包装为 `[入站事件]…`，不会以 `/` 开头。
- 拥有者现有技能包：mattpocock-skills 38 个技能，22 个标 `disable-model-invocation: true`（grill-me、to-spec、to-tickets、triage、wayfinder、handoff 等），15 个带附属文件，多为引用 md，脚本只有 3 个 sh 和 1 个 cjs，且多为模板；ponytail 6 个技能，均只有 `SKILL.md`；`~/.agents/skills` 69 个技能、9.7 MB，含大量 Python 脚本。工具镜像基于 `node:24-slim`，无 Python，默认无网络。

## 实施范围

### 1. 技能库与解析

- 位置固定为 `<agentDir>/skills/`（本机 `~/.ruukoto/agent/skills/`，服务器 `/var/lib/ruukoto/agent/skills/`），不加配置项。开发实例使用自身 profile 下的 `agent/skills/`，不继承日常实例，也不加导入参数。
- 扫描与校验复用 pi 导出的 `loadSkillsFromDir`：含 `SKILL.md` 的目录即技能根，整包复制的嵌套目录照常扫描，跟随符号链接；同名先到先得并产出冲突诊断。不自写解析器。只使用 `name`、`description`、`disable-model-invocation`；`allowed-tools` 等其他字段不生效。
- 单个 `SKILL.md` 超过 64 KiB 的技能不进入技能库，记为诊断。所有诊断都要能被拥有者看到，不静默丢弃（见 §5）。

### 2. 钉版与目录注入

- 任务开始时（与项目指令同一时点）读取技能库，把技能目录与全部 `SKILL.md` 正文钉在内存，整个任务内的加载与显式调用都使用这份；版本为钉版内容的 sha256，写入选择记录。修改从下一任务生效。
- 目录只含名称与描述，不含主机路径，也不含 `disable-model-invocation` 技能；以选择器前缀消息注入，包装文字与项目指令同类（参考内容，不能变更控制面身份、审批规则或权限模式），并说明用 `skill` 工具加载正文与引用文件。
- 目录计入固定预算；超预算时按现有规则中断并暂停队列，不静默截断。`/context` 新增「技能」类别（`BREAKDOWN_CATEGORIES`）；prompt 快照照常可查。
- 受 `dataScopeRestricted` 约束：chat 与 QQ 群不注入目录、不注册工具。GitHub 评审任务的收窄工具集不变。

### 3. `skill` 宿主工具

- 新增宿主工具 `skill`（参数 `name`，可选 `path`），供 main、coding 与普通开发会话使用：新增工具类别并加入 `ROLE_DEFINITIONS`，按宿主工具模式接入 `handleToolCall` 的宿主工具列表，并加入 `RETRY_SAFE_TOOLS`。
- 不带 `path`：返回钉版的 `SKILL.md` 正文（去掉 frontmatter）及技能版本。`disable-model-invocation` 技能拒绝加载，未知名称明确报错。
- 带 `path`：读取该技能目录内的引用文件。路径为相对路径，realpath 必须仍在该技能目录内；只读普通文件、UTF-8 文本，单文件上限 64 KiB。引用文件在调用时读取，不钉版，结果带文件 sha256（用 `ponytail:` 注释标明这一上限）。脚本同样只作为文本返回，不原地执行。
- 工具只读，任何访问模式下都不产生审批。选择器对 `skill` 结果免除 4000 字符截取，结果照常计入历史预算。

### 4. 拥有者显式调用

- TUI 新命令 `/skill <名称> [参数]`：提交任务，输入为 `/skill:<名称> [参数]`，沿用现有提交与 `request_id` 去重。CLI `ruukoto submit … "/skill:<名称> …"` 走同一路径。
- 任务开始时按钉版目录展开：输入替换为带技能名与版本的正文块加参数，作为用户消息进入历史，不受工具结果截取。显式调用不受 `disable-model-invocation` 限制。未知名称使任务明确失败，并在错误中列出可用技能。
- 技能不交给 pi 的资源加载器，不使用 pi 自带的 `/skill:` 展开。Telegram/QQ 私聊不识别 `/skill:`。

### 5. 查看技能库

- 新增只读控制面操作，返回当前技能库（名称、是否仅显式调用、描述摘要）与诊断。TUI `/skills` 展示；`/skill` 不带名称时显示同一列表。不加 CLI 命令和配置中心页面。

### 6. 文档

- README 的 TUI 命令表加 `/skill`、`/skills`。
- `docs/runtime.md` 记录技能库位置、服务器维护方式（`sudo cp -r` 到 `/var/lib/ruukoto/agent/skills/`）、钉版规则、64 KiB 上限，以及脚本不原地执行。

## 已确认范围

2026-09-25 访谈确认（Q1–Q13 均按推荐）：

- 技能采用 Agent Skills 标准（`SKILL.md`），可直接复用现成技能包与 pi 的解析。新增能力仍归「插件」，两者分开。
- 只由拥有者提供，Agent 不能新建或修改技能。模型可写、之后又作为指令注入每个任务的文件是持久的提示注入通道，而且与长期记忆的「经验」类别重叠；需要时另开 issue。
- 只有全局技能库，不做项目级技能，也不做按项目开关；项目特有的规则已由项目指令覆盖。
- main 与 coding 可用，含共享 main 的 Telegram/QQ 私聊与委派的 coding 子任务。chat 与 QQ 群排除，与其现有资料范围一致。
- 不采用 pi 原生技能路径：main 没有 `read`/`bash`，按主机路径读取在容器与执行账户下不可行。
- 尊重 `disable-model-invocation`，否则 to-tickets、handoff 这类工作流可能被模型自行触发，目录也更嘈杂。
- 引用文件可读，脚本不原地执行。只读挂载技能库快照只对 coding 有效，还要为执行账户另开读取，镜像也没有 Python。
- 钉版规则与项目指令一致。引用文件不钉版，避免每个任务都快照整棵目录树。
- 位置固定，不做可配置路径：服务器上后台账户读不了拥有者主目录；拥有者精选的子集比直接指向 `~/.agents/skills`（69 个技能）更适合固定预算。
- 查看技能库只做 TUI `/skills`，CLI 等有脚本需要时再加。
- 不写 ADR，取舍记在本工单。

## 验收标准

离线集成测试（mock 模型）覆盖：

- 技能库扫描：嵌套技能包、符号链接、缺少描述、YAML 错误、同名冲突和超过 64 KiB 的情形，诊断可经 `/skills` 看到；技能库为空或目录不存在时不注入目录，任务正常执行。
- main 与 coding 的模型上下文含技能目录（名称与描述，不含主机路径与仅显式调用的技能）；chat、QQ 群没有目录，也没有 `skill` 工具；GitHub 评审任务的工具集不变。
- `skill` 加载正文：结果完整，超过 4000 字符也不被截取，并带版本；仅显式调用的技能被拒绝；未知名称报错。
- 引用文件：正常读取时带 sha256；`..`、绝对路径、指向技能目录外的符号链接、目录、非文本和超过 64 KiB 的文件均被拒绝。
- 钉版：任务进行中修改 `SKILL.md`，本任务的加载与展开仍得到任务开始时的内容；下一任务得到新内容，选择记录中的版本随之变化。
- `/skill <名称> [参数]`：任务输入展开为正文块加参数并进入历史；仅显式调用的技能可以这样调用；未知名称使任务失败并列出可用技能；重连重试不重复提交。
- `/context` 显示「技能」类别；目录超预算时按现有规则中断，不截断。
- 各访问模式下加载技能都不产生审批，技能内容不改变任务的权限模式与审批规则。

`npm run typecheck` 与 `npm test` 通过；README 与 `docs/runtime.md` 同步更新。

## 关联与后续

- 复用 [05：上下文与资料授权](05-context-and-memory.md) 的前缀注入与钉版规则、[13：prompt 查看](13-prompt-inspector.md) 的快照、[14：上下文分解](14-context-breakdown.md) 的分类，以及 [21：交互入口与开发实例](21-interaction-and-dev.md) 的 TUI 命令与开发实例；角色定义见 [daily-agent 01](../../daily-agent/issues/01-orchestration.md)。
- 另行立项：Agent 新建或修改技能；项目级技能；按项目开关；Telegram/QQ 私聊显式调用；技能脚本原地执行（需要挂载与运行时，如 Python）；CLI `ruukoto skills`。

## Comments

### 2026-09-25：创建工单与访谈确认

用户要求增加技能系统。grilling 访谈四轮，Q1–Q14 全部按推荐确认，要点见「已确认范围」。事实核对覆盖 pi 0.85.1 的技能加载与 `/skill:` 展开、上下文组装与项目指令钉版、工具与执行环境的文件可见性，结论见「背景」。

访谈中顺带发现的两个问题另开 [23](23-container-full-access.md) 与 [24](24-system-prompt-discovery.md)。coding 会话会注入个人共享记忆（`src/core/memory.ts:95`，`dataScopeRestricted` 只覆盖 chat 与 QQ 群），与 `.scratch/daily-agent/spec.md:66`「coding 只能收到委派任务明确传入的数据」是否冲突，待拥有者判断，未开工单。
