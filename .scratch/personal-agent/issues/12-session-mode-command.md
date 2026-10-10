Status: resolved
Depends on: 03, 04

# 将 `/mode` 改为当前 session 的模式选择

## 目标

将现有 `/mode` 命令改为无参数列表选择：输入 `/mode` 后，在当前 session 中选择 `manul`、`full_access` 或 `auto-review`，选择结果作为该 session 后续任务的默认模式，不再要求指定 task。

## 当前情况

2026-09-22 当前工作区：

- [TUI](../../../src/tui/app.ts) 当前要求 `/mode <confirm|full_access> [taskId]`，无参数时提示用法；没有列表选择入口。
- [Runtime](../../../src/runtime/runtime.ts) 的 `switchTaskMode` 和 [控制协议](../../../src/control/server.ts) 的 `switch_mode` 都按 `task_id` 操作，支持 `confirm` 与 `full_access`，并处理运行中任务的待生效模式。
- [任务类型](../../../src/core/types.ts) 的 `accessMode`、`pendingAccessMode` 和权限版本属于任务级安全状态。请求确认模式与完全访问模式的边界由 [ADR 0003](../../../.agents/notes/implemented/feature/2026-09-19-explicit-access-modes.md) 规定，自动审批尚未纳入首期范围。

## 实施范围

- `/mode` 无参数时打开列表选择；列表显示当前 session 的生效模式和可选模式。Esc 取消，不修改任何状态。
- 选择结果保存到当前 session，作为之后新建任务的默认访问模式；`submit`、`continue` 以及内部创建任务的调用沿用该 session 默认值，除非调用方明确传入一次性的任务模式。
- 已运行、等待审批或已排队的任务保留创建时的 `accessMode`；切换 session 默认值不能改写任务、权限版本、待处理审批、目录占用或工具执行状态。现有针对特定 task 的 `switch_mode` 能力是否保留，作为兼容与安全评估项，不由本工单静默删除。
- 创建任务时在后台读取并固定 session 默认值，不能只在 TUI 显示层保存；多客户端切换需要认证、持久化、事件广播和版本冲突处理，重连后显示后台真实状态。
- `manul` 的拼写和语义需要确认：若意图是 `manual`，应决定它是否对应现有 `confirm`；若保留外部显示名 `manul`，内部仍需使用明确的枚举和值映射。`auto-review` 不是当前 `AccessMode`，必须先定义它是否代表自动审批、自动检查后请求确认，或其他受限流程。
- 在 `auto-review` 的权限与审批语义确认前，不得实现为绕过确认、自动升级到 `full_access` 或扩大文件/网络访问范围。任何自动审批能力都必须重新审查 ADR 0003 的控制边界。

## 实施计划

1. 先确认三个模式的产品名称、内部枚举、权限边界和默认值；记录 `manul` 是否修正为 `manual`，并明确 `auto-review` 的工具、网络、凭据和审批行为。信息未确认前，工单保持 `needs-triage`，不把 `auto-review` 当作已有模式实现。
2. 在 session 领域模型、SQLite schema 和 Store 中增加 session 默认模式及版本号；迁移旧 session 时使用现有默认 `confirm`，不能把历史任务的 `accessMode` 批量改写。更新 session 创建、读取、快照和持久事件。
3. 增加经过拥有者认证的 session 模式读取/设置控制接口，采用期望版本的条件更新；成功更新后事务内广播事件，失败不改变旧值。控制接口只返回安全的模式标识，不返回凭据或执行环境秘密。
4. 修改 Runtime 的任务提交入口，使未显式提供任务模式时使用提交瞬间的 session 默认值，再将结果固定写入任务。已接收任务的幂等核实和断线重试必须继续使用原任务模式，不能因 session 默认值后来变化而漂移。
5. 在 TUI 复用现有选择列表和覆盖层，将 `/mode` 补全、帮助、状态栏和错误提示改为 session 语义。后台确认后再更新状态；响应过期、断线或版本冲突时先刷新，不自动覆盖其他客户端的新选择。
6. 保留并单独标注 task 级 `switch_mode` 的行为。若确认需要移除 task 级入口，另行更新控制协议、CLI、审批事件和 ADR，不在快捷命令改造中隐式删除安全能力。

## 验收标准

- 在当前 session 执行 `/mode` 可打开列表，选择后显示新的 session 默认模式；不需要输入 task ID。
- 下一次 `submit`、`continue` 和内部任务创建使用新的默认模式；已运行、排队和等待审批的任务不被改写。
- 未选择 session、未认证、模式不支持、后台拒绝、版本冲突和断线时均有明确提示，当前默认值不被错误修改。
- 两个 TUI 客户端同时修改时，旧版本更新被拒绝或刷新；重连和后台重启后 session 默认模式保持一致。
- `full_access` 仍需拥有者明确选择，不能由 `auto-review` 或普通模型输出自动开启；自动审批语义未确认前不宣称已实现。
- 现有 task 级模式切换、审批、权限版本、工具执行边界和任务重连测试不回归。

## Comments

### 2026-09-22：创建工单

用户要求将现有 `/mode` 改为无 task 参数的列表选择，并作用于当前 session。当前实现仅支持任务级 `confirm|full_access`；用户描述中的 `manul` 与 `auto-review` 尚需确认具体名称和权限语义。

### 2026-09-22：实现完成

按实施计划落地，未确认部分按工单要求收窄：

- `manul` 视为 `manual` 笔误，对应现有 `confirm`（请求确认）；`auto-review` 语义未确认，未实现为任何模式，`set_session_mode` 只接受 `confirm | full_access`，ADR 0003 边界不变。
- Session 增加 `defaultAccessMode` + `defaultAccessModeVersion`（SQLite 补列迁移，旧会话默认 `confirm`，历史任务不改写）；`set_session_mode` 控制接口走拥有者认证与期望版本 CAS，事务内广播 `session.default_mode_changed`。
- `submit`/`continue` 未显式传模式时固定提交瞬间的会话默认值（幂等摘要按解析后的模式计算，默认值后续变更不漂移已接收任务）；显式传入的一次性模式优先。
- TUI `/mode` 改为无参数列表选择（Esc 取消），`full_access` 需二次确认；状态栏同时显示当前任务模式与会话默认模式；冲突/断线时刷新后台真实值，不自动重放。
- 任务级 `switch_mode`（控制协议与 CLI `switch-mode`）按第 6 条保留，未删除。
- 协议版本升至 v6；新增集成测试覆盖 CAS、默认值固定、既有任务不改写与非法模式拒绝。全部 139 个测试通过。
