Status: resolved
Depends on: 04

# 添加 `/new` 命令，在当前工作区新建 session

## 目标

在 TUI 中增加 `/new` 命令，复用当前会话的项目和工作区，创建一个新的 session 并自动切换到该 session，便于在同一工作区开始独立任务。

## 当前情况

2026-09-22 当前工作区：

- [TUI](../../../src/tui/app.ts) 已有 `/new-session <工作目录>`，要求手动提供工作目录；创建成功后调用 `switchSession`。
- [Runtime](../../../src/runtime/runtime.ts) 已有 `createSession`，负责校验项目、解析工作区身份、拒绝受保护路径，并创建持久化 session。
- [控制协议](../../../src/control/server.ts) 已有 `create_session`，无需新增后台会话类型或重复实现目录校验。

## 实施范围

- 在 TUI 命令补全、帮助和命令分发中增加 `/new`，说明为“在当前工作区创建 session”。
- `/new` 必须要求当前已有 session；从当前视图读取 `projectId` 和 `cwd`，调用现有 `create_session` 控制接口。
- 创建成功后更新本地状态并切换到返回的新 session，编辑器焦点、历史窗口和任务视图都绑定新 session；旧 session 的运行中或排队任务继续执行，不改变队列和任务状态。
- 当前没有 session 时给出明确提示，指向 `/new-project` 或 `/new-session <工作目录>`；不得从 `state.projects[0]` 猜测工作区。
- 创建失败时保留当前 session 和编辑内容，显示后台返回的错误；受保护路径、目录身份变化和项目不存在等错误沿用现有 `create_session` 语义。
- `/new-session <工作目录>` 保持现有行为，避免把快捷命令和可指定工作区命令合并成含糊的参数解析。

## 实施计划

1. 复用现有 `cmdNewSession`，增加一个“从当前视图取 `projectId` 与 `cwd`”的调用入口；如果当前实现把参数检查、请求和切换混在一起，抽取最小共享路径，避免复制创建逻辑。
2. 更新 `SLASH_COMMANDS`、`handleCommand`、帮助文案和无 session 提示，确保 `/new` 可补全、可见且不会被当作未知命令。
3. 沿用 `create_session` 的事件、快照、认证和错误处理；不增加新的控制协议操作、数据库表或 session 生命周期。
4. 用现有 TUI/控制协议测试设施补充验证：当前工作区创建并切换成功；当前 session 有任务时新 session 不影响旧任务；无当前 session、后台拒绝和断线时提示正确且不误切换；重复执行 `/new` 可创建两个独立 session；`/new-session` 的显式目录路径行为不回归。

## 验收标准

- 在已选 session 中执行 `/new`，后台创建的新 session 使用相同项目和规范化工作区，TUI 自动显示新 session。
- 新 session 没有复制旧 session 的任务、队列状态或历史消息；旧 session 仍可通过 `/sessions` 找回。
- 未选择 session 时不创建任何 session，提示下一步操作。
- 创建失败时不改变当前选择、不丢失输入，并展示可理解的错误。
- `npm run typecheck` 和受影响的 TUI 测试通过。

## Comments

### 2026-09-22：创建工单

用户要求增加 `/new` 命令，在当前工作区新建一个 session。现有 `/new-session` 和 `create_session` 能覆盖后台能力，本工单只补充快捷交互入口。

### 2026-09-22：已实现

在 `src/tui/app.ts` 增加 `/new` 命令：从当前视图取 `projectId` 与 `cwd`，与 `/new-session` 共享 `createAndSwitch` 创建路径；未选择会话时提示 `/new-project` 或 `/new-session`，不再从 `state.projects[0]` 猜测。`test/14-tui-app.test.ts` 新增两个用例（创建并切换、可重复创建；无会话时不创建且提示正确）。`npm run typecheck` 与 `test/14-tui-app.test.ts` 全部通过。
