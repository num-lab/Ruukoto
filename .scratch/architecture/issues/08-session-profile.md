Status: ready-for-agent

# 会话身份与执行画像：一次判定「这个会话是什么」，按任务给出执行画像

## 目标

「这个会话是普通开发会话、main、SubAgent 还是已退役归档」由一个模块一次判定；给定任务，同一模块给出执行画像（工具过滤、MCP 按效果放行、资料范围、工作区或写入目标）。driver、tool-router、Runtime、编排器只向它要结论。来源：2026-10-05 架构审查的候选 01。

## 背景

2026-10-05 核对（develop d109dbe）：

- 会话身份由三处数据拼出：`session.kind`、`agent_roles`（`getAgentRoleBySession`）、`sub_agents`（`getSubAgentBySession`），约 23 处各自判定：`driver.ts` 286、323、371、538–548、672、750、760、811、919–926；`tool-availability.ts` 28–35、55–58；`tool-router.ts:160`；`runtime.ts` 1461、2182、2187、2337、2363、2885；`orchestrator.ts` 452、646、680；`subagents.ts:281`。
- `sessionToolClass(kind, roleId)`（`tool-availability.ts:56`）不可能返回 `subagent`；driver 的 `toolClass` 先查 `getSubAgentBySession` 再回退（`driver.ts:323`），其他调用方各自重复这一步。工单 03 立的 seam 已被绕开：`subagent` 类别清单为空（`tool-availability.ts:30`），SubAgent 的工具政策在 driver 里按 `toolClass === "subagent"` 另行编码（286、538、548、672、811、919–926）。
- 写入目标经 `getWorkDelegation(task.workId).writeTarget` 读取多处（`driver.ts:543`、`:922`、`tool-router.ts:160`、`runtime.ts:2812` 经 `core/worktree.ts:64` 的 `taskWorkspaceFor`）；宿主评审的只读 MCP 经 `taskMcp`（= `githubEvents.isReviewTask`，`runtime.ts:2927`）在 driver 判定 3 处（811、924、925）。
- 时序耦合：SDK 会话建立时的工具过滤（`driver.ts:538–545`）按当时任务的工作计算，只能收窄不能补回；它正确只因为 Runtime 在每个 SubAgent 任务后释放 driver（`runtime.ts:2885`，注释说明释放是为回收 SDK 缓存与 MCP 连接；`driver.ts:913` 的注释依赖它：「每个任务重建 Driver 后本任务已钉版」）。SDK 会话只在 MCP 签名或模型配置变化时重建（`dropSdkForToolChange`，`driver.ts:864–866`），写入目标不在签名里。若这一释放被去掉，复用的 Agent 从只读工作转到修改工作时仍只有只读工具。
- `subagents.ts:281` 的「SubAgent 不能委派下级」只在 `mode === "modify"` 分支检查；analyze 委派由工具层（`subagent` 类别为空、`ownerOriginated`）挡住，不是活漏洞。
- 判定按用途分五类：
  - 入口政策（谁能提交、能否改模式）：`runtime.ts` 2182（计划模式只限普通开发会话）、2187（SubAgent 会话不能提交）、2195 与 2792（退役归档拒绝与队列兜底）、2337、2363、3112（unverified → idle）。
  - 执行画像（工具、资料范围、写入目标）：driver 的 `toolClass` 及其分支；`tool-router.ts:160` 的 `launchSpecFor` 重写了 `core/worktree.ts:64` `taskWorkspaceFor` 的同一判定。
  - 每次调用的宿主身份重核（安全复核，有意新鲜读取）：`driver.ts:351`（verifyMainBinding）、`:383–384`（verifyDelegationHost）、`subagent-tools.ts:259`、`chat-result-tools.ts:82`、`im-approvals.ts:351`。
  - 送达方向（父会话是 main 还是普通开发会话）：`orchestrator.ts` 452、646、680，`subagents.ts` 835、868，`driver.ts:760`——归候选 09。
  - 列表可见性（客户端）：快照分别下发 `sessions`、`roleSessionIds`、`subAgentSessionIds`，由 `control/workspace.ts` 92/153、`tui/app.ts:2840`、`dir-identity.ts:83` 各自重组「普通会话」。
- 测试：会话判定本身没有直接测试；44、58 号是唯一走到调用门与发送前拦截的测试（工单 03），经 `(t.runtime as any).getDriver` 取 driver。
- issue 23（agent-direction）的固定 coding 退役已在 d109dbe 落地，schema、`AgentRoleId` 的 coding/chat 与 `qq_group` 保留不收缩（读取兼容）。其评审有意保留两处退役判定：`sessionToolClass`（纯函数，归档返回 null）与 `retiredSessionReason`（`runtime.ts:1461`，读 store、返回原因字符串），理由是合并要给纯函数引入 store 依赖。23 当时待拥有者决定的「ruukoto 产品是否拒绝普通开发会话」已在本单访谈中定为不拒绝（见决定 4）。

## 决定（2026-10-05 访谈）

1. **范围**：入口政策与执行画像两类进模块；每次调用的宿主身份重核改用同一解析，但每次新鲜读取、不缓存；送达方向留给 09（09 向本模块要身份）；列表可见性不动（改它要升控制协议，客户端重组没有缺陷）。
2. **身份形状：读与分类拆开**。一处从 store 一次读出会话、角色行与 SubAgent 行；一个纯函数分类为普通开发会话 / main / SubAgent（附其 Agent 行）/ 已退役归档（附原因）。分类器保持无 store 依赖（回应 issue 23 评审保留两处判定的理由），退役判定只剩一处；入口与队列兜底直接用身份里的原因。
3. **时序耦合**：画像的工具集（写入 / 只读 / 宿主评审只读 MCP）并入 SDK 会话签名，变化时走既有 `dropSdkForToolChange` 重建；「SubAgent driver 每任务释放」退回纯资源回收，正确性不再依赖它。
4. **无产品维度**：ruukoto 不拒绝普通开发会话（拥有者决定，记于 agent-direction issue 23，该单已关闭），模块不带产品参数。
5. **入口政策的形状**：模块只给会话身份；Runtime 各入口按身份一行判定（提交：SubAgent 会话拒绝、已退役归档按原因拒绝、计划模式只限普通开发会话；改默认模式与切换模式：SubAgent 拒绝；队列兜底：归档按原因取消；resume-queue：从身份取 Agent 行）。错误码与文案留在各入口。不做「操作 × 身份」规则表——过不了删除测试。
6. **执行画像**：由会话身份、任务、工作与是否宿主评审算出，任务开始算一次、钉到任务结束。内容：
   - 工具：会话类别（工单 03 的类别表）；SubAgent 工具集（只读 / 写入 / 宿主评审：另开只读 MCP、关 `subagent_message`）——装配过滤、任务收窄与 SDK 签名同用这一份；
   - 是否规划 MCP（类别含 mcp，或 SubAgent 宿主评审任务）；
   - 资料受限（SubAgent）：上下文组装的 `restricted`、技能不钉、`/skill` 不展开、产物只读本任务自产且排除 prompt 快照、发送前复核资料来源；
   - 计划模式资格（只普通开发会话）；
   - 系统提示键。

   不进画像：dev 注入（`driver.ts:760`，送达方向归 09）；工作区——`tool-router.launchSpecFor` 改为直接调用 `taskWorkspaceFor`，画像不再包一层。
7. **位置与命名**：会话身份的类型与纯分类函数放 `src/core/session-identity.ts`，store 加一个方法读三行并调用分类；执行画像放 `src/agent/tool-availability.ts`，删 `sessionToolClass`。CONTEXT.md 收录「会话身份」（四种身份）；「执行画像」只是代码概念，不进术语表。
8. **Q4 的决定记入 ADR 0017 补充段**（「ruukoto 保留普通开发会话」），不另立 ADR。

9. **「只有一层」在本单**：`SubAgentManager.delegate()` 的父会话判定（`subagents.ts` 277 的 kind、281 的 SubAgent、284 的非 main 角色，后两项只在 modify 分支）合成一条按身份的判定：父会话必须是普通开发会话或 main 会话，两种 mode 都适用。宿主评审的父任务在 main 会话（`orchestrator.ts:340`），不受影响。`planMode` 死参数、状态转换与资格判定留给 12。

### 行为变化

可达路径无变化。不可达路径：manager 也拒绝来自 SubAgent 会话与已退役归档会话的 analyze 委派（工具层原本已拒）；SubAgent 的 SDK 会话在画像工具集变化时重建（原本靠每任务释放 driver 保证）。

### 测试

- `test/62`：`sessionToolClass` 用例换成分类用例（SubAgent 行 + 类别 dev 仍是 SubAgent 会话；qq_group 无角色行是已退役；coding、chat 各带原因；main 行是 main 会话）——替换，不叠加。新增画像表：身份 × 工作（无 / 只读 / 写入）× 宿主评审 × `/plan` 输入 → 工具集、是否规划 MCP、`restricted`、计划资格、提示键；只读 / 写入 / 评审三种 SDK 签名互不相同。
- store 方法不单测（三次查询加分类）。
- `test/83` 新增一例：同一 SubAgent 从只读工作复用到修改工作，新任务拿到写入工具。交付时做一次性变异：临时去掉 `runtime.ts:2885` 的每任务释放，该例仍通过。
- 44、58（唯一走到调用门的测试）不动；80–87 作回归。

## 步骤

分支 `session-identity`（从 develop）。

0. 工单、CONTEXT.md「会话身份」、ADR 0017 补充段、agent-direction issue 23 关闭（本次访谈已写好，提交即可）。
1. 会话身份：`src/core/session-identity.ts` 与 store 方法；删 `sessionToolClass`、`retiredSessionReason`；Runtime 各入口、队列兜底、resume-queue、5 处每次调用重核（`driver.ts` verifyMainBinding / verifyDelegationHost、`subagent-tools.ts:259`、`chat-result-tools.ts:82`、`im-approvals.ts:351`）与决定 9 的父会话判定改用身份；62 的分类用例。
2. 执行画像：`tool-availability.ts` 的画像；driver 的装配过滤、任务收窄、MCP 规划、资料受限、计划资格、系统提示与 SDK 签名改用画像；router 改用 `taskWorkspaceFor`；62 的画像表、83 新例与变异核对。
3. 文档：`docs/runtime.md`「架构要点」加会话身份与执行画像；按 `.skills/visual-docs/SKILL.md` 同步图解页；本单追加交付记录并标 resolved。

每步 `npm run typecheck` 与全量 `npm test`（nohup + 退出码文件）通过后在分支本地提交，不 push；不在 tx 上跑真实模型验收（纯重构）；何时合入 develop 由拥有者决定。

## 相关 ADR

- ADR 0020 §2：SubAgent 身份经 `sub_agents` 按会话识别，不进旧角色列——保持。
- ADR 0021：写入目标首次委派钉定、继续沿用并复核——画像只读取，不改钉定规则。
- 工单 03（工具可用性）：类别表仍是可见性的唯一来源。

## Comments
