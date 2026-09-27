Status: ready-for-agent

# 工具可用性：一个模块回答「这个任务能看见、能调用哪些工具」

## 目标

「这个会话、这个任务允许哪些工具，被拒的原因是什么」由一个模块回答。装配、激活、发送前与调用门都向它要结论，不再各自编码。来源：2026-09-26 架构审查的候选 03。

## 背景

2026-09-27 核对（main 183b5c2）：

- 五个检查点各有编码。装配（`driver.ts:333–460`）混用 `isQqGroup`、`roleAllows(类别)`、`role()?.id === "main"` 与 `dataScopeRestricted`；激活（:730–736）按 Web Search 开关与 `taskAllowsTool` 过滤；发送前（:521–548）有 `qq_tools_forbidden` / `role_tools_forbidden` / `task_tools_forbidden` 三个码；调用门（:1073–1187）依次是 QQ 群全拒、4 处「仅 main」、角色快照、`taskAllowsTool`；执行时各工具另有复核。
- 普通开发会话没有角色，`roleAllows` 一律放行（:261–264），「仅 main」四族只能另加角色字符串排除（装配 :374/388/400/410、调用门 :1084/1102/1106/1109）。新工具族只挂 `roleAllows(新类别)` 就会出现在普通开发会话里。
- `app_data` 类别只写不读：装配只看 `role()?.id === "main"`（:374），全仓库没有 `roleAllows("app_data")`。
- `agent_roles.tools` 是 `ROLE_DEFINITIONS` 的镜像：`ensureRoles` 每次启动用代码值覆盖（`orchestrator.ts:260–282`），唯一读取方是 `roleAllows`。
- QQ 群会话的角色经 `qq_sessions` 联表解析成 chat（`store.ts:764–771`）；联表查不到时角色为 null，只剩 `isQqGroup` 一道防线。
- pi 的 `prepareToolCall` 先在激活集里查名字，查不到直接返回 not found，不进调用门（`pi-agent-core/dist/agent-loop.js:400–412`）。调用门的「仅 main」、角色快照与发送前的 `role_tools_forbidden` / `qq_tools_forbidden` 经模型路径走不到，没有测试。
- 三份「只读」名单是三种政策且有意不同：`PLAN_TOOL_NAMES` 含 bash、http_request（靠计划说明约束），`RETRY_SAFE_TOOLS` 不含，GitHub 评审只放行 read、read_artifact 与只读 MCP。
- 驱动里 `dataScopeRestricted`（:303–305）与系统提示选择（:451）按 QQ 群/角色另行判断；计划模式钉版用 `!dataScopeRestricted`（:604），提交入口只接受普通开发会话（`runtime.ts:1511`）。

## 决定

### 范围

- 纳入：会话类别 → 工具类别；任务收窄的组合（计划模式、GitHub 评审收窄 `allowTaskTool`、Web Search 项目开关、MCP 钉版的只读判定）；装配、激活、发送前、调用门都向模块要结论。
- 不纳入：调用门的分派（`ROUTED_TOOL_NAMES`、8 份宿主名单与 mcp 分支登记 `hostToolCalls`、`confirmTools` mock 路径）；获批后的复核（`verifyMainBinding`、MCP 配置版本，候选 04）；资料范围（`Accessor`）；系统提示文案；停止与恢复路径按工具族分类（候选 05）；`RETRY_SAFE_TOOLS`；新闻计划的宿主直连搜索（不是模型工具）。
- 不做统一的「只读」元数据：三份名单是三种政策，合成一个标记会抹掉有意的差异。各名单留在各自来源（`plan-mode.ts`、`github/events.ts`、编排器），前两者作为任务收窄的输入交给模块。
- 委派的来源限制（`coding_delegate` 只允许拥有者发起的任务，`delegation-tools.ts:92–99`）不并入，保持执行时拒绝并说明：main 会话里拥有者任务与唤醒任务交替，按任务隐藏会让工具定义变化，每次切换都让整段历史的提示缓存失效。
- 类别粒度不变：`todo_write` 仍归 coding，`read_artifact` 仍归 coding，host_data 读写不拆。
- 后续事项（本单不做）：装配了但漏登记分派名单的宿主工具会落到 `confirmTools` 路径放行。

### 会话工具类别

模块内一张静态表，唯一来源：

| 会话类别 | 工具类别 |
|---|---|
| dev（普通开发会话） | coding、host_data、web_search、mcp、skills |
| main | host_data、web_search、app_data、scheduler、delegation、chat_results、skills |
| coding | coding、host_data、web_search、mcp、skills |
| chat（chat 角色与 QQ 群） | 无 |

- 新工具族默认对所有会话不可见，写进哪份清单才出现。「仅 main」= 只有 main 的清单含这些类别；8 处角色字符串判断删除。
- QQ 群按 `session.kind === "qq_group"` 归入 chat，不靠联表。
- `ROLE_DEFINITIONS` 只留 id 与项目名；`agent_roles.tools` 不再读取、不再同步（删 `updateAgentRoleTools`），列保留、不迁移，新建角色时写入表里的值。

### 接口（`src/agent/tool-availability.ts`，纯函数，不依赖 store）

```ts
export type SessionToolClass = "dev" | "main" | "coding" | "chat";

/** QQ 群按会话 kind 归入 chat；角色会话按宿主绑定；其余为普通开发会话。 */
export function sessionToolClass(kind: Session["kind"], roleId: AgentRoleId | null): SessionToolClass;

/** 会话类别的工具类别清单（模块内静态表）。 */
export function allowsCategory(cls: SessionToolClass, category: ToolCategory): boolean;

/** 本任务允许的工具：已装配的工具减去任务收窄与关闭的 Web Search。 */
export function taskToolSet(input: {
  registered: readonly string[];
  plan: boolean;
  webSearchEnabled: boolean;
  mcpEffect: (name: string) => McpToolEffect | undefined;
  narrow?: (name: string, mcpEffect?: McpToolEffect) => boolean;
}): { allowed: ReadonlySet<string>; reasonFor(name: string): string };
```

driver：

- 首次用到时算 `toolClass`（Driver 生命周期内不变）；装配按 `allowsCategory` 建工具族，`planMcp` 同样。
- 任务开始算一次 `taskTools`：激活用 `allowed`；发送前与调用门查它，拒绝附 `reasonFor`。三个检查点都保留（pi「先查激活集」是实现细节，一次集合查询几乎零成本）。调用门的统一检查放在最前（模式边界之前），不记录执行意图。
- 删 `roleAllows`、8 处角色字符串判断、`roleAllowedToolNames`、`taskAllowsTool`、工具路径上的 `isQqGroup`。
- 会话分类复用：`dataScopeRestricted` = `toolClass === "chat"`；系统提示 `SYSTEM_PROMPTS[toolClass]`；计划模式只在 `toolClass === "dev"` 时钉版（与提交入口一致，含读取失败的回退）。`Accessor` 仍需区分 QQ 群与 chat 角色，保留 `isQqGroup`。
- 注入依赖仍叫 `allowTaskTool`，driver 绑定任务后作为 `narrow` 传入。执行时的 Web Search 开关现场检查保留。

### 拒绝原因与中断码

- 发送前只留 `task_tools_forbidden:<工具>（<原因>）,…`；删 `qq_tools_forbidden`、`role_tools_forbidden`。
- 调用门：「任务工具白名单不含 <工具>（<原因>）」。
- 原因：本会话不开放（未装配）/ 计划模式不开放 / 本任务由宿主收窄 / 项目已关闭 Web Search。
- 调用门不再写 `app_data.rejected`，事件类型删去 `tool_call_gate` 来源；应用数据工具自身的拒绝事件不变。

### 行为变化

可达路径没有行为变化。只在不可达路径上有差异：发送前与调用门也检查 Web Search 开关；绕过提交入口进入 main/coding 的 `/plan` 输入不再按计划模式运行；调用门对被拒工具的判断提前到模式边界之前。

### 领域与文档

- CONTEXT.md「技能」改为 main、coding 与普通开发会话可用（issue 22 规格第 39 行、代码与 `runtime.md:489` 均如此）。
- 不新写 ADR：重构后 ADR 0009:12「三层共用同一份白名单」成立；修正 `types.ts:115`、`orchestrator.ts:81` 的注释。
- `runtime.md`「架构要点」加一条「工具可用性」，同步 :649。

### 测试

- 新增 `test/62-tool-availability.test.ts`（纯函数）：`sessionToolClass`（QQ 群无角色绑定也归 chat）；四个会话类别 × 九个工具类别的字面矩阵；`taskToolSet` 的计划模式、GitHub 式收窄、关闭 Web Search、组合、各原因文本与未装配工具的原因。
- 44、58 号保留结构（唯一能走到调用门与发送前拦截的测试）；其余端到端（28、39、41、48、56 号与 QQ 群空工具集）不动作回归。
- 28 号「升级既有 main 的工具清单」断言删除。
- 收尾变异：普通开发会话清单误加 app_data、计划模式收窄失效、QQ 群改回联表分类、激活/发送前/调用门各自不查集合、Web Search 过滤失效、`narrow` 被忽略、装配漏查类别。

## 步骤

0. 工单与 CONTEXT.md「技能」修正。
1. 模块与 driver 接入（接口、会话分类复用、拒绝原因与中断码、调用门事件）；新增 62 号，44/58 号按需调整。
2. 清单单一来源：`ROLE_DEFINITIONS` 只留 id 与项目名，`ensureRoles` 新建时写表值，删 `updateAgentRoleTools`，删 28 号相应断言，修正两处「三层共用」注释。
3. 文档收尾：`runtime.md`；工单标记完成并追加交付记录。

每步 `npm test` 与 `npm run typecheck` 都通过后在分支 `tool-availability` 本地提交，不 push。不在 tx 上跑真实模型验收。
